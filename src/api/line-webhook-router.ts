/**
 * LINE inbound webhook handler (openclaw-style: LINE is webhook-only, no polling).
 *
 * Exposed as a WebhookAppHandler ({ verify, handlePost }) wired into the unified
 * `/webhooks/:app` dispatcher (see webhooks-router.ts) under app "line". The
 * dispatcher mounts BEFORE express.json() and applies express.raw, so the raw
 * request bytes are available for signature validation (LINE signs the raw body;
 * a re-serialized parsed body would not match).
 *
 * Flow: verify x-line-signature → 200 → for each text message from a 1:1 user,
 * show a loading animation and forward a normalized {content, meta} to the
 * target agent's existing /channel callback (the same intake Telegram uses).
 */
import { type Request, type Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateSignature, messagingApi, type webhook } from '@line/bot-sdk';
import type { AgentRunner } from '../agent/runner';
import { createLogger } from '../logger';
import {
  isResolvedSourceAllowed,
  resolveLineSource,
  type ResolvedLineSource,
} from './line-access';
import {
  recordDeniedSender,
  recordDeniedConversation,
  getPendingSender,
  generatePairingCode,
} from './line-pending-senders';
import { wasBotMentioned, type LineMessageLike } from './line-mention';
import type { WebhookAppHandler } from './webhooks-router';

const LOADING_SECONDS = 20; // 5..60, multiple of 5; 1:1 chats only
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // matches MediaStore.maxUploadBytes

/** A sane public hostname: letters, digits, dot, hyphen, optional :port. */
const HOST_RE = /^[A-Za-z0-9.\-:]+$/;

/**
 * Persist the gateway's own public base URL (derived from the inbound LINE
 * webhook request) to `<workspace>/../.public-base`, which the `line_image` MCP
 * tool reads at call-time to mint signed `/public/<token>` URLs. This removes the
 * need for any public-base-URL env var.
 *
 * Scheme is hardcoded `https`: the pod's Traefik `web-vm` entrypoint does NOT
 * trust forwarded headers, so X-Forwarded-Proto arrives as `http` (wrong). The
 * Host header IS reliable (pod FQDN).
 *
 * Defensive by contract: validates the host, only rewrites when the content
 * changed (avoids I/O per message), writes atomically (temp + rename), and never
 * throws — a failure here must not break webhook handling.
 */
function persistPublicBase(
  workspace: string,
  host: string,
  logger: ReturnType<typeof createLogger>,
): void {
  try {
    const h = (host.split(',')[0] ?? '').trim();
    if (!h || !HOST_RE.test(h)) {
      logger.debug('LINE webhook: skip .public-base (invalid/empty host)', { host });
      return;
    }
    const base = `https://${h}/gateway`;
    const target = path.resolve(workspace, '..', '.public-base');
    let current = '';
    try {
      current = fs.readFileSync(target, 'utf8');
    } catch {
      current = '';
    }
    if (current === base) return;
    const tmp = path.join(path.dirname(target), `.public-base.${process.pid}.tmp`);
    fs.writeFileSync(tmp, base, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    logger.debug('LINE webhook: .public-base write failed', { error: (err as Error).message });
  }
}

/** Pick a file extension from an image's magic bytes; default jpg (LINE photos). */
function sniffImageExt(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (
    buf.length >= 12 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'webp';
  return 'jpg';
}

/**
 * Fetch an inbound LINE image's bytes via the blob (data) API and write them to
 * a temp file, returning its absolute path. The runner copies this into the
 * agent's permanent MediaStore and tells the agent to Read it (meta.image_path).
 * Returns null on failure; the turn still forwards (agent sees the text/empty).
 */
async function downloadLineImage(
  blobClient: messagingApi.MessagingApiBlobClient,
  messageId: string,
): Promise<string | null> {
  const stream = await blobClient.getMessageContent(messageId);
  const dest = path.join(os.tmpdir(), `line-img-${messageId}-${Date.now()}.tmp`);
  const fileStream = fs.createWriteStream(dest);
  let total = 0;
  let ext = 'jpg';
  let firstChunk = true;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > MAX_IMAGE_BYTES) {
      (stream as { destroy?: () => void }).destroy?.();
      fileStream.destroy();
      fs.rmSync(dest, { force: true });
      throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte cap`);
    }
    if (firstChunk) { ext = sniffImageExt(b); firstChunk = false; }
    fileStream.write(b);
  }
  await new Promise<void>((resolve, reject) => fileStream.end((err?: Error | null) => err ? reject(err) : resolve()));
  if (total === 0) { fs.rmSync(dest, { force: true }); return null; }
  const finalDest = dest.replace(/\.tmp$/, `.${ext}`);
  fs.renameSync(dest, finalDest);
  return finalDest;
}

/**
 * One-time pairing-code message. The code is a VISUAL-MATCH token: the sender
 * reports it to the admin, who matches it against the UI before adding them to
 * the allowlist. The sender does NOT reply with it — say so explicitly so they
 * don't paste it back expecting an automated unlock. Bilingual TH/EN.
 */
function pairingMessage(code: string, kind: 'user' | 'group' | 'room' | 'other'): string {
  const inGroup = kind === 'group' || kind === 'room';
  const thWhere = inGroup ? 'ในกลุ่มนี้' : '';
  const enWhere = inGroup ? ' in this group' : '';
  return (
    `รหัสจับคู่ (pairing code) ของคุณคือ: ${code}\n` +
    `กรุณาแจ้งรหัสนี้ให้แอดมินเพื่อขอเปิดใช้งานบอท${thWhere} (ไม่ต้องพิมพ์รหัสตอบกลับ)\n\n` +
    `Your pairing code: ${code}\n` +
    `Share this code with the admin to get access${enWhere}. (No need to reply with it.)`
  );
}

export type NormalizedLineMessage = {
  content: string;
  meta: Record<string, string>;
};

/**
 * Normalize a LINE webhook event into the gateway's {content, meta} intake shape.
 * Returns null for anything we don't handle in the POC (non-text, non-user source).
 *
 * `resolved` lets the caller pass the source it already resolved for the access
 * gate, so a single event isn't re-parsed; omitted, it resolves here.
 */
export function normalizeLineEvent(
  event: webhook.Event,
  resolved?: ResolvedLineSource,
): NormalizedLineMessage | null {
  if (event.type !== 'message') return null;
  const msg = (event as webhook.MessageEvent).message;
  // Text and image are handled; image bytes are fetched separately in handlePost
  // (via the LINE blob API) and surfaced to the agent through meta.image_path.
  if (!msg || (msg.type !== 'text' && msg.type !== 'image')) return null;
  // Accept 1:1 user, group, and room sources. chat_id is the conversation key
  // (userId / groupId / roomId — the reply/push target); user_id is the human
  // who sent it (may be absent in groups → falls back to the conversation id).
  const { conversationId, senderId, kind } = resolved ?? resolveLineSource(event.source);
  if (kind === 'other' || !conversationId) return null;

  const sender = senderId || conversationId;
  const text = msg.type === 'text' ? ((msg as webhook.TextMessageContent).text ?? '') : '';
  const meta: Record<string, string> = {
    source: 'line',
    chat_id: conversationId,
    user_id: sender,
    user: sender,
    message_id: String(msg.id ?? ''),
    ts: new Date(event.timestamp ?? Date.now()).toISOString(),
    line_chat_type: kind, // 'user' | 'group' | 'room'
  };
  if (msg.type === 'image') meta.media_type = 'image';
  if (typeof (event as webhook.MessageEvent).replyToken === 'string') {
    meta.reply_token = (event as webhook.MessageEvent).replyToken as string;
  }
  return { content: text, meta };
}

export type NormalizedLinePostback = { chatId: string; replyToken: string; data: string };

/**
 * Normalize a LINE postback event (the slow-LLM "Get answer" button tap) into
 * {chatId, replyToken, data}. Returns null for non-postback / non-user / tokenless
 * events. `normalizeLineEvent` still drops postbacks; this is handled separately.
 */
export function normalizeLinePostback(event: webhook.Event): NormalizedLinePostback | null {
  if (event.type !== 'postback') return null;
  const source = event.source;
  if (!source) return null;
  const pe = event as webhook.PostbackEvent;
  const data = pe.postback?.data ?? '';
  const replyToken = typeof pe.replyToken === 'string' ? pe.replyToken : '';
  if (!data || !replyToken) return null;

  let chatId: string;
  if (source.type === 'user') {
    if (!source.userId) return null;
    chatId = source.userId;
  } else if (source.type === 'group') {
    if (!source.groupId) return null;
    chatId = source.groupId;
  } else if (source.type === 'room') {
    if (!source.roomId) return null;
    chatId = source.roomId;
  } else {
    return null;
  }

  return { chatId, replyToken, data };
}

/** Find the agent that has LINE configured (POC: single line-enabled agent, or by id). */
function resolveLineAgent(
  agents: Map<string, AgentRunner>,
  agentId?: string,
): AgentRunner | null {
  if (agentId) {
    const r = agents.get(agentId);
    return r && r.getAgentConfig().line?.channelSecret ? r : null;
  }
  for (const runner of agents.values()) {
    if (runner.getAgentConfig().line?.channelSecret) return runner;
  }
  return null;
}

/**
 * Optional outbound base-URL overrides — only used to point the LINE SDK at a
 * mock server in tests. Production passes nothing, so the SDK uses its real
 * defaults (api.line.me / api-data.line.me). Replaces the former
 * LINE_API_BASE / LINE_DATA_API_BASE env reads so there's no test-only env seam
 * leaking into production code.
 */
export interface LineWebhookOptions {
  apiBase?: string;
  dataApiBase?: string;
}

export function createLineWebhookHandler(
  agents: Map<string, AgentRunner>,
  logDir: string,
  opts: LineWebhookOptions = {},
): WebhookAppHandler {
  const logger = createLogger('line-webhook', logDir);

  // LINE webhook URL verification (Console "Verify" sends a GET / empty POST).
  const handleGet = (_req: Request, res: Response): void => {
    res.status(200).json({ ok: true });
  };

  const handlePost = async (req: Request, res: Response): Promise<void> => {
    const agentId = req.params.agentId as string | undefined;
    const runner = resolveLineAgent(agents, agentId);
    if (!runner) {
      res.status(404).json({ error: 'no LINE-enabled agent' });
      return;
    }
    const cfg = runner.getAgentConfig().line;
    const secret = cfg?.channelSecret ?? '';
    const signature = req.header('x-line-signature') ?? '';
    const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    if (!secret || !signature || !validateSignature(buf, secret, signature)) {
      logger.warn('LINE webhook rejected: bad signature', { agentId: runner.getAgentConfig().id });
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    // Signature verified: derive our own public base URL from this trusted
    // request and persist it for the line_image MCP tool. The Host is reliable;
    // the scheme is hardcoded https (see persistPublicBase).
    const fwdHost = req.headers['x-forwarded-host'];
    const host =
      (typeof fwdHost === 'string' ? fwdHost : Array.isArray(fwdHost) ? fwdHost[0] : '') ||
      req.headers.host ||
      '';
    persistPublicBase(runner.getAgentConfig().workspace, host, logger);

    // Acknowledge immediately; process events after responding.
    res.status(200).json({ ok: true });

    let events: webhook.Event[] = [];
    try {
      events = (JSON.parse(buf.toString('utf8')) as { events?: webhook.Event[] }).events ?? [];
    } catch (err) {
      logger.warn('LINE webhook: bad JSON', { error: (err as Error).message });
      return;
    }

    const token = cfg?.channelAccessToken ?? '';
    const client = token
      ? new messagingApi.MessagingApiClient({
          channelAccessToken: token,
          ...(opts.apiBase ? { baseURL: opts.apiBase } : {}),
        })
      : null;
    // Blob/data API lives on a different host (api-data.line.me) than the
    // messaging API, so it takes its own base override (used by tests).
    const blobClient = token
      ? new messagingApi.MessagingApiBlobClient({
          channelAccessToken: token,
          ...(opts.dataApiBase ? { baseURL: opts.dataApiBase } : {}),
        })
      : null;

    for (const event of events) {
      // Postback BEFORE access gate: a tap on our slow-LLM button must reach the
      // cache even if the user's allowlist status changed since the button was sent.
      // The postback data is opaque (request_id we issued), so bypassing the gate here
      // is safe — only users who received the button can tap it.
      const pb = normalizeLinePostback(event);
      if (pb) {
        try {
          await runner.handleLinePostback(pb.chatId, pb.replyToken, pb.data);
        } catch (err) {
          logger.error('LINE webhook: postback handling failed', {
            error: (err as Error).message,
          });
        }
        continue;
      }

      // Access gate (single choke point — mirrors hermes _dispatch_event):
      // resolve the source once and gate before any message handling.
      // Closed by default for both DMs (dmPolicy/dmAllowlist) and groups/rooms
      // (groupPolicy/groupAllowlist). `'open'` restores answer-to-anyone.
      const resolved = resolveLineSource(event.source);
      if (!isResolvedSourceAllowed(cfg, resolved)) {
        logger.debug('LINE webhook: source not allowed', {
          agentId: runner.getAgentConfig().id,
          kind: resolved.kind,
          policy:
            (resolved.kind === 'user' ? cfg?.dmPolicy : cfg?.groupPolicy) ?? '(closed)',
          conversationId: resolved.conversationId,
        });
        // Remember the knock so an admin can find + add it from the UI without
        // grepping logs, and (pairing mode) reply a one-time code the admin can
        // visually match before +Add. The id we track is the sender (DM) or the
        // conversation (group/room). Names are backfilled best-effort without
        // bumping the knock count.
        const deniedAgentId = runner.getAgentConfig().id;
        const knockId =
          resolved.kind === 'user' ? resolved.senderId : resolved.conversationId;
        if (knockId) {
          // Pairing applies only under allowlist/closed-default (open never
          // denies; disabled is hard-off) and unless explicitly turned off.
          const sourcePolicy = resolved.kind === 'user' ? cfg?.dmPolicy : cfg?.groupPolicy;
          const isPairing =
            cfg?.pairing !== false && sourcePolicy !== 'open' && sourcePolicy !== 'disabled';
          const prev = getPendingSender(deniedAgentId, knockId);
          const code = prev?.code ?? (isPairing ? generatePairingCode() : undefined);

          let wasNew = false;
          if (resolved.kind === 'user') {
            wasNew = recordDeniedSender(deniedAgentId, knockId, undefined, Date.now(), code);
            if (client) {
              void client
                .getProfile(knockId)
                .then((p) => {
                  const e = getPendingSender(deniedAgentId, knockId);
                  if (e && p?.displayName && !e.displayName) e.displayName = p.displayName;
                })
                .catch(() => {});
            }
          } else if (resolved.kind === 'group') {
            wasNew = recordDeniedConversation(deniedAgentId, knockId, 'group', undefined, Date.now(), code);
            if (client) {
              void client
                .getGroupSummary(knockId)
                .then((s) => {
                  const e = getPendingSender(deniedAgentId, knockId);
                  if (e && s?.groupName && !e.displayName) e.displayName = s.groupName;
                })
                .catch(() => {});
            }
          } else if (resolved.kind === 'room') {
            wasNew = recordDeniedConversation(deniedAgentId, knockId, 'room', undefined, Date.now(), code);
          }

          // Send the pairing code exactly once — on first contact only — via the
          // free reply token (never push; don't spend quota on strangers).
          const replyToken = (event as webhook.MessageEvent).replyToken;
          if (isPairing && wasNew && code && client && typeof replyToken === 'string' && replyToken) {
            void client
              .replyMessage({
                replyToken,
                messages: [{ type: 'text', text: pairingMessage(code, resolved.kind) }],
              })
              .catch((err) =>
                logger.debug('LINE pairing code reply failed', { error: (err as Error).message }),
              );
          }
        }
        continue;
      }

      // Normalize the event into our /channel intake format.
      const norm = normalizeLineEvent(event, resolved);
      if (!norm) continue;
      const userId = norm.meta.chat_id;

      // Group/room activation gate: unless requireMention is explicitly false,
      // only respond when the bot is @mentioned (native isSelf or its name).
      // DMs (line_chat_type === 'user') always pass. This runs after normalize
      // so non-message / non-text-image events are already filtered out.
      if (norm.meta.line_chat_type !== 'user' && cfg?.requireMention !== false) {
        const msg = (event as webhook.MessageEvent).message;
        if (!wasBotMentioned(msg as unknown as LineMessageLike)) {
          logger.debug('LINE webhook: group/room message without bot mention, ignoring', {
            agentId: runner.getAgentConfig().id,
            chatType: norm.meta.line_chat_type,
            conversationId: userId,
          });
          continue;
        }
      }

      // Inbound image: fetch the bytes via the blob API and hand the agent an
      // absolute path (meta.image_path). The runner persists it to MediaStore
      // and instructs the agent to Read it, same as Telegram attachments.
      if (norm.meta.media_type === 'image' && blobClient && norm.meta.message_id) {
        try {
          const imgPath = await downloadLineImage(blobClient, norm.meta.message_id);
          if (imgPath) norm.meta.image_path = imgPath;
        } catch (err) {
          logger.warn('LINE webhook: image download failed', {
            messageId: norm.meta.message_id,
            error: (err as Error).message,
          });
        }
      }

      // Loading animation (best-effort, 1:1 only — LINE rejects it for
      // groups/rooms, where chat_id is a groupId/roomId).
      if (client && norm.meta.line_chat_type === 'user') {
        client
          .showLoadingAnimation({ chatId: userId, loadingSeconds: LOADING_SECONDS })
          .catch((err) => logger.debug('showLoadingAnimation failed', { error: (err as Error).message }));
      }

      // Forward to the agent's existing /channel intake (same path Telegram uses).
      try {
        await fetch(`http://127.0.0.1:${runner.getCallbackPort()}/channel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(norm),
        });
      } catch (err) {
        logger.error('LINE webhook: failed to forward to callback', {
          error: (err as Error).message,
        });
      }
    }
  };

  return { verify: handleGet, handlePost };
}
