/**
 * WhatsApp Business Cloud API outbound tool module — exposes
 * `whatsapp_cloud_reply` to the Claude session.
 *
 * WhatsApp Cloud is a ToolModule (reply-only, like Slack/LINE): inbound
 * arrives via the gateway's Express webhook route
 * (src/api/whatsapp-cloud-webhook-router.ts), not here.
 *
 * Mirrors `mcp/tools/slack/module.ts` directly — real, Meta-issued
 * credentials with no reply-token TTL to work around, so this module always
 * sends directly from the subprocess, same as Slack. Unlike Slack there are
 * no `thread_id`/`message_id` params: the Cloud API has no threads, and this
 * channel doesn't carry Slack's ack-reaction to clear.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
// mcp/ ships as source (package.json `files` lists "mcp/", not "src/") and
// runs directly under bun — it may only import a compiled dist/ artifact,
// never src/ directly (see tests/unit/mcp-no-src-imports.test.ts). `npm run
// build` must have run at least once for this import to resolve locally.
import { WhatsAppCloudClient } from '../../../dist/api/whatsapp-cloud-client.js';
import { MAX_ATTACHMENT_BYTES } from '../shared/limits';

/**
 * Extension-based mime sniff for outbound files — self-contained on purpose
 * (mirrors limits.ts's own doc comment: mcp/** must not import src/**, so
 * this can't reuse src/shared/image-sniff.ts's magic-byte sniffer). Good
 * enough here because these are files the AGENT itself wrote (generate_image
 * output, a downloaded PDF, ...), not attacker-controlled bytes — unlike the
 * inbound side, where the webhook router sniffs the real bytes.
 */
function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

export class WhatsAppCloudModule implements ToolModule {
  id = 'whatsapp_cloud';
  toolVisibility: ToolVisibility = 'current-channel';

  // Files already delivered this session — same retry-dedup as Slack's
  // module (a small model sometimes retries after a transient send hiccup
  // even though the upload landed, which would spam duplicate media).
  private readonly sentFiles = new Set<string>();

  isEnabled(): boolean {
    return process.env.GATEWAY_ORIGIN_CHANNEL === 'whatsapp_cloud';
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'whatsapp_cloud_reply',
        description:
          'Send a reply to the current WhatsApp conversation (WhatsApp Business Cloud API). ' +
          'Pass chat_id (the phone number shown in the <channel> tag) and text. ' +
          'Optionally pass files (absolute paths) to attach images or PDF documents — ' +
          'each file is sent as its own message; a caption (from text) rides on the first one.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'WhatsApp phone number to send to (the chat_id from the channel turn).',
            },
            text: {
              type: 'string',
              description: 'Message text.',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Absolute file paths to attach (images or PDF documents). Optional — text can be ' +
                'sent alone, files can be sent alone, or both together (text becomes the first file\'s caption).',
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
    if (name === 'whatsapp_cloud_reply') return this.handleReply(args);
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  private async handleReply(args: Record<string, unknown>): Promise<McpToolResult> {
    const chatId = typeof args.chat_id === 'string' ? args.chat_id : '';
    const text = typeof args.text === 'string' ? args.text : '';
    const requested = Array.isArray(args.files) ? (args.files as unknown[]) : [];
    const accessToken = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ?? '';
    const phoneNumberId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID ?? '';

    if (!chatId) {
      return { content: [{ type: 'text', text: 'whatsapp_cloud_reply: missing chat_id' }], isError: true };
    }

    // Drop files already delivered successfully this session (retry-dedup).
    const files = requested.filter(
      (f): f is string => typeof f === 'string' && !this.sentFiles.has(f),
    );

    // Nothing new to say or send — the whole reply is a duplicate retry. No-op
    // success so the agent treats it as delivered and stops retrying.
    if (!text && files.length === 0 && requested.length > 0) {
      return { content: [{ type: 'text', text: 'already sent (duplicate suppressed)' }] };
    }
    if (!text && files.length === 0) {
      return { content: [{ type: 'text', text: 'whatsapp_cloud_reply: text cannot be empty' }], isError: true };
    }
    if (!accessToken || !phoneNumberId) {
      return {
        content: [{ type: 'text', text: 'whatsapp_cloud_reply: missing WHATSAPP_CLOUD_ACCESS_TOKEN/WHATSAPP_CLOUD_PHONE_NUMBER_ID' }],
        isError: true,
      };
    }

    const client = new WhatsAppCloudClient({
      accessToken,
      phoneNumberId,
      logDir: process.env.GATEWAY_WORKSPACE_DIR ?? '/tmp',
    });

    try {
      // Size-check before any upload starts, so an oversized file fails fast
      // instead of half-way through a multi-file batch.
      for (const f of files) {
        const st = fs.statSync(f);
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`);
        }
      }

      if (files.length > 0) {
        // The Cloud API sends one message per media item (no Slack-style
        // batch-into-one-message) — the caption rides on the FIRST file only.
        for (let i = 0; i < files.length; i++) {
          const f = files[i]!;
          const mime = guessMimeType(f);
          const uploaded = await client.uploadMedia(f, mime);
          if ('error' in uploaded) {
            throw new Error(uploaded.error);
          }
          const caption = i === 0 ? (text || undefined) : undefined;
          const sent = mime.startsWith('image/')
            ? await client.sendImage(chatId, uploaded.mediaId, caption)
            : await client.sendDocument(chatId, uploaded.mediaId, path.basename(f), caption);
          if (sent.error) {
            throw new Error(sent.error.message ?? 'send failed');
          }
        }
      } else {
        const sent = await client.sendText(chatId, text);
        if (sent.error) {
          throw new Error(sent.error.message ?? 'send failed');
        }
      }

      // Mark as sent only AFTER the send succeeds — a genuine failure leaves
      // them eligible for a retry rather than silently dropped.
      for (const f of files) this.sentFiles.add(f);
      return {
        content: [
          {
            type: 'text',
            text: files.length > 0
              ? `Sent message to WhatsApp (${files.length} file(s)).`
              : 'Sent message to WhatsApp.',
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `whatsapp_cloud_reply failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
}
