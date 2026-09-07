/**
 * WhatsApp outbound tool module — exposes `whatsapp_reply` to the Claude
 * session. Unlike Slack/SMS/LINE, this does NOT open its own connection to
 * the platform: Baileys multiplexes all send/receive through the ONE live
 * socket the gateway's in-process WhatsAppManager already holds (see
 * src/whatsapp/manager.ts's doc comment for why a fresh per-call connection
 * isn't viable here the way it is for a stateless REST client). Instead this
 * tool POSTs to the gateway's own internal `/v1/agents/:id/whatsapp/send`
 * route, using the same `GATEWAY_API_URL`/`GATEWAY_API_KEY` bridge every MCP
 * subprocess already receives (the same bridge Discord's module uses to
 * reach `/cli` pairing approval — a proven pattern, just not yet used to
 * reach a receiver's live resource specifically).
 *
 * WhatsApp is a ToolModule (reply-only, like LINE/Slack/SMS): inbound
 * arrives via WhatsAppManager directly forwarding to the agent's callback
 * port, not through this MCP subprocess at all.
 */
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';

export class WhatsAppModule implements ToolModule {
  id = 'whatsapp';
  toolVisibility: ToolVisibility = 'current-channel';

  isEnabled(): boolean {
    return process.env.GATEWAY_ORIGIN_CHANNEL === 'whatsapp';
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'whatsapp_reply',
        description:
          'Send a reply to the current WhatsApp conversation. ' +
          'Pass chat_id (the JID shown in the <channel> tag) and text. ' +
          'If the <channel> tag carries an account_id, pass it too — the agent ' +
          'may have several linked WhatsApp numbers, and account_id is the one ' +
          'the incoming message arrived on. ' +
          'Optionally pass image_path (an absolute path) to attach an image — ' +
          'text then becomes the caption. WhatsApp has its own lightweight ' +
          'formatting (*bold*, _italic_, ~strikethrough~), not HTML or standard markdown.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'WhatsApp JID to send to (the chat_id from the channel turn).',
            },
            text: {
              type: 'string',
              description: 'Message text (or caption, if image_path is also passed).',
            },
            image_path: {
              type: 'string',
              description: 'Optional absolute path to an image file to attach.',
            },
            account_id: {
              type: 'string',
              description:
                'Which linked WhatsApp number to send from — copy account_id from ' +
                'the <channel> tag so the reply comes from the number the message ' +
                'arrived on. Omit only if the tag has none.',
            },
          },
          required: ['chat_id'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name === 'whatsapp_reply') return this.handleReply(args);
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  private async handleReply(args: Record<string, unknown>): Promise<McpToolResult> {
    const chatId = typeof args.chat_id === 'string' ? args.chat_id : '';
    const text = typeof args.text === 'string' ? args.text : '';
    const imagePath = typeof args.image_path === 'string' ? args.image_path : undefined;
    const accountId = typeof args.account_id === 'string' && args.account_id ? args.account_id : undefined;
    const agentId = process.env.GATEWAY_AGENT_ID ?? '';
    const apiUrl = process.env.GATEWAY_API_URL ?? '';
    const apiKey = process.env.GATEWAY_API_KEY ?? '';

    if (!chatId) {
      return { content: [{ type: 'text', text: 'whatsapp_reply: missing chat_id' }], isError: true };
    }
    if (!text && !imagePath) {
      return {
        content: [{ type: 'text', text: 'whatsapp_reply: text or image_path is required' }],
        isError: true,
      };
    }
    if (!agentId || !apiUrl || !apiKey) {
      return {
        content: [{ type: 'text', text: 'whatsapp_reply: missing gateway API bridge env vars' }],
        isError: true,
      };
    }

    try {
      const res = await fetch(`${apiUrl}/api/v1/agents/${agentId}/whatsapp/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ jid: chatId, text, image_path: imagePath, account_id: accountId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return {
          content: [{ type: 'text', text: `whatsapp_reply failed: ${body.error ?? res.status}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: 'Sent message via WhatsApp.' }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `whatsapp_reply failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
}
