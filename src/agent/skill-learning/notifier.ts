/**
 * Skill notifier — tells the operator when the closed loop writes a skill.
 *
 * Two independent surfaces (per user request, 2026-08-17):
 *   1. **Diary** (`SKILLS_LEARNED.md` in the workspace) — ALWAYS appended, an
 *      immutable audit log of every auto-write. Cheap, offline, never throttled.
 *   2. **Channel push** (Telegram) — a short "learned a skill" ping, gated by
 *      `cfg.notify`. Throttled: up to NOTIFY_THROTTLE_MAX immediate pings per
 *      rolling window, then further writes coalesce into one digest so a burst
 *      cannot spam the chat.
 *
 * Everything here is best-effort and MUST NOT throw into the review path.
 * The channel transport (`send`) is injected — the manager builds the real
 * Telegram sender; tests pass a capturing stub. Diary + throttle logic are
 * transport-agnostic and fully unit-testable with an injected clock.
 */

import * as fs from 'fs';
import * as path from 'path';

export const DIARY_FILENAME = 'SKILLS_LEARNED.md';

/** Rolling window for the burst throttle. */
export const NOTIFY_THROTTLE_WINDOW_MS = 10 * 60_000; // 10 minutes
/** Immediate pings allowed per window before writes coalesce into a digest. */
export const NOTIFY_THROTTLE_MAX = 3;

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** A channel transport: deliver one plain-text message. Never expected to throw. */
export type SendFn = (text: string) => void | Promise<void>;

export interface SkillWriteEvent {
  name: string;
  action: 'create' | 'edit';
  sessionId: string;
  /** Timestamp (ms) — injected clock so tests are deterministic. */
  now: number;
}

export interface SkillNotifierOpts {
  workspaceDir: string;
  /** Channel push on/off. The diary is written regardless. */
  notify: boolean;
  /** Channel transport. `undefined` ⇒ no channel wired (diary-only). */
  send?: SendFn;
  logger?: { info: (msg: string) => void; warn?: (msg: string) => void };
}

/**
 * Read the Telegram allowlist for a workspace — the chat_ids authorized to talk
 * to this agent, which are exactly the right recipients for its notifications
 * (Telegram DM chat_id == user_id). Best-effort: any error ⇒ no recipients.
 */
export function readTelegramRecipients(workspaceDir: string): string[] {
  try {
    const accessPath = path.join(workspaceDir, '.telegram-state', 'access.json');
    const raw = fs.readFileSync(accessPath, 'utf-8');
    const parsed = JSON.parse(raw) as { allowFrom?: unknown };
    if (!Array.isArray(parsed.allowFrom)) return [];
    return parsed.allowFrom.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

/** POST a Telegram sendMessage. Best-effort; resolves even on HTTP failure. */
export async function pushTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
}

/**
 * Build the channel `send` transport for an agent from its Telegram bot token.
 * Returns `undefined` when no token is configured (diary-only). The returned fn
 * resolves recipients fresh on each call (allowlist may change at runtime) and
 * fans out best-effort — one failed recipient never blocks the others.
 */
export function buildTelegramSend(
  workspaceDir: string,
  botToken: string | undefined,
  logger?: SkillNotifierOpts['logger'],
): SendFn | undefined {
  if (!botToken) return undefined;
  return async (text: string) => {
    const recipients = readTelegramRecipients(workspaceDir);
    for (const chatId of recipients) {
      try {
        await pushTelegram(botToken, chatId, text);
      } catch (err) {
        logger?.warn?.(`[skill-learning] telegram notify failed for ${chatId}: ${(err as Error).message}`);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Multi-channel transport registry
// ---------------------------------------------------------------------------
//
// The notifier is channel-agnostic: it calls one `send(text)` that fans out to
// every channel the agent has configured. Each channel is a small factory that
// returns a `SendFn` (or `undefined` when the agent has no token for it). To add
// a channel, implement its `build<Channel>Send` and register it in
// TRANSPORT_REGISTRY — nothing else (SkillNotifier, the manager) changes.
//
// Recipient resolution is a per-channel concern: Telegram/Discord/Line each read
// their own `.<channel>-state/access.json` `allowFrom` allowlist (the owners
// authorized to talk to the agent — exactly who should get its notifications).

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_MAX_MESSAGE_LENGTH = 2000;
const LINE_API_BASE = 'https://api.line.me';
const LINE_MAX_MESSAGE_LENGTH = 5000; // LINE hard-limits a text message to 5000 chars.
const PUSH_TIMEOUT_MS = 10_000;

/** Per-agent channel credentials available at gateway boot (from AgentConfig). */
export interface ChannelTokens {
  telegramBotToken?: string;
  discordBotToken?: string;
  /** LINE channel access token. Present ⇒ the LINE transport self-activates. */
  lineAccessToken?: string;
}

/**
 * Read an `allowFrom` string[] from `<workspace>/<stateDir>/access.json`.
 * Shared shape across Telegram/Discord/LINE. Best-effort: any error ⇒ [].
 */
function readAllowFrom(workspaceDir: string, stateDir: string): string[] {
  try {
    const accessPath = path.join(workspaceDir, stateDir, 'access.json');
    const parsed = JSON.parse(fs.readFileSync(accessPath, 'utf-8')) as { allowFrom?: unknown };
    if (!Array.isArray(parsed.allowFrom)) return [];
    return parsed.allowFrom.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

/** Split text into chunks no longer than `limit`, preferring paragraph/line/space breaks. */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return text.length === 0 ? [] : [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit);
    const nl = rest.lastIndexOf('\n', limit);
    const sp = rest.lastIndexOf(' ', limit);
    const cut = para > limit / 2 ? para : nl > limit / 2 ? nl : sp > 0 ? sp : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ---- Discord ---------------------------------------------------------------

/** Discord recipients: user_ids from `.discord-state/access.json` `allowFrom`. */
export function readDiscordRecipients(workspaceDir: string): string[] {
  return readAllowFrom(workspaceDir, '.discord-state');
}

/**
 * Open (or fetch the existing) DM channel with a user and return its channel id.
 * Discord push targets a channel, not a user — a proactive DM needs this hop
 * first (unlike Telegram where chat_id == user_id). Returns undefined on failure.
 */
async function openDiscordDmChannel(botToken: string, userId: string): Promise<string | undefined> {
  const resp = await fetch(`${DISCORD_API_BASE}/users/@me/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
    body: JSON.stringify({ recipient_id: userId }),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  if (!resp.ok) return undefined;
  const ch = (await resp.json()) as { id?: unknown };
  return typeof ch.id === 'string' ? ch.id : undefined;
}

/** DM a Discord user (open DM channel, then post chunked). Best-effort. */
export async function pushDiscordDM(botToken: string, userId: string, text: string): Promise<void> {
  const channelId = await openDiscordDmChannel(botToken, userId);
  if (!channelId) return;
  for (const content of chunkText(text, DISCORD_MAX_MESSAGE_LENGTH)) {
    const resp = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!resp.ok) return; // stop the burst for this recipient on the first failure
  }
}

/** Build the Discord `send` transport. undefined when no bot token is configured. */
export function buildDiscordSend(
  workspaceDir: string,
  botToken: string | undefined,
  logger?: SkillNotifierOpts['logger'],
): SendFn | undefined {
  if (!botToken) return undefined;
  return async (text: string) => {
    for (const userId of readDiscordRecipients(workspaceDir)) {
      try {
        await pushDiscordDM(botToken, userId, text);
      } catch (err) {
        logger?.warn?.(`[skill-learning] discord notify failed for ${userId}: ${(err as Error).message}`);
      }
    }
  };
}

// ---- LINE ------------------------------------------------------------------

/** LINE recipients: user_ids from `.line-state/access.json` `allowFrom`. */
export function readLineRecipients(workspaceDir: string): string[] {
  return readAllowFrom(workspaceDir, '.line-state');
}

/** Push a LINE text message to a user. Best-effort; resolves even on HTTP failure. */
export async function pushLine(accessToken: string, to: string, text: string): Promise<void> {
  await fetch(`${LINE_API_BASE}/v2/bot/message/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, LINE_MAX_MESSAGE_LENGTH) }] }),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
}

/**
 * Build the LINE `send` transport. undefined when no channel access token is
 * configured — so LINE stays dormant until an agent has LINE set up, at which
 * point it self-activates with no code change ("just open it": the token flows
 * in from AgentConfig.line.channelAccessToken at boot).
 */
export function buildLineSend(
  workspaceDir: string,
  accessToken: string | undefined,
  logger?: SkillNotifierOpts['logger'],
): SendFn | undefined {
  if (!accessToken) return undefined;
  return async (text: string) => {
    for (const to of readLineRecipients(workspaceDir)) {
      try {
        await pushLine(accessToken, to, text);
      } catch (err) {
        logger?.warn?.(`[skill-learning] line notify failed for ${to}: ${(err as Error).message}`);
      }
    }
  };
}

// ---- Registry --------------------------------------------------------------

/** A channel transport factory: returns a SendFn, or undefined if not configured. */
type TransportBuilder = (
  workspaceDir: string,
  tokens: ChannelTokens,
  logger?: SkillNotifierOpts['logger'],
) => SendFn | undefined;

/**
 * Registered channel transports. Add a channel by appending one entry — the
 * notifier and manager need no changes.
 *
 * NOT registered: the web/`api` channel is request/response only and has no
 * proactive push transport (no SSE/WS/queue for agent-initiated messages).
 * Wiring it needs new delivery infrastructure — tracked as a separate issue.
 */
const TRANSPORT_REGISTRY: TransportBuilder[] = [
  (ws, t, log) => buildTelegramSend(ws, t.telegramBotToken, log),
  (ws, t, log) => buildDiscordSend(ws, t.discordBotToken, log),
  (ws, t, log) => buildLineSend(ws, t.lineAccessToken, log),
];

/**
 * Build a single fan-out `send` across every configured channel transport.
 * Returns undefined when the agent has no push channel wired (diary-only).
 * Fan-out is best-effort and concurrent — one channel failing never blocks the
 * others, and no rejection escapes into the review path.
 */
export function buildChannelSend(
  workspaceDir: string,
  tokens: ChannelTokens,
  logger?: SkillNotifierOpts['logger'],
): SendFn | undefined {
  const sends = TRANSPORT_REGISTRY.map((build) => build(workspaceDir, tokens, logger)).filter(
    (s): s is SendFn => Boolean(s),
  );
  if (sends.length === 0) return undefined;
  return async (text: string) => {
    await Promise.all(
      sends.map(async (send) => {
        try {
          await send(text);
        } catch (err) {
          logger?.warn?.(`[skill-learning] channel notify failed: ${(err as Error).message}`);
        }
      }),
    );
  };
}

export class SkillNotifier {
  private readonly workspaceDir: string;
  private readonly notify: boolean;
  private readonly send?: SendFn;
  private readonly logger?: SkillNotifierOpts['logger'];

  /** Timestamps of immediate pings still inside the current window. */
  private recent: number[] = [];
  /** Coalesced writes awaiting a digest flush. */
  private buffer: string[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: SkillNotifierOpts) {
    this.workspaceDir = opts.workspaceDir;
    this.notify = opts.notify;
    this.send = opts.send;
    this.logger = opts.logger;
  }

  /**
   * Record a live skill write. Appends the diary (always) and, if channel push
   * is on, either pings immediately or buffers for a digest. Never throws.
   */
  onSkillWritten(ev: SkillWriteEvent): void {
    this.appendDiary(ev);
    if (!this.notify || !this.send) return;
    try {
      this.pushThrottled(ev);
    } catch (err) {
      this.logger?.warn?.(`[skill-learning] notify failed: ${(err as Error).message}`);
    }
  }

  /** Emit any buffered digest now (shutdown / test seam / timer callback). */
  flushPending(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const n = this.buffer.length;
    if (n > 0 && this.send) {
      const list = this.buffer.join(', ');
      this.buffer = [];
      void this.safeSend(`🧠 ${n} more skill${n === 1 ? '' : 's'} learned (auto): ${list}`);
    }
    this.recent = [];
  }

  // ---- internals -------------------------------------------------------------

  private pushThrottled(ev: SkillWriteEvent): void {
    const now = ev.now;
    // Roll the window forward.
    this.recent = this.recent.filter((t) => now - t < NOTIFY_THROTTLE_WINDOW_MS);
    const verb = ev.action === 'create' ? 'created' : 'updated';
    if (this.recent.length < NOTIFY_THROTTLE_MAX) {
      this.recent.push(now);
      void this.safeSend(`🧠 Skill ${verb} (auto): ${ev.name} · session ${shortId(ev.sessionId)} · /skill-metrics`);
    } else {
      // Over the burst limit — coalesce into a digest.
      this.buffer.push(`${verb} ${ev.name}`);
      this.armFlush(now);
    }
  }

  private armFlush(now: number): void {
    if (this.flushTimer) return;
    const oldest = this.recent[0] ?? now;
    const delay = Math.max(0, NOTIFY_THROTTLE_WINDOW_MS - (now - oldest));
    this.flushTimer = setTimeout(() => this.flushPending(), delay);
    if (typeof (this.flushTimer as NodeJS.Timeout).unref === 'function') {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  private async safeSend(text: string): Promise<void> {
    if (!this.send) return;
    try {
      await this.send(text);
    } catch (err) {
      this.logger?.warn?.(`[skill-learning] notify send failed: ${(err as Error).message}`);
    }
  }

  private appendDiary(ev: SkillWriteEvent): void {
    try {
      const file = path.join(this.workspaceDir, DIARY_FILENAME);
      const iso = new Date(ev.now).toISOString();
      let prefix = '';
      if (!fs.existsSync(file)) {
        prefix =
          '# Skills Learned (auto)\n\n' +
          'Audit log of skills the self-improvement loop wrote automatically. ' +
          'One line per write; newest at the bottom.\n\n';
      }
      const line = `- ${iso} — **${ev.action}** \`${ev.name}\` (session ${shortId(ev.sessionId)})\n`;
      fs.appendFileSync(file, prefix + line, 'utf-8');
    } catch (err) {
      this.logger?.warn?.(`[skill-learning] diary append failed: ${(err as Error).message}`);
    }
  }
}

function shortId(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}
