/**
 * Slack outbound tool module — exposes `slack_reply` to the Claude session.
 *
 * Slack is a ToolModule (reply-only, like LINE/ApiModule): inbound arrives via
 * the gateway's Express webhook route (src/api/slack-webhook-router.ts), not
 * here.
 *
 * Unlike LINE (`mcp/tools/line/module.ts`), there is no reply-token TTL to
 * work around and no gateway-side reply manager to defer to (see the plan's
 * "no reply-manager needed" design note) — `chat.postMessage` works with the
 * bot token at any time, so this module always sends directly from the
 * subprocess.
 */
import * as fs from 'fs';
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
// mcp/ ships as source (package.json `files` lists "mcp/", not "src/") and
// runs directly under bun — it may only import a compiled dist/ artifact,
// never src/ directly (see tests/unit/mcp-no-src-imports.test.ts, a
// regression guard for the exact v1.3.25 packaging bug this would otherwise
// reintroduce: `../../../src/*` resolves fine in this dev repo but throws
// "Cannot find module" from an installed package). `npm run build` must have
// run at least once for this import to resolve locally.
import { SlackClient } from '../../../dist/api/slack-client.js';
import { MAX_ATTACHMENT_BYTES } from '../shared/limits';

export class SlackModule implements ToolModule {
  id = 'slack';
  toolVisibility: ToolVisibility = 'current-channel';

  // Files already delivered this session. Small models sometimes retry
  // slack_reply after a transient send hiccup even though the upload
  // succeeded, which spams duplicate images. We never re-send the same file.
  private readonly sentFiles = new Set<string>();

  isEnabled(): boolean {
    return process.env.GATEWAY_ORIGIN_CHANNEL === 'slack';
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'slack_reply',
        description:
          'Send a reply to the current Slack conversation. ' +
          'Pass chat_id (the Slack channel/DM id shown in the <channel> tag) and text. ' +
          'Optionally pass files (absolute paths) to attach images or documents. ' +
          'Also pass message_id from the <channel> tag when present — it clears the ' +
          '⏳ "seen" reaction the gateway left on the inbound message. ' +
          'Pass thread_id to reply inside the same thread instead of top-level.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'Slack channel or DM id to send to (the chat_id from the channel turn).',
            },
            text: {
              type: 'string',
              description: 'Message text.',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Absolute file paths to attach (e.g. a generate_image result path). ' +
                'Optional — text can be sent alone, files can be sent alone, or both ' +
                'together as one message with the text as caption.',
            },
            message_id: {
              type: 'string',
              description:
                'Optional inbound message ts from the <channel> tag — clears the ack reaction left on it.',
            },
            thread_id: {
              type: 'string',
              description:
                'Optional thread_ts to reply inside the same thread instead of top-level — ' +
                'pass the thread_ts attribute from the <channel> tag when present, so a reply ' +
                'to a threaded message stays in-thread.',
            },
          },
          // `text` is NOT required: a files-only reply (an image with no caption)
          // is a legitimate send.
          required: ['chat_id'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name === 'slack_reply') return this.handleReply(args);
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  private async handleReply(args: Record<string, unknown>): Promise<McpToolResult> {
    const chatId = typeof args.chat_id === 'string' ? args.chat_id : '';
    const text = typeof args.text === 'string' ? args.text : '';
    const messageId = typeof args.message_id === 'string' ? args.message_id : '';
    const threadId = typeof args.thread_id === 'string' ? args.thread_id : '';
    const requested = Array.isArray(args.files) ? (args.files as unknown[]) : [];
    const token = process.env.SLACK_BOT_TOKEN ?? '';

    if (!chatId) {
      return { content: [{ type: 'text', text: 'slack_reply: missing chat_id' }], isError: true };
    }

    // Drop files already delivered successfully this session (retry-dedup): a
    // small model sometimes retries slack_reply after a transient hiccup even
    // though the upload landed, which would spam duplicate images.
    const files = requested.filter(
      (f): f is string => typeof f === 'string' && !this.sentFiles.has(f),
    );

    // Nothing new to say or send — the whole reply is a duplicate retry. No-op
    // success so the agent treats it as delivered and stops retrying.
    if (!text && files.length === 0 && requested.length > 0) {
      return { content: [{ type: 'text', text: 'already sent (duplicate suppressed)' }] };
    }
    if (!text && files.length === 0) {
      return { content: [{ type: 'text', text: 'slack_reply: text cannot be empty' }], isError: true };
    }
    if (!token) {
      return { content: [{ type: 'text', text: 'slack_reply: missing SLACK_BOT_TOKEN' }], isError: true };
    }

    const client = new SlackClient({ botToken: token, logDir: process.env.GATEWAY_WORKSPACE_DIR ?? '/tmp' });
    try {
      // Size-check before any upload starts, so an oversized file fails fast
      // instead of half-way through a multi-file batch.
      for (const f of files) {
        const st = fs.statSync(f);
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`);
        }
      }

      // With files, ONE uploadFiles call carries both the attachments and the
      // text (as Slack's initial_comment) — never also postMessage, which would
      // split one reply into two Slack messages.
      const sent =
        files.length > 0
          ? await client.uploadFiles(chatId, files, {
              threadTs: threadId || undefined,
              initialComment: text || undefined,
            })
          : await client.postMessage(chatId, text, threadId || undefined);
      if (!sent.ok) {
        return { content: [{ type: 'text', text: `slack_reply failed: ${sent.error}` }], isError: true };
      }
      // Mark as sent only AFTER the send succeeds — a genuine failure leaves
      // them eligible for a retry rather than silently dropped.
      for (const f of files) this.sentFiles.add(f);
      // Best-effort: clear the ack-reaction the webhook left on the inbound
      // message. Never blocks or fails the reply itself on a reaction error.
      if (messageId) {
        void client.removeReaction(chatId, messageId).catch(() => {});
      }
      return {
        content: [
          {
            type: 'text',
            text: files.length > 0
              ? `Sent message to Slack (${files.length} file(s)).`
              : 'Sent message to Slack.',
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `slack_reply failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
}
