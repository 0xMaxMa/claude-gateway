/**
 * WeChatManager — one instance per agent, owning that agent's link to a
 * single personal WeChat account through Tencent's iLink Bot API bridge.
 *
 * Deliberately NOT modeled on a persistent-socket channel (there is no
 * WeChat equivalent of Discord's gateway connection or WhatsApp's Baileys
 * socket in this codebase). iLink delivers messages via long-polling
 * (`getupdates`, 35s timeout per the Hermes-agent doc this was researched
 * from) — there is also no existing hand-rolled long-poll loop to copy in
 * this codebase; Telegram's polling lives inside the external
 * `claude --channels` CLI, not here. The loop below is the new piece.
 *
 * What IS reused from existing channels:
 *  - The QR/status state machine shape (`status`/`qr`/`loggedOut`) mirrors
 *    every device-linked channel's UX contract, kept intentionally small
 *    since WeChat (unlike WhatsApp/Baileys) has no pairing-code option and
 *    no multi-account support in v1.
 *  - `WECHAT_CHANNEL_ENABLED` is a hard kill switch: iLink is a third-party
 *    dependency GetPod does not control, so the whole channel must be
 *    disableable with one env var and no redeploy of manager logic.
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

/** Backoff after a poll/link failure, capped, doubling each consecutive failure. */
const POLL_BACKOFF_BASE_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 30_000;

/** How long a QR login attempt stays valid before `startLinking()` must be called again. */
const LINK_ATTEMPT_TIMEOUT_MS = 2 * 60 * 1000;
const LINK_POLL_INTERVAL_MS = 2_000;

/** Recent inbound message ids retained for at-least-once de-dup (iLink has no delivery guarantee stated). */
const RECENT_MESSAGE_CACHE_SIZE = 200;

/** Timing knobs, overridable in tests so the suite doesn't depend on real wall-clock delays. */
export interface WeChatManagerTiming {
  pollTimeoutSeconds: number;
  pollBackoffBaseMs: number;
  pollBackoffMaxMs: number;
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
  pollBackoffBaseMs: POLL_BACKOFF_BASE_MS,
  pollBackoffMaxMs: POLL_BACKOFF_MAX_MS,
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
  return process.env.WECHAT_CHANNEL_ENABLED === 'true';
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
    private readonly client: ILinkClient = createILinkClient(''),
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
   * Start a fresh QR-code linking flow. Requires `WECHAT_CHANNEL_ENABLED` —
   * this is the hard kill switch for a third-party dependency GetPod doesn't
   * control (see module doc comment).
   */
  async startLinking(): Promise<void> {
    if (!isWeChatChannelEnabled()) {
      throw new Error(
        'WeChat channel is disabled (WECHAT_CHANNEL_ENABLED is not "true") — the iLink bridge ' +
          'this channel depends on can be killed instantly without a redeploy; ask an admin to enable it.',
      );
    }
    this.stopping = false;
    this.loggedOut = false;
    const session = await this.client.requestLinkQr();
    this.qrDataUri = session.qrDataUri;
    this.status = 'pending_scan';

    const deadline = Date.now() + this.timing.linkAttemptTimeoutMs;
    while (!this.stopping && Date.now() < deadline) {
      await sleep(this.timing.linkPollIntervalMs);
      const result = await this.client.pollLinkStatus(session.loginSessionId);
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
      this.status = 'unlinked';
      this.qrDataUri = undefined;
    }
  }

  /** Logout and wipe the linked session. The user must scan fresh afterward. */
  async unlink(): Promise<void> {
    this.stopping = true;
    this.pollGeneration += 1; // orphans any in-flight poll loop's iteration check
    await this.pollLoopPromise?.catch(() => {});
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
   */
  async sendMessage(toId: string, text: string): Promise<void> {
    if (!this.credentials) throw new Error('WeChat account is not linked');
    const chunks = chunkWeChatText(text);
    for (let i = 0; i < chunks.length; i++) {
      const result = await this.client.sendText(this.credentials, toId, chunks[i], this.contextTokens[toId]);
      this.contextTokens[toId] = result.contextToken;
      if (i < chunks.length - 1) await sleep(WECHAT_CHUNK_DELAY_MS);
    }
    await this.persistSession();
  }

  private startPollLoop(): void {
    const generation = ++this.pollGeneration;
    this.pollLoopPromise = this.runPollLoop(generation);
  }

  private async runPollLoop(generation: number): Promise<void> {
    let backoffMs = this.timing.pollBackoffBaseMs;
    while (!this.stopping && generation === this.pollGeneration && this.credentials) {
      try {
        const updates = await this.client.getUpdates(this.credentials, this.timing.pollTimeoutSeconds);
        backoffMs = this.timing.pollBackoffBaseMs;
        for (const update of updates) {
          if (this.isDuplicate(update.id)) continue;
          this.rememberMessage(update.id);
          this.onMessage?.(update);
        }
        if (this.timing.pollIdleDelayMs > 0) await sleep(this.timing.pollIdleDelayMs);
      } catch (err) {
        this.logger.warn('WeChat getUpdates failed, backing off', {
          agentId: this.agentConfig.id,
          error: (err as Error).message,
          backoffMs,
        });
        this.status = 'reconnecting';
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, this.timing.pollBackoffMaxMs);
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
