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
import type { WebhookAppHandler } from './webhooks-router';

// Requests older than this are rejected outright (Slack's own replay-protection
// guidance: reject if the timestamp is more than 5 minutes from "now").
const MAX_REQUEST_AGE_SECONDS = 60 * 5;

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

interface SlackEvent {
  type: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
}

/**
 * Normalize a Slack Events API `event` into the gateway's {content, meta}
 * intake shape. Returns null for anything not handled in v1 (bot-authored
 * events, missing channel/user, non message/app_mention types — see 2c for
 * what's deliberately deferred: files, edits, reactions, etc.).
 */
export function normalizeSlackEvent(
  event: SlackEvent,
  resolved?: ResolvedSlackSource,
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

  return { content: event.text ?? '', meta };
}

/** Verify `X-Slack-Signature` (HMAC-SHA256 of "v0:{timestamp}:{rawBody}") and reject stale requests. */
function verifySlackSignature(
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

export function createSlackWebhookHandler(
  agents: Map<string, AgentRunner>,
  logDir: string,
  opts: SlackWebhookOptions = {},
): WebhookAppHandler {
  const logger = createLogger('slack-webhook', logDir);
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
    const event = payload.event as SlackEvent | undefined;
    if (!event) return;

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

    const norm = normalizeSlackEvent(event, resolved);
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
