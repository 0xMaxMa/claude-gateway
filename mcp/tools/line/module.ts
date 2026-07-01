/**
 * LINE outbound tool module — exposes `line_reply` to the Claude session.
 *
 * LINE is a ToolModule (reply-only, like ApiModule): inbound arrives via the
 * gateway's Express webhook route (src/api/line-webhook-router.ts), not here.
 *
 * Delivery is reply-token-first → push fallback (matches openclaw/hermes-agent):
 * LINE counts push/broadcast against the OA's monthly quota but reply-token
 * messages are FREE, so we send via the reply API when a (still-valid) reply_token
 * is passed, and fall back to push if it's absent or expired/used (the single-use
 * token has no guaranteed lifetime — ~1 min — so push remains the safety net).
 */
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
import { messagingApi } from '@line/bot-sdk';
import { chunkText, planLineSend, LINE_TEXT_LIMIT } from './pure';

export class LineModule implements ToolModule {
  id = 'line';
  toolVisibility: ToolVisibility = 'current-channel';

  isEnabled(): boolean {
    return process.env.GATEWAY_ORIGIN_CHANNEL === 'line';
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'line_reply',
        description:
          'Send a reply to the current LINE user. ' +
          'Pass chat_id (the LINE userId shown in the <channel> tag) and text. ' +
          'Also pass reply_token from the <channel> tag when present — it sends the ' +
          'reply for FREE (push messages count against the LINE quota); the tool ' +
          'automatically falls back to push if the token is expired/used. ' +
          'Long text is split into multiple messages automatically.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'LINE userId to send to (the chat_id from the channel turn).',
            },
            text: {
              type: 'string',
              description: 'Message text. Automatically split into <=5000-char messages.',
            },
            reply_token: {
              type: 'string',
              description:
                'Optional single-use reply token from the <channel> tag. When valid, the ' +
                'reply is sent free via the reply API; falls back to push automatically.',
            },
          },
          required: ['chat_id', 'text'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name === 'line_reply') return this.handleReply(args);
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  private async handleReply(args: Record<string, unknown>): Promise<McpToolResult> {
    const chatId = typeof args.chat_id === 'string' ? args.chat_id : '';
    const text = typeof args.text === 'string' ? args.text : '';
    const replyToken = typeof args.reply_token === 'string' ? args.reply_token : '';
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '';

    if (!chatId) {
      return { content: [{ type: 'text', text: 'line_reply: missing chat_id' }], isError: true };
    }
    if (!text) {
      return { content: [{ type: 'text', text: 'line_reply: text cannot be empty' }], isError: true };
    }

    // Refresh mode: the gateway (LineReplyManager) is the sole LINE sender — it
    // observes this tool call in the session output stream and delivers the
    // reply (free reply, or cache + postback button when slow). Sending here too
    // would double-send and contend for the single-use reply token, so skip it.
    if (process.env.LINE_REPLY_REFRESH === '1') {
      return { content: [{ type: 'text', text: 'Reply handed to gateway for delivery.' }] };
    }
    if (!token) {
      return {
        content: [{ type: 'text', text: 'line_reply: missing LINE_CHANNEL_ACCESS_TOKEN' }],
        isError: true,
      };
    }

    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: token,
    });

    const toMessages = (group: string[]) =>
      group.map((t) => ({ type: 'text' as const, text: t }));
    const push = (group: string[]) => client.pushMessage({ to: chatId, messages: toMessages(group) });

    const chunks = chunkText(text, LINE_TEXT_LIMIT);
    const plan = planLineSend(chunks, replyToken.length > 0);
    let via = 'push';
    try {
      // Reply-token-first: the first batch goes via the FREE reply API when a token
      // is present, falling back to push if the token is expired/used. Remaining
      // batches always push (a reply token is single-use).
      if (plan.replyBatch) {
        try {
          await client.replyMessage({ replyToken, messages: toMessages(plan.replyBatch) });
          via = plan.pushBatches.length > 0 ? 'reply + push' : 'reply';
        } catch {
          await push(plan.replyBatch); // token expired/used → push fallback
          via = 'push (reply fallback)';
        }
      }
      for (const group of plan.pushBatches) await push(group);
      return {
        content: [{ type: 'text', text: `Sent ${chunks.length} message(s) to LINE (${via}).` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `line_reply failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
}
