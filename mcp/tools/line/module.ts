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
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
import { messagingApi } from '@line/bot-sdk';
import { chunkText, planLineSend, LINE_TEXT_LIMIT } from './pure';
import { signPublicToken } from './public-token';

/** Default lifetime of a signed image URL handed to LINE (1 hour). */
const DEFAULT_MEDIA_URL_TTL_MS = 60 * 60 * 1000;

/**
 * Convert a media path (absolute under the agent media root, or already relative
 * like "media/<chat>/<file>.png") to the "media/…"-relative form the gateway's
 * signed-URL route expects. Returns null if it cannot be resolved to the media root.
 */
function toRelativeMediaPath(p: string): string | null {
  if (!p) return null;
  const normalized = p.replace(/\\/g, '/');
  if (!path.isAbsolute(normalized)) {
    return normalized.startsWith('media/') ? normalized : `media/${normalized.replace(/^\/+/, '')}`;
  }
  const workspace = process.env.GATEWAY_WORKSPACE_DIR;
  if (!workspace) return null;
  const mediaRoot = path.resolve(workspace, '..', 'media');
  const rel = path.relative(mediaRoot, path.resolve(normalized));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `media/${rel.split(path.sep).join('/')}`;
}

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
      {
        name: 'line_image',
        description:
          'Send an image to the current LINE user. Pass chat_id (the LINE userId from the ' +
          '<channel> tag) and image (a media path saved by the gateway, e.g. a generate_image ' +
          'result path or a "media/…" path). LINE can only fetch public HTTPS URLs, so the tool ' +
          'mints a signed, short-lived public URL for the file and sends it as an image message. ' +
          'Pass reply_token from the <channel> tag when present to send for FREE (falls back to push).',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'LINE userId to send to (the chat_id from the channel turn).',
            },
            image: {
              type: 'string',
              description: 'Media path of the image (absolute path under the agent media dir, or a "media/…" relative path).',
            },
            preview: {
              type: 'string',
              description: 'Optional separate preview-image media path. Defaults to the same image.',
            },
            reply_token: {
              type: 'string',
              description: 'Optional single-use reply token from the <channel> tag (sends free; falls back to push).',
            },
          },
          required: ['chat_id', 'image'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name === 'line_reply') return this.handleReply(args);
    if (name === 'line_image') return this.handleImage(args);
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

  /**
   * Send an image via a signed short-lived public URL. LINE's servers fetch the
   * image over public HTTPS (the normal media route is API-key-gated), so we mint
   * a token the gateway `/public/:token` route verifies + streams.
   */
  private async handleImage(args: Record<string, unknown>): Promise<McpToolResult> {
    const chatId = typeof args.chat_id === 'string' ? args.chat_id : '';
    const image = typeof args.image === 'string' ? args.image : '';
    const preview = typeof args.preview === 'string' && args.preview ? args.preview : image;
    const replyToken = typeof args.reply_token === 'string' ? args.reply_token : '';
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '';

    if (!chatId) {
      return { content: [{ type: 'text', text: 'line_image: missing chat_id' }], isError: true };
    }
    if (!image) {
      return { content: [{ type: 'text', text: 'line_image: image path is required' }], isError: true };
    }

    // Public base URL is derived by the gateway from the inbound LINE webhook and
    // written to `<workspace>/../.public-base` (no public-base-URL env var). Read it
    // here at call-time; if it isn't there yet the pod hasn't seen a webhook, so
    // ask the user to send another message rather than pushing a broken URL.
    const workspace = process.env.GATEWAY_WORKSPACE_DIR;
    if (!workspace) {
      return {
        content: [{ type: 'text', text: 'line_image: GATEWAY_WORKSPACE_DIR not set' }],
        isError: true,
      };
    }
    let publicBase = '';
    try {
      publicBase = fs
        .readFileSync(path.resolve(workspace, '..', '.public-base'), 'utf8')
        .trim()
        .replace(/\/+$/, '');
    } catch {
      publicBase = '';
    }
    if (!publicBase) {
      return {
        content: [{ type: 'text', text: 'line_image: public base not resolved yet (send a message again)' }],
        isError: true,
      };
    }
    // HMAC key for the public media URL = this pod's gateway API key (reused, not a
    // separate secret). NOT the LLM proxy_secret/CLAUDE_CODE_OAUTH_TOKEN — the public
    // token is a gateway route, so the gateway's own key is the right signer, and the verify
    // side resolves the same key from config.gateway.api.keys (see gateway-router.ts).
    const signSecret = process.env.GATEWAY_API_KEY ?? '';
    const agentId = process.env.GATEWAY_AGENT_ID ?? '';
    if (!signSecret || !agentId) {
      return {
        content: [{ type: 'text', text: 'line_image: image delivery not configured (missing GATEWAY_API_KEY or GATEWAY_AGENT_ID)' }],
        isError: true,
      };
    }

    const relImage = toRelativeMediaPath(image);
    const relPreview = toRelativeMediaPath(preview);
    if (!relImage || !relPreview) {
      return {
        content: [{ type: 'text', text: `line_image: could not resolve media path to the agent media root: ${image}` }],
        isError: true,
      };
    }

    const ttl = Number(process.env.GATEWAY_MEDIA_URL_TTL_MS) > 0
      ? Number(process.env.GATEWAY_MEDIA_URL_TTL_MS)
      : DEFAULT_MEDIA_URL_TTL_MS;
    const exp = Date.now() + ttl;
    const signUrl = (rel: string): string =>
      `${publicBase}/public/${signPublicToken({ k: 'media', a: agentId, p: rel, e: exp }, signSecret)}`;

    const message = {
      type: 'image' as const,
      originalContentUrl: signUrl(relImage),
      previewImageUrl: signUrl(relPreview),
    };

    if (!token) {
      return { content: [{ type: 'text', text: 'line_image: missing LINE_CHANNEL_ACCESS_TOKEN' }], isError: true };
    }
    const client = new messagingApi.MessagingApiClient({ channelAccessToken: token });

    let via = 'push';
    try {
      if (replyToken) {
        try {
          await client.replyMessage({ replyToken, messages: [message] });
          via = 'reply';
        } catch {
          await client.pushMessage({ to: chatId, messages: [message] });
          via = 'push (reply fallback)';
        }
      } else {
        await client.pushMessage({ to: chatId, messages: [message] });
      }
      return { content: [{ type: 'text', text: `Sent image to LINE (${via}).` }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `line_image failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
}
