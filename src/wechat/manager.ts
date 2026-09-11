/**
 * WeChatManager — one instance per agent, owning that agent's link to a
 * single personal WeChat account through Tencent's iLink Bot API ("WeChat
 * ClawBot" — see src/wechat/ilink-client.ts's doc comment: this is Tencent's
 * own self-serve product, `Tencent/openclaw-weixin` on GitHub, not a
 * third-party grey-market bridge as first assumed during research).
 *
 * Deliberately NOT modeled on a persistent-socket channel (there is no
 * WeChat equivalent of Discord's gateway connection or WhatsApp's Baileys
 * socket in this codebase). iLink delivers messages via long-polling
 * (`getupdates`, 35s timeout, confirmed against Tencent's own protocol doc)
 * — there is also no existing hand-rolled long-poll loop to copy in this
 * codebase; Telegram's polling lives inside the external `claude --channels`
 * CLI, not here. The loop below is the new piece.
 *
 * What IS reused from existing channels:
 *  - The QR/status state machine shape (`status`/`qr`/`loggedOut`) mirrors
 *    every device-linked channel's UX contract, kept intentionally small
 *    since WeChat (unlike WhatsApp/Baileys) has no pairing-code option and
 *    no multi-account support in v1.
 *  - `WECHAT_CHANNEL_DISABLED` is a hard kill switch, enabled by default (like
 *    every other channel here — WhatsApp's own unofficial Baileys bridge has
 *    no equivalent gate; a user linking via QR is already the informed
 *    consent). Opt-OUT rather than opt-IN deliberately: an opt-in flag would
 *    silently break WeChat for every existing deployer on their first update
 *    after this channel ships, since nothing prompts them to set it. The
 *    escape hatch still exists because, even though this is Tencent's own
 *    product, no deployer of this gateway controls it (protocol changes, the
 *    undocumented `need_verifycode`/`verify_code_blocked` states this
 *    integration can't yet act on, etc.) — an admin who hits one of those can
 *    kill the whole channel with one env var and no redeploy of manager logic.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { AgentConfig } from '../types';
import { createLogger } from '../logger';
import {
  ILinkClient,
  ILinkCredentials,
  ILinkUpdate,
  createILinkClient,
} from './ilink-client';

export type WeChatLinkStatus = 'unlinked' | 'pending_scan' | 'linked' | 'reconnecting';

export interface WeChatStatus {
  status: WeChatLinkStatus;
  /** Data URI to render while `status === 'pending_scan'`. */
  qr?: string;
  /** Session was invalidated remotely (WeChat logged this device out). */
  loggedOut: boolean;
}

/** Directory name for this channel's on-disk session file, relative to the agent workspace. */
export const WECHAT_STATE_DIR = '.wechat-state';

/** iLink's documented per-message character limit (Hermes-agent doc). */
export const WECHAT_MAX_MESSAGE_LENGTH = 4000;

/** Delay between outbound chunks, per iLink's documented rate-limit guidance. */
export const WECHAT_CHUNK_DELAY_MS = 300;

/** `getupdates` long-poll timeout, per the iLink contract both source docs describe. */
const POLL_TIMEOUT_SECONDS = 35;

/**
 * getUpdates failure handling — deliberately NOT exponential backoff.
 * Matches Tencent's own official client (`Tencent/openclaw-weixin`'s
 * `src/monitor/monitor.ts`, confirmed live 2026-09-10) exactly: a short flat
 * retry for the first few failures, one fixed pause after
 * `POLL_MAX_CONSECUTIVE_FAILURES` in a row, then reset back to fast retries.
 * An earlier exponential-backoff version of this (1s→2s→4s...capped at 30s,
 * NEVER resetting while failures continued) starved the poll loop of
 * attempts during a real live test: the endpoint returns Cloudflare 522/524
 * on the large majority of idle long-polls (confirmed via direct curl
 * outside this codebase too — it's Tencent/Cloudflare-side flakiness, not a
 * bug here), so how OFTEN we retry directly determines whether a queued
 * message actually gets picked up in a timely way.
 */
const POLL_RETRY_DELAY_MS = 2_000;
const POLL_BACKOFF_DELAY_MS = 30_000;
const POLL_MAX_CONSECUTIVE_FAILURES = 3;

/** How long a QR login attempt stays valid before `startLinking()` must be called again. */
const LINK_ATTEMPT_TIMEOUT_MS = 2 * 60 * 1000;
const LINK_POLL_INTERVAL_MS = 2_000;

/** Recent inbound message ids retained for at-least-once de-dup (iLink has no delivery guarantee stated). */
const RECENT_MESSAGE_CACHE_SIZE = 200;

/** Timing knobs, overridable in tests so the suite doesn't depend on real wall-clock delays. */
export interface WeChatManagerTiming {
  pollTimeoutSeconds: number;
  /** Flat retry delay for the first `pollMaxConsecutiveFailures` getUpdates failures in a row. */
  pollRetryDelayMs: number;
  /** Fixed pause once `pollMaxConsecutiveFailures` failures happen consecutively — then the counter resets. */
  pollBackoffDelayMs: number;
  pollMaxConsecutiveFailures: number;
  linkAttemptTimeoutMs: number;
  linkPollIntervalMs: number;
  /**
   * Minimum pacing between successful `getUpdates` calls. iLink's real
   * `getupdates` blocks for up to `pollTimeoutSeconds` on its own, so this is
   * 0 in production — it exists so a test double that resolves instantly
   * can't spin the loop into a memory-exhausting busy-loop (every call is
   * recorded by the mock framework).
   */
  pollIdleDelayMs: number;
}

const DEFAULT_TIMING: WeChatManagerTiming = {
  pollTimeoutSeconds: POLL_TIMEOUT_SECONDS,
  pollRetryDelayMs: POLL_RETRY_DELAY_MS,
  pollBackoffDelayMs: POLL_BACKOFF_DELAY_MS,
  pollMaxConsecutiveFailures: POLL_MAX_CONSECUTIVE_FAILURES,
  linkAttemptTimeoutMs: LINK_ATTEMPT_TIMEOUT_MS,
  linkPollIntervalMs: LINK_POLL_INTERVAL_MS,
  pollIdleDelayMs: 0,
};

/** Split outbound text at iLink's documented 4000-char limit, on whole lines where possible. */
export function chunkWeChatText(text: string): string[] {
  if (text.length <= WECHAT_MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > WECHAT_MAX_MESSAGE_LENGTH) {
    let cut = rest.lastIndexOf('\n', WECHAT_MAX_MESSAGE_LENGTH);
    if (cut <= 0) cut = WECHAT_MAX_MESSAGE_LENGTH;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export function isWeChatChannelEnabled(): boolean {
  return process.env.WECHAT_CHANNEL_DISABLED !== 'true';
}

function wechatStateFile(workspace: string): string {
  return path.join(workspace, WECHAT_STATE_DIR, 'session.json');
}

interface WeChatSessionFile {
  credentials: ILinkCredentials;
  /** Per-recipient context tokens iLink requires echoing on the next send. */
  contextTokens: Record<string, string>;
}

export class WeChatManager {
  private status: WeChatLinkStatus = 'unlinked';
  private qrDataUri: string | undefined;
  private loggedOut = false;
  private stopping = false;
  private credentials: ILinkCredentials | undefined;
  private contextTokens: Record<string, string> = {};
  private readonly stateFile: string;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly recentMessageIds = new Set<string>();
  private readonly recentMessageOrder: string[] = [];
  private pollLoopPromise: Promise<void> | undefined;
  private pollGeneration = 0;

  constructor(
    private agentConfig: AgentConfig,
    logDir: string,
    private readonly client: ILinkClient = createILinkClient('', agentConfig.wechat?.botAgent),
    /** Called once per new inbound message, after de-dup — never for a retried delivery. */
    private readonly onMessage?: (update: ILinkUpdate) => void,
    private readonly timing: WeChatManagerTiming = DEFAULT_TIMING,
  ) {
    this.stateFile = wechatStateFile(agentConfig.workspace);
    this.logger = createLogger(`${agentConfig.id}:wechat`, logDir);
  }

  updateAgentConfig(newConfig: AgentConfig): void {
    this.agentConfig = newConfig;
  }

  getStatus(): WeChatStatus {
    return { status: this.status, qr: this.qrDataUri, loggedOut: this.loggedOut };
  }

  /** Resume a previously-linked session on gateway boot — no-op if never linked. */
  async resumeIfLinked(): Promise<void> {
    if (!isWeChatChannelEnabled()) return;
    const saved = await this.readSession();
    if (!saved) return;
    this.credentials = saved.credentials;
    this.contextTokens = saved.contextTokens;
    this.status = 'linked';
    this.logger.info('Resuming previously-linked WeChat session', { agentId: this.agentConfig.id });
    this.startPollLoop();
  }

  /**
   * Start a fresh QR-code linking flow. Blocked only if an admin has set
   * `WECHAT_CHANNEL_DISABLED` — the hard kill switch for a third-party
   * dependency no deployer of this gateway controls (see module doc comment).
   */
  async startLinking(): Promise<void> {
    if (!isWeChatChannelEnabled()) {
      throw new Error(
        'WeChat channel is disabled (WECHAT_CHANNEL_DISABLED is "true") — the iLink bridge ' +
          'this channel depends on can be killed instantly without a redeploy; ask an admin to re-enable it.',
      );
    }
    this.stopping = false;
    this.loggedOut = false;
    const session = await this.client.requestLinkQr();
    this.qrDataUri = session.qrDataUri;
    this.status = 'pending_scan';

    const deadline = Date.now() + this.timing.linkAttemptTimeoutMs;
    let lastLoggedStatus: string | undefined;
    while (!this.stopping && Date.now() < deadline) {
      await sleep(this.timing.linkPollIntervalMs);
      let result;
      try {
        result = await this.client.pollLinkStatus(session.loginSessionId);
      } catch (err) {
        // A single request failing/timing out (observed live: the host
        // `scaned_but_redirect` redirects to can be slow or unresponsive)
        // must not abort the whole attempt — keep polling until the
        // deadline above, same as a transient "wait" status would.
        this.logger.warn('WeChat QR status poll failed, retrying', {
          agentId: this.agentConfig.id,
          error: (err as Error).message,
        });
        continue;
      }
      // Only every STATUS CHANGE is logged (not every poll) — a real attempt
      // polls every 2s for up to 2 minutes, so logging unconditionally would
      // mostly just repeat "wait" dozens of times.
      if (result.status && result.status !== lastLoggedStatus) {
        this.logger.info('WeChat QR link status changed', {
          agentId: this.agentConfig.id,
          status: result.status,
        });
        lastLoggedStatus = result.status;
      }
      if (result.linked && result.credentials) {
        this.credentials = result.credentials;
        this.contextTokens = {};
        this.qrDataUri = undefined;
        this.status = 'linked';
        await this.persistSession();
        this.startPollLoop();
        return;
      }
    }
    if (!this.stopping) {
      this.logger.warn('WeChat QR link attempt timed out', {
        agentId: this.agentConfig.id,
        lastStatus: lastLoggedStatus ?? 'unknown',
      });
      this.status = 'unlinked';
      this.qrDataUri = undefined;
    }
  }

  /** Logout and wipe the linked session. The user must scan fresh afterward. */
  async unlink(): Promise<void> {
    this.stopping = true;
    this.pollGeneration += 1; // orphans any in-flight poll loop's iteration check
    await this.pollLoopPromise?.catch(() => {});
    if (this.credentials) {
      await this.client.notifyStop(this.credentials).catch((err) => {
        this.logger.warn('WeChat notifyStop failed (continuing anyway)', {
          agentId: this.agentConfig.id,
          error: (err as Error).message,
        });
      });
    }
    this.credentials = undefined;
    this.contextTokens = {};
    this.qrDataUri = undefined;
    this.status = 'unlinked';
    this.loggedOut = false;
    await fsp.rm(this.stateFile, { force: true }).catch(() => {});
  }

  /**
   * Send a single outbound message, chunked over iLink's 4000-char limit with
   * the documented 0.3s inter-chunk delay. Media is out of scope for v1 (see
   * the plan's non-goals) — text only.
   *
   * `contextToken` is NOT refreshed here — per Tencent's real protocol
   * (confirmed against `Tencent/openclaw-weixin`'s own doc), the token flows
   * the other way: an INBOUND message establishes it (captured in
   * `runPollLoop` below), and every subsequent send to that sender echoes
   * whatever was captured last. `sendmessage`'s own response carries no
   * token to update.
   */
  async sendMessage(toId: string, text: string): Promise<void> {
    if (!this.credentials) throw new Error('WeChat account is not linked');
    const chunks = chunkWeChatText(text);
    for (let i = 0; i < chunks.length; i++) {
      await this.client.sendText(this.credentials, toId, chunks[i], this.contextTokens[toId]);
      if (i < chunks.length - 1) await sleep(WECHAT_CHUNK_DELAY_MS);
    }
    await this.persistSession();
  }

  private startPollLoop(): void {
    const generation = ++this.pollGeneration;
    this.pollLoopPromise = this.runPollLoop(generation);
  }

  private async runPollLoop(generation: number): Promise<void> {
    // Tell iLink this client is now listening, before the first getUpdates
    // call — see ILinkClient.notifyStart's doc comment. Mirrors Tencent's
    // own client exactly: never blocks startup on failure, just logs.
    if (this.credentials) {
      try {
        await this.client.notifyStart(this.credentials);
      } catch (err) {
        this.logger.warn('WeChat notifyStart failed (continuing anyway)', {
          agentId: this.agentConfig.id,
          error: (err as Error).message,
        });
      }
    }
    let consecutiveFailures = 0;
    while (!this.stopping && generation === this.pollGeneration && this.credentials) {
      try {
        const updates = await this.client.getUpdates(this.credentials, this.timing.pollTimeoutSeconds);
        consecutiveFailures = 0;
        for (const update of updates) {
          // Captured unconditionally, even for a redelivered id: iLink may
          // hand back a fresher token on a retry, and there's no separate
          // signal for "this token changed" to key off instead.
          if (update.contextToken) this.contextTokens[update.fromId] = update.contextToken;
          if (this.isDuplicate(update.id)) continue;
          this.rememberMessage(update.id);
          this.onMessage?.(update);
        }
        if (this.timing.pollIdleDelayMs > 0) await sleep(this.timing.pollIdleDelayMs);
      } catch (err) {
        consecutiveFailures += 1;
        // Flat 2s retry for the first few failures, one fixed 30s pause after
        // pollMaxConsecutiveFailures in a row, then reset — NOT exponential
        // backoff. See POLL_RETRY_DELAY_MS's doc comment for why.
        const backingOff = consecutiveFailures >= this.timing.pollMaxConsecutiveFailures;
        this.logger.warn('WeChat getUpdates failed, retrying', {
          agentId: this.agentConfig.id,
          error: (err as Error).message,
          consecutiveFailures,
          backingOff,
        });
        // Deliberately NOT flipping to 'reconnecting' here, at any failure
        // count. Unlike WhatsApp/Baileys' persistent socket (where a drop is
        // real and 'reconnecting' means something), getUpdates is a
        // stateless long-poll retried in a loop — a thrown error here is
        // almost always just a Cloudflare edge timeout on an otherwise-idle
        // poll (confirmed live: happens on the large majority of idle polls
        // against a perfectly healthy, still-linked account), not a session
        // problem. Marking 'reconnecting' — which the web UI reads as
        // wechat_connected=false and hides the pending-senders/allowlist
        // section for — on ordinary transport errors made the UI flap
        // between connected/disconnected during completely normal idle
        // operation. `status` stays 'linked' through routine getUpdates
        // failures; only a real session problem (not detected yet — would
        // need iLink's business-level ret/errcode, which the thrown Error
        // here doesn't carry structured) should ever downgrade it.
        await sleep(backingOff ? this.timing.pollBackoffDelayMs : this.timing.pollRetryDelayMs);
        if (backingOff) consecutiveFailures = 0;
        continue;
      }
      if (this.status === 'reconnecting') this.status = 'linked';
    }
  }

  private isDuplicate(id: string): boolean {
    return this.recentMessageIds.has(id);
  }

  private rememberMessage(id: string): void {
    this.recentMessageIds.add(id);
    this.recentMessageOrder.push(id);
    if (this.recentMessageOrder.length > RECENT_MESSAGE_CACHE_SIZE) {
      const oldest = this.recentMessageOrder.shift();
      if (oldest !== undefined) this.recentMessageIds.delete(oldest);
    }
  }

  private async readSession(): Promise<WeChatSessionFile | undefined> {
    try {
      const raw = await fsp.readFile(this.stateFile, 'utf-8');
      return JSON.parse(raw) as WeChatSessionFile;
    } catch {
      return undefined;
    }
  }

  private async persistSession(): Promise<void> {
    if (!this.credentials) return;
    const dir = path.dirname(this.stateFile);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const payload: WeChatSessionFile = { credentials: this.credentials, contextTokens: this.contextTokens };
    await fsp.writeFile(this.stateFile, JSON.stringify(payload), { mode: 0o600 });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-exported so callers (router/runner) don't need to import fs directly
// just to check whether a session file exists before constructing a manager.
export function hasSavedWeChatSession(workspace: string): boolean {
  return fs.existsSync(wechatStateFile(workspace));
}
