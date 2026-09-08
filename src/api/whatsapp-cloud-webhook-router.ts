/**
 * WhatsApp Business Cloud API inbound webhook handler.
 *
 * Structural port of `slack-webhook-router.ts`'s overall shape (verify
 * handler + handlePost + normalize + forward-to-callback) — Slack is the
 * right template here (both are webhook-based channels with real,
 * Meta/Slack-issued credentials), not the Baileys `whatsapp-webhook`-less
 * device-link bridge. The mechanics that genuinely differ from Slack are
 * called out inline below:
 *
 *  - The verify handshake is a signed GET (`hub.mode`/`hub.verify_token`/
 *    `hub.challenge`), the OPPOSITE of Slack's signed-POST url_verification.
 *  - Signature scheme has no timestamp component (HMAC-SHA256 of the raw
 *    body only) — Meta's replay defence is at the transport/token level, not
 *    a timestamp window like Slack's.
 *  - Inbound messages arrive as an ARRAY per webhook call
 *    (`entry[].changes[].value.messages[]`) — Cloud API can batch several
 *    messages in one POST, unlike Slack's one-event-per-request.
 *  - `value.statuses[]` (our own outbound delivery receipts) must never be
 *    normalized as inbound messages — they're skipped outright.
 *  - No group concept at all (see `whatsapp-cloud-access.ts`'s doc comment)
 *    — every inbound sender is a DM.
 *
 * Exposed as a WebhookAppHandler ({ verify, handlePost }) wired into the
 * unified `/webhooks/:app` dispatcher (see webhooks-router.ts) under app
 * "whatsapp_cloud".
 */
import { type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentRunner } from '../agent/runner';
import { createLogger } from '../logger';
import {
  isResolvedWhatsAppCloudSourceAllowed,
  resolveWhatsAppCloudSource,
  type ResolvedWhatsAppCloudSource,
} from './whatsapp-cloud-access';
import {
  recordDeniedSender,
  getPendingSender,
  generatePairingCode,
} from './pending-senders';
import { WhatsAppCloudClient } from './whatsapp-cloud-client';
import { MediaStore } from '../history/media-store';
import { sniffImageExt, sanitizeFilenameId } from '../shared/image-sniff';
import type { WebhookAppHandler } from './webhooks-router';

const WHATSAPP_CLOUD_API_BASE = 'https://graph.facebook.com/v20.0';

// Inbound media cap. Sourced from MediaStore (where the downloaded bytes end
// up) for both images and documents — a router-local literal could drift
// from what the store then rejects.
const MAX_MEDIA_BYTES = MediaStore.maxUploadBytes;

// Meta retries a webhook delivery if our ack is slow/dropped — message.id is
// the dedup key. A bounded, age-pruned map is enough (mirrors Slack's
// seenEventIds): it only needs to outlive Meta's short retry window, not forever.
const WHATSAPP_CLOUD_MESSAGE_ID_TTL_MS = 10 * 60_000;

// The returned media download `url` must resolve to a Meta-owned host before
// the bearer token is ever attached to the second GET — see
// downloadWhatsAppCloudMedia's doc comment (mirrors downloadSlackImage's
// host-check-before-sending-token defense).
const MEDIA_HOST_ALLOWLIST: RegExp[] = [/\.fbcdn\.net$/, /^graph\.facebook\.com$/, /^lookaside\.fbsbx\.com$/];

export type NormalizedWhatsAppCloudMessage = {
  content: string;
  meta: Record<string, string>;
};

interface WhatsAppCloudContact {
  profile?: { name?: string };
  wa_id?: string;
}

interface WhatsAppCloudMediaObject {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

/**
 * Meta's structured contact payload. NOT a vCard — unlike Baileys (which
 * hands over the raw vCard string the sender's phone produced), the Cloud API
 * decomposes it into JSON, so a vCard has to be synthesized from these fields
 * if the agent is to see one (see `synthesizeVCard`).
 */
interface WhatsAppCloudContactCard {
  name?: { formatted_name?: string };
  phones?: Array<{ phone?: string }>;
}

export interface WhatsAppCloudMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: WhatsAppCloudMediaObject;
  document?: WhatsAppCloudMediaObject;
  /**
   * Present when the user replied to a specific earlier message; `id` is that
   * message's id. Meta does NOT inline the quoted message's text or sender
   * here — see normalizeWhatsAppCloudMessage's reply-context branch.
   */
  context?: { id?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  contacts?: WhatsAppCloudContactCard[];
  /** Stickers are `image/webp` media, downloaded through the same path as images. */
  sticker?: WhatsAppCloudMediaObject;
  /**
   * A tap on a reply button / a pick from a list message that WE sent (Phase 3
   * — see WhatsAppCloudClient.sendInteractiveButtons/sendInteractiveList).
   * Exactly one of `button_reply`/`list_reply` is present, matching the
   * interactive type that was sent.
   */
  interactive?: {
    type?: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  [key: string]: unknown;
}

export interface WhatsAppCloudValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string };
  contacts?: WhatsAppCloudContact[];
  messages?: WhatsAppCloudMessage[];
  statuses?: unknown[];
}

interface WhatsAppCloudChange {
  field?: string;
  value?: WhatsAppCloudValue;
}

interface WhatsAppCloudEntry {
  id?: string;
  changes?: WhatsAppCloudChange[];
}

interface WhatsAppCloudPayload {
  object?: string;
  entry?: WhatsAppCloudEntry[];
}

/**
 * Extract the inbound message list from a webhook `value` object — returns
 * [] for a status-only batch (our own outbound delivery receipts) or any
 * payload shape without a `messages` array at all, so callers never try to
 * normalize a status update as an inbound message.
 */
export function extractInboundMessages(value: WhatsAppCloudValue | undefined): WhatsAppCloudMessage[] {
  return value?.messages ?? [];
}

/**
 * Build a minimal vCard from Meta's structured contact payload.
 *
 * The Cloud API does NOT hand over a vCard string (Baileys does — see
 * manager.ts's contactMessage branch, which uses `contactMessage.vcard`
 * verbatim), it hands over decomposed JSON. Synthesizing a 3.0 vCard here
 * means BOTH WhatsApp channels put the same kind of value in the same
 * `meta.vcard` key, so the agent never needs channel-specific handling.
 * Returns undefined when there is neither a name nor a phone to put in it.
 */
export function synthesizeVCard(contact: WhatsAppCloudContactCard | undefined): string | undefined {
  const name = contact?.name?.formatted_name?.trim();
  const phone = contact?.phones?.find((p) => p.phone)?.phone?.trim();
  if (!name && !phone) return undefined;
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  if (name) lines.push(`FN:${name}`);
  if (phone) lines.push(`TEL:${phone}`);
  lines.push('END:VCARD');
  return lines.join('\n');
}

/**
 * Normalize an inbound Cloud API message into the gateway's {content, meta}
 * intake shape. Returns null when `from` is missing/empty (no reply target).
 * `content` is the text body for `type: 'text'`, the caption (possibly
 * empty) for `type: 'image'`/`'document'`, or a short human summary for
 * `type: 'location'`, or the selected option's title for `type: 'interactive'`
 * (a button tap / list pick) — remaining types (audio, video, ...) are still
 * out of scope and forward with empty content rather than being dropped, same
 * posture as Slack's "no text → empty content, not null".
 *
 * Stays synchronous and pure: an attached image/document/sticker's bytes are
 * fetched by the async handler AFTER this returns, which sets
 * `meta.image_path`/`meta.document_path`/`meta.sticker_path` on the object
 * built here.
 */
export function normalizeWhatsAppCloudMessage(
  msg: WhatsAppCloudMessage,
  resolved?: ResolvedWhatsAppCloudSource,
): NormalizedWhatsAppCloudMessage | null {
  const r = resolved ?? resolveWhatsAppCloudSource(msg.from);
  if (r.kind === 'other' || !r.conversationId) return null;

  const meta: Record<string, string> = {
    source: 'whatsapp_cloud',
    chat_id: r.conversationId,
    user_id: r.senderId,
    user: r.senderId,
    message_id: msg.id ?? '',
  };

  // Reply context. Meta's webhook carries ONLY the quoted message's id — the
  // quoted text and its sender are NOT inlined (a real Cloud API limitation,
  // not a gap here; retrieving them would need our own store of previously
  // seen messages). So `replied_user`/`replied_text` are deliberately left
  // unset for this channel, and buildChannelXml emits `<replied
  // message_id=… user="">` with an empty body. Baileys, by contrast, does
  // inline the quote and populates all three.
  if (msg.context?.id) meta.replied_message_id = msg.context.id;

  let content = '';
  if (msg.type === 'text') content = msg.text?.body ?? '';
  else if (msg.type === 'image') content = msg.image?.caption ?? '';
  else if (msg.type === 'document') content = msg.document?.caption ?? '';
  else if (msg.type === 'location' && msg.location) {
    const { latitude, longitude, name, address } = msg.location;
    if (typeof latitude === 'number') meta.location_lat = String(latitude);
    if (typeof longitude === 'number') meta.location_lng = String(longitude);
    // A pinned place carries a name/address; a raw dropped pin carries only
    // coordinates, which already ride along in meta — hence the generic
    // fallback rather than repeating the numbers in the text.
    content = [name, address].filter(Boolean).join(', ') || '[Location shared]';
  } else if (msg.type === 'contacts') {
    const vcard = synthesizeVCard(msg.contacts?.[0]);
    if (vcard) meta.vcard = vcard;
  } else if (msg.type === 'interactive') {
    // A button tap / list pick (Phase 3). `content` becomes the DISPLAY TITLE
    // of whatever the user selected, so the turn reads to the agent exactly as
    // if they had typed that label — no interactive-aware agent-side handling
    // is needed for the common case. The machine-readable `id` rides along in
    // meta.interactive_id for agents whose logic branches on the id instead
    // (ids are stable; titles are what the user reads and may be localized).
    const selected = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
    if (selected) {
      content = selected.title ?? '';
      if (selected.id) meta.interactive_id = selected.id;
    }
  }

  return { content, meta };
}

/** Verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body — no timestamp component). */
export function verifyMetaSignature(
  rawBody: Buffer,
  appSecret: string,
  sigHeader: string | undefined,
): boolean {
  if (!appSecret || !sigHeader) return false;
  const prefix = 'sha256=';
  if (!sigHeader.startsWith(prefix)) return false;
  const expected = `${prefix}${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(sigHeader, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Constant-time string equality — same posture as verifyMetaSignature above. */
function safeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Find the agent that has WhatsApp Cloud configured (mirrors resolveSlackAgent). */
function resolveWhatsAppCloudAgent(
  agents: Map<string, AgentRunner>,
  agentId?: string,
): AgentRunner | null {
  if (agentId) {
    const r = agents.get(agentId);
    return r && r.getAgentConfig().whatsapp_cloud?.appSecret ? r : null;
  }
  for (const runner of agents.values()) {
    if (runner.getAgentConfig().whatsapp_cloud?.appSecret) return runner;
  }
  return null;
}

/**
 * One-time pairing-code message — same visual-match-code contract as
 * Slack/LINE's pairingMessage. DM-only (no "in this channel/group" phrasing
 * needed — there is no group tier on this channel).
 */
function pairingMessage(code: string): string {
  return (
    `รหัสจับคู่ (pairing code) ของคุณคือ: ${code}\n` +
    `กรุณาแจ้งรหัสนี้ให้แอดมินเพื่อขอเปิดใช้งานบอท (ไม่ต้องพิมพ์รหัสตอบกลับ)\n\n` +
    `Your pairing code: ${code}\n` +
    `Share this code with the admin to get access. (No need to reply with it.)`
  );
}

/**
 * Fetch an inbound media attachment's bytes and return them + the reported
 * mime type. Two-step, per the Cloud API's media contract:
 *   1. `GET /{media-id}?access_token=...` → `{url, mime_type}` — the
 *      returned `url` is short-lived and NOT itself bearer-protected the way
 *      `url_private` is on Slack, but IS host-restricted to Meta's own CDN.
 *   2. `GET <url>` with the SAME bearer token.
 *
 * Step 2's host is validated against MEDIA_HOST_ALLOWLIST BEFORE the token is
 * attached — defense in depth against a future payload-shape change or bug
 * upstream of this call handing us an attacker-chosen `url` (mirrors
 * downloadSlackImage's identical host-check-before-sending-token structure).
 * Enforces MAX_MEDIA_BYTES against both the declared content-length and the
 * actual streamed byte count. Returns null when the metadata step yields no
 * `url`; throws on HTTP failure, an untrusted host, or an over-cap size — the
 * caller logs and forwards the turn regardless.
 */
async function downloadWhatsAppCloudMedia(
  accessToken: string,
  mediaId: string,
  apiBase: string,
): Promise<{ buf: Buffer; mimeType: string } | null> {
  const metaRes = await fetch(`${apiBase}/${mediaId}?access_token=${encodeURIComponent(accessToken)}`);
  if (!metaRes.ok) throw new Error(`HTTP ${metaRes.status} fetching media metadata`);
  const metaJson = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!metaJson.url) return null;

  let host: string;
  try {
    host = new URL(metaJson.url).hostname;
  } catch {
    throw new Error('invalid media url');
  }
  if (!MEDIA_HOST_ALLOWLIST.some((re) => re.test(host))) {
    throw new Error(`refusing to send bearer token to untrusted media host: ${host}`);
  }

  const res = await fetch(metaJson.url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading media`);

  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
    throw new Error(`media exceeds ${MAX_MEDIA_BYTES} byte cap`);
  }

  let buf: Buffer;
  if (res.body) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_MEDIA_BYTES) throw new Error(`media exceeds ${MAX_MEDIA_BYTES} byte cap`);
      chunks.push(Buffer.from(chunk));
    }
    buf = Buffer.concat(chunks);
  } else {
    buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_MEDIA_BYTES) throw new Error(`media exceeds ${MAX_MEDIA_BYTES} byte cap`);
  }

  return { buf, mimeType: metaJson.mime_type ?? 'application/octet-stream' };
}

function writeTempImage(buf: Buffer, messageId?: string): string {
  // messageId is Meta-webhook-supplied and not guaranteed to match wamid.*'s
  // format — sanitize before it reaches a filename (see sanitizeFilenameId).
  const suffix = `${sanitizeFilenameId(messageId)}-${Date.now()}`;
  const dest = path.join(os.tmpdir(), `whatsapp-cloud-img-${suffix}.${sniffImageExt(buf)}`);
  fs.writeFileSync(dest, buf, { mode: 0o600 });
  return dest;
}

function writeTempDocument(buf: Buffer, mimeType: string, filename: string | undefined, messageId?: string): string {
  const suffix = `${sanitizeFilenameId(messageId)}-${Date.now()}`;
  const extFromName = filename ? path.extname(filename) : '';
  const ext = extFromName || (mimeType === 'application/pdf' ? '.pdf' : '');
  const dest = path.join(os.tmpdir(), `whatsapp-cloud-doc-${suffix}${ext}`);
  fs.writeFileSync(dest, buf, { mode: 0o600 });
  return dest;
}

export interface WhatsAppCloudWebhookOptions {
  /** Test-only Graph API base override (see WhatsAppCloudClient / media metadata fetch). */
  apiBase?: string;
}

export function createWhatsAppCloudWebhookHandler(
  agents: Map<string, AgentRunner>,
  logDir: string,
  opts: WhatsAppCloudWebhookOptions = {},
): WebhookAppHandler {
  const logger = createLogger('whatsapp-cloud-webhook', logDir);
  const apiBase = opts.apiBase ?? WHATSAPP_CLOUD_API_BASE;
  const seenMessageIds = new Map<string, number>();
  const isDuplicateMessage = (id: string): boolean => {
    const now = Date.now();
    for (const [mid, ts] of seenMessageIds) {
      if (now - ts > WHATSAPP_CLOUD_MESSAGE_ID_TTL_MS) seenMessageIds.delete(mid);
    }
    if (seenMessageIds.has(id)) return true;
    seenMessageIds.set(id, now);
    return false;
  };

  // GET handshake (opposite of Slack's signed-POST url_verification): Meta
  // calls this once when the webhook subscription is configured, comparing
  // our echoed `hub.challenge` against what it sent. Must respond with the
  // RAW challenge string, not JSON-wrapped, on match.
  const verify = (req: Request, res: Response): void => {
    const agentId = req.params.agentId as string | undefined;
    const runner = resolveWhatsAppCloudAgent(agents, agentId);
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expected = runner?.getAgentConfig().whatsapp_cloud?.verifyToken;
    if (mode === 'subscribe' && expected && typeof token === 'string' && safeStringEqual(token, expected)) {
      res.status(200).type('text/plain').send(String(challenge ?? ''));
      return;
    }
    logger.warn('WhatsApp Cloud webhook: verify handshake failed', { agentId, mode });
    res.status(403).json({ error: 'verification failed' });
  };

  const handlePost = async (req: Request, res: Response): Promise<void> => {
    const agentId = req.params.agentId as string | undefined;
    const runner = resolveWhatsAppCloudAgent(agents, agentId);
    if (!runner) {
      res.status(404).json({ error: 'no WhatsApp Cloud-enabled agent' });
      return;
    }
    const cfg = runner.getAgentConfig().whatsapp_cloud;
    const secret = cfg?.appSecret ?? '';
    const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    if (!verifyMetaSignature(buf, secret, req.header('x-hub-signature-256'))) {
      logger.warn('WhatsApp Cloud webhook rejected: bad signature', { agentId: runner.getAgentConfig().id });
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    let payload: WhatsAppCloudPayload;
    try {
      payload = JSON.parse(buf.toString('utf8')) as WhatsAppCloudPayload;
    } catch (err) {
      logger.warn('WhatsApp Cloud webhook: bad JSON', { error: (err as Error).message });
      res.status(400).json({ error: 'bad JSON' });
      return;
    }

    // Ack immediately (Meta retries if our ack is slow/dropped) — process after.
    res.status(200).json({ ok: true });

    const deniedAgentId = runner.getAgentConfig().id;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const messages = extractInboundMessages(value);
        if (messages.length === 0) continue; // status-only batch, or no messages field at all

        // contacts[] carries profile.name synchronously, keyed by wa_id — used
        // for the pending-knock display name with no extra API call needed
        // (unlike Slack's getUserDisplayName round-trip).
        const nameByWaId = new Map<string, string>();
        for (const c of value?.contacts ?? []) {
          if (c.wa_id && c.profile?.name) nameByWaId.set(c.wa_id, c.profile.name);
        }

        for (const msg of messages) {
          if (msg.id && isDuplicateMessage(msg.id)) {
            logger.debug('WhatsApp Cloud webhook: duplicate message id (Meta retry), skipping', { id: msg.id });
            continue;
          }

          const resolved = resolveWhatsAppCloudSource(msg.from);
          if (resolved.kind === 'other' || !resolved.conversationId) continue;

          if (!isResolvedWhatsAppCloudSourceAllowed(cfg, resolved)) {
            logger.debug('WhatsApp Cloud webhook: source not allowed', {
              agentId: deniedAgentId,
              policy: cfg?.dmPolicy ?? '(closed)',
              conversationId: resolved.conversationId,
            });
            const knockId = resolved.senderId;
            if (knockId) {
              const isPairing = cfg?.pairing !== false && cfg?.dmPolicy !== 'open' && cfg?.dmPolicy !== 'disabled';
              const prev = getPendingSender('whatsapp_cloud', deniedAgentId, knockId);
              const code = prev?.code ?? (isPairing ? generatePairingCode() : undefined);
              const displayName = nameByWaId.get(knockId);
              const wasNew = recordDeniedSender('whatsapp_cloud', deniedAgentId, knockId, displayName, Date.now(), code);

              // Send the pairing code exactly once — on first contact only.
              if (isPairing && wasNew && code && cfg?.accessToken && cfg?.phoneNumberId) {
                const client = new WhatsAppCloudClient({
                  accessToken: cfg.accessToken,
                  phoneNumberId: cfg.phoneNumberId,
                  logDir,
                  apiBase: opts.apiBase,
                });
                void client
                  .sendText(knockId, pairingMessage(code))
                  .catch((err) => logger.debug('WhatsApp Cloud pairing code reply failed', { error: (err as Error).message }));
              }
            }
            continue;
          }

          const norm = normalizeWhatsAppCloudMessage(msg, resolved);
          if (!norm) continue;

          // Receipt signals (Phase 2), both strictly best-effort and both
          // gated on config — mirrors slack-webhook-router.ts's
          // `void client.addReaction(...).catch(() => {})` call site: fired
          // right after the access gate, never awaited, never able to fail
          // the turn. The ack reaction is cleared by the
          // `whatsapp_cloud_reply` MCP tool once the agent's reply lands.
          if (msg.id && cfg?.accessToken && cfg?.phoneNumberId) {
            const receiptClient = new WhatsAppCloudClient({
              accessToken: cfg.accessToken,
              phoneNumberId: cfg.phoneNumberId,
              logDir,
              apiBase: opts.apiBase,
            });
            if (cfg.sendReadReceipts !== false) {
              void receiptClient.markAsRead(msg.id).catch(() => {});
            }
            if ((cfg.reactionLevel ?? 'ack') === 'ack') {
              void receiptClient.sendReaction(resolved.conversationId, msg.id).catch(() => {});
            }
          }

          // Inbound media (image AND document, both eager at receipt time):
          // fetch the bytes with the access token and hand the agent an
          // absolute path. Images use the existing meta.image_path contract;
          // documents use the new meta.document_path key, but ONLY when the
          // mime type passes MediaStore.isAllowedMime() (PDF only in
          // practice today) — an unsupported document type is logged and
          // skipped, but the turn still forwards with whatever caption it has.
          //
          // Stickers (Phase 2) ride the SAME download path — they are
          // `image/webp` media, which MediaStore.isAllowedMime already
          // permits (`image/` prefix) and sniffImageExt already recognizes
          // (RIFF/WEBP magic bytes) — but land on their own
          // meta.sticker_path key, never image_path, so the agent can tell a
          // sticker apart from a photo.
          if (cfg?.accessToken && (msg.type === 'image' || msg.type === 'document' || msg.type === 'sticker')) {
            const mediaObj =
              msg.type === 'image' ? msg.image : msg.type === 'sticker' ? msg.sticker : msg.document;
            if (mediaObj?.id) {
              try {
                const downloaded = await downloadWhatsAppCloudMedia(cfg.accessToken, mediaObj.id, apiBase);
                if (downloaded) {
                  if (msg.type === 'image') {
                    norm.meta.image_path = writeTempImage(downloaded.buf, msg.id);
                  } else if (msg.type === 'sticker') {
                    if (MediaStore.isAllowedMime(downloaded.mimeType)) {
                      norm.meta.sticker_path = writeTempImage(downloaded.buf, msg.id);
                    } else {
                      logger.warn('WhatsApp Cloud webhook: sticker mime type not allowed, skipping download', {
                        mimeType: downloaded.mimeType,
                      });
                    }
                  } else if (MediaStore.isAllowedMime(downloaded.mimeType)) {
                    norm.meta.document_path = writeTempDocument(downloaded.buf, downloaded.mimeType, mediaObj.filename, msg.id);
                  } else {
                    logger.warn('WhatsApp Cloud webhook: document mime type not allowed, skipping download', {
                      mimeType: downloaded.mimeType,
                    });
                  }
                }
              } catch (err) {
                logger.warn('WhatsApp Cloud webhook: media download failed', {
                  mediaId: mediaObj.id,
                  error: (err as Error).message,
                });
              }
            }
          }

          try {
            await fetch(`http://127.0.0.1:${runner.getCallbackPort()}/channel`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(norm),
            });
          } catch (err) {
            logger.error('WhatsApp Cloud webhook: failed to forward to callback', {
              error: (err as Error).message,
            });
          }
        }
      }
    }
  };

  return { verify, handlePost };
}
