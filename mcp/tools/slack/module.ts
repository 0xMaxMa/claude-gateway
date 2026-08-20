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
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
// mcp/ ships as source (package.json `files` lists "mcp/", not "src/") and
// runs directly under bun — it may only import a compiled dist/ artifact,
// never src/ directly (see tests/unit/mcp-no-src-imports.test.ts, a
// regression guard for the exact v1.3.25 packaging bug this would otherwise
// reintroduce: `../../../src/*` resolves fine in this dev repo but throws
// "Cannot find module" from an installed package). `npm run build` must have
// run at least once for this import to resolve locally.
import { SlackClient } from '../../../dist/api/slack-client.js';

export class SlackModule implements ToolModule {
  id = 'slack';
  toolVisibility: ToolVisibility = 'current-channel';

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
            message_id: {
              type: 'string',
              description:
                'Optional inbound message ts from the <channel> tag — clears the ack reaction left on it.',
            },
            thread_id: {
              type: 'string',
              description: 'Optional thread_ts to reply inside the same thread instead of top-level.',
            },
          },
          required: ['chat_id', 'text'],
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
    const token = process.env.SLACK_BOT_TOKEN ?? '';

    if (!chatId) {
      return { content: [{ type: 'text', text: 'slack_reply: missing chat_id' }], isError: true };
    }
    if (!text) {
      return { content: [{ type: 'text', text: 'slack_reply: text cannot be empty' }], isError: true };
    }
    if (!token) {
      return { content: [{ type: 'text', text: 'slack_reply: missing SLACK_BOT_TOKEN' }], isError: true };
    }

    const client = new SlackClient({ botToken: token, logDir: process.env.GATEWAY_WORKSPACE_DIR ?? '/tmp' });
    try {
      const sent = await client.postMessage(chatId, text, threadId || undefined);
      if (!sent.ok) {
        return { content: [{ type: 'text', text: `slack_reply failed: ${sent.error}` }], isError: true };
      }
      // Best-effort: clear the ack-reaction the webhook left on the inbound
      // message. Never blocks or fails the reply itself on a reaction error.
      if (messageId) {
        void client.removeReaction(chatId, messageId).catch(() => {});
      }
      return { content: [{ type: 'text', text: 'Sent message to Slack.' }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `slack_reply failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
}
