/**
 * WeChat outbound tool module — exposes `wechat_reply` to the Claude session.
 *
 * WeChat is a ToolModule (reply-only): inbound arrives via the gateway's own
 * WeChatManager long-poll loop (src/wechat/manager.ts), not here. Unlike
 * Slack (`mcp/tools/slack/module.ts`), this module cannot talk to the
 * third-party API directly — the live iLink session (credentials, per-
 * recipient context tokens) only exists inside the main gateway process, so
 * every send is proxied through that process's own `/wechat/send` route,
 * the same reasoning WhatsApp's Baileys socket needs (see
 * src/api/router.ts's `/whatsapp/send` route once that channel lands, and
 * `mcp/tools/cron/module.ts` for the same "call back into our own gateway
 * API" shape this module follows).
 */
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
import { WeChatClient } from './client';

export class WeChatModule implements ToolModule {
  id = 'wechat';
  toolVisibility: ToolVisibility = 'current-channel';

  private client: WeChatClient | null = null;

  isEnabled(): boolean {
    return (
      process.env.GATEWAY_ORIGIN_CHANNEL === 'wechat' &&
      Boolean(process.env.GATEWAY_API_URL && process.env.GATEWAY_AGENT_ID)
    );
  }

  private getClient(): WeChatClient {
    if (!this.client) {
      const apiUrl = process.env.GATEWAY_API_URL!;
      const agentId = process.env.GATEWAY_AGENT_ID!;
      const apiKey = process.env.GATEWAY_API_KEY;
      this.client = new WeChatClient(apiUrl, agentId, apiKey);
    }
    return this.client;
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'wechat_reply',
        description:
          'Send a reply to the current WeChat conversation. ' +
          'Pass chat_id (the WeChat sender id shown in the <channel> tag) and text. ' +
          'Text-only for now — WeChat media sending is not yet supported.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'WeChat sender id to send to (the chat_id from the channel turn).',
            },
            text: {
              type: 'string',
              description: 'Message text.',
            },
          },
          required: ['chat_id', 'text'],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name !== 'wechat_reply') {
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
    }
    const chatId = args.chat_id as string | undefined;
    const text = args.text as string | undefined;
    if (!chatId || !text) {
      return {
        content: [{ type: 'text', text: 'wechat_reply failed: chat_id and text are required' }],
        isError: true,
      };
    }
    try {
      await this.getClient().send(chatId, text);
      return { content: [{ type: 'text', text: 'sent' }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `wechat_reply failed: ${msg}` }], isError: true };
    }
  }
}
