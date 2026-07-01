/**
 * LineReplyManager — gateway-side LINE outbound + slow-LLM postback button.
 *
 * Direct port of hermes-agent's `plugins/platforms/line/adapter.py` slow-LLM
 * flow (PR #18153, leepoweii), adapted to claude-gateway: the LLM runs in a
 * subprocess and LINE inbound arrives via the webhook router, so the token
 * lifecycle + state machine live here (one instance per LINE-enabled agent,
 * owned by AgentRunner) instead of in the channel adapter.
 *
 * Why it exists: LINE reply tokens are single-use and expire ~60s after the
 * user's message; replying with the token is FREE, push is metered. When the
 * agent is slow, we burn the token (before it expires) to send a tappable
 * Template Buttons bubble; tapping it delivers a fresh reply token, so the
 * cached answer goes out free. No tap → the answer waits in cache and expires
 * (no auto-push). Push happens only as a fallback when a reply-token send fails.
 *
 * Mapping to the python source:
 *   onInbound        ← reply-token stash + _keep_typing timer arm
 *   fireButton       ← _fire_postback (1188–1213)
 *   onAnswer         ← send + _send_text_chunks (1079–1133)
 *   handlePostback   ← _handle_postback_event (996–1053)
 *   markInterrupted  ← interrupt_session_activity (1226–1231)
 *   RequestCache     ← RequestCache (283–366)
 */
import { messagingApi } from '@line/bot-sdk';
import { createLogger } from '../logger';
import {
  splitForLine,
  stripMarkdownPreservingUrls,
  LINE_MAX_MESSAGES_PER_REQUEST,
} from './line-pure';

// hermes constants (adapter.py 114, 123–129, 309–310).
const REPLY_TOKEN_TTL_MS = 50_000; // conservative cap below LINE's ~60s
const READY_TTL_MS = 3_600_000; // 1h for READY/ERROR/DELIVERED entries
const PENDING_TTL_MS = 86_400_000; // 24h for PENDING (button sent, LLM running)
const PRUNE_INTERVAL_MS = 600_000; // 10 min

const DEFAULT_BUTTON_LABEL = 'Get answer';
const DEFAULT_PENDING_TEXT =
  '🤔 Still thinking. Tap below to fetch the answer when it\'s ready.';
const DEFAULT_DELIVERED_TEXT = 'Already replied ✅';
const DEFAULT_INTERRUPTED_TEXT = 'Run was interrupted before completion.';

enum State {
  PENDING = 'pending', // button sent, LLM still running
  READY = 'ready', // LLM done, response cached, waiting for postback tap
  DELIVERED = 'delivered',
  ERROR = 'error', // LLM raised / interrupted; cached error text waiting
}

interface CacheEntry {
  state: State;
  payload: string;
  chatId: string;
  createdAt: number;
  updatedAt: number;
}

export interface LineReplyManagerOptions {
  agentId: string;
  logDir: string;
  accessToken: string;
  /** Seconds before the button fires. Caller guarantees > 0. */
  thresholdSeconds: number;
  buttonLabel?: string;
  pendingText?: string;
}

export class LineReplyManager {
  private readonly client: messagingApi.MessagingApiClient;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly thresholdMs: number;
  private readonly buttonLabel: string;
  private readonly pendingText: string;
  private readonly deliveredText = DEFAULT_DELIVERED_TEXT;
  private readonly interruptedText = DEFAULT_INTERRUPTED_TEXT;

  // Cache state machine (RequestCache).
  private readonly cache = new Map<string, CacheEntry>();
  private ridSeq = 0;

  // Per-chat runtime state.
  private readonly replyTokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly pendingButtons = new Map<string, string>(); // chatId → rid
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly turns = new Map<string, number>();
  private readonly answeredTurn = new Map<string, number>();

  private readonly pruneTimer: NodeJS.Timeout;

  constructor(opts: LineReplyManagerOptions) {
    this.client = new messagingApi.MessagingApiClient({
      channelAccessToken: opts.accessToken,
    });
    this.logger = createLogger(`line-reply:${opts.agentId}`, opts.logDir);
    this.thresholdMs = Math.max(1, opts.thresholdSeconds) * 1000;
    this.buttonLabel = (opts.buttonLabel || DEFAULT_BUTTON_LABEL).slice(0, 20) || DEFAULT_BUTTON_LABEL;
    this.pendingText = opts.pendingText || DEFAULT_PENDING_TEXT;
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  // ── Inbound: new user turn ────────────────────────────────────────────────
  /**
   * A user message arrived: stash its reply token and (by default) arm the
   * slow-button timer.
   *
   * `opts.armButton === false` stashes the token + bumps the turn counter but
   * does NOT arm the button — used for group/room turns, where the shared-tap
   * button is disabled but the answer must still be delivered. Crucially the
   * reply token is still stashed so `onAnswer` can reply→push (the subprocess
   * suppresses its own LINE send under LINE_REPLY_REFRESH, so the gateway is the
   * only thing that delivers; skipping the stash would silently drop the answer).
   */
  onInbound(chatId: string, replyToken: string, opts?: { armButton?: boolean }): void {
    if (!chatId || !replyToken) return;
    this.clearTimer(chatId);
    // A new turn supersedes a PREVIOUS turn's button only once that turn's answer
    // has resolved (READY/ERROR/DELIVERED): retiring it from the one-button guard
    // lets THIS turn fire its own button so its answer isn't swallowed (a prior
    // READY-but-untapped button would otherwise block fireButton, and onAnswer's
    // setReady would no-op). A still-PENDING button (rapid messages, answer not
    // yet in) is kept, preserving the one-outstanding-button invariant. The old
    // cache entry stays intact either way, so a tap on the old bubble in chat
    // history still resolves.
    const prevRid = this.pendingButtons.get(chatId);
    if (prevRid && this.cache.get(prevRid)?.state !== State.PENDING) {
      this.pendingButtons.delete(chatId);
    }
    this.turns.set(chatId, (this.turns.get(chatId) ?? 0) + 1);
    this.answeredTurn.delete(chatId);
    this.replyTokens.set(chatId, { token: replyToken, expiresAt: Date.now() + REPLY_TOKEN_TTL_MS });
    if (opts?.armButton === false) return; // group/room: deliver via onAnswer, no button
    const t = setTimeout(() => {
      void this.fireButton(chatId);
    }, this.thresholdMs);
    t.unref?.();
    this.timers.set(chatId, t);
  }

  // ── Slow path: send the Template Buttons bubble (_fire_postback) ───────────
  private async fireButton(chatId: string): Promise<void> {
    this.timers.delete(chatId);
    // Agent already answered (token consumed) → nothing to do.
    if (!this.replyTokens.has(chatId)) return;
    // One outstanding button per chat.
    if (this.pendingButtons.has(chatId)) return;

    const rid = this.registerPending(chatId);
    this.pendingButtons.set(chatId, rid);
    const token = this.consumeReplyToken(chatId);
    if (!token) {
      this.pendingButtons.delete(chatId);
      this.cache.delete(rid);
      return;
    }
    try {
      await this.client.replyMessage({
        replyToken: token,
        messages: [this.buildButtonMessage(rid)],
      });
      this.logger.info('LINE: sent slow-LLM postback button', { chatId, rid });
    } catch (err) {
      this.logger.warn('LINE: postback button send failed', { error: (err as Error).message });
      this.pendingButtons.delete(chatId);
    }
  }

  // ── Answer ready (send + _send_text_chunks) ───────────────────────────────
  /** The agent produced its reply text for this turn. */
  async onAnswer(chatId: string, text: string): Promise<void> {
    if (!chatId) return;
    // Idempotency: tool_use and result can both surface the same answer.
    const turn = this.turns.get(chatId);
    if (turn !== undefined) {
      if (this.answeredTurn.get(chatId) === turn) return;
      this.answeredTurn.set(chatId, turn);
    }
    this.clearTimer(chatId);

    // A button is outstanding → cache the answer for the user to fetch via tap.
    const pendingRid = this.pendingButtons.get(chatId);
    if (pendingRid) {
      this.setReady(pendingRid, text);
      return;
    }
    await this.sendChunks(chatId, text);
  }

  private async sendChunks(chatId: string, text: string): Promise<void> {
    const chunks = splitForLine(stripMarkdownPreservingUrls(text));
    if (chunks.length === 0) return;
    const messages = chunks.slice(0, LINE_MAX_MESSAGES_PER_REQUEST).map((c) => this.textMessage(c));

    const token = this.consumeReplyToken(chatId);
    if (token) {
      try {
        await this.client.replyMessage({ replyToken: token, messages });
        return;
      } catch (err) {
        this.logger.info('LINE: reply token rejected; falling back to push', {
          error: (err as Error).message,
        });
        // fall through to push
      }
    }
    try {
      await this.client.pushMessage({ to: chatId, messages });
    } catch (err) {
      this.logger.error('LINE: push send failed', { error: (err as Error).message });
    }
  }

  // ── Postback tap (_handle_postback_event) ─────────────────────────────────
  /**
   * Handle a tapped postback. Returns true when it is OUR refresh button (so the
   * caller must NOT forward it to the agent); false for any other postback.
   */
  async handlePostback(chatId: string, freshToken: string, data: string): Promise<boolean> {
    let parsed: { action?: string; request_id?: string };
    try {
      parsed = JSON.parse(data);
    } catch {
      return false;
    }
    if (parsed?.action !== 'show_response') return false;
    // From here on it's ours — never wake the agent, even if malformed/stale.
    const requestId = parsed.request_id ?? '';
    const entry = requestId ? this.cache.get(requestId) : undefined;
    if (!freshToken || !entry) return true;

    if (entry.state === State.READY) {
      const chunks = splitForLine(stripMarkdownPreservingUrls(entry.payload));
      const messages = chunks
        .slice(0, LINE_MAX_MESSAGES_PER_REQUEST)
        .map((c) => this.textMessage(c));
      // Flip to DELIVERED synchronously before any await so that a concurrent
      // tap sees DELIVERED and short-circuits instead of double-sending.
      this.markDelivered(requestId);
      this.clearPendingButton(chatId, requestId);
      try {
        await this.client.replyMessage({ replyToken: freshToken, messages });
      } catch (err) {
        this.logger.warn('LINE: postback reply failed; falling back to push', {
          error: (err as Error).message,
        });
        try {
          await this.client.pushMessage({ to: chatId, messages });
        } catch (err2) {
          this.logger.error('LINE: postback push fallback failed', {
            error: (err2 as Error).message,
          });
        }
      }
    } else if (entry.state === State.ERROR) {
      await this.safeReply(freshToken, entry.payload || this.interruptedText);
      this.markDelivered(requestId);
      this.clearPendingButton(chatId, requestId);
    } else if (entry.state === State.DELIVERED) {
      await this.safeReply(freshToken, this.deliveredText);
    } else if (entry.state === State.PENDING) {
      // Still working — re-issue the wait notice; the original button stays
      // tappable in chat history for a later tap.
      await this.safeReply(freshToken, this.pendingText);
    }
    return true;
  }

  /** The turn was interrupted/cancelled — surface an error for any pending button. */
  markInterrupted(chatId: string): void {
    this.clearTimer(chatId);
    const rid = this.pendingButtons.get(chatId);
    if (rid) {
      this.setError(rid, this.interruptedText);
      this.pendingButtons.delete(chatId);
    }
  }

  disposeChat(chatId: string): void {
    this.clearTimer(chatId);
    this.replyTokens.delete(chatId);
    this.pendingButtons.delete(chatId);
    this.turns.delete(chatId);
    this.answeredTurn.delete(chatId);
  }

  disposeAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    clearInterval(this.pruneTimer);
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private clearTimer(chatId: string): void {
    const t = this.timers.get(chatId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(chatId);
    }
  }

  /** Clear the chat's pending-button guard only if it still points at `rid`
   *  (so delivering/tapping a superseded button can't clear a newer one). */
  private clearPendingButton(chatId: string, rid: string): void {
    if (this.pendingButtons.get(chatId) === rid) this.pendingButtons.delete(chatId);
  }

  private consumeReplyToken(chatId: string): string {
    const entry = this.replyTokens.get(chatId);
    if (!entry) return '';
    this.replyTokens.delete(chatId); // single-use
    if (!entry.token || Date.now() >= entry.expiresAt) return '';
    return entry.token;
  }

  private async safeReply(token: string, text: string): Promise<void> {
    try {
      await this.client.replyMessage({ replyToken: token, messages: [this.textMessage(text)] });
    } catch (err) {
      this.logger.debug('LINE: safeReply failed', { error: (err as Error).message });
    }
  }

  private textMessage(text: string): messagingApi.TextMessage {
    return { type: 'text', text };
  }

  private buildButtonMessage(rid: string): messagingApi.TemplateMessage {
    const truncated = this.pendingText.length <= 160 ? this.pendingText : this.pendingText.slice(0, 157) + '...';
    const alt = this.pendingText.length <= 400 ? this.pendingText : this.pendingText.slice(0, 397) + '...';
    return {
      type: 'template',
      altText: alt,
      template: {
        type: 'buttons',
        text: truncated,
        actions: [
          {
            type: 'postback',
            label: this.buttonLabel,
            data: JSON.stringify({ action: 'show_response', request_id: rid }),
            displayText: this.buttonLabel,
          },
        ],
      },
    };
  }

  // ── RequestCache ──────────────────────────────────────────────────────────
  private registerPending(chatId: string): string {
    const rid = `rr-${Date.now().toString(36)}-${(this.ridSeq++).toString(36)}`;
    const now = Date.now();
    this.cache.set(rid, { state: State.PENDING, payload: '', chatId, createdAt: now, updatedAt: now });
    return rid;
  }

  private setReady(rid: string, payload: string): void {
    const e = this.cache.get(rid);
    if (!e || e.state !== State.PENDING) return;
    e.state = State.READY;
    e.payload = payload;
    e.updatedAt = Date.now();
  }

  private setError(rid: string, message: string): void {
    const e = this.cache.get(rid);
    if (!e || e.state !== State.PENDING) return;
    e.state = State.ERROR;
    e.payload = message;
    e.updatedAt = Date.now();
  }

  private markDelivered(rid: string): void {
    const e = this.cache.get(rid);
    if (!e || (e.state !== State.READY && e.state !== State.ERROR)) return;
    e.state = State.DELIVERED;
    e.payload = ''; // free the LLM answer text immediately; DELIVERED sentinel is all we need
    e.updatedAt = Date.now();
  }

  private prune(): void {
    const now = Date.now();
    for (const [rid, e] of this.cache) {
      const ttl = e.state === State.PENDING ? PENDING_TTL_MS : READY_TTL_MS;
      const stamp = e.state === State.PENDING ? e.createdAt : e.updatedAt;
      if (now - stamp > ttl) this.cache.delete(rid);
    }
    // Reap per-chat turn counters for chats with no live state left, so they
    // don't grow unbounded as distinct users come and go. A chat is "active"
    // if it still has a cached request, an armed timer, an outstanding button,
    // or a stashed reply token. Dropping a stale counter is safe: answeredTurn
    // is reaped in lockstep, so the next inbound restarts idempotency cleanly.
    const active = new Set<string>();
    for (const e of this.cache.values()) active.add(e.chatId);
    for (const id of this.timers.keys()) active.add(id);
    for (const id of this.pendingButtons.keys()) active.add(id);
    for (const id of this.replyTokens.keys()) active.add(id);
    for (const id of this.turns.keys()) if (!active.has(id)) this.turns.delete(id);
    for (const id of this.answeredTurn.keys()) if (!active.has(id)) this.answeredTurn.delete(id);
  }
}
