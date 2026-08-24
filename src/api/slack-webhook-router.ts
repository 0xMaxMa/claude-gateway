/**
 * Slack inbound webhook handler — HTTP Request URLs mode (bot token +
 * signing secret), not Socket Mode (see the plan's 2b note on that choice).
 *
 * Exposed as a WebhookAppHandler ({ verify, handlePost }) wired into the
 * unified `/webhooks/:app` dispatcher (see webhooks-router.ts) under app
 * "slack" — mirrors `line-webhook-router.ts`'s shape, with the mechanics that
 * genuinely differ from LINE called out inline below (signature scheme, the
 * POST-based url_verification handshake, the 3s ack requirement, and no
 * reply-token TTL to work around).
 *
 * Flow: verify X-Slack-Signature → ack within 3s → for each allowed DM or
 * @mention, forward a normalized {content, meta} to the target agent's
 * existing /channel callback (the same intake Telegram/LINE use).
 */
import { type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentRunner } from '../agent/runner';
import { createLogger } from '../logger';
import {
  isResolvedSourceAllowed,
  resolveSlackSource,
  type ResolvedSlackSource,
  type SlackEventLike,
} from './slack-access';
import {
  recordDeniedSender,
  recordDeniedConversation,
  getPendingSender,
  generatePairingCode,
} from './pending-senders';
import { SlackClient } from './slack-client';
import { MediaStore } from '../history/media-store';
import { sniffImageExt } from '../shared/image-sniff';
import type { WebhookAppHandler } from './webhooks-router';

// Requests older than this are rejected outright (Slack's own replay-protection
// guidance: reject if the timestamp is more than 5 minutes from "now").
const MAX_REQUEST_AGE_SECONDS = 60 * 5;

// Inbound image cap. Sourced from MediaStore, which is where the downloaded
// bytes end up — a router-local literal could drift into accepting an image the
// store then rejects.
const MAX_IMAGE_BYTES = MediaStore.maxUploadBytes;

/**
 * Fetch an inbound Slack image's bytes and write them to a temp file, returning
 * its absolute path. `url_private` is NOT public — it requires the bot token as
 * a bearer, the same auth requirement LINE's blob API has.
 *
 * The runner copies the returned path into the agent's permanent MediaStore and
 * tells the agent to Read it (meta.image_path), exactly as for LINE/Telegram.
 * Returns null on an empty body; throws on HTTP failure or over-cap size — the
 * caller logs and forwards the turn regardless.
 */
async function downloadSlackImage(
  botToken: string,
  fileUrl: string,
  fileId?: string,
): Promise<string | null> {
  // Defence in depth: the signature check upstream already guarantees the event
  // (and thus `url_private`) is authentic Slack data, but never send the bot
  // token anywhere other than Slack's own file host. If a future refactor ever
  // moves the download ahead of verification, or Slack changes the payload
  // shape, this stops the token from leaking to an attacker-chosen host.
  let host: string;
  try {
    host = new URL(fileUrl).hostname;
  } catch {
    throw new Error('invalid file url');
  }
  if (host !== 'slack.com' && !host.endsWith('.slack.com')) {
    throw new Error(`refusing to send bot token to non-Slack host: ${host}`);
  }

  const res = await fetch(fileUrl, { headers: { Authorization: `Bearer ${botToken}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // Cheap early reject on the declared length, then enforce the cap again while
  // reading — a response that omits or lies about content-length must not be
  // able to blow past it.
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte cap`);
  }

  let buf: Buffer;
  if (res.body) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte cap`);
      chunks.push(Buffer.from(chunk));
    }
    buf = Buffer.concat(chunks);
  } else {
    buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte cap`);
  }

  if (buf.length === 0) return null;
  // Include the Slack file id (like LINE's `line-img-${messageId}-…`) so two
  // events landing in the same millisecond on a shared tmpdir can't collide.
  const suffix = fileId ? `${fileId}-${Date.now()}` : `${Date.now()}`;
  const dest = path.join(os.tmpdir(), `slack-img-${suffix}.${sniffImageExt(buf)}`);
  fs.writeFileSync(dest, buf);
  return dest;
}

/**
 * One-time pairing-code message — same visual-match-code contract as LINE's
 * `pairingMessage` (line-webhook-router.ts), reused verbatim ("ใช้ระบบ pair
 * เดิม"): the sender reports the code to the admin, who matches it in the UI
 * before adding them to the allowlist. The sender does NOT reply with it.
 */
function pairingMessage(code: string, kind: 'user' | 'group'): string {
  const inChannel = kind === 'group';
  const thWhere = inChannel ? 'ในช่องนี้' : '';
  const enWhere = inChannel ? ' in this channel' : '';
  return (
    `รหัสจับคู่ (pairing code) ของคุณคือ: ${code}\n` +
    `กรุณาแจ้งรหัสนี้ให้แอดมินเพื่อขอเปิดใช้งานบอท${thWhere} (ไม่ต้องพิมพ์รหัสตอบกลับ)\n\n` +
    `Your pairing code: ${code}\n` +
    `Share this code with the admin to get access${enWhere}. (No need to reply with it.)`
  );
}

export type NormalizedSlackMessage = {
  content: string;
  meta: Record<string, string>;
};

/** A file attached to an inbound event (message with subtype `file_share`, or an app_mention). */
interface SlackEventFile {
  id?: string;
  name?: string;
  mimetype?: string;
  /** Private download URL — needs the bot token as a bearer, not publicly fetchable. */
  url_private?: string;
}

interface SlackEvent {
  type: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  files?: SlackEventFile[];
}

/**
 * Strip a leading/embedded bot self-mention (`<@U…>`) from `app_mention` text.
 * Slack delivers the raw text with the mention markup inline (e.g.
 * `<@U0BOT> hello`), which is noise to the agent. Only the bot's OWN id is
 * removed — mentions of other users are left intact so the agent can still see
 * who else was referenced. No-op when the bot id is unknown.
 */
function stripBotMention(text: string, botUserId: string | undefined): string {
  if (!text || !botUserId) return text;
  // Match `<@U123>` or `<@U123|label>` for exactly this bot id.
  const re = new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g');
  return text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Normalize a Slack Events API `event` into the gateway's {content, meta}
 * intake shape. Returns null for anything not handled in v1 (bot-authored
 * events, missing channel/user, non message/app_mention types — see 2c for
 * what's deliberately deferred: edits, reactions, etc.).
 *
 * Stays synchronous and pure: an attached image's bytes are fetched by the
 * async handler AFTER this returns (see downloadSlackImage's call site), which
 * sets `meta.image_path` on the object built here.
 */
export function normalizeSlackEvent(
  event: SlackEvent,
  resolved?: ResolvedSlackSource,
  botUserId?: string,
): NormalizedSlackMessage | null {
  if (event.type !== 'message' && event.type !== 'app_mention') return null;
  // Bot-loop protection (2c #18) — never respond to our own or another bot's
  // messages. Hard default, not a config toggle.
  if (event.bot_id) return null;

  const r = resolved ?? resolveSlackSource(event as SlackEventLike);
  if (r.kind === 'other' || !r.conversationId) return null;

  const meta: Record<string, string> = {
    source: 'slack',
    chat_id: r.conversationId,
    user_id: r.senderId || r.conversationId,
    user: r.senderId || r.conversationId,
    message_id: event.ts ?? '',
    ts: event.event_ts ?? event.ts ?? '',
    slack_chat_type: r.kind, // 'user' | 'group'
  };
  if (event.thread_ts) meta.thread_ts = event.thread_ts;

  return { content: stripBotMention(event.text ?? '', botUserId), meta };
}

/** Verify `X-Slack-Signature` (HMAC-SHA256 of "v0:{timestamp}:{rawBody}") and reject stale requests. */
export function verifySlackSignature(
  rawBody: Buffer,
  signingSecret: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
): boolean {
  if (!signingSecret || !timestampHeader || !signatureHeader) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > MAX_REQUEST_AGE_SECONDS) return false;

  const base = `v0:${timestampHeader}:${rawBody.toString('utf8')}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Find the agent that has Slack configured (mirrors resolveLineAgent — single-agent-per-secret POC, or by id). */
function resolveSlackAgent(
  agents: Map<string, AgentRunner>,
  agentId?: string,
): AgentRunner | null {
  if (agentId) {
    const r = agents.get(agentId);
    return r && r.getAgentConfig().slack?.signingSecret ? r : null;
  }
  for (const runner of agents.values()) {
    if (runner.getAgentConfig().slack?.signingSecret) return runner;
  }
  return null;
}

export interface SlackWebhookOptions {
  /** Test-only Web API base override (see SlackClient). */
  apiBase?: string;
}

// Slack retries an event (at-least-once delivery) if our 200 ack is slow or
// dropped — event_id is Slack's own dedup key for exactly this case. A bounded
// map is enough here, not a full LRU: entries are pruned by age on each
// insert, and Slack's retry window is short (seconds to a few minutes), so
// this only needs to outlive that window, not forever.
const SLACK_EVENT_ID_TTL_MS = 10 * 60_000;

export function createSlackWebhookHandler(
  agents: Map<string, AgentRunner>,
  logDir: string,
  opts: SlackWebhookOptions = {},
): WebhookAppHandler {
  const logger = createLogger('slack-webhook', logDir);
  const seenEventIds = new Map<string, number>();
  const isDuplicateSlackEvent = (eventId: string): boolean => {
    const now = Date.now();
    for (const [id, ts] of seenEventIds) {
      if (now - ts > SLACK_EVENT_ID_TTL_MS) seenEventIds.delete(id);
    }
    if (seenEventIds.has(eventId)) return true;
    seenEventIds.set(eventId, now);
    return false;
  };
  // Slack's URL-verification handshake arrives as a signed POST, not a GET —
  // unlike LINE's Console "Verify" (an empty GET/POST) — so this handler is
  // effectively unused; kept only because WebhookAppHandler requires it.
  const verify = (_req: Request, res: Response): void => {
    res.status(200).json({ ok: true });
  };

  const handlePost = async (req: Request, res: Response): Promise<void> => {
    const agentId = req.params.agentId as string | undefined;
    const runner = resolveSlackAgent(agents, agentId);
    if (!runner) {
      res.status(404).json({ error: 'no Slack-enabled agent' });
      return;
    }
    const cfg = runner.getAgentConfig().slack;
    const secret = cfg?.signingSecret ?? '';
    const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    if (
      !verifySlackSignature(
        buf,
        secret,
        req.header('x-slack-request-timestamp'),
        req.header('x-slack-signature'),
      )
    ) {
      logger.warn('Slack webhook rejected: bad signature', { agentId: runner.getAgentConfig().id });
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
    } catch (err) {
      logger.warn('Slack webhook: bad JSON', { error: (err as Error).message });
      res.status(400).json({ error: 'bad JSON' });
      return;
    }

    // URL verification handshake (signature already verified above — Slack
    // signs this request type too). Must respond with the raw challenge, not JSON-wrapped.
    if (payload.type === 'url_verification') {
      res.status(200).json({ challenge: payload.challenge });
      return;
    }

    // Ack immediately (Slack retries if we don't respond within ~3s) — process after.
    res.status(200).json({ ok: true });

    if (payload.type !== 'event_callback') return;
    const eventId = typeof payload.event_id === 'string' ? payload.event_id : '';
    if (eventId && isDuplicateSlackEvent(eventId)) {
      logger.debug('Slack webhook: duplicate event_id (Slack retry), skipping', { eventId });
      return;
    }
    const event = payload.event as SlackEvent | undefined;
    if (!event) return;

    // The bot's own Slack user id — carried on every event_callback in
    // `authorizations` — used to strip the bot's self-mention from
    // app_mention text (see normalizeSlackEvent below).
    const authorizations = payload.authorizations as Array<{ user_id?: string }> | undefined;
    const botUserId = authorizations?.[0]?.user_id;

    const deniedAgentId = runner.getAgentConfig().id;
    const resolved = resolveSlackSource(event as SlackEventLike);

    // Bot-loop protection before the access gate too — a bot's own message
    // should never mint a pairing knock either.
    if (event.bot_id) return;

    if (!isResolvedSourceAllowed(cfg, resolved)) {
      logger.debug('Slack webhook: source not allowed', {
        agentId: deniedAgentId,
        kind: resolved.kind,
        policy: (resolved.kind === 'user' ? cfg?.dmPolicy : cfg?.groupPolicy) ?? '(closed)',
        conversationId: resolved.conversationId,
      });
      const knockId = resolved.kind === 'user' ? resolved.senderId : resolved.conversationId;
      if (knockId) {
        const sourcePolicy = resolved.kind === 'user' ? cfg?.dmPolicy : cfg?.groupPolicy;
        const isPairing = cfg?.pairing !== false && sourcePolicy !== 'open' && sourcePolicy !== 'disabled';
        const prev = getPendingSender('slack', deniedAgentId, knockId);
        const code = prev?.code ?? (isPairing ? generatePairingCode() : undefined);
        const client = cfg?.botToken
          ? new SlackClient({ botToken: cfg.botToken, logDir, apiBase: opts.apiBase })
          : null;

        let wasNew = false;
        if (resolved.kind === 'user') {
          wasNew = recordDeniedSender('slack', deniedAgentId, knockId, undefined, Date.now(), code);
          // Best-effort display-name backfill — mirrors LINE's getProfile() call.
          if (client) {
            void client
              .getUserDisplayName(knockId)
              .then((name) => {
                const e = getPendingSender('slack', deniedAgentId, knockId);
                if (e && name && !e.displayName) e.displayName = name;
              })
              .catch(() => {});
          }
        } else if (resolved.kind === 'group') {
          wasNew = recordDeniedConversation('slack', deniedAgentId, knockId, 'group', undefined, Date.now(), code);
          // Best-effort channel-name backfill — mirrors LINE's getGroupSummary() call.
          if (client) {
            void client
              .getChannelName(knockId)
              .then((name) => {
                const e = getPendingSender('slack', deniedAgentId, knockId);
                if (e && name && !e.displayName) e.displayName = name;
              })
              .catch(() => {});
          }
        }

        // Send the pairing code exactly once — on first contact only.
        if (isPairing && wasNew && code && client) {
          const target = resolved.conversationId;
          void client
            .postMessage(target, pairingMessage(code, resolved.kind === 'group' ? 'group' : 'user'))
            .catch((err) => logger.debug('Slack pairing code reply failed', { error: (err as Error).message }));
        }
      }
      return;
    }

    const norm = normalizeSlackEvent(event, resolved, botUserId);
    if (!norm) return;

    // Channel activation gate: unless requireMention is explicitly false,
    // only respond to app_mention events in channels (DMs always pass).
    // event.type === 'app_mention' already IS the "bot was mentioned" signal
    // at the Slack API level — a plain 'message' event in a channel never
    // reaches this handler unless the workspace also subscribes to broader
    // message.* events, so this check is a defensive no-op today but keeps
    // the same explicit posture LINE's requireMention gate has.
    if (
      resolved.kind === 'group' &&
      cfg?.requireMention !== false &&
      event.type !== 'app_mention'
    ) {
      logger.debug('Slack webhook: channel message without bot mention, ignoring', {
        agentId: deniedAgentId,
        conversationId: resolved.conversationId,
      });
      return;
    }

    // Ack-reaction (2c): added here on receipt; removed by the `slack_reply`
    // MCP tool (mcp/tools/slack/module.ts) once the agent's reply actually
    // posts, using the same `chat_id`/`message_id` passed through `norm.meta`
    // below — this file only ever adds it, never removes it.
    const token = cfg?.botToken;
    if (token) {
      const client = new SlackClient({ botToken: token, logDir, apiBase: opts.apiBase });
      if (event.ts) {
        void client.addReaction(resolved.conversationId, event.ts).catch(() => {});
      }
    }

    // Inbound image: fetch the first image attachment's bytes with the bot token
    // and hand the agent an absolute path (meta.image_path) — the same contract
    // LINE uses, so the runner persists it to MediaStore and tells the agent to
    // Read it. Best-effort: a failure only logs, the text turn still forwards.
    // Scope is images only; other file types are left alone for now.
    const imageFile = event.files?.find(
      (f) => typeof f.mimetype === 'string' && f.mimetype.startsWith('image/') && f.url_private,
    );
    if (token && imageFile?.url_private) {
      try {
        const imgPath = await downloadSlackImage(token, imageFile.url_private, imageFile.id);
        if (imgPath) norm.meta.image_path = imgPath;
      } catch (err) {
        logger.warn('Slack webhook: image download failed', {
          fileId: imageFile.id,
          error: (err as Error).message,
        });
      }
    }

    try {
      await fetch(`http://127.0.0.1:${runner.getCallbackPort()}/channel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(norm),
      });
    } catch (err) {
      logger.error('Slack webhook: failed to forward to callback', {
        error: (err as Error).message,
      });
    }
  };

  return { verify, handlePost };
}
