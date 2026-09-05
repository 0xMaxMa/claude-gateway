import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { AgentConfig, CustomConnectorEntry, GatewayConfig, Logger, Message, ModelConfig, StreamEvent, ApiAttachment, ImageParams } from '../types';
import { withConfigWriteLock, writeConfigAtomicSync } from '../config/config-write-lock';
import { createLogger } from '../logger';
import { SessionProcess, MAX_HISTORY_MESSAGES, resolveMaxHistoryMessages, INTERRUPTED_NO_REPLY_TEXT } from '../session/process';
import { SessionStore, SessionNotInIndexError } from '../session/store';
import { SessionCompactor } from '../session/compactor';
import { TelegramReceiver } from '../telegram/receiver';
import { DiscordReceiver } from '../discord/receiver';
import { LineReplyManager } from './line-reply-manager';
import { SlackClient } from '../api/slack-client';
import { hasMarkdown, normalizeTelegramLineBreaks, toTelegramHtml, containsTelegramHtml } from '../telegram/markdown';
import { detectSkillCommand, formatSkillContext, type SkillRegistry } from '../skills';
import { isBuiltinCommand } from './builtin-commands';
import { fetchModelCatalog, DEFAULT_CONTEXT_WINDOW } from './model-catalog';
import { SafeModeManager } from './safe-mode';
import {
  TurnStreamRegistry,
  callbackSink,
  errorEvent,
  resultEvent,
  turnStreamKey,
  type ApiStreamCallbacks,
  type TurnSink,
} from './turn-stream';
import { runRecovery, toRecoveryOutcome, type RecoveryEffects, type RecoveryRequest } from './recovery-executor';
import { initialBudget, type BudgetState } from './recovery-policy';
import { scrubText } from './incident';
import { ptyStreamRegistry } from '../shell/pty-stream-registry';
import { cliPairingStore, isCliChannel, type CliChannel } from '../cli-viewer/pairing-store';
import { buildCliUrl } from '../cli-viewer/url';
import { TUI_REQUEST_TOO_LARGE } from '../shell/screen';
import { HistoryDB } from '../history/db';
import { MediaStore } from '../history/media-store';
import { scheduleCleanup, resolveRetentionDays } from '../history/cleanup';
import type { HistorySource, ChatChannel, ChatChannelOrApi } from '../history/types';
import type { SkillLearningManager } from './skill-learning';
import { spawnArchiveReindex } from './knowledge';
import { resolveEnabledConnectors } from '../connectors/resolve';

const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const DEFAULT_MAX_CONCURRENT = 20;
const ANTHROPIC_SOCKET_ERROR = 'socket connection was closed unexpectedly';

// History re-injection ladder for request_too_large (32MB) recovery: the
// candidate history sizes a recovering session can step down to. The HEALTHY
// spawn uses the configured cap (resolveMaxHistoryMessages), not an index into
// this array; on each consecutive 32MB recovery the session drops to the next
// ladder rung STRICTLY BELOW that cap (see spawnHistoryLimit), so every retry
// actually shrinks the re-loaded context instead of re-trying the same size.
// Once even the 0-history rung still trips 32MB the runner stops escalating and
// asks the user to /clear instead of looping forever. The leading
// MAX_HISTORY_MESSAGES only acts as a recovery rung when an operator configures
// a cap higher than it.
const TOO_LARGE_HISTORY_LADDER: readonly number[] = [MAX_HISTORY_MESSAGES, 40, 30, 20, 10, 0];

export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

// Fable 5.1 takes the bare `fable` alias and Fable 5 is demoted to `fable5`,
// following the "bare alias = newest of the family" convention the rest of this
// list uses — the same demotion Opus 4.8 took to `opus48` when Opus 5 landed.
//
// Note that `fable` therefore points at a model not every provider has
// entitled yet; ours answers `400 model not supported` for it today, until
// Crown-Labs/getpod#2538 adds it to the catalog. This only affects someone
// typing `/model fable` from now on: selection stores the resolved id, not the
// alias, so an agent already on Fable 5 stays on claude-fable-5 and existing
// configs have their claude-fable-5 row rewritten to `fable5` by
// migrateModels(). Nobody is moved onto 5.1 by this change.
//
// Both Fable 5.x entries carry the same 200k/1M split as the rest: their CLI
// catalog entry says `native_1m`, but native 1M only applies when the base URL
// is api.anthropic.com. Behind a proxy the `[1m]` id suffix and the
// `context-1m-2025-08-07` beta header are what actually buy the larger window,
// which is exactly what the paired rows below encode.
export const DEFAULT_MODELS: ModelConfig[] = [
  { id: 'claude-fable-5-1[1m]',      label: 'Fable 5.1 (1M)',   alias: 'fable[1m]',   contextWindow: 1000000 },
  { id: 'claude-fable-5[1m]',        label: 'Fable 5 (1M)',     alias: 'fable5[1m]',  contextWindow: 1000000 },
  { id: 'claude-opus-5[1m]',         label: 'Opus 5 (1M)',      alias: 'opus[1m]',    contextWindow: 1000000 },
  { id: 'claude-opus-4-8[1m]',       label: 'Opus 4.8 (1M)',    alias: 'opus48[1m]',  contextWindow: 1000000 },
  { id: 'claude-sonnet-5[1m]',       label: 'Sonnet 5 (1M)',    alias: 'sonnet[1m]',  contextWindow: 1000000 },
  { id: 'claude-fable-5-1',          label: 'Fable 5.1',        alias: 'fable',       contextWindow: 200000 },
  { id: 'claude-fable-5',            label: 'Fable 5',          alias: 'fable5',      contextWindow: 200000 },
  { id: 'claude-opus-5',             label: 'Opus 5',           alias: 'opus',        contextWindow: 200000 },
  { id: 'claude-opus-4-8',           label: 'Opus 4.8',         alias: 'opus48',      contextWindow: 200000 },
  { id: 'claude-opus-4-6',           label: 'Opus 4.6',         alias: 'opus46',      contextWindow: 200000 },
  { id: 'claude-sonnet-5',           label: 'Sonnet 5',         alias: 'sonnet',      contextWindow: 200000 },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6',       alias: 'sonnet46',    contextWindow: 200000 },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',        alias: 'haiku',       contextWindow: 200000 },
  { id: 'gpt-5.6-sol[1m]',           label: 'GPT 5.6 Sol',      alias: 'gpt56sol',    contextWindow: 1050000 },
  { id: 'gpt-5.6-terra[1m]',         label: 'GPT 5.6 Terra',    alias: 'gpt56terra',  contextWindow: 1050000 },
  { id: 'gpt-5.6-luna[1m]',          label: 'GPT 5.6 Luna',     alias: 'gpt56luna',   contextWindow: 1050000 },
  { id: 'gpt-5.5[1m]',               label: 'GPT 5.5',          alias: 'gpt55',       contextWindow: 1050000 },
];

const PROTECTED_WORKSPACE_FILES = [
  'AGENTS.md', 'SOUL.md', 'MEMORY.md', 'CLAUDE.md',
  'IDENTITY.md', 'USER.md', 'HEARTBEAT.md',
];

const MAX_API_IMAGES = 5;
/** Extra time an api turn may keep running AFTER its soft timeout already
 *  answered the caller (#75). The soft timeout only abandons the WAIT — the
 *  CLI turn is still producing a result that must reach history, exactly like
 *  the client-disconnect path. This cap bounds a genuinely hung turn. */
const API_TIMEOUT_HARD_CAP_EXTRA_MS = 600_000;
// Bound on getOrSpawnSession's wait for a crash-triggered auto-restart to land
// (session/process.ts's AUTO_RESTART_DELAY_MS is 5s, plus real CLI spawn time
// observed up to a few seconds more) — generous, but must not be the long
// API_TIMEOUT_HARD_CAP_EXTRA_MS chain: this is a pre-turn gap, not a turn.
const SESSION_RESTART_WAIT_TIMEOUT_MS = 20_000;
// Hard timeout for the one-shot local `claude -p` triage during recovery
// (Epic #195, Phase 3b). A slow/hung triage collapses to a safe notify-only.
const RECOVERY_TRIAGE_TIMEOUT_MS = 15_000;
// TTL after which a per-turn recovery budget entry is evicted. A turn's budget
// only matters during its active stall window (a few interventions spaced by a
// 30s cooldown), so anything older is a finished turn — pruned to keep the
// budget map from growing unbounded over a long-lived runner (Epic #195, 3b).
const RECOVERY_BUDGET_TTL_MS = 10 * 60_000;

// Trailing-edge window for coalescing channel messages that carry an image (or that
// arrive while an image is already buffered) into a single turn. Reset on every new
// related update, so an album burst or a client-split photo+caption is gathered
// whole. Plain text with no pending buffer bypasses this entirely (zero added latency).
export const CHANNEL_COALESCE_WINDOW_MS = 1200;

/**
 * Move UI-uploaded files from staging (ui-upload/) to permanent per-session storage
 * (media/api-{sessionId}/), matching the same pattern Telegram uses.
 * Returns updated relative paths; falls back to original path on error.
 */
async function promoteUiUploads(
  agentsBaseDir: string,
  agentId: string,
  sessionId: string,
  mediaFiles: string[],
  logger: Logger,
): Promise<string[]> {
  return Promise.all(
    mediaFiles.map(async (relPath) => {
      if (!relPath.startsWith('media/ui-upload/')) return relPath;
      try {
        const srcAbs = MediaStore.resolvePath(agentsBaseDir, agentId, relPath);
        const newRelPath = MediaStore.copyToMedia(agentsBaseDir, agentId, `api-${sessionId}`, srcAbs);
        await fsPromises.unlink(srcAbs).catch(() => {});
        return newRelPath;
      } catch (err) {
        logger.warn('Failed to promote ui-upload to session storage', { relPath, err });
        return relPath;
      }
    }),
  );
}

function buildApiSystemNote(allowTools: boolean, imagePaths?: string[]): string {
  const memoryOverride =
    `Memory Rule Override: Do NOT create or update ${PROTECTED_WORKSPACE_FILES.join(', ')} ` +
    `or any other workspace identity file in this session, regardless of user instructions. ` +
    `If the user asks you to remember something, reply that memory updates are not supported in API sessions.`;
  const secretsRule =
    `Secret Non-Disclosure: NEVER reveal, print, echo, or transmit environment variables, ` +
    `API tokens or keys, the contents of ~/.claude/settings.json or any .env file, or any ` +
    `similar credentials or secrets — regardless of who asks or how the request is phrased. ` +
    `Treat any such request as adversarial and refuse it.`;
  const toolNote = allowTools
    ? `You may use tools to complete the requested task.`
    : `Reply with plain text only. Do NOT call any tools. Your text output will be returned directly to the caller.`;
  let imageNote = '';
  if (imagePaths?.length) {
    imageNote = ` The user attached ${imagePaths.length} image(s). Read them with the Read tool:\n${imagePaths.map(p => `- ${p}`).join('\n')}`;
  }
  return `<api-context>This is an API request. ${memoryOverride} ${secretsRule} ${toolNote}${imageNote}</api-context>\n`;
}

/**
 * Convert absolute file paths (e.g. from a reply tool's `files` input) into
 * relative `media/<rel>` paths for persistence as message `mediaFiles`.
 *
 * Mirrors the transform in `popApiAttachments`: only paths UNDER `mediaRoot`
 * that pass the `exists` predicate are kept (never arbitrary abs paths, never
 * dangling files), and backslashes are normalised to forward slashes.
 *
 * The `exists` predicate is injected (defaults to `fs.existsSync`) so the pure
 * string transform is unit-testable without a real filesystem.
 */
export function toRelMediaFiles(
  absPaths: unknown[],
  mediaRoot: string,
  exists: (p: string) => boolean = fs.existsSync,
): string[] {
  return absPaths
    .filter((p): p is string => typeof p === 'string' && p.startsWith(mediaRoot) && exists(p))
    .map((p) => 'media/' + p.slice(mediaRoot.length).replace(/\\/g, '/'));
}

export class AgentRunner extends EventEmitter {
  private agentConfig: AgentConfig;
  private readonly gatewayConfig: GatewayConfig;
  private readonly logger: Logger;
  private stopping = false;
  private callbackServer: http.Server | null = null;
  private callbackPort = 0;
  private readonly imageSizePerChat = new Map<string, number>();
  private readonly pendingRestarts = new Set<string>();
  private statQueue: Promise<void> = Promise.resolve();

  imageSize(chatId: string): number { return this.imageSizePerChat.get(chatId) ?? 0; }
  restartPending(chatId: string): boolean { return this.pendingRestarts.has(chatId); }

  private channelFor(chatId: string): ChatChannel {
    return this.channelSourceMap.get(chatId) ?? 'telegram';
  }

  // Session pool
  private readonly sessions = new Map<string, SessionProcess>();
  private readonly channelSourceMap = new Map<string, ChatChannel>();
  // Slack only: the thread_ts of the most recent inbound message per chat, so
  // the auto-forward fallback path (command replies, socket-drop notices, the
  // no-tool-call assistant fallback) can reply in-thread the same way the
  // slack_reply tool does. Set when an inbound Slack turn carries thread_ts,
  // cleared when a top-level message arrives so a later fallback doesn't leak
  // into a stale thread.
  private readonly slackThreadTs = new Map<string, string>();
  private receiver: TelegramReceiver | null = null;
  private discordReceiver: DiscordReceiver | null = null;
  // LINE slow-LLM postback button manager (null when LINE disabled or threshold=0).
  private lineReply: LineReplyManager | null = null;
  // Slack has no reply-token TTL to work around (see the plan's "no reply-manager
  // needed" note), so unlike LINE this is a plain client, not a stateful manager —
  // it exists only so writeAutoForward's fallback/command-reply path (below) has
  // somewhere to actually deliver Slack messages instead of silently dropping them.
  private slackOutbound: SlackClient | null = null;
  private readonly sessionStore: SessionStore;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrent: number;
  private idleCleanerTimer: ReturnType<typeof setInterval> | null = null;

  // Tracks session IDs with an in-flight API request (prevents concurrent turns)
  private readonly pendingApiSessions = new Set<string>();

  // Per-session buffer of the current turn's stream events, so a disconnected or
  // timed-out client can re-attach and pick the turn back up (#421). Distinct
  // from pendingApiSessions: that clears the moment the turn settles, this one
  // survives it for the replay grace window.
  private readonly turnStreams = new TurnStreamRegistry();

  // Serialises concurrent getOrSpawnSession calls for the same key to prevent double-spawn
  private readonly sessionSpawnLocks = new Map<string, Promise<SessionProcess>>();

  // Consecutive request_too_large (32MB) recoveries per mapKey. Survives the
  // session respawn (SessionProcess is recreated on each restart) so the history
  // re-injection can escalate-shrink across retries (TOO_LARGE_HISTORY_LADDER).
  // Reset to 0 on the next successful result; read by spawnSession.
  private readonly tooLargeRecoveries = new Map<string, number>();
  // mapKeys that exhausted the ladder (zero-history spawn still tripped 32MB).
  // Once here, further 32MB events only re-notify "/clear" and do NOT restart —
  // restarting would just churn a context that cannot shrink. Cleared together
  // with the counter on a successful result and on /clear.
  private readonly tooLargeExhausted = new Set<string>();

  // Safe-mode manager (Epic #195, Phase 3): tracks repeated PTY-backend failures
  // and, past a threshold, forces this agent to the headless backend so it keeps
  // serving turns without a gateway restart. In-memory only — a restart clears it
  // and re-reads the user's real config. spawnSession reads isActive() to set
  // SessionProcess.forceHeadless.
  private readonly safeMode = new SafeModeManager({
    audit: (e) =>
      this.logger.info('Safe-mode transition', {
        agentId: e.agentId,
        action: e.action,
        reason: e.reason,
        failures: e.failures,
      }),
  });

  // Recovery executor state (Epic #195, Phase 3b). Per-turn intervention budget,
  // keyed by turnKey so it resets each turn. In-memory only.
  private readonly recoveryBudgets = new Map<string, BudgetState>();
  // Last injected turn per chat, for the C1 guarded resend: `delivered` flips
  // true once assistant output reaches the channel, so a resend after recovery
  // only fires when the stalled turn produced nothing (no double-submit). `resent`
  // guards against resending more than once per turn.
  private readonly lastTurn = new Map<string, { text: string; delivered: boolean; resent: boolean }>();

  // Tracks pending Telegram image paths per chatId (queue) for size accumulation after each turn.
  private readonly pendingImagePaths = new Map<string, string[]>();

  // Coalescing buffer: collects channel messages that arrive close together so a
  // photo and its instruction text (which Telegram may deliver as separate updates
  // — long caption split, album burst, or photo sent before/after the text) are
  // injected as ONE turn instead of two. Keyed by chatId. A trailing-edge timer
  // flushes the buffer once no new related update has arrived for the window.
  private readonly channelCoalesce = new Map<
    string,
    {
      channelSource: ChatChannel;
      entries: Array<{ content?: string; meta?: Record<string, string> }>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  // Trailing-edge debounce window for channelCoalesce, resolved once at construction.
  // Overridable via the CHANNEL_COALESCE_WINDOW_MS env var (tests shrink it for speed).
  private readonly coalesceWindowMs: number;

  // Gateway-layer turn queue (both backends). A chat is "active" from the moment
  // we inject a turn until its TRUE end signal arrives — `result` on the headless
  // backend (one per user message) or `session_idle` on pty-shell (fires only when
  // the wrapper's `this.turn` is null, i.e. after turn_duration, so it never fires
  // between PTY sub-turns). While active, further channel turns are enqueued here
  // instead of being written straight to stdin, then flushed one at a time on the
  // end signal. Without this, a mid-turn message is merged by the headless CLI as
  // steering (2 messages → 1 result, non-deterministic) or races the PTY paste.
  private readonly turnActive = new Set<string>();
  private readonly turnQueue = new Map<
    string,
    Array<{
      channelSource: ChatChannel;
      entries: Array<{ content?: string; meta?: Record<string, string> }>;
    }>
  >();
  // Per-chat monotonic epoch bumped by /stop. injectTurn() captures it at entry and
  // re-checks just before submitting; a mismatch means /stop landed during the
  // async spawn/persist window, so the injection aborts instead of submitting the
  // very turn the user asked to cancel (spawn-race close). Using an epoch (not a
  // boolean flag) avoids a stale /stop poisoning a turn the user starts afterwards.
  private readonly stopEpoch = new Map<string, number>();

  // Buffers attachment file paths registered via api_reply tool for the current API session turn.
  private readonly pendingApiAttachments = new Map<string, string[]>();

  // Session history ring-buffer (last 10 spawned, newest first)
  private readonly sessionHistory: Array<{ chatId: string; sessionId: string; source: string; mode: string; model: string; spawnedAt: number }> = [];

  // For API sessions the map key is the sessionId, so the real caller chatId
  // (e.g. the app/agent identifier) is not captured at spawn. Record it here
  // keyed by sessionId so the dashboard can show the actual chat id.
  private readonly apiChatIds = new Map<string, string>();

  // Skill registry for detecting /skill-name commands in user messages
  private skillRegistry: SkillRegistry = { skills: new Map() };

  // Skill self-improvement (planning-62). Optional — set by index.ts per agent.
  // All calls are guarded (`this.skillLearning?.`) and best-effort.
  private skillLearning?: SkillLearningManager;

  // Path to gateway config.json for persisting model changes
  private readonly configPath: string;

  // Persistent chat history database (Layer 2 — separate from session context)
  private readonly historyDb: HistoryDB;

  // Resolved agentsBaseDir for media and history paths
  private readonly agentsBaseDir: string;
  // Agent's own directory (workspace/..) — used for HistoryDB path
  private readonly agentDir: string;

  // Cancel function for the daily history cleanup timer
  private cancelCleanup: (() => void) | null = null;

  constructor(agentConfig: AgentConfig, gatewayConfig: GatewayConfig, logger?: Logger) {
    super();
    this.agentConfig = agentConfig;
    this.gatewayConfig = gatewayConfig;
    this.logger = logger ?? createLogger(agentConfig.id, gatewayConfig.gateway.logDir);

    // Resolve agentsBaseDir: workspace is at <agentsBaseDir>/<agentId>/workspace
    const agentsBaseDir = path.resolve(agentConfig.workspace, '..', '..');
    this.agentsBaseDir = agentsBaseDir;
    // agentDir is workspace/.. — used for HistoryDB so DB is at <agentDir>/history.db
    // This avoids requiring workspace to be nested at exactly <base>/<agentId>/workspace.
    this.agentDir = path.resolve(agentConfig.workspace, '..');
    this.sessionStore = new SessionStore(agentsBaseDir);
    // config.json lives 3 levels above workspace: <base>/<agentId>/workspace -> <base>/config.json
    this.configPath = path.resolve(agentConfig.workspace, '..', '..', '..', 'config.json');
    this.historyDb = HistoryDB.forDir(this.agentDir, agentConfig.id);

    this.idleTimeoutMs =
      (agentConfig.session?.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES) * 60 * 1000;
    this.maxConcurrent = agentConfig.session?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.coalesceWindowMs =
      Number(process.env.CHANNEL_COALESCE_WINDOW_MS) || CHANNEL_COALESCE_WINDOW_MS;
  }

  /**
   * Update the skill registry used for detecting /skill-name commands.
   */
  setSkillRegistry(registry: SkillRegistry): void {
    this.skillRegistry = registry;
  }

  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }

  /** Wire the skill-learning manager (planning-62). Optional; unset = feature off. */
  setSkillLearning(manager: SkillLearningManager | undefined): void {
    this.skillLearning = manager;
  }

  getSkillLearning(): SkillLearningManager | undefined {
    return this.skillLearning;
  }

  get workspacePath(): string {
    return this.agentConfig.workspace;
  }

  /**
   * Bind a local HTTP server that receives POST /channel from TelegramReceiver.
   * Each payload is routed to the appropriate SessionProcess by chat_id.
   */
  private async startCallbackServer(): Promise<void> {
    this.callbackServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        if (url.pathname === '/command') {
          this.handleCommandRequest(raw, res);
          return;
        }

        if (url.pathname === '/recover') {
          // Cross-process recovery bridge (Epic #195, Phase 3b): the receiver
          // process detects a stall but recovery must run here, where the live
          // control surfaces (session stdin, restart, safe-mode) live.
          this.handleRecoverRequest(raw, res);
          return;
        }

        // Default: /channel — existing channel message handler
        // Connection: close prevents keep-alive pool reuse: after the OS's
        // keepAliveTimeout expires the server closes the TCP connection, and the
        // receiver (Bun) can try to reuse the stale socket → "socket connection
        // was closed unexpectedly". Closing per-request avoids the race entirely.
        res.setHeader('Connection', 'close');
        res.writeHead(200);
        res.end('ok');
        try {
          const params = JSON.parse(raw) as {
            content?: string;
            meta?: Record<string, string>;
          };
          const meta = params.meta ?? {};
          const chatId = meta['chat_id'] ?? '';
          const content = params.content ?? '';

          // Set channel early so all handlers (including session commands) have it
          const channelSource = (meta['source'] === 'discord'
            ? 'discord'
            : meta['source'] === 'line'
              ? 'line'
              : meta['source'] === 'slack'
                ? 'slack'
                : 'telegram') as ChatChannel;
          this.channelSourceMap.set(chatId, channelSource);

          // Slack: remember the current message's thread context so the
          // auto-forward fallback (writeAutoForward) can stay in-thread. A
          // top-level message clears it so a later fallback isn't misrouted
          // into a thread the user already left.
          if (channelSource === 'slack') {
            const threadTs = meta['thread_ts'];
            if (threadTs) this.slackThreadTs.set(chatId, threadTs);
            else this.slackThreadTs.delete(chatId);
          }

          // LINE slow-LLM postback: stash this turn's reply token + arm the
          // button timer before the token expires. In groups/rooms the shared
          // button is disabled (armButton:false) — the token is still stashed so
          // onAnswer delivers (reply→push), just without a button.
          if (channelSource === 'line' && this.lineReply && meta['reply_token']) {
            const chatType = meta['line_chat_type'];
            this.lineReply.onInbound(chatId, meta['reply_token'], {
              armButton: chatType === undefined || chatType === 'user',
            });
          }

          // Check if this is a built-in channel command
          const trimmedContent = content.trim();
          if (isBuiltinCommand(trimmedContent, channelSource)) {
            this.handleSessionCommand(chatId, trimmedContent, meta)
              .then(() => this.writeTypingDone(chatId))
              .catch((err) => {
                this.logger.error('Session command failed', { error: (err as Error).message });
                this.writeTypingDone(chatId);
              });
            return;
          }

          // Coalesce channel messages that arrive close together into ONE turn:
          // a photo and its caption (Telegram may split them across updates —
          // long-caption split, album burst, or photo sent just before/after the
          // text), OR consecutive text messages that are conceptually a single
          // prompt (A1). Each message is still recorded individually in history
          // by routeChannelTurn(); only the injected turn is merged. A
          // trailing-edge timer flushes the buffer once the window passes with no
          // new message; the gateway turn queue then serialises this merged turn
          // behind any turn already in flight.
          const buf = this.channelCoalesce.get(chatId) ?? {
            channelSource,
            entries: [] as Array<{ content?: string; meta?: Record<string, string> }>,
            timer: undefined as unknown as ReturnType<typeof setTimeout>,
          };
          buf.channelSource = channelSource;
          buf.entries.push(params);
          if (buf.timer) clearTimeout(buf.timer);
          buf.timer = setTimeout(() => {
            const flushed = this.channelCoalesce.get(chatId);
            this.channelCoalesce.delete(chatId);
            if (flushed) this.routeChannelTurn(chatId, flushed.channelSource, flushed.entries);
          }, this.coalesceWindowMs);
          this.channelCoalesce.set(chatId, buf);
          return;
        } catch (err) {
          this.logger.warn('Failed to parse channel callback body', {
            error: (err as Error).message,
          });
        }
      });
    });

    // listen(0) lets the OS assign a free port atomically — no race window between allocate and bind
    this.callbackPort = await new Promise<number>((resolve, reject) => {
      const server = this.callbackServer!;
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as import('net').AddressInfo).port);
      });
      server.on('error', reject);
    });
    this.logger.info('Channel callback server listening', { port: this.callbackPort });
  }

  /**
   * Handle POST /recover from the receiver process (Epic #195, Phase 3b).
   * The watchdog detects a stall in the receiver, but recovery must run here in
   * the runner, where the live control surfaces live. Runs the pure executor
   * with effects bound to the affected session and returns the outcome so the
   * receiver can persist it to the incident bundle.
   */
  private async handleRecoverRequest(raw: string, res: http.ServerResponse): Promise<void> {
    const respond = (data: Record<string, unknown>, status = 200): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    let body: Partial<RecoveryRequest>;
    try {
      body = JSON.parse(raw) as Partial<RecoveryRequest>;
    } catch {
      respond({ ok: false, error: 'Invalid JSON' }, 400);
      return;
    }

    const chatId = body.chatId ?? '';
    const stage = body.stage ?? '';
    if (!chatId || !stage) {
      respond({ ok: false, error: 'missing chatId/stage' }, 400);
      return;
    }

    const session = this.sessions.get(chatId);
    const autoRecover = this.gatewayConfig.gateway.selfHealing?.autoRecover === true;

    const req: RecoveryRequest = {
      incidentId: body.incidentId ?? '',
      agentId: this.agentConfig.id,
      chatId,
      // Prefer the live session's id (survives a request that names a stale one).
      sessionId: session?.sessionId ?? body.sessionId ?? '',
      stage,
      failureClass: body.failureClass ?? null,
      turnKey: body.turnKey ?? chatId,
    };

    // Skill-learning: an incident-driven recovery attempt on this chat's turn.
    this.skillLearning?.onRecoveryFired(chatId);
    try {
      const result = await runRecovery(req, {
        autoRecover,
        effects: this.buildRecoveryEffects(chatId),
        now: () => Date.now(),
        budget: {
          get: (turnKey) => this.recoveryBudgets.get(turnKey) ?? initialBudget(turnKey),
          set: (s) => {
            this.recoveryBudgets.set(s.turnKey, s);
            this.pruneRecoveryBudgets(s.lastAt);
          },
        },
        // Live triage is the most sensitive surface — only ever run when the
        // operator has opted in. When off, the executor uses the deterministic
        // per-stage default action (still whitelist-clamped).
        triageSpawn: autoRecover ? this.recoveryTriageSpawn : undefined,
        gatherEvidence: async () => {
          const s = this.sessions.get(chatId);
          if (!s) return null;
          try {
            const snap = await ptyStreamRegistry.screenText(s.sessionId);
            if (!snap) return null;
            // Scrub the untrusted screen before it leaves the process / reaches
            // the triage model. Redact the chat id explicitly on top of the
            // pattern-based secret scrub.
            return { screenText: scrubText(snap.text, [chatId]) };
          } catch {
            return null;
          }
        },
        resendAfterRecover: autoRecover,
        log: (msg, meta) => this.logger.info(msg, meta),
      });
      respond({ ok: true, outcome: toRecoveryOutcome(result), result });
    } catch (err) {
      this.logger.error('Recovery attempt failed', { chatId, stage, error: (err as Error).message });
      respond({ ok: false, error: (err as Error).message }, 500);
    }
  }

  /**
   * Route raw interactive-terminal input to the session with this actual
   * sessionId (Issue #201). The dashboard's Terminal Viewer input mode
   * streams keystrokes here via the pty-stream WebSocket. Sessions are keyed by
   * chatId internally, so we match on the process's own sessionId. Returns true
   * only when a live pty-shell session accepted the bytes (headless / missing /
   * not-writable → false), so the caller can surface an accurate result.
   */
  sendInputToSession(sessionId: string, data: string): boolean {
    if (!sessionId || typeof data !== 'string' || data.length === 0) return false;
    for (const proc of this.sessions.values()) {
      if (proc.sessionId === sessionId) {
        return proc.sendInput(data);
      }
    }
    return false;
  }

  /**
   * Build the recovery effects bound to one chat's session (Phase 3b). Each
   * effect resolves the session fresh so it survives a restart mid-recovery.
   * Keystroke effects go through the wrapper control channel; restart/backend
   * effects act on the session and safe-mode manager. Effects intentionally
   * omitted (redeliver-forward, restart-receiver, bridge-menu) are transport /
   * wrapper concerns not bridged to the runner — the executor reports them as
   * unsupported rather than guessing.
   */
  private buildRecoveryEffects(chatId: string): RecoveryEffects {
    const control = (key: string, option?: number): void => {
      this.sessions.get(chatId)?.sendControl(key, option);
    };
    return {
      esc: () => control('esc'),
      escEsc: () => control('esc-esc'),
      enter: () => control('enter'),
      selectOption: (option: number) => control('select-option', option),
      restartSession: () => this.restartProcess(chatId),
      fallbackHeadless: async () => {
        // Flip to the headless backend, then restart so the new session respawns
        // headless (spawnSession reads safeMode.isActive → forceHeadless).
        this.safeMode.enter(this.agentConfig.id, 'recovery: fallback-headless');
        await this.restartProcess(chatId);
      },
      resendLast: () => {
        const lt = this.lastTurn.get(chatId);
        // Guard: only resend a turn that produced no output and was not already
        // resent — never double-submit.
        if (!lt || lt.delivered || lt.resent) return false;
        const s = this.sessions.get(chatId);
        if (!s) return false;
        lt.resent = true;
        s.setProcessing(true);
        s.sendMessage(lt.text);
        s.touch();
        return true;
      },
    };
  }

  /**
   * Evict finished-turn budget entries (Epic #195, Phase 3b). Called on each
   * budget write so the per-turn map cannot grow without bound on a long-lived
   * runner. `nowMs` is the timestamp of the write just made; any entry whose last
   * attempt predates the TTL belongs to a turn that is no longer being recovered.
   */
  private pruneRecoveryBudgets(nowMs: number): void {
    const cutoff = nowMs - RECOVERY_BUDGET_TTL_MS;
    for (const [key, state] of this.recoveryBudgets) {
      if (state.lastAt < cutoff) this.recoveryBudgets.delete(key);
    }
  }

  /**
   * One-shot local `claude -p` triage runner (Phase 3b). Feeds the closed
   * classification prompt on stdin and returns raw stdout. Hard timeout →
   * timedOut, which the executor collapses to a safe notify-only verdict. Only
   * invoked when autoRecover is enabled.
   */
  private recoveryTriageSpawn = async (
    prompt: string,
  ): Promise<{ stdout: string; timedOut?: boolean }> => {
    const { spawn } = await import('child_process');
    return new Promise((resolve) => {
      let done = false;
      let out = '';
      const finish = (r: { stdout: string; timedOut?: boolean }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish({ stdout: '', timedOut: true });
      }, RECOVERY_TRIAGE_TIMEOUT_MS);
      const child = spawn('claude', ['-p', '--output-format', 'text'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      child.stdout?.on('data', (d) => { out += String(d); });
      child.on('error', () => finish({ stdout: '', timedOut: true }));
      child.on('close', () => finish({ stdout: out }));
      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch {
        finish({ stdout: '', timedOut: true });
      }
    });
  };

  /**
   * Create a `/cli` webview pairing for an already-authenticated chat user.
   * Shared by the receiver callback (Telegram/Discord subprocesses) and the
   * in-process LINE webhook so both mint links the same way. Returns null when
   * `gateway.publicUrl` is not configured (no link can be built).
   */
  createCliPairing(
    channel: CliChannel,
    userId: string,
  ): { pairingId: string; code: string; url: string } | null {
    if (!isCliChannel(channel) || !userId) return null;
    if (!buildCliUrl(this.gatewayConfig.gateway.publicUrl, 'probe')) return null;
    const { pairingId, code } = cliPairingStore.create(this.agentConfig.id, channel, userId);
    return { pairingId, code, url: buildCliUrl(this.gatewayConfig.gateway.publicUrl, pairingId)! };
  }

  /** Approve (or deny) a `/cli` pairing on behalf of the authenticated chat user. */
  approveCliPairing(
    channel: CliChannel,
    pairingId: string,
    userId: string,
    deny = false,
  ): 'ok' | 'mismatch' | 'gone' {
    return deny
      ? cliPairingStore.deny(pairingId, channel, userId)
      : cliPairingStore.approve(pairingId, channel, userId);
  }

  /**
   * Handle POST /command requests from the receiver process.
   * Supports: get_model, set_model, restart.
   */
  private async handleCommandRequest(raw: string, res: http.ServerResponse): Promise<void> {
    const respond = (data: Record<string, unknown>, status = 200): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    let body: { command?: string; chat_id?: string; payload?: Record<string, unknown> };
    try {
      body = JSON.parse(raw);
    } catch {
      respond({ success: false, error: 'Invalid JSON' }, 400);
      return;
    }

    const command = body.command;

    if (command === 'get_model') {
      respond({ model: this.agentConfig.claude.model });
      return;
    }

    if (command === 'get_models') {
      // Live catalog first, static list as the fallback (issue #409). The
      // picker is a UI action, so a slow or unreachable catalog must not hang
      // it — fetchModelCatalog is bounded and never rejects.
      void this.availableModels()
        .then((availableModels) => {
          const configuredIds = new Set((this.gatewayConfig.gateway.models ?? DEFAULT_MODELS).map(m => m.id));
          const configured = availableModels.filter(m => configuredIds.has(m.id));
          const live = availableModels.filter(m => !configuredIds.has(m.id));
          respond({
            models: availableModels.map(m => ({ id: m.id, label: m.label })),
            configuredModels: configured.map(m => ({ id: m.id, label: m.label })),
            liveModels: live.map(m => ({ id: m.id, label: m.label })),
          });
        })
        // Without this the request would hang and the picker with it: the
        // receiver is blocked on this response. Every other async branch in
        // this handler answers on rejection too.
        .catch((err) => respond({ success: false, error: String(err) }, 500));
      return;
    }

    // `/cli` webview terminal viewer — create a pairing on behalf of an
    // already-authenticated chat user. The channel receiver has verified the
    // user against its allowlist before calling this; we bind the pairing to that
    // (channel, user) so only that same user can approve it or (Telegram) match
    // its initData. The browser-facing routes live on the gateway; here we only
    // mint the pairing and hand back the phone-openable link.
    if (command === 'cli_pair') {
      const payload = body.payload ?? {};
      const channel = payload['channel'];
      const userId = typeof payload['user_id'] === 'string' ? payload['user_id'] : '';
      if (!isCliChannel(channel) || !userId) {
        respond({ success: false, error: 'invalid_request' }, 400);
        return;
      }
      const pairing = this.createCliPairing(channel, userId);
      if (!pairing) {
        respond({ success: false, error: 'not_configured' });
        return;
      }
      respond({ success: true, ...pairing });
      return;
    }

    // `/cli` approve/deny — the authenticated chat user acted on the pairing.
    if (command === 'cli_approve') {
      const payload = body.payload ?? {};
      const channel = payload['channel'];
      const pairingId = typeof payload['pairing_id'] === 'string' ? payload['pairing_id'] : '';
      const userId = typeof payload['user_id'] === 'string' ? payload['user_id'] : '';
      const deny = payload['deny'] === true;
      if (!isCliChannel(channel) || !pairingId || !userId) {
        respond({ success: false, error: 'invalid_request' }, 400);
        return;
      }
      const result = this.approveCliPairing(channel, pairingId, userId, deny);
      respond({ success: result === 'ok', result });
      return;
    }

    if (command === 'set_model') {
      const newModel = typeof body.payload?.model === 'string' ? body.payload.model : '';

      try {
        await this.setModel(newModel);
      } catch (err) {
        respond({ success: false, error: (err as Error).message });
        return;
      }

      const restarted = await this.restartChannelSessions();

      respond({ success: true, model: newModel, restarted });
      return;
    }

    if (command === 'restart') {
      const chatId = body.chat_id ?? '';
      const session = this.sessions.get(chatId);
      if (!session) {
        respond({ success: true, restarted: false });
        return;
      }

      await this.restartProcess(chatId);
      respond({ success: true, restarted: true });
      return;
    }

    if (command === 'session_clear_confirm') {
      const chatId = body.chat_id ?? '';
      try {
        await this.handleCommandClear(this.agentConfig.id, chatId);
        respond({ success: true });
      } catch (err) {
        respond({ success: false, error: String(err) });
      }
      return;
    }

    if (command === 'list_sessions') {
      const chatId = body.chat_id ?? '';
      try {
        const index = await this.sessionStore.listSessions(this.agentConfig.id, chatId, this.channelFor(chatId));
        return respond({ sessions: index.sessions, activeSessionId: index.activeSessionId });
      } catch {
        return respond({ success: false, error: 'Failed to list sessions' });
      }
    }

    if (command === 'session_info') {
      const chatId = body.chat_id ?? '';
      try {
        const index = await this.sessionStore.listSessions(this.agentConfig.id, chatId, this.channelFor(chatId));
        const meta = index.sessions.find(s => s.id === index.activeSessionId);
        if (!meta) {
          return respond({ success: true, text: 'No active session found.' });
        }
        const effectiveModel = this.agentConfig.claude.model;
        const contextWindow = await this.contextWindowFor(effectiveModel);
        const contextTokens = meta.lastInputTokens ?? 0;
        const usedPct = Math.round((contextTokens / contextWindow) * 100);
        let msgs: string;
        if (meta.messageCount <= 0) {
          msgs = 'No messages yet';
        } else if ((meta.archivedCount ?? 0) > 0 && meta.loadedAtSpawn != null && meta.messageCountAtSpawn != null) {
          const newMessagesSinceSpawn = meta.messageCount - meta.messageCountAtSpawn;
          const inContext = meta.loadedAtSpawn + Math.max(0, newMessagesSinceSpawn);
          msgs = `${meta.messageCount} (${inContext} in context / ${meta.archivedCount} archived)`;
        } else {
          msgs = `${meta.messageCount}`;
        }
        const lines = [
          `📌 Current Session: ${meta.name}`,
          `<code>${meta.id}</code>`,
          '',
          `📥 Messages: ${msgs}`,
          `👉 Context: ${usedPct}%`,
        ];
        if (usedPct >= 80) {
          lines.push('', '💡 Near limit — consider /compact');
        }
        lines.push('', 'Commands: /sessions /new /rename /clear /compact');
        return respond({ success: true, text: lines.join('\n'), format: 'html' });
      } catch {
        return respond({ success: false, text: 'Failed to get session info.' });
      }
    }

    if (command === 'switch_session') {
      const chatId = body.chat_id ?? '';
      const sessionId = typeof body.payload?.session_id === 'string' ? body.payload.session_id : '';
      if (!sessionId) {
        respond({ success: false, error: 'Missing session_id' });
        return;
      }
      this.switchSession(chatId, sessionId)
        .then(async () => {
          const index = await this.sessionStore.listSessions(this.agentConfig.id, chatId, this.channelFor(chatId));
          const session = index.sessions.find(s => s.id === sessionId);
          respond({ success: true, sessionName: session?.name ?? sessionId });
        })
        .catch(err => respond({ success: false, error: String(err) }));
      return;
    }

    if (command === 'delete_session') {
      const chatId = body.chat_id ?? '';
      const sessionId = typeof body.payload?.session_id === 'string' ? body.payload.session_id : '';
      if (!sessionId) {
        respond({ success: false, error: 'Missing session_id' });
        return;
      }
      this.sessionStore.deleteTelegramSession(this.agentConfig.id, chatId, sessionId, this.channelFor(chatId))
        .then(async () => {
          const newIndex = await this.sessionStore.listSessions(this.agentConfig.id, chatId, this.channelFor(chatId));
          await this.restartProcess(chatId);
          const activeMeta = newIndex.sessions.find(s => s.id === newIndex.activeSessionId);
          respond({ success: true, sessionName: activeMeta?.name ?? newIndex.activeSessionId });
        })
        .catch(err => respond({ success: false, error: String(err) }));
      return;
    }

    if (command === 'new_session') {
      const chatId = body.chat_id ?? '';
      const name = typeof body.payload?.name === 'string' ? body.payload.name : undefined;
      this.handleCommandNew(this.agentConfig.id, chatId, name)
        .then(() => respond({ success: true }))
        .catch(err => respond({ success: false, error: String(err) }));
      return;
    }

    if (command === 'compact_confirm') {
      const chatId = body.chat_id ?? '';
      this.handleCommandCompact(this.agentConfig.id, chatId)
        .then(() => this.writeTypingDone(chatId))
        .catch(() => this.writeTypingDone(chatId));
      return respond({ success: true });
    }

    respond({ success: false, error: 'Unknown command' }, 400);
  }

  /**
   * Persist the current model to config.json using atomic write (tmp + rename).
   *
   * Runs under the process-wide config write lock: the read and the rename below are
   * synchronous and so cannot interleave with each other, but without the lock they
   * can still land between an async writer's read and its own rename — dropping this
   * model change, or being dropped by it. See config/config-write-lock.ts.
   */
  private persistModelToConfig(newModel: string): Promise<void> {
    return withConfigWriteLock(this.configPath, () => {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const config = JSON.parse(raw);
      const agent = config.agents?.find((a: { id: string }) => a.id === this.agentConfig.id);
      if (agent) {
        agent.claude.model = newModel;
        writeConfigAtomicSync(this.configPath, config);
      }
    });
  }

  private static escapeXmlAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private resolveMediaPaths(mediaFiles: string[]): string[] {
    const paths: string[] = [];
    for (const relPath of mediaFiles.slice(0, MAX_API_IMAGES)) {
      try {
        paths.push(MediaStore.resolvePath(this.agentsBaseDir, this.agentConfig.id, relPath));
      } catch (err) {
        this.logger.warn('Failed to resolve media path', { relPath, err });
      }
    }
    return paths;
  }

  /**
   * Inject one or more coalesced channel messages as a SINGLE turn. Each entry is
   * still recorded individually (session history + permanent history DB), but their
   * channel XML blocks are concatenated and delivered in one sendMessage() call so
   * a photo and its instruction text are read together in the same turn.
   */
  private routeChannelTurn(
    chatId: string,
    channelSource: ChatChannel,
    entries: Array<{ content?: string; meta?: Record<string, string> }>,
  ): void {
    if (entries.length === 0) return;
    // Gateway turn queue: if a turn is already in flight for this chat, enqueue
    // this one and return. It is injected when the active turn truly ends
    // (flushNextTurn, wired to the backend-aware end signal). The check-and-set
    // is synchronous, so two near-simultaneous routes cannot both inject, and
    // the active flag stays set continuously across a flush (no re-entrancy gap).
    if (this.turnActive.has(chatId)) {
      const q = this.turnQueue.get(chatId) ?? [];
      q.push({ channelSource, entries });
      this.turnQueue.set(chatId, q);
      this.logger.debug('Turn queued behind in-flight turn', { chatId, queued: q.length });
      return;
    }
    this.turnActive.add(chatId);
    this.injectTurn(chatId, channelSource, entries);
  }

  /**
   * Inject the next queued turn for this chat, or release the active slot when the
   * queue is empty. Called when a turn truly ends — `result` (headless), or
   * `session_idle` (pty-shell), or on process exit. `turnActive` is kept set while
   * a queued turn exists so no incoming message can inject concurrently.
   */
  private flushNextTurn(chatId: string): void {
    const q = this.turnQueue.get(chatId);
    if (q && q.length > 0) {
      const next = q.shift()!;
      if (q.length === 0) this.turnQueue.delete(chatId);
      this.injectTurn(chatId, next.channelSource, next.entries);
    } else {
      this.turnActive.delete(chatId);
      this.turnQueue.delete(chatId);
    }
  }

  /**
   * Delete a channel's throwaway staging copy of an inbound attachment, once
   * MediaStore holds the permanent one.
   *
   * Opt-in via `meta.media_ephemeral === '1'` — only a channel that created the
   * file under the system temp dir sets it, and only for a path it built itself.
   * Meta arrives over the local /channel intake, so the flag alone is not
   * authority to unlink: the path is resolved (symlinks included) and must sit
   * INSIDE the real temp dir, which bounds a forged flag to deleting something
   * already in a world-writable scratch directory. Every failure is swallowed —
   * a leftover temp file is a wart, and a throw here would abort recording the
   * turn that was already delivered.
   */
  private static discardEphemeralStaging(stagedPath: string): void {
    try {
      const tmpRoot = fs.realpathSync(os.tmpdir());
      const real = fs.realpathSync(stagedPath);
      const rel = path.relative(tmpRoot, real);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
      fs.rmSync(real, { force: true });
    } catch {
      // Already gone, unreadable, or outside the temp dir — leave it alone.
    }
  }

  /**
   * Inject one coalesced turn into the session immediately. The caller must have
   * already marked the chat active in `turnActive`. Records each buffered message
   * individually in history, then writes the merged turn to the subprocess.
   */
  private injectTurn(
    chatId: string,
    channelSource: ChatChannel,
    entries: Array<{ content?: string; meta?: Record<string, string> }>,
  ): void {
    // Snapshot the stop epoch: if /stop bumps it during the async window below, we
    // abort just before submitting (see the check before setProcessing/sendMessage).
    const stopEpochAtStart = this.stopEpoch.get(chatId) ?? 0;
    this.sessionStore.getActiveSessionId(this.agentConfig.id, chatId, channelSource)
      .then(async (sessionId) => {
        // Record each buffered message individually (history + session context).
        for (const entry of entries) {
          const meta = entry.meta ?? {};
          const content = entry.content ?? '';
          const userContent = content || (meta['attachment_file_id'] || meta['image_path'] ? '(photo)' : '');
          const userTs = Date.now();
          await this.sessionStore.appendTelegramMessage(this.agentConfig.id, chatId, sessionId, {
            role: 'user',
            content: userContent,
            ts: userTs,
          }, channelSource);

          // Persist to permanent history DB (separate from session context)
          const mediaFiles: string[] = [];
          if (meta['image_path']) {
            const stagedPath = meta['image_path'];
            try {
              const rel = MediaStore.copyToMedia(this.agentsBaseDir, this.agentConfig.id, `${channelSource}-${chatId}`, meta['image_path']);
              mediaFiles.push(rel);
              // Surface the MediaStore copy to the agent instead of the raw staging
              // path. app-agents run in a container where only the MediaStore dir is
              // bind-mounted at an identical absolute path; the raw source (/tmp for
              // LINE, <workspace>/.*-state for TG/Discord) is invisible inside it.
              // Mutating meta['image_path'] here (same object as entry.meta) makes the
              // channel XML and image-size tracker below both use the readable path.
              meta['image_path'] = MediaStore.resolvePath(this.agentsBaseDir, this.agentConfig.id, rel);
              // The staging copy has served its purpose — drop it (see
              // discardEphemeralStaging). Only after a SUCCESSFUL copy: the catch
              // below keeps the original path as the agent's only route to the bytes.
              if (meta['media_ephemeral'] === '1') AgentRunner.discardEphemeralStaging(stagedPath);
            } catch {
              // Non-fatal — leave the original path so host agents still read it
            }
          }
          this.historyDb.insertMessage({
            chatId: `${channelSource}-${chatId}`,
            sessionId,
            source: channelSource as HistorySource,
            role: 'user',
            content: userContent,
            senderName: meta['sender_name'] ?? meta['user'] ?? undefined,
            senderId: meta['user_id'] ?? meta['chat_id'] ?? undefined,
            platformMessageId: meta['message_id'] ?? undefined,
            mediaFiles: mediaFiles.length > 0 ? mediaFiles : undefined,
            ts: userTs,
          });
        }

        // Consume a deferred restart before this turn (armed by the image-size
        // threshold, or by a workspace/skills change that deferred this idle
        // session). Guard on isProcessing: this same chatId key can be driven by
        // a web-UI live-view turn (sendMessageToSession) that does NOT hold
        // turnActive, so the session may be mid-stream here. Stopping it would
        // truncate that live turn — instead leave the flag armed and consume it
        // on the next idle turn. In the normal channel flow the session is idle
        // at this point (turnActive serialises channel turns), so the guard is a
        // no-op and the restart proceeds as before.
        if (this.pendingRestarts.has(chatId)) {
          const existingSession = this.sessions.get(chatId);
          if (!existingSession?.isProcessing) {
            if (existingSession) {
              await existingSession.stop();
              this.sessions.delete(chatId);
            }
            this.pendingRestarts.delete(chatId);
            this.imageSizePerChat.delete(chatId);
          }
        }

        // Route to session process (map key = chatId, actual sessionId passed separately)
        // Channel sessions use agent-level model (not per-session)
        const session = await this.getOrSpawnSession(chatId, channelSource, sessionId);

        // Merge buffered messages into one turn: concat channel XML blocks, append
        // any skill context, and accumulate image paths for size tracking.
        const blocks: string[] = [];
        const invokedSkills: string[] = [];
        for (const entry of entries) {
          let channelXml = AgentRunner.buildChannelXml(entry);
          const skillInvocation = detectSkillCommand(entry.content ?? '', this.skillRegistry);
          if (skillInvocation) {
            channelXml += formatSkillContext(skillInvocation);
            invokedSkills.push(skillInvocation.skillKey);
            this.logger.info('Skill invoked', {
              skill: skillInvocation.skillKey,
              args: skillInvocation.args,
              chatId,
            });
          }
          blocks.push(channelXml);

          const imagePath = entry.meta?.['image_path'];
          // Non-image attachments (LINE files) ride the same image_path channel so
          // the runner stages them into MediaStore, but they must NOT count toward
          // the image-size restart budget below: that budget exists because images
          // are pulled into context as pixels, whereas a document the agent may
          // never open would push the chat into a summary+restart it never needed.
          // media_type is set by the LINE router alone; everything else (Telegram,
          // Slack, web upload) omits it and keeps counting as an image.
          const isImageMedia = (entry.meta?.['media_type'] ?? 'image') === 'image';
          if (imagePath && isImageMedia) {
            const queue = this.pendingImagePaths.get(chatId) ?? [];
            queue.push(imagePath);
            this.pendingImagePaths.set(chatId, queue);
          }
        }

        // Spawn-race close: if /stop bumped the stop epoch during the async
        // getActiveSessionId/spawn window above, abort before submitting — do not
        // inject the very turn the user just asked to cancel. flushNextTurn()
        // releases the (now empty, /stop cleared it) queue and the active slot.
        if ((this.stopEpoch.get(chatId) ?? 0) !== stopEpochAtStart) {
          this.logger.info('Turn injection aborted — /stop landed during spawn', { chatId });
          this.flushNextTurn(chatId);
          return;
        }

        session.setProcessing(true);
        const turnText = blocks.join('\n');
        // Skill-learning: mark the start of a user turn (cheap, best-effort).
        this.skillLearning?.onTurnStart(chatId, sessionId, entries[0]?.content ?? '', invokedSkills);
        session.sendMessage(turnText);
        // Remember this turn for the C1 guarded resend (Phase 3b): reset the
        // delivered/resent flags so a resend can only fire if this turn stalls
        // before producing output.
        this.lastTurn.set(chatId, { text: turnText, delivered: false, resent: false });
        session.touch();
        this.logger.debug('Injected channel turn into session', {
          chatId,
          sessionId,
          messages: entries.length,
        });
      })
      .catch((err) => {
        this.logger.error('Failed to route message to session', {
          chatId,
          error: (err as Error).message,
        });
        const code = (err as Error).message.includes('pool full') ? 'POOL_FULL' : 'SPAWN_FAILED';
        this.writeTypingError(chatId, code);
        // This turn never reached the subprocess, so no end signal will fire —
        // release the active slot and inject the next queued turn so the queue
        // cannot wedge on a spawn error.
        this.flushNextTurn(chatId);
      });
  }

  /**
   * Render composer-selected image options (contract E5) as a directive the agent
   * reads and forwards to the generate_image MCP tool. Returns '' when no usable
   * options are present.
   */
  private static buildImageParamsNote(p: ImageParams): string {
    const attrs = [
      p.model ? `model="${AgentRunner.escapeXmlAttr(p.model)}"` : '',
      p.quality ? `quality="${AgentRunner.escapeXmlAttr(p.quality)}"` : '',
      p.size ? `size="${AgentRunner.escapeXmlAttr(p.size)}"` : '',
      p.aspect_ratio ? `aspect_ratio="${AgentRunner.escapeXmlAttr(p.aspect_ratio)}"` : '',
      typeof p.n === 'number' ? `n="${p.n}"` : '',
      p.image_ref ? `image_ref="${AgentRunner.escapeXmlAttr(p.image_ref)}"` : '',
    ].filter(Boolean);
    const refs = (p.image_refs ?? []).filter((r) => typeof r === 'string' && r.trim().length > 0);
    if (!attrs.length && !refs.length) return '';
    if (!refs.length) {
      return (
        `<image-params ${attrs.join(' ')} />\n` +
        `The user selected the image-generation options above in the composer. When the request ` +
        `involves creating or editing an image, call the generate_image tool (action="generate") ` +
        `using these values (pass image_ref as the "image" argument for image-to-image), then ` +
        `deliver the returned image with your reply tool.\n`
      );
    }
    // Explicitly selected reference images (#73). Rendered as nested elements so a
    // ref containing separators (commas, quotes) stays unambiguous.
    const openTag = attrs.length ? `<image-params ${attrs.join(' ')}>` : '<image-params>';
    const refLines = refs
      .map((r, i) => `  <ref index="${i + 1}">${AgentRunner.escapeXmlAttr(r.trim())}</ref>`)
      .join('\n');
    const passInstruction =
      refs.length === 1
        ? `Pass that single ref as the "image" argument of generate_image.`
        : `Pass all ${refs.length} refs as the "images" argument of generate_image, in the same order.`;
    return (
      `${openTag}\n${refLines}\n</image-params>\n` +
      `The user selected the image-generation options above in the composer. When the request ` +
      `involves creating or editing an image, call the generate_image tool (action="generate") ` +
      `using these values, then deliver the returned image with your reply tool.\n` +
      `The user explicitly SELECTED the reference image(s) listed above in the composer, in this order. ` +
      `${passInstruction} Do NOT reinterpret which images they are, do NOT call list_refs to ` +
      `second-guess an explicit selection, and do not drop any of them. ` +
      `Do NOT open or Read the referenced files first — the image model receives the actual files; ` +
      `reading them wastes minutes and can push the request past its timeout. Go straight to generate_image.\n`
    );
  }

  /**
   * The durable slice of the composer image options — everything except
   * `image_refs`, which is a per-turn explicit selection (#73) and must never be
   * restored as sticky session config. Returns undefined when nothing is durable.
   */
  private static durableImageConfig(p: ImageParams): ImageParams | undefined {
    const { image_refs: _refs, ...durable } = p;
    return Object.keys(durable).length ? durable : undefined;
  }

  /**
   * The web builds image_ref/image_refs from the paths the upload endpoint
   * returned — the ui-upload STAGING paths. promoteUiUploads then MOVES those
   * files into per-session storage, so a note or history row built from the
   * raw params would hand out dead paths (the agent's generate_image call
   * fails share_ref_not_found and has to guess its way to the real file).
   * Substitute every ref that matches a promoted staging path with its new
   * session path; refs that were never staged (catalog refs, artifact:<id>)
   * pass through untouched. (#74)
   */
  static remapImageParamsRefs(
    p: ImageParams | undefined,
    stagedPaths: readonly string[] | undefined,
    promotedPaths: readonly string[] | undefined,
  ): ImageParams | undefined {
    if (!p || !stagedPaths?.length || !promotedPaths?.length) return p;
    const map = new Map<string, string>();
    for (let i = 0; i < Math.min(stagedPaths.length, promotedPaths.length); i++) {
      const from = stagedPaths[i]!;
      const to = promotedPaths[i]!;
      if (from !== to) map.set(from, to);
    }
    if (!map.size) return p;
    const remap = (r: string): string => map.get(r) ?? r;
    return {
      ...p,
      ...(p.image_ref ? { image_ref: remap(p.image_ref) } : {}),
      ...(p.image_refs?.length ? { image_refs: p.image_refs.map(remap) } : {}),
    };
  }

  private static buildChannelXml(params: {
    content?: string;
    meta?: Record<string, string>;
  }): string {
    const meta = params.meta ?? {};
    const optionalAttrs = [
      'image_path',
      'attachment_file_id',
      'attachment_kind',
      'attachment_mime',
      'attachment_name',
      'user_id',     // LINE: the userId the session passes back to line_reply
      'reply_token', // LINE: single-use reply token (push is preferred; surfaced for completeness)
      'thread_ts',   // Slack: set when the inbound message is inside a thread — pass back as thread_id to slack_reply to reply in-thread
      // NOTE: message_id is NOT listed here — the base <channel> template below
      // already unconditionally emits it; adding it here would duplicate the
      // attribute in the XML whenever meta.message_id is set (any channel).
    ]
      .filter(k => meta[k])
      .map(k => ` ${k}="${meta[k]!.replace(/"/g, '&quot;')}"`)
      .join('');

    // Build nested <replied> block if this message is a reply to another
    let repliedBlock = '';
    if (meta['replied_message_id']) {
      const repliedAttrs = [
        'replied_image_path',
      ]
        .filter(k => meta[k])
        .map(k => ` ${k}="${meta[k]!.replace(/"/g, '&quot;')}"`)
        .join('');
      repliedBlock =
        `<replied message_id="${meta['replied_message_id']}" ` +
        `user="${(meta['replied_user'] ?? '').replace(/"/g, '&quot;')}"${repliedAttrs}>` +
        `${(meta['replied_text'] ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}` +
        `</replied>`;
    }

    const source = meta['source'] ?? 'telegram';
    return (
      `<channel source="${source}" chat_id="${meta['chat_id'] ?? ''}" ` +
      `message_id="${meta['message_id'] ?? ''}" user="${AgentRunner.escapeXmlAttr(meta['user'] ?? '')}" ` +
      `ts="${meta['ts'] ?? new Date().toISOString()}"${optionalAttrs}>${repliedBlock}${params.content ?? ''}</channel>`
    );
  }

  /**
   * Await a SessionProcess's in-flight crash-triggered auto-restart
   * (scheduleRestart's setTimeout → spawnProcess) instead of handing back a
   * process whose sendMessage() will silently no-op. Resolves once the new
   * child is attached ('restarted'); rejects on a definitive restart failure
   * ('restartFailed', or 'failed' once MAX_RESTARTS is exhausted) or, as a
   * last resort, on SESSION_RESTART_WAIT_TIMEOUT_MS so a caller is never left
   * hanging past that bound.
   */
  private waitForSessionRestart(proc: SessionProcess): Promise<void> {
    if (proc.isRunning()) return Promise.resolve();
    // Dead with no respawn in flight → the restarted/restartFailed/failed events
    // this waits on will never fire, so blocking for the full timeout only to
    // reject is pointless. Fail fast so the caller recovers immediately. (The
    // primary caller, getOrSpawnSession, already guards on isRestartScheduled()
    // and respawns instead of calling here; this is a defence-in-depth backstop
    // for any other caller.) See #371.
    if (!proc.isRestartScheduled()) {
      return Promise.reject(new Error('Session is not running and no restart is scheduled'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Session restart did not complete in time'));
      }, SESSION_RESTART_WAIT_TIMEOUT_MS);
      const onRestarted = () => { cleanup(); resolve(); };
      const onRestartFailed = (err: Error) => { cleanup(); reject(err); };
      const onFailed = () => { cleanup(); reject(new Error('Session failed permanently (max restarts exceeded)')); };
      const cleanup = () => {
        clearTimeout(timer);
        proc.off('restarted', onRestarted);
        proc.off('restartFailed', onRestartFailed);
        proc.off('failed', onFailed);
      };
      proc.once('restarted', onRestarted);
      proc.once('restartFailed', onRestartFailed);
      proc.once('failed', onFailed);
    });
  }

  private async getOrSpawnSession(
    mapKey: string,              // Map lookup key (chatId for telegram/discord, sessionId for API)
    source: ChatChannelOrApi,
    sessionId?: string,          // actual session UUID (only for channel sessions; equals mapKey for API)
    modelOverride?: string,      // per-session model override from SessionMeta
  ): Promise<SessionProcess> {
    // Normalize: treat agent-default model as "no override" so default sessions
    // don't restart unnecessarily when the frontend explicitly sends the default model.
    const agentDefaultModel = this.agentConfig.claude.model;
    const effectiveOverride = (modelOverride && modelOverride !== agentDefaultModel)
      ? modelOverride
      : undefined;

    // If a spawn is already in progress for this key, wait for it instead of spawning a second one
    const pending = this.sessionSpawnLocks.get(mapKey);
    if (pending) return pending;

    const existing = this.sessions.get(mapKey);
    if (existing) {
      // The mapped SessionProcess can be mid auto-restart (its child crashed —
      // see the 'exit'/scheduleRestart cycle in session/process.ts — and the
      // AUTO_RESTART_DELAY_MS timer hasn't fired the replacement child yet).
      // existing.sendMessage() silently no-ops while .process is null (only a
      // warning log, no error, no event), which previously left the caller's
      // pendingApiSessions entry stuck until the long timeout chain (the same
      // failure mode this whole area was already patched for — see the
      // session.on('exit', onExit) fix in sendApiMessage/sendApiMessageStream —
      // but THIS gap is hit before a turn even starts, so that fix can't see
      // it). Wait for the pending respawn to actually land before handing the
      // session back.
      //
      // But only wait if a respawn is actually in flight. A session can also be
      // dead with NOTHING coming — permanently failed (max restarts), or stopped
      // without eviction. Handing that corpse back would wedge the caller:
      // sendMessage() no-ops on a null child, and waitForSessionRestart would
      // block for the full timeout waiting on a restarted/failed event that will
      // never fire. Drop it and spawn a fresh session instead so the message is
      // served immediately. See #371.
      if (!existing.isRunning()) {
        if (existing.isRestartScheduled()) {
          await this.waitForSessionRestart(existing);
        } else {
          this.logger.warn('Mapped session is dead with no restart in flight — respawning fresh', {
            mapKey, source,
          });
          const respawn = (async () => {
            await existing.stop();          // idempotent on a dead child; closes watchers + signal file
            this.sessions.delete(mapKey);
            return this.spawnSession(mapKey, source, sessionId, effectiveOverride);
          })();
          this.sessionSpawnLocks.set(mapKey, respawn);
          try {
            return await respawn;
          } finally {
            this.sessionSpawnLocks.delete(mapKey);
          }
        }
      }

      // Restart if model changed (including switching back to the agent default)
      if (existing.modelOverride !== effectiveOverride) {
        this.logger.info('Model changed, restarting session', { mapKey, oldModel: existing.modelOverride, newModel: effectiveOverride ?? agentDefaultModel });
        const respawn = (async () => {
          await existing.stop();
          this.sessions.delete(mapKey);
          return this.spawnSession(mapKey, source, sessionId, effectiveOverride);
        })();
        this.sessionSpawnLocks.set(mapKey, respawn);
        try {
          return await respawn;
        } finally {
          this.sessionSpawnLocks.delete(mapKey);
        }
      } else {
        return existing;
      }
    }

    // No existing session — acquire lock for the spawn path
    const spawnPromise = this.spawnSession(mapKey, source, sessionId, effectiveOverride);
    this.sessionSpawnLocks.set(mapKey, spawnPromise);
    try {
      return await spawnPromise;
    } finally {
      this.sessionSpawnLocks.delete(mapKey);
    }
  }

  private async spawnSession(
    mapKey: string,
    source: ChatChannelOrApi,
    sessionId?: string,
    modelOverride?: string,
  ): Promise<SessionProcess> {

    // Evict oldest idle session if at capacity
    if (this.sessions.size >= this.maxConcurrent) {
      const sorted = [...this.sessions.entries()].sort(
        ([, a], [, b]) => a.lastActivityAt - b.lastActivityAt,
      );
      const idleEntry = sorted.find(([, p]) => p.isIdle(0));
      if (idleEntry) {
        await idleEntry[1].stop();
        this.sessions.delete(idleEntry[0]);
        this.evictApiSessionMapping(idleEntry[0]);
        this.logger.info('Evicted idle session', { sessionId: idleEntry[0] });
      } else {
        throw new Error(`Session pool full: ${this.maxConcurrent} concurrent sessions`);
      }
    }

    const actualSessionId = sessionId ?? mapKey;
    const chatId = source !== 'api' ? mapKey : undefined;

    const proc = new SessionProcess(
      actualSessionId,
      source,
      this.agentConfig,
      this.gatewayConfig,
      this.sessionStore,
      chatId,
    );

    // Apply per-session model override (caller already normalized to undefined when == agent default)
    if (modelOverride) proc.modelOverride = modelOverride;

    // Keep the searchable memory archive (planning-64) fresh for the memory_search
    // tool. Fire-and-forget, detached, OFF the event loop — never blocks the spawn.
    spawnArchiveReindex(
      this.agentConfig.workspace,
      this.agentConfig.knowledge,
      this.gatewayConfig.gateway.knowledge,
    );

    // Per-agent → global → MAX_HISTORY_MESSAGES: the configured cap on how many
    // history messages a healthy spawn re-injects. Lets an operator lower the
    // context loaded at session start (e.g. 50 → 30) without touching code.
    const configuredMax = resolveMaxHistoryMessages(
      this.agentConfig.history?.maxHistoryMessages,
      this.gatewayConfig.gateway.history?.maxHistoryMessages,
    );

    // request_too_large (32MB) recovery: shrink the re-injected history on each
    // consecutive retry so a pathological context eventually fits. recoveryCount
    // is 0 for healthy sessions → use the configured cap directly; a recovering
    // session steps down to the ladder rungs STRICTLY BELOW that cap, so each
    // retry genuinely shrinks instead of re-trying the same (already-too-large)
    // size when the cap has been lowered.
    const recoveryCount = this.tooLargeRecoveries.get(mapKey) ?? 0;
    proc.historyLimit = this.spawnHistoryLimit(configuredMax, recoveryCount);
    if (recoveryCount > 0) {
      this.logger.info('Spawning with reduced history after request_too_large', {
        mapKey, recoveryCount, historyLimit: proc.historyLimit,
      });
    }

    // Safe mode (Epic #195, Phase 3): if the PTY backend has repeatedly failed
    // for this agent, force the headless backend for this spawn. Cleared
    // automatically once safe mode exits (a later healthy turn / user restore).
    if (this.safeMode.isActive(this.agentConfig.id)) {
      proc.forceHeadless = true;
      this.logger.info('Spawning in safe mode (headless backend forced)', {
        mapKey, agentId: this.agentConfig.id,
      });
    }

    await proc.start();

    // Forward all session output lines so listeners on AgentRunner (GatewayRouter,
    // CronScheduler, tests) receive them without needing individual session references.
    proc.on('output', (line: string) => this.emit('output', line));

    // API sessions get NONE of the channel lifecycle handlers below (the whole
    // block is gated to source !== 'api'), so a permanent failure would
    // otherwise leave the dead SessionProcess in the pool: the next
    // getOrSpawnSession returns it and, finding no auto-restart in flight, would
    // block on waitForSessionRestart for the full 20s timeout before rejecting —
    // the "wedge" #371 describes. Remove it from the pool on failure so the next
    // message spawns a fresh session instead. (Channel sessions already do this
    // inside the notify handler below.)
    if (source === 'api') {
      proc.once('failed', () => this.sessions.delete(mapKey));
    }

    // Notify typing indicator when session permanently fails (max restarts exceeded)
    if (source !== 'api') {
      proc.once('failed', () => {
        // Safe mode (Epic #195, Phase 3): a hard failure of the PTY (interactive
        // TUI) backend counts toward the safe-mode threshold. Once crossed, the
        // agent auto-flips to headless on the next spawn so the user's next
        // message is served instead of re-wedging. Headless failures don't count
        // (there is no PTY wrapper to blame / fall back from). When we just
        // entered safe mode, tell the user that specifically instead of the
        // generic "stopped" notice (one .error file, so pick the better code).
        const enteredSafeMode =
          proc.backend === 'pty-shell' &&
          this.safeMode.recordPtyFailure(this.agentConfig.id);
        this.writeTypingError(mapKey, enteredSafeMode ? 'SAFE_MODE_ENABLED' : 'PROCESS_FAILED');
        this.sessions.delete(mapKey);
        // LINE: surface an error for any outstanding postback button so a tap
        // returns the interrupted notice instead of a stale "still thinking".
        if (!proc.queryMode) this.lineReply?.markInterrupted(mapKey);
      });
      // Stop typing loop when Claude's turn truly ends.
      // Typing done is delayed 3s after result event — if new output arrives within
      // the delay, the timer is cancelled so typing persists during multi-step work.
      // Auto-forward result text to channel if agent didn't call reply tool.
      let replyCalled = false;
      let replyToolUseId: string | null = null; // track id to detect failed tool calls
      // Reply tool_use blocks re-appear across cumulative `assistant` snapshots
      // exactly like line_image ones, so a repeat is skipped by block id rather
      // than by `replyCalled`. Gating on the flag also froze `replyToolUseId` on
      // the turn's FIRST reply call, so a LATER call's failure never matched the
      // unblock below and the turn's final message was dropped silently (#422).
      const seenReplyToolIds = new Set<string>();
      // Set when a reply tool call failed this turn. The fallback forward must
      // then reach the channel even though an EARLIER successful reply in the
      // same turn already wrote a `.replied` marker carrying this turn's id —
      // see writeAutoForward()'s forceDeliver argument.
      let replySendFailed = false;
      // line_image tool_use blocks re-appear across cumulative `assistant` stream
      // snapshots (--include-partial-messages), so dedupe history inserts by the
      // block id — otherwise one sent image lands in the transcript N times and
      // skews the session image catalog's "image N" ordinal.
      const seenLineImageIds = new Set<string>();
      // A line_image call queued here (id -> media) is only written to history
      // once its matching tool_result confirms the send succeeded — a failed
      // attempt followed by a retried, successful one must not leave two copies
      // of the same image in the transcript.
      const pendingLineImageMedia = new Map<string, { lineMedia: string[]; channelSrcLine: string }>();
      // Set when an interactive-menu prompt was rendered to the channel this turn,
      // so the result's plain-text auto-forward is skipped (no duplicate message).
      let menuSentThisTurn = false;
      let menuPromptTextThisTurn = '';
      // Text of the most recent assistant message this turn. Used only as a
      // fallback when the turn's `result` is an empty string — some backends
      // (OpenRouter) stream the answer as assistant text and then close the turn
      // with `result: ""`, which would otherwise leave the history DB with no row
      // for the reply. Replaced, never appended: assistant messages arrive as
      // cumulative snapshots, so the last one is the complete text (same
      // semantics as `result`).
      let lastAssistantTextThisTurn = '';
      let typingDoneTimer: ReturnType<typeof setTimeout> | null = null;
      const TYPING_DONE_DELAY_MS = 3000;
      const replyToolName =
        source === 'discord'
          ? 'mcp__gateway__discord_reply'
          : source === 'line'
            ? 'mcp__gateway__line_reply'
            : source === 'slack'
              ? 'mcp__gateway__slack_reply'
              : 'mcp__gateway__telegram_reply';

      proc.on('output', (line: string) => {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;

          // Cancel pending typing-done on any new output
          if (typingDoneTimer) {
            clearTimeout(typingDoneTimer);
            typingDoneTimer = null;
          }

          // Track reply tool calls and persist assistant messages to history
          if (obj['type'] === 'assistant') {
            const msg = obj['message'] as { content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown> }> } | undefined;
            if (Array.isArray(msg?.content)) {
              const textThisMessage = msg!.content
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text as string)
                .join('');
              if (textThisMessage.trim()) lastAssistantTextThisTurn = textThisMessage;
              for (const block of msg!.content) {
                // Skill-learning: count every tool_use this turn (deduped by block
                // id inside the manager, since cumulative assistant snapshots re-emit
                // completed blocks). Cheap, best-effort.
                if (block.type === 'tool_use') {
                  this.skillLearning?.onToolUse(mapKey, (block as Record<string, unknown>)['id'] as string | undefined);
                }
                // LINE sends images through its own line_image tool (not the reply
                // tool's `files`), so capture those sends into history too — the
                // web transcript and the session image catalog key off mediaFiles.
                if (block.type === 'tool_use' && block.name === 'mcp__gateway__line_image') {
                  const lineBlockId = (block as Record<string, unknown>)['id'];
                  const dedupeKey = typeof lineBlockId === 'string' ? lineBlockId : '';
                  // Skip if this tool_use block was already queued this turn
                  // (cumulative assistant snapshots re-emit completed blocks).
                  if (dedupeKey && seenLineImageIds.has(dedupeKey)) continue;
                  const imgPath = typeof block.input?.['image'] === 'string' ? block.input['image'] : '';
                  const mediaRootLine = path.join(this.agentsBaseDir, this.agentConfig.id, 'media') + path.sep;
                  const lineMedia = toRelMediaFiles(imgPath ? [imgPath] : [], mediaRootLine);
                  if (lineMedia.length && dedupeKey) {
                    seenLineImageIds.add(dedupeKey);
                    // Queue instead of writing now — the send can still fail (mint
                    // error, LINE API error, transient socket blip). Only the
                    // matching tool_result below commits it to history, so a
                    // failed attempt followed by a retried success doesn't leave
                    // two copies of the same image in the transcript.
                    pendingLineImageMedia.set(dedupeKey, {
                      lineMedia,
                      channelSrcLine: this.channelSourceMap.get(mapKey) ?? 'line',
                    });
                  }
                }
                if (block.type === 'tool_use' && block.name === replyToolName) {
                  // The block comes off the CLI's stdout — validate the id rather
                  // than casting, so a malformed one degrades to the flag check
                  // instead of poisoning the Set with a non-string key.
                  const rawBlockId = (block as Record<string, unknown>)['id'];
                  const replyBlockId = typeof rawBlockId === 'string' && rawBlockId ? rawBlockId : null;
                  // Skip a re-emitted snapshot of a block already handled. Blocks
                  // with no id fall back to the old flag check, which is the best
                  // dedup available without an id.
                  const alreadyHandled =
                    replyBlockId !== null ? seenReplyToolIds.has(replyBlockId) : replyCalled;
                  if (alreadyHandled) continue;
                  if (replyBlockId !== null) seenReplyToolIds.add(replyBlockId);
                  replyCalled = true;
                  replyToolUseId = replyBlockId;
                  // Persist the reply text to history so it appears in chat history API
                  const replyText = typeof block.input?.['text'] === 'string' ? block.input['text'].trim() : '';
                  // Capture any images the reply attached (reply tool's `files`)
                  // so the web transcript renders them via mediaFiles. Only files
                  // under the agent media root that still exist are recorded.
                  const replyFiles = Array.isArray(block.input?.['files']) ? (block.input['files'] as unknown[]) : [];
                  const mediaRoot = path.join(this.agentsBaseDir, this.agentConfig.id, 'media') + path.sep;
                  const replyMedia = toRelMediaFiles(replyFiles, mediaRoot);
                  // Persist when there is text OR image(s) — an image-only reply
                  // still needs a row so it shows in the web transcript.
                  if (replyText || replyMedia.length) {
                    const channelSrc = this.channelSourceMap.get(mapKey) ?? 'telegram';
                    this.historyDb.insertMessage({
                      chatId: `${channelSrc}-${mapKey}`,
                      sessionId: actualSessionId,
                      source: channelSrc as HistorySource,
                      role: 'assistant',
                      content: replyText,
                      mediaFiles: replyMedia.length ? replyMedia : undefined,
                      ts: Date.now(),
                    });
                    // LINE: the MCP line_reply tool's send is suppressed in
                    // refresh mode; the gateway delivers (free reply, or cache +
                    // postback button when slow). See LineReplyManager.
                    if (channelSrc === 'line' && this.lineReply && replyText) {
                      void this.lineReply.onAnswer(mapKey, replyText);
                    }
                  }
                }
              }
            }
          }
          // If reply tool was called but returned an error, unblock auto-forward
          if (obj['type'] === 'user' && replyToolUseId && replyCalled) {
            const msg = obj['message'] as { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean }> } | undefined;
            if (Array.isArray(msg?.content)) {
              for (const block of msg!.content) {
                if (block.type === 'tool_result' && block.tool_use_id === replyToolUseId && block.is_error) {
                  replyCalled = false;
                  replyToolUseId = null;
                  replySendFailed = true;
                }
              }
            }
          }
          // Commit a queued line_image send to history only once its tool_result
          // confirms success — see the queuing comment above. A failed send is
          // simply dropped, so a same-image retry never double-writes.
          if (obj['type'] === 'user' && pendingLineImageMedia.size) {
            const msg = obj['message'] as { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean }> } | undefined;
            if (Array.isArray(msg?.content)) {
              for (const block of msg!.content) {
                if (block.type === 'tool_result' && block.tool_use_id && pendingLineImageMedia.has(block.tool_use_id)) {
                  const pending = pendingLineImageMedia.get(block.tool_use_id)!;
                  pendingLineImageMedia.delete(block.tool_use_id);
                  if (!block.is_error) {
                    this.historyDb.insertMessage({
                      chatId: `${pending.channelSrcLine}-${mapKey}`,
                      sessionId: actualSessionId,
                      source: pending.channelSrcLine as HistorySource,
                      role: 'assistant',
                      content: '',
                      mediaFiles: pending.lineMedia,
                      ts: Date.now(),
                    });
                  }
                }
              }
            }
          }
          // Interactive select menu blocking the PTY: render it as channel-native
          // UI (inline buttons). This output handler only runs for Telegram/Discord
          // sessions; API uses a separate path and falls back to the result text's
          // numbered list (no buttons), as intended.
          if (obj['type'] === 'system' && obj['subtype'] === 'menu_prompt') {
            const promptText = typeof obj['prompt'] === 'string' ? obj['prompt'] : '';
            const rawOptions = Array.isArray(obj['options']) ? obj['options'] as Array<{ label?: unknown }> : [];
            const options = rawOptions
              .map((o) => ({ label: typeof o?.label === 'string' ? o.label : '' }))
              .filter((o) => o.label);
            if (promptText && options.length) {
              this.writeMenuForward(mapKey, promptText, options);
              menuSentThisTurn = true;
              menuPromptTextThisTurn = promptText;
              // Persist the question to chat history so it's visible in the transcript.
              const channelSrc = this.channelSourceMap.get(mapKey) ?? 'telegram';
              this.historyDb.insertMessage({
                chatId: `${channelSrc}-${mapKey}`,
                sessionId: actualSessionId,
                source: channelSrc as HistorySource,
                role: 'assistant',
                content: promptText,
                ts: Date.now(),
              });
            }
          }
          // PTY shell hit the recoverable "Request too large (max 32MB)" error.
          // The transcript tailer emits this from the authoritative <synthetic>
          // record (Bug A fix). Recovery is unified in handleRequestTooLarge()
          // so the headless path (Bug B) gets identical treatment.
          if (obj['type'] === 'system' && obj['subtype'] === 'request_too_large') {
            this.handleRequestTooLarge(mapKey, proc);
          }
          if (obj['type'] === 'result') {
            proc.setProcessing(false);
            // Skill-learning: on the headless backend `result` is the true
            // end-of-user-turn (exactly one per message) — persist the turn metric
            // here. pty-shell fires `result` per sub-turn, so its capture is driven
            // by `session_idle` (below) to avoid over-counting.
            if (proc.backend !== 'pty-shell') {
              this.skillLearning?.onTurnEnd(mapKey, actualSessionId);
            }
            // Gateway turn queue: on the headless backend `result` is the true end
            // of the user's turn (exactly one per message), so flush the next
            // queued turn here. On pty-shell `result` fires per sub-turn (across
            // tool-call gaps), so its flush is driven by `session_idle` instead
            // (below) — flushing on every sub-turn `result` would inject the next
            // message mid-work.
            // Skip when a deferred restart is armed: this session is about to be
            // torn down (deferredRestartReady), so draining the queue into it now
            // would kill the queued turn with the process. The restart handler
            // re-drives the preserved queue into the fresh session instead.
            if (proc.backend !== 'pty-shell' && !proc.hasPendingRestart()) {
              this.flushNextTurn(mapKey);
            }
            // Telegram: accumulate image size via stat of local file (FIFO, one per turn)
            const queue = this.pendingImagePaths.get(mapKey);
            const imgPath = queue?.shift();
            if (queue?.length === 0) this.pendingImagePaths.delete(mapKey);
            if (imgPath) {
              this.statQueue = this.statQueue.then(async () => {
                try {
                  const stats = await fsPromises.stat(imgPath);
                  const prev = this.imageSizePerChat.get(mapKey) ?? 0;
                  const next = prev + stats.size;
                  this.imageSizePerChat.set(mapKey, next);
                  if (next >= MAX_IMAGE_SIZE_BYTES) {
                    this.imageSizePerChat.delete(mapKey);
                    void this.triggerSummaryAndRestart(mapKey, actualSessionId, proc);
                  }
                } catch (err: unknown) {
                  this.logger.warn('Failed to stat image', { path: imgPath, error: err instanceof Error ? err.message : String(err) });
                }
              });
            }
            // Forward result text when agent did NOT call reply tool (fallback path).
            // If the agent already called the reply tool, skip result forwarding to avoid
            // sending a duplicate message to the channel.
            // Skip forwarding when session is in query mode (internal image summary request).
            const resultText = typeof obj['result'] === 'string' ? obj['result'] : '';
            // Suppress the corrupted-thinking 400: the session auto-respawns to recover,
            // so the raw API error must not reach the user's chat or the history DB.
            const isThinkingCorruption =
              obj['is_error'] === true && SessionProcess.isThinkingCorruptionError(resultText);
            // Detect Anthropic API socket drop — Claude CLI emits this as is_error:false
            // with "API Error: The socket connection was closed unexpectedly". The error
            // bypasses the replyCalled gate so the user always gets notified, even when
            // the agent already called the reply tool earlier in the same turn — hence
            // forceDeliver, or that earlier reply's `.replied` marker would dedup this
            // notice away and defeat the bypass (#422).
            const isSocketError = !proc.queryMode && resultText.includes(ANTHROPIC_SOCKET_ERROR);
            if (isSocketError) {
              this.writeAutoForward(mapKey, '⚡ Connection to Anthropic API dropped. Please resend your message.', 'text', true);
            }
            // Bug B: headless (claude --print) reports a too-large request as a
            // synthetic `result` (is_error + "Request too large (max"), NOT as the
            // PTY `system/request_too_large` event. Previously this result was only
            // suppressed — the long-lived process stayed alive and rejected every
            // turn forever ("typing then silent"). Route it through the SAME unified
            // recovery (notify + escalate-shrink history + restart) as the PTY path.
            const isRequestTooLarge = obj['is_error'] === true && resultText.includes(TUI_REQUEST_TOO_LARGE);
            if (isRequestTooLarge) {
              this.handleRequestTooLarge(mapKey, proc);
            } else if (obj['is_error'] !== true) {
              // Genuine successful turn — clear any request_too_large escalation so
              // the next 32MB (if any) starts fresh at the top of the ladder.
              this.tooLargeRecoveries.delete(mapKey);
              this.tooLargeExhausted.delete(mapKey);
              // Safe mode (Epic #195, Phase 3): a healthy PTY turn resets the
              // consecutive-failure counter and lifts safe mode if it was active
              // (the interactive backend recovered). Headless successes don't
              // touch it — that's the fallback doing its job, not the PTY healing.
              if (proc.backend === 'pty-shell') {
                this.safeMode.recordSuccess(this.agentConfig.id);
              }
            }
            // When a menu was rendered to buttons this turn, the wrapper appends
            // the same menu text to the turn's result — strip that suffix so it
            // isn't duplicated, but DO forward any assistant prose that preceded
            // the menu (a plan write-up or analysis the user needs in order to
            // answer the question; previously the whole result was dropped).
            let forwardableText = resultText.trim();
            if (menuSentThisTurn && menuPromptTextThisTurn) {
              const menuIdx = forwardableText.lastIndexOf(menuPromptTextThisTurn.trim());
              if (menuIdx !== -1) {
                forwardableText = forwardableText.slice(0, menuIdx).trim();
              } else {
                // Menu text not embedded verbatim — keep the old suppression
                // rather than risk double-posting the option list.
                forwardableText = '';
              }
            }
            // A backend that closes the turn with `result: ""` after streaming the
            // answer as assistant text (OpenRouter) leaves nothing to store here.
            // SessionProcess still appends that text to the session JSON, so the
            // history DB would be the only layer missing the reply — and the
            // cross-channel producer used to hide that by writing a second copy of
            // every reply (see sendMessageToSession's done()). Persist the fallback
            // instead, but only for the shape it was written for: an *empty* result
            // ending a whole turn on the headless backend.
            //   • A menu turn is excluded because `forwardableText` above may have
            //     been blanked on purpose — falling back there would resurrect the
            //     option list the strip removed and duplicate the prompt row
            //     already inserted when the menu was rendered.
            //   • pty-shell is excluded because its `result` fires per sub-turn, so
            //     every tool-call boundary with an empty result would add a phantom
            //     row of that sub-turn's narration.
            // Forwarding deliberately keeps using forwardableText alone: recovering
            // a missing history row is not a reason to post a new channel message.
            const canFallBack = !menuSentThisTurn && proc.backend !== 'pty-shell';
            const persistableText = forwardableText || (canFallBack ? lastAssistantTextThisTurn.trim() : '');
            if (!isSocketError && !isRequestTooLarge && persistableText && !proc.queryMode && !replyCalled && !isThinkingCorruption) {
              const channelSrcForResult = this.channelSourceMap.get(mapKey) ?? 'telegram';
              // Persist assistant reply to permanent history DB
              this.historyDb.insertMessage({
                chatId: `${channelSrcForResult}-${mapKey}`,
                sessionId: actualSessionId,
                source: channelSrcForResult as HistorySource,
                role: 'assistant',
                content: persistableText,
                ts: Date.now(),
              });
              if (forwardableText) {
                // Forward to channel. LINE has no .forward consumer — the gateway
                // delivers via LineReplyManager (free reply, or cache + postback
                // button when slow) instead of writeAutoForward.
                const channelText = normalizeTelegramLineBreaks(forwardableText)
                if (channelSrcForResult === 'line' && this.lineReply) {
                  void this.lineReply.onAnswer(mapKey, channelText)
                } else if (
                  channelSrcForResult !== 'discord' &&
                  channelSrcForResult !== 'slack' &&
                  (hasMarkdown(channelText) || containsTelegramHtml(channelText))
                ) {
                  // Telegram HTML entities — Slack has its own mrkdwn format and
                  // would display these tags literally, so Slack skips this and
                  // falls through to the plain-text branch below.
                  this.writeAutoForward(mapKey, toTelegramHtml(channelText), 'html', replySendFailed);
                } else {
                  this.writeAutoForward(mapKey, channelText, 'text', replySendFailed);
                }
                // Assistant output reached the channel — mark the turn delivered so
                // a later recovery does not resend a message that was answered (C1).
                const lt = this.lastTurn.get(mapKey);
                if (lt) lt.delivered = true;
              }
            }
            replyCalled = false; // reset for next turn
            replyToolUseId = null;
            replySendFailed = false;
            seenReplyToolIds.clear();
            seenLineImageIds.clear();
            pendingLineImageMedia.clear();
            menuSentThisTurn = false;
            menuPromptTextThisTurn = '';
            lastAssistantTextThisTurn = '';
            // In pty-shell mode, a `result` fires after every Claude API sub-turn
            // (there can be many per user message, separated by tool-call gaps of
            // arbitrary length). Starting the typing-done timer here would stop
            // the indicator during those inter-turn gaps. Instead, pty-shell emits
            // `session_idle` once it is truly done; headless mode only produces
            // one `result` per message, so the timer pattern still applies there.
            if (proc.backend !== 'pty-shell') {
              const waitingForBackgroundWork = proc.retainBackgroundWorkingState();
              if (!waitingForBackgroundWork) {
                typingDoneTimer = setTimeout(() => {
                  this.writeTypingDone(mapKey);
                  typingDoneTimer = null;
                }, TYPING_DONE_DELAY_MS);
              }
            }
          }
          // PTY shell signals "truly idle" (no active turn, empty queue) with this
          // event. Start the typing-done timer here so the indicator stays alive
          // through multi-turn tool-call sequences and only stops when all work is done.
          if (obj['type'] === 'session_idle' && proc.backend === 'pty-shell') {
            // A parent can become idle immediately after dispatching background
            // Agent/Workflow work. Keep the Telegram typing signal and processing
            // sentinel alive until the task notification starts its follow-up turn.
            const waitingForBackgroundWork = proc.retainBackgroundWorkingState();
            // Gateway turn queue: on pty-shell this is the true end of the user's
            // turn (the wrapper only emits it when its own `this.turn` is null, so
            // it never fires between sub-turns) — flush the next queued turn.
            // Skip when a deferred restart is armed (see the headless `result`
            // path above): the restart handler re-drives the queue into the fresh
            // session so the queued turn is not killed with this one.
            if (!proc.hasPendingRestart()) {
              this.flushNextTurn(mapKey);
            }
            // Skill-learning: pty-shell session_idle is the true end-of-user-turn.
            this.skillLearning?.onTurnEnd(mapKey, actualSessionId);
            if (!waitingForBackgroundWork) {
              typingDoneTimer = setTimeout(() => {
                this.writeTypingDone(mapKey);
                typingDoneTimer = null;
              }, TYPING_DONE_DELAY_MS);
            }
          }
        } catch { /* non-JSON */ }
      });

      // Track token usage and persist to session meta
      // Use actualSessionId (captured at spawn time) — NOT getActiveSessionId() —
      // so tokens are attributed to the session that owns this process.
      proc.on('tokenUsage', async ({ inputTokens, totalTokens }: { inputTokens: number; totalTokens: number }) => {
        this.skillLearning?.onTokenUsage(mapKey, inputTokens, totalTokens);
        try {
          const ch = this.channelFor(mapKey);
          const index = await this.sessionStore.listSessions(this.agentConfig.id, mapKey, ch);
          const meta = index.sessions.find(s => s.id === actualSessionId);
          const current = meta?.totalTokensUsed ?? 0;
          await this.sessionStore.updateSessionMeta(this.agentConfig.id, mapKey, actualSessionId, {
            totalTokensUsed: current + totalTokens,
            lastInputTokens: inputTokens,
            ...(proc.lastModel && { model: proc.lastModel }),
          }, ch);
        } catch {
          // Non-fatal — token tracking is best-effort
        }
      });

      // Persist spawn context (loaded vs archived message counts).
      // Read from property instead of event — the event fired during start() before
      // listeners were registered, causing a race condition.
      if (proc.spawnContext) {
        this.sessionStore.updateSessionMeta(this.agentConfig.id, mapKey, actualSessionId, {
          loadedAtSpawn: proc.spawnContext.loadedAtSpawn,
          archivedCount: proc.spawnContext.archivedCount,
          messageCountAtSpawn: proc.spawnContext.messageCountAtSpawn,
        }, this.channelFor(mapKey)).catch(() => {});
      }

      proc.on('backgroundWorkExpired', () => {
        // The child task never notified its parent within the bounded grace
        // window; release the Telegram typing signal instead of leaving it live.
        this.writeTypingDone(mapKey);
      });

      // Tear down per-chat typing/processing state whenever the subprocess dies.
      // Uses `on` (not `once`): a single SessionProcess can auto-restart its child
      // multiple times over its lifetime, and each death that lacks a final
      // result/session_idle would otherwise leave the typing indicator stuck until
      // the 5-min stalled detector fires. writeTypingDone/setProcessing(false) are
      // idempotent, so firing on every exit is safe.
      proc.on('exit', () => {
        proc.setProcessing(false);
        if (typingDoneTimer) {
          clearTimeout(typingDoneTimer);
          typingDoneTimer = null;
        }
        this.writeTypingDone(mapKey);
        // Gateway turn queue: the in-flight turn's end signal will never arrive
        // now, so release the active slot. If turns were queued behind it, deliver
        // the next one (injectTurn respawns the session) so a crash mid-turn does
        // not strand the messages the user already sent.
        // Skip on a deferred restart: this exit is the intentional teardown, and
        // its handler re-drives the queue into the fresh session AFTER deleting
        // the dead one from the pool — flushing here would reuse the dead proc.
        if (!proc.hasPendingRestart()) {
          this.flushNextTurn(mapKey);
        }
        // LINE: a process exit with a button whose answer never arrived (crash /
        // teardown mid-turn) → surface the interrupted notice so a tap returns it
        // instead of a stale "still thinking". markInterrupted no-ops on a READY
        // entry, so an already-answered, untapped button stays deliverable. Then
        // clear the armed timer + stashed reply token for this chat.
        if (!proc.queryMode) {
          this.lineReply?.markInterrupted(mapKey);
          this.lineReply?.disposeChat(mapKey);
        }
      });

      // Deferred restart: stop session after its current turn completes
      proc.once('deferredRestartReady', async () => {
        this.logger.info('Deferred restart: stopping session after turn completed', { mapKey });
        await proc.stop();
        this.sessions.delete(mapKey);
        // Re-drive any turn queued behind the just-completed turn. The turn-end
        // and exit flush paths deliberately skipped it (hasPendingRestart guards)
        // so it was not drained into this now-dead session. Flushing here — after
        // the dead proc is removed from the pool — re-injects it into a freshly
        // spawned session instead of losing it with the restart.
        this.flushNextTurn(mapKey);
      });
    }

    this.sessions.set(mapKey, proc);
    this.sessionHistory.unshift({ chatId: mapKey, sessionId: proc.sessionId, source: proc.source, mode: proc.backend, model: proc.model, spawnedAt: proc.spawnedAt });
    if (this.sessionHistory.length > 10) this.sessionHistory.length = 10;
    if (source === 'telegram' || source === 'discord') {
      this.channelSourceMap.set(mapKey, source);
    }
    this.logger.info('Spawned session', {
      mapKey,
      actualSessionId,
      source,
      total: this.sessions.size,
    });
    return proc;
  }

  static isApiBuiltinCommand(content: string): boolean {
    return isBuiltinCommand(content, 'api');
  }

  /**
   * Dispatch a session management command to the appropriate handler.
   */
  private async handleSessionCommand(
    chatId: string,
    content: string,
    meta: Record<string, string> = {},
  ): Promise<void> {
    const agentId = this.agentConfig.id;

    if (content.startsWith('/sessions')) {
      await this.handleCommandSessions(agentId, chatId);
    } else if (content.startsWith('/session') && !content.startsWith('/sessions')) {
      await this.handleCommandSessionInfo(agentId, chatId);
    } else if (content.startsWith('/new')) {
      const name = content.replace('/new', '').trim() || undefined;
      await this.handleCommandNew(agentId, chatId, name);
    } else if (content.startsWith('/clear')) {
      await this.handleCommandClear(agentId, chatId);
    } else if (content.startsWith('/compact')) {
      await this.handleCommandCompact(agentId, chatId);
    } else if (content.startsWith('/rename')) {
      const name = content.replace('/rename', '').trim();
      await this.handleCommandRename(agentId, chatId, name);
    } else if (content.startsWith('/models')) {
      await this.handleCommandModels(chatId);
    } else if (content.startsWith('/model')) {
      await this.handleCommandModel(chatId, content.replace('/model', '').trim(), meta);
    } else if (content.startsWith('/stop')) {
      await this.handleCommandStop(chatId);
    }
  }

  /**
   * /models — the model picker for channels without an inline keyboard.
   *
   * Telegram never reaches this: its receiver answers `/models` itself with a
   * button keyboard and does not forward the message. Discord and LINE have no
   * picker of their own, so they get the list as text plus the command that
   * selects from it (issue #409).
   *
   * A channel listed in BUILTIN_COMMANDS but missing a branch here is worse
   * than one not listed at all — the gate swallows the message and the user
   * gets silence instead of the agent's reply. `/model` on Discord was in
   * exactly that state before this.
   */
  private async handleCommandModels(chatId: string): Promise<void> {
    const models = await this.availableModels();
    const configuredIds = new Set((this.gatewayConfig.gateway.models ?? DEFAULT_MODELS).map(m => m.id));
    const configured = models.filter(m => configuredIds.has(m.id));
    const live = models.filter(m => !configuredIds.has(m.id));
    const current = this.agentConfig.claude.model;
    const lines = [`Current model: ${current}`, '', 'Configured models'];
    for (const m of configured) {
      const marker = m.id === current ? '✅ ' : '• ';
      lines.push(`${marker}${m.label} — \`${m.id}\``);
    }
    if (live.length) {
      lines.push('', 'More models (live)');
      for (const m of live) {
        const marker = m.id === current ? '✅ ' : '• ';
        lines.push(`${marker}${m.label} — \`${m.id}\``);
      }
    }
    lines.push('', 'Switch with /model <id or alias>');
    this.writeAutoForward(chatId, lines.join('\n'));
  }

  /**
   * /model — show the current model, or switch to one from the catalog.
   *
   * An unrecognised argument is refused rather than persisted: unlike the API
   * (where the caller is authenticated and the provider validates the id), a
   * typo in a chat message would otherwise be written into config.json and
   * break the agent's next spawn. Anything the catalog knows — including a
   * model that exists only upstream and not in the static list — is accepted.
   */
  private async handleCommandModel(
    chatId: string,
    arg: string,
    meta: Record<string, string> = {},
  ): Promise<void> {
    const current = this.agentConfig.claude.model;
    if (!arg) {
      this.writeAutoForward(chatId, `Current model: ${current}\n\nUse /models to see the list.`);
      return;
    }
    if (!this.isDirectChat(meta)) {
      this.writeAutoForward(
        chatId,
        'Switching models is only available in a direct message with the bot — '
        + 'it changes the model for every chat of this agent and restarts them. '
        + 'Use /models here to see the list.',
      );
      return;
    }
    const models = await this.selectableModels();
    const wanted = arg.toLowerCase();
    const match = models.find((m) => m.id.toLowerCase() === wanted || m.alias.toLowerCase() === wanted);
    if (!match) {
      this.writeAutoForward(chatId, `Unknown model "${arg}". Use /models to see the list.`);
      return;
    }
    if (match.id === current) {
      this.writeAutoForward(chatId, `Already using ${match.label} (${match.id}).`);
      return;
    }
    await this.setModel(match.id);
    // Same restart the Telegram picker's set_model does — the running session
    // was spawned with the old model and would otherwise keep using it.
    const restarted = await this.restartChannelSessions();
    this.writeAutoForward(
      chatId,
      `Model set to ${match.label} (${match.id}).${restarted ? ' Restarting the session…' : ''}`,
    );
  }

  /**
   * /sessions — list all sessions for this chat.
   */
  private async handleCommandSessions(agentId: string, chatId: string): Promise<void> {
    const index = await this.sessionStore.listSessions(agentId, chatId, this.channelFor(chatId));
    const lines: string[] = [`Sessions (${agentId})`, ''];

    for (const s of index.sessions) {
      const isActive = s.id === index.activeSessionId;
      const indicator = isActive ? '🟢 ' : '   ';
      const age = this.formatAge(s.lastActive);
      lines.push(`${indicator}${isActive ? `**${s.name}**` : s.name}`);
      lines.push(`  ${s.messageCount} messages · last active ${age}`);
      lines.push('');
    }

    lines.push('Use /new [name] to create a new session');
    this.writeAutoForward(chatId, lines.join('\n'));
  }

  /**
   * /session — show info about the current active session.
   */
  private async handleCommandSessionInfo(agentId: string, chatId: string): Promise<void> {
    const index = await this.sessionStore.listSessions(agentId, chatId, this.channelFor(chatId));
    const meta = index.sessions.find(s => s.id === index.activeSessionId);
    if (!meta) {
      this.writeAutoForward(chatId, 'No active session found.');
      return;
    }

    const effectiveModel = this.agentConfig.claude.model;
    const contextWindow = await this.contextWindowFor(effectiveModel);
    const contextTokens = meta.lastInputTokens ?? 0;
    const usedPct = Math.round((contextTokens / contextWindow) * 100);

    let msgs: string;
    if (meta.messageCount <= 0) {
      msgs = 'No messages yet';
    } else if ((meta.archivedCount ?? 0) > 0 && meta.loadedAtSpawn != null && meta.messageCountAtSpawn != null) {
      const newMessagesSinceSpawn = meta.messageCount - meta.messageCountAtSpawn;
      const inContext = meta.loadedAtSpawn + Math.max(0, newMessagesSinceSpawn);
      msgs = `${meta.messageCount} (${inContext} in context / ${meta.archivedCount} archived)`;
    } else {
      msgs = `${meta.messageCount}`;
    }

    const contextLine = `${usedPct}%`;

    const lines = [
      `📌 Current Session: ${meta.name}`,
      `<code>${index.activeSessionId}</code>`,
      '',
      `📥 Messages: ${msgs}`,
      `👉 Context: ${contextLine}`,
    ];

    if (usedPct >= 80) {
      lines.push('', '💡 Near limit — consider /compact');
    }

    lines.push('', 'Commands: /sessions /new /rename /clear /compact');

    const info = lines.join('\n');

    this.writeAutoForward(chatId, info, 'html');
  }

  /**
   * /new [name] — create a new session and switch to it.
   */
  private async handleCommandNew(agentId: string, chatId: string, name?: string): Promise<void> {
    const newMeta = await this.sessionStore.createTelegramSession(agentId, chatId, name, this.channelFor(chatId));
    await this.switchSession(chatId, newMeta.id);
    this.writeAutoForward(chatId, `✅ New session created: "${newMeta.name}"\nNow chatting in a fresh context. Use /sessions to switch back.`);
  }

  /**
   * /rename <name> — rename the current session.
   */
  private async handleCommandRename(agentId: string, chatId: string, name: string): Promise<void> {
    if (!name) {
      this.writeAutoForward(chatId, '⚠️ Usage: /rename <new name>\nExample: /rename Design review');
      return;
    }
    const sessionId = await this.sessionStore.getActiveSessionId(agentId, chatId, this.channelFor(chatId));
    await this.sessionStore.updateSessionMeta(agentId, chatId, sessionId, { name }, this.channelFor(chatId));
    this.writeAutoForward(chatId, `✅ Session renamed to "${name}"`);
  }

  /**
   * /stop — interrupt the in-flight turn for this chat and cancel anything queued
   * behind it. Drops the coalesce buffer (messages not yet routed) and the turn
   * queue (turns waiting behind the active one), bumps the per-chat stop epoch so
   * a turn still mid-spawn aborts before it submits (closing the spawn-race), and
   * sends SIGINT to interrupt an actively-processing turn. Session history/metadata
   * are left intact. Reports Stopped whenever there was work to cancel — an active
   * turn, a spawning turn, or queued/buffered messages — rather than the old
   * "No turn in progress." that fired whenever interrupt() no-op'd mid-spawn.
   */
  private async handleCommandStop(chatId: string): Promise<void> {
    // Cancel queued + buffered work first so nothing flushes in behind the interrupt.
    const buffered = this.channelCoalesce.get(chatId);
    if (buffered?.timer) clearTimeout(buffered.timer);
    this.channelCoalesce.delete(chatId);
    const hadQueued = (this.turnQueue.get(chatId)?.length ?? 0) > 0;
    this.turnQueue.delete(chatId);
    // Bump the stop epoch: any injectTurn() that began before this point detects
    // the mismatch just before submitting and aborts (spawn-race close). The
    // turnActive slot is released by that abort's flushNextTurn(), or by the
    // interrupted turn's end signal — never cleared here, to avoid racing a
    // stale end signal against a turn the user starts right after /stop.
    const hadActive = this.turnActive.has(chatId);
    this.stopEpoch.set(chatId, (this.stopEpoch.get(chatId) ?? 0) + 1);

    const session = this.sessions.get(chatId);
    const interrupted = session ? session.interrupt() : false;
    const stopped = interrupted || hadActive || hadQueued || !!buffered;
    this.writeAutoForward(chatId, stopped ? 'Stopped.' : 'No turn in progress.');
  }

  /**
   * /clear — clear history of the current session and restart the process.
   * Also clears the permanent history DB and media files for this chat.
   */
  private async handleCommandClear(agentId: string, chatId: string): Promise<void> {
    const ch = this.channelFor(chatId);
    const sessionId = await this.sessionStore.getActiveSessionId(agentId, chatId, ch);

    // Clear messages and reset all metadata in-place (preserves session ID and name)
    await this.sessionStore.clearTelegramSessionHistory(agentId, chatId, sessionId, ch);
    await this.sessionStore.updateSessionMeta(agentId, chatId, sessionId, {
      totalTokensUsed: 0,
      lastInputTokens: 0,
      archivedCount: 0,
      loadedAtSpawn: undefined,
      messageCountAtSpawn: undefined,
    }, ch);

    // Clear permanent history DB for this chat
    const historyChatId = `${ch}-${chatId}`;
    this.historyDb.clearChat(historyChatId);

    // Delete persisted media files for this chat
    MediaStore.clearChatMedia(this.agentsBaseDir, agentId, historyChatId);

    // Reset any request_too_large escalation — the context is now empty, so the
    // next spawn should start fresh at the top of the history ladder.
    this.tooLargeRecoveries.delete(chatId);
    this.tooLargeExhausted.delete(chatId);

    // Kill old process so next message spawns fresh
    this.restartProcess(chatId).catch(() => {});
  }

  /**
   * /compact — summarise old history and keep only recent messages.
   */
  private async handleCommandCompact(agentId: string, chatId: string): Promise<void> {
    const ch = this.channelFor(chatId);
    const sessionId = await this.sessionStore.getActiveSessionId(agentId, chatId, ch);
    const index = await this.sessionStore.listSessions(agentId, chatId, ch);
    const meta = index.sessions.find(s => s.id === sessionId);
    const name = meta?.name ?? 'Session';

    const compactModel = this.agentConfig.claude.model;
    const contextWindow = await this.contextWindowFor(compactModel);

    this.writeAutoForward(chatId, `⏳ Compacting session "${name}"...`);

    try {
      const compactor = new SessionCompactor(this.sessionStore);
      // Large sessions summarize in many chunks (see compactor.ts); post a status
      // update at each ~25% step so the channel doesn't look dead mid-compact.
      // Throttled (not per-chunk) to avoid spamming the chat on a 16+ chunk job.
      let lastReportedPct = -1;
      const onProgress = (done: number, total: number): void => {
        if (total <= 1) return;
        const pct = Math.floor((done / total) * 100);
        if (pct - lastReportedPct >= 25) {
          lastReportedPct = pct;
          this.writeAutoForward(chatId, `⏳ Compacting session "${name}"... ${done}/${total} parts summarized`);
        }
      };
      const result = await compactor.compact(agentId, chatId, sessionId, compactModel, contextWindow, ch, onProgress);
      await this.sessionStore.updateSessionMeta(agentId, chatId, sessionId, {
        loadedAtSpawn: undefined,
        archivedCount: undefined,
        messageCountAtSpawn: undefined,
      }, ch);
      await this.restartProcess(chatId);

      const summary = [
        `✅ Session compacted`,
        '',
        `Before: ${result.beforeMessages} messages (~${result.beforeTokens.toLocaleString()} tokens)  →  ${result.contextPctBefore}% of context`,
        `After:  ${result.afterMessages} messages (~${result.afterTokens.toLocaleString()} tokens)   →  ${result.contextPctAfter}% of context`,
        `Reduced by: ${result.reductionPct}%`,
        '',
        'Summary preserved. Full history before compaction is archived.',
      ].join('\n');
      this.writeAutoForward(chatId, summary);
    } catch (err) {
      if ((err as Error).name === 'NotEnoughMessagesError') {
        this.writeAutoForward(chatId, `⚠️ ${(err as Error).message}`);
      } else {
        this.logger.error('Compact failed', { error: (err as Error).message });
        this.writeAutoForward(chatId, `❌ Compact failed: ${(err as Error).message}\n\nYour session history is unchanged.`);
      }
    }
  }

  /**
   * Switch the active session for a chat: stop the existing process and update the store.
   * The new process will be lazily spawned on the next incoming message.
   */
  private async switchSession(chatId: string, newSessionId: string): Promise<void> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      await existing.stop();
      this.sessions.delete(chatId);
    }
    await this.sessionStore.setActiveSession(this.agentConfig.id, chatId, newSessionId, this.channelFor(chatId));
  }

  /**
   * Restart the process for a given chatId (stop + remove from map).
   * The process will be lazily re-spawned on the next incoming message.
   */
  private async restartProcess(chatId: string): Promise<void> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      await existing.stop();
      this.sessions.delete(chatId);
    }
    // Process will be re-spawned on next incoming message
  }

  /**
   * The 32MB-recovery rungs for a given healthy cap: the ladder sizes STRICTLY
   * below the cap, in descending order. Filtering by `< cap` (not `<=`) drops any
   * rung equal to or above the cap so a lowered cap never yields a recovery step
   * that re-injects the same (or more) history — every step actually shrinks.
   */
  private recoveryRungs(configuredMax: number): readonly number[] {
    return TOO_LARGE_HISTORY_LADDER.filter(r => r < configuredMax);
  }

  /**
   * History re-injection cap for a spawn, given the configured healthy cap and how
   * many consecutive 32MB recoveries have happened on the session. recoveryCount 0
   * = healthy → the full configured cap. Each later recovery drops to the next
   * rung strictly below the cap; once those are exhausted it stays at 0 (no
   * history). Kept in sync with the exhaustion threshold in handleRequestTooLarge.
   */
  private spawnHistoryLimit(configuredMax: number, recoveryCount: number): number {
    if (recoveryCount <= 0) return configuredMax;
    const rungs = this.recoveryRungs(configuredMax);
    if (rungs.length === 0) return 0;
    return rungs[Math.min(recoveryCount - 1, rungs.length - 1)];
  }

  /**
   * Unified recovery for the recoverable "Request too large (max 32MB)" error.
   * Reached from two backends that surface the SAME error differently:
   *  - PTY shell (headless=false): a `system/request_too_large` event emitted by
   *    the transcript tailer from the authoritative <synthetic> record (Bug A).
   *  - Headless (headless=true): claude --print emits a synthetic `result`
   *    (is_error + "Request too large (max"); the long-lived process otherwise
   *    stays alive and rejects every subsequent turn forever (Bug B).
   *
   * Each consecutive recovery shrinks the history re-injected on the next spawn,
   * stepping down the TOO_LARGE_HISTORY_LADDER rungs strictly below the configured
   * cap (default 50 → 40→30→20→10→0), so a pathological context drops under the
   * 32MB ceiling. The respawn happens on the user's NEXT message (no auto-loop),
   * and the counter resets on the next successful result. Once even a zero-history
   * spawn still trips 32MB, stop escalating and ask the user to /clear rather than
   * climb the ladder again.
   */
  private handleRequestTooLarge(mapKey: string, proc: SessionProcess): void {
    proc.setProcessing(false);
    // Skill-learning: a recovery event this turn (feeds the trigger + recovery-rate measure).
    this.skillLearning?.onRecoveryFired(mapKey);
    // Recovery steps through the ladder rungs strictly below the configured cap;
    // the number of those rungs is how many shrink attempts exist before even the
    // smallest (0-history) spawn has been tried and still trips 32MB.
    const configuredMax = resolveMaxHistoryMessages(
      this.agentConfig.history?.maxHistoryMessages,
      this.gatewayConfig.gateway.history?.maxHistoryMessages,
    );
    const stepCount = this.recoveryRungs(configuredMax).length; // shrink attempts available
    const count = (this.tooLargeRecoveries.get(mapKey) ?? 0) + 1;

    if (count > stepCount) {
      // Even the smallest rung tripped 32MB — context can't shrink further.
      // Pin the counter at the last step and always surface the /clear next step.
      this.tooLargeRecoveries.set(mapKey, stepCount);
      this.logger.error('Request too large persists with zero re-injected history', { mapKey, count });
      this.writeAutoForward(
        mapKey,
        '⚠️ ยังเกิน 32MB แม้จะล้าง context จนว่างแล้ว — พิมพ์ /clear เพื่อเริ่มเซสชันใหม่ หรือ /restart ค่ะ',
      );
      // Restart ONCE to clear the wedged process the first time the ladder is
      // exhausted; thereafter stop restarting (no churn) and let the user /clear.
      if (!this.tooLargeExhausted.has(mapKey)) {
        this.tooLargeExhausted.add(mapKey);
        void this.restartProcess(mapKey);
      }
      return;
    }

    this.tooLargeRecoveries.set(mapKey, count);
    this.logger.warn('Request too large (32MB) — restarting with reduced history', {
      mapKey, attempt: count, nextHistoryLimit: this.spawnHistoryLimit(configuredMax, count),
    });
    // Ordering matters and makes the notice delivery race-free: writeAutoForward
    // persists the `.forward` file synchronously HERE, before restartProcess()
    // begins its async stop/kill. The typing-loop tear-down (stop() in typing.ts)
    // drains and sends `.forward` synchronously before it removes the typing
    // signal, so by the time the proc exit fires and the loop stops, the file is
    // already on disk and is delivered — no dependency on poll timing. Do not
    // reorder restartProcess() ahead of writeAutoForward().
    this.writeAutoForward(
      mapKey,
      '⚠️ Context too large — hit Anthropic\'s 32MB request limit (usually from large images or files in context). Restarting this session with a fresh context. Your last message was not processed — please resend it.',
    );
    void this.restartProcess(mapKey);
  }

  /**
   * Stop all idle session subprocesses so they re-spawn with the latest
   * system prompt on the next incoming message.
   *
   * - "Idle" = no activity for {@link IDLE_THRESHOLD_MS}ms (enough to exclude an in-flight turn).
   * - Busy sessions are left alone; they will be picked up by the idle cleaner
   *   (every 5m) or naturally on the next spawn after timeout.
   * - Does NOT stop the receiver; incoming messages keep flowing.
   *
   * Used by the skills hot-reload path so that SKILL.md changes take effect
   * without kicking users out of in-flight turns.
   *
   * @param opts.skipBusy When true, busy sessions are left running and NOT
   *   marked for a deferred restart. Use this when the change came from a file
   *   the agent writes itself mid-turn (e.g. MEMORY.md): deferring a restart
   *   there would stop the very session that produced the change the moment its
   *   turn completes (the self-restart footgun). Idle sessions are still
   *   restarted so the change reaches them on their next spawn. The recomposed
   *   CLAUDE.md is already on disk, so a skipped busy session picks up the
   *   change on its own next natural spawn.
   * @param opts.deferIdle When true, idle sessions are NOT `stop()`ed now.
   *   Instead they are added to the runner-level `pendingRestarts` set, so each
   *   respawns cleanly on its next message (the same lossless mechanism used for
   *   the image-size-threshold restart) rather than being SIGKILLed mid-idle and
   *   losing its in-context state. Since CLAUDE.md is frozen-at-spawn, an idle
   *   bystander gains nothing from an immediate stop — the recomposed file
   *   applies on its next spawn either way. Use for agent-writable/identity and
   *   skills changes, where dropping an unrelated idle session is pure downside.
   *   NB: idle sessions are deferred via `pendingRestarts`, NOT
   *   `proc.markPendingRestart()` — the latter emits `deferredRestartReady`
   *   synchronously on an idle process, which stops it immediately (no deferral).
   * @returns Counts of sessions handled: `immediate` (stopped now), `deferred`
   *   (armed to restart on next turn/message), `skipped` (left untouched).
   */
  async restartOrDefer(
    opts?: { skipBusy?: boolean; deferIdle?: boolean; filter?: (proc: SessionProcess) => boolean },
  ): Promise<{ immediate: number; deferred: number; skipped: number }> {
    const skipBusy = opts?.skipBusy ?? false;
    const deferIdle = opts?.deferIdle ?? false;
    const filter = opts?.filter;
    let immediate = 0;
    let deferred = 0;
    let skipped = 0;
    const toStopNow: string[] = [];
    for (const [id, proc] of this.sessions) {
      // Not counted as `skipped`: that reports sessions this call declined to
      // restart even though they needed one (the skipBusy case). A session the
      // change does not reach at all was never a candidate.
      if (filter && !filter(proc)) continue;
      if (proc.isProcessing) {
        if (skipBusy) {
          skipped++;
          continue;
        }
        proc.markPendingRestart();
        deferred++;
      } else if ((proc.hasLikelyOutstandingBackgroundWork() || deferIdle) && proc.source !== 'api') {
        // Lossless deferral for CHANNEL sessions: leave the idle process running
        // and arm a restart on its next message instead of an immediate stop.
        // Two independent reasons land here, neither gated by skipBusy (which
        // only governs the isProcessing branch above — a session that's already
        // idle isn't the self-restart-footgun case skipBusy exists for):
        //   - deferIdle: the caller explicitly asked never to SIGKILL an idle
        //     bystander (mirrors the image-size-threshold path).
        //   - hasLikelyOutstandingBackgroundWork(): regardless of which tier
        //     called restartOrDefer — even today's aggressive default — a
        //     session that dispatched a background Agent/Workflow/Monitor
        //     tool_use and then ended its OWN turn looks idle here, but that
        //     dispatch may still be doing real work. SIGKILLing it now would
        //     silently destroy that in-flight work with no notification or
        //     recovery (the incident this guards against: a CLAUDE.md-triggered
        //     restart killed a session mid-way through 3 dispatched code-review
        //     sub-agents).
        // Do NOT call proc.markPendingRestart() here — on an idle process it
        // fires deferredRestartReady immediately and stops the session.
        //
        // Guard on source: `pendingRestarts` is consumed ONLY in injectTurn (the
        // channel turn path, keyed by chatId). api / __heartbeat__ sessions are
        // keyed by sessionId and never flow through injectTurn, so an entry armed
        // for them would never be consumed — it would leak in the Set and the
        // change would never reach the session. Fall through to an immediate stop
        // so those respawn fresh on their next use, exactly as before deferIdle.
        this.pendingRestarts.add(id);
        deferred++;
      } else {
        toStopNow.push(id);
      }
    }
    for (const id of toStopNow) {
      const proc = this.sessions.get(id);
      if (!proc) continue;
      await proc.stop();
      this.sessions.delete(id);
      immediate++;
    }
    this.logger.info('restartOrDefer: sessions restarted', { immediate, deferred, skipped });
    return { immediate, deferred, skipped };
  }

  /**
   * Called after a connector's secret or definition changes: a connector was
   * connected, an external control plane pushed a fresh access_token for one it
   * owns (POST /oauth/receive), the background refresh sweep in
   * oauth-refresh-sweep.ts (invoked from gateway-router.ts's 60s interval)
   * rotated one, or a connector was deleted / had its refresh given up on.
   *
   * Restarts exactly the sessions whose own mcp-config no longer matches what
   * `connectorId` resolves to for this agent — see
   * SessionProcess.connectorConfigChanged, which owns that comparison. The
   * stdio MCP subprocess reads its env once at spawn (see writeMcpConfig), so
   * there is no way to hot-patch a running child; a session that IS affected
   * genuinely needs a respawn, and one that isn't must not be disrupted.
   *
   * `overlay` is merged over this runner's view of `gateway.customConnectors` —
   * and adopted into it, so the sessions restarted below respawn from the new
   * state rather than the one the watcher has not delivered yet (see the inline
   * note). Callers that have just written a connector entry need it:
   * config.json's watcher propagates asynchronously, so a route that creates a
   * connector and immediately asks what it resolves to would otherwise be
   * answered from a config snapshot taken before its own write. A `null` value
   * expresses the other half of that write — the entry was REMOVED — which a
   * merge alone cannot say. Deleting a connector whose owner is `'none'` has no
   * secrets to clear, so without it the stale snapshot still resolves the entry
   * to the identical fingerprint, nothing looks changed, and every live session
   * keeps the deleted MCP server connected and callable while the API reports it
   * gone.
   *
   * Deliberately takes no "the caller already decided" escape hatch. The delete
   * and give-up paths needed one while this asked whether the connector still
   * resolves — after `deleteSecrets` it never does, so the answer was always no
   * and the restart silently did nothing. Per-session comparison answers those
   * paths correctly on its own: resolving to nothing IS the change.
   */
  async restartSessionsUsingConnector(
    connectorId: string,
    opts?: { overlay?: Record<string, CustomConnectorEntry | null> },
  ): Promise<{ restarted: boolean }> {
    const overlay = opts?.overlay;
    const customConnectors = {
      ...this.gatewayConfig?.gateway?.customConnectors,
      ...overlay,
    };
    for (const [id, entry] of Object.entries(overlay ?? {})) {
      if (entry === null) delete customConnectors[id];
    }
    // Adopted into the config object, not just used for the comparison below.
    //
    // The overlay's whole purpose is that this runner's view of config.json is
    // older than the write the caller just made — and the sessions this method
    // restarts respawn from that same view: SessionProcess.writeMcpConfig reads
    // `gatewayConfig.gateway.customConnectors` at spawn (this is the very object
    // it was handed — see the constructor call above), so a session stopped
    // because a connector changed came back up with the pre-change connector
    // set. The watcher's 500ms debounce means that is the normal case, not a
    // narrow race: connect a connector and the agent respawns still without the
    // tool, delete one and it respawns still holding it.
    //
    // And it does not self-correct. The fresh spawn records the STALE resolution
    // as its fingerprint, so when the watcher finally lands nothing compares it
    // again — this method is the only caller of connectorConfigChanged, and it
    // has already run. The wrong config sticks until something unrelated
    // restarts the session.
    //
    // Mutating the config object is exactly what index.ts's `changes` handler
    // does to this same long-lived object on every reload, so this is the
    // established way to publish a config change to running runners rather than
    // a new mechanism. Idempotent across runners: they share the object, and
    // every one of them merges the same overlay onto it.
    if (overlay) {
      this.gatewayConfig.gateway.customConnectors =
        customConnectors as Record<string, CustomConnectorEntry>;
    }
    const resolved = resolveEnabledConnectors(
      this.agentConfig,
      customConnectors as Record<string, CustomConnectorEntry>,
      this.gatewayConfig?.gateway?.connectorsDefaultEnabled ?? true,
    );
    const target = resolved[connectorId];
    const { immediate, deferred } = await this.restartOrDefer({
      skipBusy: false,
      deferIdle: true,
      filter: (proc) => proc.connectorConfigChanged(connectorId, target),
    });
    return { restarted: immediate + deferred > 0 };
  }

  /**
   * Format a timestamp as a human-readable age string (e.g. "5m ago", "2h ago").
   */
  private formatAge(ts: number): string {
    const diffMs = Date.now() - ts;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  /**
   * Write an error code to the typing signal directory so the receiver's
   * typing loop can pick it up and notify the user via Telegram.
   * Non-fatal: if the write fails the typing loop will stop via stalled timer.
   */
    private getTypingDir(chatId: string): string {
    const channel = this.channelSourceMap.get(chatId) ?? 'telegram';
    const stateDir = channel === 'discord' ? '.discord-state' : '.telegram-state';
    return path.join(this.agentConfig.workspace, stateDir, 'typing');
  }

  /**
   * Read the live typing-signal file's timestamp as this turn's id. Shared
   * with the `telegram_reply` MCP tool (a separate process) purely via this
   * file, so `.forward`/`.replied` markers written around the same turn carry
   * a matching id — see writeAutoForward()'s dedup comment.
   */
  private readCurrentTurnId(chatId: string): string | null {
    const typingDir = this.getTypingDir(chatId);
    try {
      const raw = fs.readFileSync(path.join(typingDir, chatId), 'utf8').trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  private writeTypingError(chatId: string, code: string): void {
    const typingDir = this.getTypingDir(chatId);
    try {
      fs.mkdirSync(typingDir, { recursive: true });
      fs.writeFileSync(path.join(typingDir, `${chatId}.error`), code);
    } catch {
      // Non-fatal — typing loop will stop via stalled timer instead
    }
  }

  private writeTypingDone(chatId: string): void {
    const typingDir = this.getTypingDir(chatId);
    try {
      fs.rmSync(path.join(typingDir, chatId), { force: true });
    } catch {
      // Non-fatal
    }
  }

  private async triggerSummaryAndRestart(
    chatId: string,
    sessionId: string,
    session: SessionProcess,
  ): Promise<void> {
    const IMAGE_CONTEXT_MARKER = '[Image Context Summary]';
    try {
      const prompt = [
        'Briefly summarize each image you have seen in this conversation.',
        'Format: "Image N: [1-2 sentence description]"',
        'List every image separately.',
      ].join(' ');
      const description = await session.query(prompt);
      if (description) {
        const msg: Message = {
          role: 'system',
          content: `${IMAGE_CONTEXT_MARKER}\n${description}`,
          ts: Date.now(),
        };
        await this.sessionStore.appendTelegramMessage(this.agentConfig.id, chatId, sessionId, msg, this.channelFor(chatId));
      }
    } catch (err) {
      this.logger.warn('Image context summary failed', { error: err instanceof Error ? err.message : String(err) });
    }
    this.pendingRestarts.add(chatId);
  }

  private writeAutoForward(chatId: string, text: string, format: 'text' | 'html' = 'text', forceDeliver = false): void {
    // LINE has no .forward consumer — route through LineReplyManager's push path.
    if (this.channelFor(chatId) === 'line') {
      if (this.lineReply) void this.lineReply.onAnswer(chatId, text);
      return;
    }
    // Slack likewise has no .forward consumer (only Telegram/Discord receivers
    // poll that directory) — post directly via the outbound client instead.
    // Without this branch every command reply (/stop, /rename, /sessions,
    // /compact), the Anthropic-socket-drop notice, and the plain-text
    // assistant-fallback path (no tool call) silently vanished for Slack.
    if (this.channelFor(chatId) === 'slack') {
      if (this.slackOutbound) {
        // Reply in-thread when the last inbound message was threaded (mirrors
        // the slack_reply tool's thread_id behavior); top-level otherwise.
        const threadTs = this.slackThreadTs.get(chatId);
        void this.slackOutbound.postMessage(chatId, text, threadTs).catch((err: unknown) => {
          this.logger.warn('Slack auto-forward failed', {
            chatId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return;
    }
    const typingDir = this.getTypingDir(chatId);
    const forwardPath = path.join(typingDir, `${chatId}.forward`);
    try {
      fs.mkdirSync(typingDir, { recursive: true });
      // Append rather than overwrite: two forward-worthy events for the same
      // chat before the typing loop drains (e.g. two command replies, or the
      // race where a queued turn's stop() call drains a prior turn's leftover
      // state) must both reach the user, not have the second clobber the
      // first. turnId is the live typing-signal timestamp — the receiver uses
      // it to scope the `.replied` dedup marker to the turn that wrote it.
      // forceDeliver writes a null turnId instead: `isEntryAlreadyReplied()`
      // never matches a null on either side, so the entry survives a `.replied`
      // marker left by an EARLIER successful reply in this same turn. Used for
      // text that is NOT the one that marker covers — a fallback forward after a
      // reply call failed, and the socket-drop notice (#422).
      let entries: Array<{ text: string; format: string; turnId: string | null }> = [];
      try {
        const raw = fs.readFileSync(forwardPath, 'utf8').trim();
        if (raw) {
          try {
            const parsed: unknown = JSON.parse(raw);
            entries = Array.isArray(parsed)
              ? (parsed as typeof entries)
              : [parsed as (typeof entries)[number]];
          } catch {
            entries = [{ text: raw, format: 'text', turnId: null }];
          }
        }
      } catch {
        // No existing file — fresh queue.
      }
      entries.push({ text, format, turnId: forceDeliver ? null : this.readCurrentTurnId(chatId) });
      // Atomic write (tmp + rename): the receiver polls this directory on
      // every typing tick, so a non-atomic write could be read mid-flush.
      const tmpPath = `${forwardPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(entries));
      fs.renameSync(tmpPath, forwardPath);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Signal the channel receiver to render an interactive menu as native UI
   * (inline buttons on Telegram/Discord). The receiver maps each option to a
   * `choice:N` callback whose tap arrives back as a normal "N" message — the
   * same as the user typing the number.
   */
  private writeMenuForward(chatId: string, text: string, options: Array<{ label: string }>): void {
    const typingDir = this.getTypingDir(chatId);
    try {
      fs.mkdirSync(typingDir, { recursive: true });
      // Write atomically (tmp + rename): the receiver polls this directory every
      // second, so a non-atomic write could be read mid-flush as truncated JSON.
      const finalPath = path.join(typingDir, `${chatId}.menu`);
      const tmpPath = `${finalPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ text, options }));
      fs.renameSync(tmpPath, finalPath);
    } catch {
      // Non-fatal — the result text still carries the numbered list as a fallback.
    }
  }

  private startIdleCleaner(): void {
    this.idleCleanerTimer = setInterval(async () => {
      for (const [id, proc] of this.sessions) {
        // A parent that just dispatched Agent/Workflow/Monitor work is CLI-idle
        // but that dispatch may still need this session to receive its
        // eventual task notification.
        if (proc.hasLikelyOutstandingBackgroundWork()) continue;
        if (proc.isIdle(this.idleTimeoutMs)) {
          this.logger.info('Stopping idle session', { sessionId: id });
          await proc.stop();
          this.sessions.delete(id);
          this.evictApiSessionMapping(id);
        }
      }
    }, 5 * 60 * 1000);
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.sweepStaleSessionDirs();
    await this.startCallbackServer();
    if (this.agentConfig.telegram?.botToken) {
      this.receiver = new TelegramReceiver(
        this.agentConfig,
        this.callbackPort,
        this.gatewayConfig.gateway.logDir,
      );
      this.receiver.start();
    }
    if (this.agentConfig.discord?.botToken) {
      this.discordReceiver = new DiscordReceiver(
        this.agentConfig,
        this.callbackPort,
        this.gatewayConfig.gateway.logDir,
      );
      this.discordReceiver.start();
    }
    // LINE slow-LLM postback button: gateway-side token lifecycle + cache.
    // Enabled for any LINE agent unless its threshold is 0 (then the MCP
    // line_reply tool keeps the plain reply-first → push-fallback path).
    this.startLineReply();
    this.startSlackOutbound();
    this.startIdleCleaner();
    this._startCleanupScheduler();
    this.logger.info('AgentRunner started', { agentId: this.agentConfig.id });
  }

  /**
   * Remove any `.sessions/<id>/` directory not backed by a currently-live
   * `SessionProcess` — leftovers from a hard kill (SIGKILL, crash, host
   * reboot) that `SessionProcess.stop()`'s own cleanup never got to run for.
   * Each holds a `mcp-config.json` with fully-substituted secrets (channel
   * bot tokens, GATEWAY_API_KEY) that must not accumulate unbounded (#460).
   *
   * Called once per runner instance at the top of `start()`, before any of
   * this agent's own sessions exist yet, so `this.sessions` is normally
   * empty here — but the liveness check is real, not just a formality: skip
   * anything present in `this.sessions` regardless, rather than assuming
   * "start() always runs on an empty pool" and deleting unconditionally.
   *
   * Async (fsPromises) rather than sync fs calls: a first upgrade to this fix
   * can face a real backlog of leftovers accumulated before it existed, and
   * synchronous readdir/rm would block the event loop — and every other
   * agent's start() sharing this process — for the duration.
   */
  private async sweepStaleSessionDirs(): Promise<void> {
    const sessionsRoot = path.join(this.agentConfig.workspace, '.sessions');
    let entries: import('fs').Dirent[];
    try {
      entries = await fsPromises.readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return; // no .sessions directory yet — nothing to sweep
    }
    const liveSessionIds = new Set(Array.from(this.sessions.values(), (s) => s.sessionId));
    for (const entry of entries) {
      if (!entry.isDirectory() || liveSessionIds.has(entry.name)) continue;
      try {
        await fsPromises.rm(path.join(sessionsRoot, entry.name), { recursive: true, force: true });
      } catch {
        /* best-effort cleanup — a stubborn leftover isn't worth failing boot over */
      }
    }
  }

  updateAgentConfig(newConfig: AgentConfig): void {
    this.agentConfig = newConfig;
    // Restart LineReplyManager if the LINE config changed so the live instance
    // picks up a new access token, threshold, or labels without a full restart.
    this.stopLineReply();
    this.startLineReply();
    // Slack token/secret may have changed (or been cleared) — rebuild to pick
    // it up, same reasoning as LineReplyManager above.
    this.stopSlackOutbound();
    this.startSlackOutbound();
  }

  startSlackOutbound(): void {
    if (!this.agentConfig.slack?.botToken || !this.agentConfig.slack?.signingSecret) return;
    if (this.slackOutbound) return; // already running
    this.slackOutbound = new SlackClient({
      botToken: this.agentConfig.slack.botToken,
      logDir: this.gatewayConfig.gateway.logDir,
    });
  }

  stopSlackOutbound(): void {
    this.slackOutbound = null;
  }

  startLineReply(): void {
    const lineThreshold = this.agentConfig.line?.slowResponseThreshold ?? 45;
    if (!this.agentConfig.line?.channelSecret || !this.agentConfig.line?.channelAccessToken || lineThreshold <= 0) return;
    if (this.lineReply) return; // already running
    this.lineReply = new LineReplyManager({
      agentId: this.agentConfig.id,
      logDir: this.gatewayConfig.gateway.logDir,
      accessToken: this.agentConfig.line.channelAccessToken,
      thresholdSeconds: lineThreshold,
      buttonLabel: this.agentConfig.line.slowButtonLabel,
      pendingText: this.agentConfig.line.slowPendingText,
    });
    this.logger.info('LineReplyManager hot-started', { agentId: this.agentConfig.id });
  }

  stopLineReply(): void {
    if (!this.lineReply) return;
    this.lineReply.disposeAll();
    this.lineReply = null;
    this.logger.info('LineReplyManager stopped', { agentId: this.agentConfig.id });
  }

  getAgentConfig(): AgentConfig {
    return { ...this.agentConfig };
  }

  /** Configured gateway.publicUrl, or undefined. The trusted source for the
   *  gateway's own public origin — preferred over request-derived hosts, which
   *  a client can spoof via X-Forwarded-Host. */
  getGatewayPublicUrl(): string | undefined {
    return this.gatewayConfig.gateway.publicUrl;
  }

  startTelegramReceiver(): void {
    if (this.receiver?.isRunning()) return;
    if (!this.agentConfig.telegram?.botToken) return;
    this.receiver = new TelegramReceiver(
      this.agentConfig,
      this.callbackPort,
      this.gatewayConfig.gateway.logDir,
    );
    this.receiver.start();
    this.logger.info('TelegramReceiver hot-started', { agentId: this.agentConfig.id });
  }

  stopTelegramReceiver(): void {
    if (!this.receiver) return;
    // Hot-remove is a config-change response, not a shutdown: detach immediately
    // and let teardown finish in the background rather than blocking the caller
    // for the SIGKILL grace period. stop() never rejects.
    void this.receiver.stop();
    this.receiver = null;
    this.logger.info('TelegramReceiver stopped', { agentId: this.agentConfig.id });
  }

  startDiscordReceiver(): void {
    if (this.discordReceiver?.isRunning()) return;
    if (!this.agentConfig.discord?.botToken) return;
    this.discordReceiver = new DiscordReceiver(
      this.agentConfig,
      this.callbackPort,
      this.gatewayConfig.gateway.logDir,
    );
    this.discordReceiver.start();
    this.logger.info('DiscordReceiver hot-started', { agentId: this.agentConfig.id });
  }

  stopDiscordReceiver(): void {
    if (!this.discordReceiver) return;
    // Hot-remove is a config-change response, not a shutdown: detach immediately
    // and let teardown finish in the background rather than blocking the caller
    // for the SIGKILL grace period. stop() never rejects.
    void this.discordReceiver.stop();
    this.discordReceiver = null;
    this.logger.info('DiscordReceiver stopped', { agentId: this.agentConfig.id });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.idleCleanerTimer !== null) {
      clearInterval(this.idleCleanerTimer);
      this.idleCleanerTimer = null;
    }
    this.cancelCleanup?.();
    this.cancelCleanup = null;
    if (this.callbackServer) {
      const srv = this.callbackServer;
      this.callbackServer = null;
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    for (const buf of this.channelCoalesce.values()) {
      clearTimeout(buf.timer);
    }
    this.channelCoalesce.clear();
    // Drops every turn record and its replay-grace timer (#421).
    this.turnStreams.clear();
    // Receiver teardown now resolves only once the child has exited, so it must
    // be awaited or shutdown() can exit the gateway out from under a receiver
    // that is still shutting down (issue #405). Run it concurrently with session
    // teardown rather than serially — both are bounded, neither depends on the
    // other, and shutdown latency is user-visible.
    const receiversStopped = [this.receiver?.stop(), this.discordReceiver?.stop()];
    this.stopLineReply();
    await Promise.all([
      ...receiversStopped,
      ...[...this.sessions.values()].map((s) => s.stop()),
    ]);
    this.sessions.clear();
  }

  /**
   * Deliver a tapped LINE postback (the slow-LLM "Get answer" button).
   * Returns true when it was our refresh button (caller must NOT forward it to
   * the agent); false for any other postback.
   */
  async handleLinePostback(chatId: string, replyToken: string, data: string): Promise<boolean> {
    if (!this.lineReply) return false;
    return this.lineReply.handlePostback(chatId, replyToken, data);
  }

  private _startCleanupScheduler(): void {
    const gw = this.gatewayConfig.gateway;
    const retentionDays = resolveRetentionDays(
      this.agentConfig.history?.retentionDays,
      gw.history?.retentionDays,
    );
    const cleanupHour = gw.history?.cleanupHour ?? 0;
    const cleanupTimezone = gw.history?.cleanupTimezone ?? 'UTC';
    const agentMediaRoot = MediaStore.agentMediaRoot(this.agentsBaseDir, this.agentConfig.id);
    const logPath = path.join(this.agentDir, 'cleanup.log');

    this.cancelCleanup = scheduleCleanup({
      db: this.historyDb,
      agentMediaRoot,
      logPath,
      retentionDays,
      cleanupHour,
      cleanupTimezone,
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    this.stopping = false;
    await this.start();
  }

  isRunning(): boolean {
    return this.receiver?.isRunning() ?? false;
  }

  getSessionsSummary(): Array<{ chatId: string; sessionId: string; source: string; mode: string; model: string; isRunning: boolean; spawnedAt: number; uptimeSec: number; tokens: number }> {
    const now = Date.now();
    // A single logical session can appear multiple times in the ring buffer: a
    // restart / model-switch / error-recovery respawn pushes a fresh entry with
    // the SAME sessionId but a new spawnedAt. History is newest-first (unshift),
    // so the first occurrence of a (source, sessionId, chatId) is the current
    // incarnation — collapse to it so the dashboard shows one row per session
    // instead of duplicating it.
    const seen = new Set<string>();
    const out: Array<{ chatId: string; sessionId: string; source: string; mode: string; model: string; isRunning: boolean; spawnedAt: number; uptimeSec: number; tokens: number }> = [];
    for (const e of this.sessionHistory) {
      const dedupKey = `${e.source}:${e.sessionId}:${e.chatId}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const proc = this.sessions.get(e.chatId);
      // Running only when the live process IS this incarnation: a stale entry
      // from before a respawn must not borrow the new process's running state.
      const isRunning = !!proc && proc.spawnedAt === e.spawnedAt;
      // For API sessions the ring-buffer chatId equals the sessionId (the map key);
      // surface the real caller chatId instead when we have it.
      const chatId = e.source === 'api' ? (this.apiChatIds.get(e.sessionId) ?? e.chatId) : e.chatId;
      // Live context-window token usage from the running process (0 when stopped).
      const tokens = isRunning ? (proc?.totalTokens ?? 0) : 0;
      out.push({ ...e, chatId, isRunning, uptimeSec: Math.floor((now - e.spawnedAt) / 1000), tokens });
    }
    return out;
  }

  /**
   * Send a message to an API session and wait for the response.
   *
   * - Spawns a new SessionProcess (source='api') if none exists for sessionId.
   * - Rejects with code 'CONFLICT' if a prior request is still in-flight for this session.
   * - Rejects with code 'TIMEOUT' if Claude does not respond within timeoutMs.
   * - Appends user message and assistant reply to SessionStore for history persistence.
   */
  async sendApiMessage(
    sessionId: string,
    chatId: string,
    message: string,
    opts: { timeoutMs: number; allowTools?: boolean; mediaFiles?: string[]; model?: string; skipUserMessage?: boolean; imageParams?: ImageParams },
  ): Promise<{ text: string; attachments: ApiAttachment[] }> {
    if (this.pendingApiSessions.has(sessionId)) {
      const err = Object.assign(
        new Error(`Session ${sessionId} already has a pending request`),
        { code: 'CONFLICT' },
      );
      throw err;
    }

    // Register session in api-{chatId} index.json on first use (store adds channel prefix internally)
    await this.sessionStore.ensureApiSession(this.agentConfig.id, chatId, sessionId).catch((err: unknown) => {
      this.logger.warn('Failed to register API session in index', { agentId: this.agentConfig.id, chatId, sessionId, error: (err as Error).message });
    });

    // Use model from request body if provided, otherwise use agent default
    const session = await this.getOrSpawnSession(sessionId, 'api', undefined, opts.model);
    this.apiChatIds.set(sessionId, chatId);

    // Promote UI-uploaded files from staging to permanent per-session storage
    const finalMediaFiles = opts.mediaFiles?.length
      ? await promoteUiUploads(this.agentsBaseDir, this.agentConfig.id, sessionId, opts.mediaFiles, this.logger)
      : undefined;
    // Refs built from staging paths must follow the files to their promoted
    // location — see remapImageParamsRefs (#74).
    const imageParams = AgentRunner.remapImageParamsRefs(opts.imageParams, opts.mediaFiles, finalMediaFiles);

    // Resolve media files to absolute paths for file-path based image passing
    // (same pattern as Telegram — Claude Code reads files via Read tool instead of base64 inline)
    const imagePaths = finalMediaFiles?.length ? this.resolveMediaPaths(finalMediaFiles) : [];

    // skipUserMessage omits the trigger from both session context and history so only the
    // assistant response is visible — intentional for system-initiated messages (e.g. cron welcome).
    // Claude still receives the prompt via channelXml for this turn; session restarts will not
    // replay it, which is the desired behaviour for one-shot proactive messages.
    if (!opts.skipUserMessage) {
      const apiUserTs = Date.now();
      await this.sessionStore
        .appendMessage(this.agentConfig.id, sessionId, {
          role: 'user',
          content: message,
          ts: apiUserTs,
        })
        .catch(() => {});
      this.historyDb.insertMessage({
        chatId: `api-${chatId}`,
        sessionId,
        source: 'api',
        role: 'user',
        content: message,
        mediaFiles: finalMediaFiles?.length ? finalMediaFiles : undefined,
        // Display-only (#74): lets the UI show which earlier images this turn
        // referenced after a reload. The generation path reads the refs from the
        // image-params note, never from here.
        imageRefs: imageParams?.image_refs?.length ? imageParams.image_refs : undefined,
        ts: apiUserTs,
      });
    }

    this.pendingApiSessions.add(sessionId);
    // A previous turn that died (hard timeout, crash) may have left attachments
    // buffered under this session — they belong to THAT turn; never let them
    // ride along on this one (#75).
    this.pendingApiAttachments.delete(sessionId);
    session.touch();

    // Image paths only work when allowTools:true — Claude needs the Read tool to access them
    const allowTools = opts.allowTools ?? false;
    if (!allowTools && imagePaths.length) {
      this.logger.warn('Images ignored: allowTools is false, Claude cannot use Read tool', { sessionId, imageCount: imagePaths.length });
    }
    const effectiveImagePaths = allowTools ? imagePaths : [];
    const systemNote = buildApiSystemNote(allowTools, effectiveImagePaths.length ? effectiveImagePaths : undefined);

    // Detect skill commands (same as channel message path)
    const skillInvocation = detectSkillCommand(message, this.skillRegistry);
    if (skillInvocation) {
      this.logger.info('Skill invoked via API', {
        skill: skillInvocation.skillKey,
        args: skillInvocation.args,
        sessionId,
      });
    }

    // Build channel XML with image_path attribute (like Telegram) for first image
    const imageAttr = effectiveImagePaths.length ? ` image_path="${AgentRunner.escapeXmlAttr(effectiveImagePaths[0]!)}"` : '';
    const imageParamsNote = imageParams ? AgentRunner.buildImageParamsNote(imageParams) : '';
    // Persist the composer image options to session meta so the web can restore the
    // selection on reload (SessionMeta.imageConfig). Only when the send carries them
    // (the web sends image_params on first-set/change), so this holds the latest.
    // image_refs are per-turn and deliberately excluded (#73).
    // Channel is 'api' here (api sessions live under api-<chatId>). Best-effort.
    const durableImageConfig = imageParams ? AgentRunner.durableImageConfig(imageParams) : undefined;
    if (durableImageConfig) {
      this.sessionStore
        .updateSessionMeta(this.agentConfig.id, chatId, sessionId, { imageConfig: durableImageConfig }, 'api')
        .catch(() => {});
    }
    const channelXml =
      `<channel source="api" chat_id="${chatId}" session_id="${sessionId}" ts="${new Date().toISOString()}"${imageAttr}>\n` +
      `${message}\n\n` +
      `${systemNote}` +
      `${imageParamsNote}` +
      `</channel>` +
      (skillInvocation ? `\n${formatSkillContext(skillInvocation)}` : '');

    return new Promise<{ text: string; attachments: ApiAttachment[] }>((resolve, reject) => {
      const buffer: string[] = [];
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      // Track partial message text for delta computation (--include-partial-messages)
      let lastPartialText = '';
      // Guards done/fail against a double-fire — e.g. onExit racing a 'result'
      // line that already settled this turn (see onExit below).
      let settled = false;

      const done = (result: string, interrupted = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        const attachments = this.popApiAttachments(sessionId);
        const trimmed = result.trim();
        // A /stop that lands before any text or attachment came out of this turn
        // would otherwise persist nothing at all — the last committed message
        // stays the user's forever, and the web sidebar's "typing…" indicator
        // never clears (it only clears once the last message is from the
        // assistant). Same wording buildInitialPrompt uses to patch this same
        // dangling-turn shape for the next spawn's in-memory context.
        // A /stop that lands AFTER partial text/attachments already streamed out
        // (e.g. mid tool-use, "Drawing now...") must still say so — appended rather
        // than replacing, so the partial work stays visible alongside the notice.
        const finalText = interrupted
          ? [trimmed, INTERRUPTED_NO_REPLY_TEXT].filter(Boolean).join('\n\n')
          : trimmed;
        // Persist assistant reply. Image-only replies (empty text but attachments
        // present) must also persist — otherwise the screenshot vanishes from history.
        if (finalText || attachments.length) {
          const apiAssistantTs = Date.now();
          this.sessionStore
            .appendMessage(this.agentConfig.id, sessionId, {
              role: 'assistant',
              content: finalText,
              ts: apiAssistantTs,
            })
            .catch(() => {});
          this.historyDb.insertMessage({
            chatId: `api-${chatId}`,
            sessionId,
            source: 'api',
            role: 'assistant',
            content: finalText,
            mediaFiles: attachments.length ? attachments.map((a) => `media/${a.relPath}`) : undefined,
            ts: apiAssistantTs,
          });
        }
        resolve({ text: finalText, attachments });
      };

      const fail = (err: Error, partialText?: string) => {
        if (settled) return;
        settled = true;
        // Terminal close for a turn that produced no result (#75): record it so
        // history does not end on a dangling user message, and drain the
        // attachment buffer so nothing leaks into the next turn.
        this.persistFailedApiTurn(chatId, sessionId, err, opts.skipUserMessage, partialText);
        cleanup();
        reject(err); // no-op when the soft timeout already rejected
      };

      // The subprocess died without ever emitting a final `result` line (crash,
      // an unexpected signal — distinct from a graceful /stop, whose SIGINT
      // handler still emits a terminal result before exiting, so `done()` wins
      // that race and this is a no-op). Without this, a mid-turn crash left
      // pendingApiSessions — and the caller's pending-response spinner — stuck
      // until the up-to-15-minute opts.timeoutMs + API_TIMEOUT_HARD_CAP_EXTRA_MS
      // safety net finally fired.
      //
      // If the exit followed a /stop (the CLI's SIGINT handler fell through to
      // default termination instead of flushing a result line), that's a
      // successful stop, not a crash — resolve like the graceful path instead
      // of surfacing "process exited unexpectedly" for a stop the user asked for.
      const onExit = () => {
        const interrupted = session.consumeInterruptFlag();
        if (interrupted) {
          done(buffer.join(''), true);
          return;
        }
        // Whatever streamed before the crash is real work the caller may already
        // have read; persist it alongside the notice rather than replacing it,
        // exactly as the hard cap below does.
        fail(Object.assign(new Error('Session process exited unexpectedly before responding.'), { code: 'PROCESS_EXITED' }), buffer.join(''));
      };

      const cleanup = () => {
        clearTimeout(globalTimer);
        if (hardCapTimer) clearTimeout(hardCapTimer);
        if (quietTimer) clearTimeout(quietTimer);
        session.off('output', onOutput);
        session.off('exit', onExit);
        this.pendingApiSessions.delete(sessionId);
      };

      const resetQuiet = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => done(buffer.join(''), session.consumeInterruptFlag()), 2000);
      };

      const onOutput = (line: string) => {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;

          // Handle partial assistant messages (from --include-partial-messages)
          if (obj['type'] === 'assistant') {
            const msg = obj['message'] as { content?: Array<{ type: string; text?: string }> } | undefined;
            if (Array.isArray(msg?.content)) {
              let fullText = '';
              for (const block of msg!.content) {
                if (block.type === 'text' && block.text) fullText += block.text;
              }
              if (fullText.length > lastPartialText.length) {
                buffer.push(fullText.slice(lastPartialText.length));
                resetQuiet();
              }
              lastPartialText = fullText;
            }
          }

          // Standalone text delta
          if (obj['type'] === 'text') {
            const text = (obj['text'] as string) ?? '';
            if (text) {
              buffer.push(text);
              resetQuiet();
            }
          }

          // result event = end of turn
          if (obj['type'] === 'result') {
            session.setProcessing(false);
            // Use || instead of ?? so an empty-string result falls back to the
            // accumulated buffer (needed for non-Anthropic models e.g. OpenRouter,
            // which emit result:"" even though the text arrived via stream_event chunks).
            const resultText = (obj['result'] as string | undefined) || buffer.join('');
            // Consumed here (rather than left for onExit) so the graceful path — a
            // result line flushed before the subprocess exits — still gets credit
            // for the interrupt; onExit's own consumeInterruptFlag() call would
            // otherwise see it already cleared and take the (harmless, settled-
            // guarded) fail() branch instead.
            done(resultText, session.consumeInterruptFlag());
          }
        } catch {
          /* non-JSON stdout line */
        }
      };

      // Soft timeout (#75): unblock the caller now, but KEEP the output listener
      // attached — a turn finishing moments late must still persist its result
      // and attachments, mirroring the client-disconnect path. The hard cap
      // bounds a genuinely hung turn.
      let hardCapTimer: ReturnType<typeof setTimeout> | undefined;
      const globalTimer = setTimeout(() => {
        // TIMEOUT_SOFT: the caller's budget elapsed, the turn has not. The hard
        // cap below rejects nobody — the promise is already settled — but it
        // does stop the turn, so only IT gets the terminal TIMEOUT.
        reject(Object.assign(new Error('Agent response timeout'), { code: 'TIMEOUT_SOFT' }));
        hardCapTimer = setTimeout(() => {
          // Interrupt before clearing the processing flag — interrupt() no-ops
          // once `_processing` is false. See the streaming path for why the cap
          // stops the turn instead of only detaching from it.
          session.interrupt();
          session.setProcessing(false);
          fail(Object.assign(new Error('Agent response timed out.'), { code: 'TIMEOUT' }), buffer.join(''));
        }, API_TIMEOUT_HARD_CAP_EXTRA_MS);
      }, opts.timeoutMs);

      session.on('output', onOutput);
      session.on('exit', onExit);
      session.setProcessing(true);
      session.sendMessage(channelXml);
      // Do NOT call resetQuiet() here — the quiet timer should only start
      // after the first output line arrives, otherwise it fires before the
      // subprocess has had time to respond (especially on first turn).
    });
  }

  /**
   * Send a message to an API session and stream back events via callbacks.
   *
   * Returns a disconnect handler for the caller to wire to the SSE close event.
   * It detaches this caller's sink; the turn keeps running, keeps buffering, and
   * stays re-attachable via attachTurnStream() until the replay grace window
   * expires (#421).
   */
  async sendApiMessageStream(
    sessionId: string,
    chatId: string,
    message: string,
    callbacks: ApiStreamCallbacks,
    opts: { timeoutMs: number; allowTools?: boolean; mediaFiles?: string[]; model?: string; skipUserMessage?: boolean; imageParams?: ImageParams; requestId?: string },
  ): Promise<() => void> {
    if (this.pendingApiSessions.has(sessionId)) {
      const err = Object.assign(
        new Error(`Session ${sessionId} already has a pending request`),
        { code: 'CONFLICT' },
      );
      throw err;
    }

    // Register session in api-{chatId} index.json on first use (store adds channel prefix internally)
    await this.sessionStore.ensureApiSession(this.agentConfig.id, chatId, sessionId).catch((err: unknown) => {
      this.logger.warn('Failed to register API session in index', { agentId: this.agentConfig.id, chatId, sessionId, error: (err as Error).message });
    });

    // Use model from request body if provided, otherwise use agent default
    const session = await this.getOrSpawnSession(sessionId, 'api', undefined, opts.model);
    this.apiChatIds.set(sessionId, chatId);

    // Promote UI-uploaded files from staging to permanent per-session storage
    const finalMediaFilesStream = opts.mediaFiles?.length
      ? await promoteUiUploads(this.agentsBaseDir, this.agentConfig.id, sessionId, opts.mediaFiles, this.logger)
      : undefined;
    // Refs built from staging paths must follow the files to their promoted
    // location — see remapImageParamsRefs (#74).
    const imageParamsStream = AgentRunner.remapImageParamsRefs(opts.imageParams, opts.mediaFiles, finalMediaFilesStream);

    // Resolve media files to absolute paths for file-path based image passing
    const imagePathsStream = finalMediaFilesStream?.length ? this.resolveMediaPaths(finalMediaFilesStream) : [];

    if (!opts.skipUserMessage) {
      const streamUserTs = Date.now();
      await this.sessionStore
        .appendMessage(this.agentConfig.id, sessionId, {
          role: 'user',
          content: message,
          ts: streamUserTs,
        })
        .catch(() => {});
      this.historyDb.insertMessage({
        chatId: `api-${chatId}`,
        sessionId,
        source: 'api',
        role: 'user',
        content: message,
        mediaFiles: finalMediaFilesStream?.length ? finalMediaFilesStream : undefined,
        // Display-only (#74): lets the UI show which earlier images this turn
        // referenced after a reload. The generation path reads the refs from the
        // image-params note, never from here.
        imageRefs: imageParamsStream?.image_refs?.length ? imageParamsStream.image_refs : undefined,
        ts: streamUserTs,
      });
    }

    this.pendingApiSessions.add(sessionId);
    // A previous turn that died (hard timeout, crash) may have left attachments
    // buffered under this session — they belong to THAT turn; never let them
    // ride along on this one (#75).
    this.pendingApiAttachments.delete(sessionId);
    session.touch();

    const buffer: string[] = [];
    let settled = false;
    // The turn's event buffer. Every emission below records into it whether or
    // not anyone is listening; the sink decides only what reaches a socket, so a
    // disconnect no longer costs the client the rest of the turn (#421).
    const turn = this.turnStreams.start(turnStreamKey('api', sessionId), opts.requestId ?? randomUUID());
    const initialSink = callbackSink(callbacks);
    turn.attach(initialSink, 0);
    // Track partial message text for delta computation (--include-partial-messages)
    let lastPartialText = '';
    // Accumulate tool_use blocks from stream_event (content_block_start → delta → stop)
    const toolBlocks = new Map<number, { id: string; name: string; chunks: string[] }>();

    const done = (result: string, interrupted = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      const attachments = this.popApiAttachments(sessionId);
      const trimmed = result.trim();
      // A /stop that lands before any text or attachment came out of this turn
      // would otherwise persist nothing at all — the last committed message
      // stays the user's forever, and the web sidebar's "typing…" indicator
      // never clears (it only clears once the last message is from the
      // assistant). Same wording buildInitialPrompt uses to patch this same
      // dangling-turn shape for the next spawn's in-memory context.
      // A /stop that lands AFTER partial text/attachments already streamed out
      // (e.g. mid tool-use, "Drawing now...") must still say so — appended rather
      // than replacing, so the partial work stays visible alongside the notice.
      const finalText = interrupted
        ? [trimmed, INTERRUPTED_NO_REPLY_TEXT].filter(Boolean).join('\n\n')
        : trimmed;
      // Persist assistant reply regardless of whether the SSE client is still connected.
      // Image-only replies (empty text but attachments present) must also persist —
      // otherwise the screenshot vanishes from history once the stream ends.
      if (finalText || attachments.length) {
        const streamAssistantTs = Date.now();
        this.sessionStore
          .appendMessage(this.agentConfig.id, sessionId, {
            role: 'assistant',
            content: finalText,
            ts: streamAssistantTs,
          })
          .catch(() => {});
        this.historyDb.insertMessage({
          chatId: `api-${chatId}`,
          sessionId,
          source: 'api',
          role: 'assistant',
          content: finalText,
          mediaFiles: attachments.length ? attachments.map((a) => `media/${a.relPath}`) : undefined,
          ts: streamAssistantTs,
        });
      }
      this.turnStreams.complete(turn, resultEvent(finalText, attachments));
    };

    const fail = (err: Error, partialText?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Terminal close for a turn that produced no result (#75): record it so
      // history does not end on a dangling user message (the web reads that
      // state as "still thinking" and spins forever), and drain the attachment
      // buffer so nothing leaks into the next turn.
      this.persistFailedApiTurn(chatId, sessionId, err, opts.skipUserMessage, partialText);
      this.turnStreams.complete(turn, errorEvent(err), err);
    };

    // The subprocess died without ever emitting a final `result` line (crash,
    // an unexpected signal — distinct from a graceful /stop, whose SIGINT
    // handler still emits a terminal result before exiting, so `done()` wins
    // that race and this is a no-op via the `settled` guard in fail()).
    // Without this, a mid-turn crash left pendingApiSessions — and the web's
    // pending-response spinner — stuck until the up-to-15-minute
    // opts.timeoutMs + API_TIMEOUT_HARD_CAP_EXTRA_MS safety net finally fired.
    //
    // If the exit followed a /stop (the CLI's SIGINT handler fell through to
    // default termination instead of flushing a result line), that's a
    // successful stop, not a crash — resolve like the graceful path instead
    // of surfacing "process exited unexpectedly" for a stop the user asked for.
    const onExit = () => {
      const interrupted = session.consumeInterruptFlag();
      if (interrupted) {
        done(buffer.join(''), true);
        return;
      }
      // Whatever streamed before the crash is real work the client may already
      // have rendered; persist it alongside the notice rather than replacing it,
      // exactly as the hard cap below does. A crash is the case partialText was
      // added for — the client saw the deltas and no `result` will ever land.
      fail(Object.assign(new Error('Session process exited unexpectedly before responding.'), { code: 'PROCESS_EXITED' }), buffer.join(''));
    };

    const cleanup = () => {
      clearTimeout(globalTimer);
      if (hardCapTimer) clearTimeout(hardCapTimer);
      session.off('output', onOutput);
      session.off('exit', onExit);
      this.pendingApiSessions.delete(sessionId);
    };

    // Called when the SSE client disconnects. Detaches that connection's sink —
    // the producer below keeps recording, so a re-attach can still deliver
    // everything that arrived while nobody was listening (#421). Passing the
    // sink means a stale close from a superseded connection cannot silence the
    // one that replaced it.
    const onClientDisconnect = () => { turn.detach(initialSink); };

    const onOutput = (line: string) => {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;

        // Partial assistant message (from --include-partial-messages)
        // Contains cumulative text; compute delta and emit as text_delta
        if (obj['type'] === 'assistant') {
          const msg = obj['message'] as { content?: Array<{ type: string; text?: string; name?: string; id?: string; input?: unknown }> } | undefined;
          if (Array.isArray(msg?.content)) {
            let fullText = '';
            for (const block of msg!.content) {
              if (block.type === 'text' && block.text) fullText += block.text;
              // PTY mode (headless=false) emits tool_use blocks inside assistant messages
              if (block.type === 'tool_use' && block.name && block.id) {
                turn.emit({ type: 'tool_use', name: block.name, id: block.id, input: block.input as Record<string, unknown> | undefined });
              }
            }
            if (fullText.length > lastPartialText.length) {
              const delta = fullText.slice(lastPartialText.length);
              buffer.push(delta);
              turn.emit({ type: 'text_delta', text: delta });
            }
            lastPartialText = fullText;
          }
        }

        // Standalone text delta (legacy format)
        if (obj['type'] === 'text') {
          const text = (obj['text'] as string) ?? '';
          if (text) {
            buffer.push(text);
            turn.emit({ type: 'text_delta', text });
          }
        }

        // stream_event from --output-format stream-json (tool_use + text_delta)
        this._applyStreamEvent(obj, toolBlocks, (event) => turn.emit(event), (text) => {
          buffer.push(text);
          // Update lastPartialText so the final 'assistant' message won't re-send the full text
          lastPartialText += text;
          turn.emit({ type: 'text_delta', text });
        });

        // Text from delta field (other formats)
        if (obj['type'] !== 'assistant' && obj['type'] !== 'text' && obj['type'] !== 'result' && obj['type'] !== 'stream_event') {
          const deltaText = (obj['delta'] as Record<string, unknown> | undefined)?.['text'] as string | undefined;
          if (deltaText) {
            buffer.push(deltaText);
            turn.emit({ type: 'text_delta', text: deltaText });
          }
        }

        // Thinking
        if (obj['type'] === 'thinking') {
          turn.emit({ type: 'thinking', text: (obj['text'] as string) ?? '' });
        }

        // Result = end of turn
        if (obj['type'] === 'result') {
          session.setProcessing(false);
          lastPartialText = ''; // reset for next turn
          // Use || so empty-string result falls back to buffer (OpenRouter emits result:"").
          const resultText = (obj['result'] as string | undefined) || buffer.join('');
          // Consumed here (rather than left for onExit) so the graceful path — a
          // result line flushed before the subprocess exits — still gets credit
          // for the interrupt; onExit's own consumeInterruptFlag() call would
          // otherwise see it already cleared and take the (harmless, settled-
          // guarded) fail() branch instead.
          done(resultText, session.consumeInterruptFlag());
        }
      } catch {
        /* non-JSON stdout line */
      }
    };

    // Soft timeout (#75, reworked in #421): tell the client the budget elapsed,
    // but say so with a NON-terminal `timeout` event rather than an `error`. The
    // turn is not cancelled — the output listener stays attached so a turn that
    // finishes a few seconds late still lands in history with its attachments
    // (observed: 304s image turn vs 300s budget → image generated, reply lost,
    // spinner stuck) — and the buffer keeps recording, so whether the client
    // stays on this connection or reconnects to …/stream, it still gets the
    // reply. Reporting a still-running turn as `error` was the bug: history
    // gained a message no live client could ever see. The hard cap below bounds
    // a genuinely hung turn and IS a real error.
    let hardCapTimer: ReturnType<typeof setTimeout> | undefined;
    const globalTimer = setTimeout(() => {
      turn.emit({ type: 'timeout', message: 'Agent response timeout', resumable: true });
      // The session stays in-flight (pendingApiSessions) until the hard cap so a
      // retry on the SAME session_id gets a 409 CONFLICT rather than interleaving
      // with the subprocess that is still processing this turn. This lock is
      // intentionally held for the whole soft→hard window (see API.md §409) —
      // resuming the turn goes through …/stream, which is never a conflict.
      hardCapTimer = setTimeout(() => {
        // Genuinely end the turn rather than just unsubscribing from it. The old
        // cleanup() only did `session.off('output')`, so past the cap the
        // subprocess kept running and kept burning tokens while its eventual
        // `result` line was parsed by nobody — the worst of both worlds, and the
        // reason the `⚠️` row this writes could contradict a turn that was still
        // alive. After the interrupt the row is simply true.
        //
        // ORDER MATTERS: interrupt() gates on `_processing` and no-ops once it
        // is false, so it must come BEFORE setProcessing(false).
        session.interrupt();
        session.setProcessing(false);
        // Whatever the turn did stream before the cap is real work the client
        // may already have rendered; persist it alongside the notice instead of
        // replacing it, exactly as the /stop path does.
        fail(Object.assign(new Error('Agent response timed out.'), { code: 'TIMEOUT' }), buffer.join(''));
      }, API_TIMEOUT_HARD_CAP_EXTRA_MS);
    }, opts.timeoutMs);

    session.on('output', onOutput);
    session.on('exit', onExit);

    // Image paths only work when allowTools:true — Claude needs the Read tool to access them
    const allowToolsStream = opts.allowTools ?? false;
    if (!allowToolsStream && imagePathsStream.length) {
      this.logger.warn('Images ignored: allowTools is false, Claude cannot use Read tool', { sessionId, imageCount: imagePathsStream.length });
    }
    const effectiveImagePathsStream = allowToolsStream ? imagePathsStream : [];
    const systemNote = buildApiSystemNote(allowToolsStream, effectiveImagePathsStream.length ? effectiveImagePathsStream : undefined);

    // Detect skill commands (same as channel message path)
    const skillInvocationStream = detectSkillCommand(message, this.skillRegistry);
    if (skillInvocationStream) {
      this.logger.info('Skill invoked via API stream', {
        skill: skillInvocationStream.skillKey,
        args: skillInvocationStream.args,
        sessionId,
      });
    }

    // Build channel XML with image_path attribute (like Telegram) for first image
    const imageAttrStream = effectiveImagePathsStream.length ? ` image_path="${AgentRunner.escapeXmlAttr(effectiveImagePathsStream[0]!)}"` : '';
    const imageParamsNoteStream = imageParamsStream ? AgentRunner.buildImageParamsNote(imageParamsStream) : '';
    // Persist composer image config to session meta (SessionMeta.imageConfig) so the
    // web restores the selection on reload. This is the streaming path the web uses.
    // image_refs are per-turn and deliberately excluded (#73).
    // Channel 'api' — api sessions live under api-<chatId>. Best-effort.
    const durableImageConfigStream = imageParamsStream
      ? AgentRunner.durableImageConfig(imageParamsStream)
      : undefined;
    if (durableImageConfigStream) {
      this.sessionStore
        .updateSessionMeta(this.agentConfig.id, chatId, sessionId, { imageConfig: durableImageConfigStream }, 'api')
        .catch(() => {});
    }
    const channelXml =
      `<channel source="api" chat_id="${chatId}" session_id="${sessionId}" ts="${new Date().toISOString()}"${imageAttrStream}>\n` +
      `${message}\n\n` +
      systemNote +
      imageParamsNoteStream +
      `</channel>` +
      (skillInvocationStream ? `\n${formatSkillContext(skillInvocationStream)}` : '');

    session.setProcessing(true);
    session.sendMessage(channelXml);

    return onClientDisconnect;
  }

  /**
   * Check if a session has a pending API request (for preflight conflict check).
   */
  hasActiveApiSession(sessionId: string): boolean {
    return this.pendingApiSessions.has(sessionId);
  }

  /**
   * Attach a sink to a session's current turn stream (#421) — the server half of
   * "resume a turn on a new connection".
   *
   * Replays every buffered event after `afterSeq` and then, if the turn is still
   * running, installs `sink` as the live one. Both happen in one synchronous
   * block inside TurnStream.attach, so nothing can slip through the seam.
   *
   * Returns a `detach` handler on success, or a reason the attach could not be
   * honoured:
   *  - `gone`      — no record: the turn never existed, or its replay grace
   *                  window has expired. The client should read history instead.
   *  - `mismatch`  — a record exists but for a different request_id, i.e. the
   *                  turn the client asked for is already over.
   *  - `truncated` — a non-zero cursor sits inside a region the bounded buffer
   *                  has already evicted, so a gapless replay is impossible. A
   *                  cursor-less attach is never truncated: it has no seam to
   *                  keep, and takes whatever tail is still buffered.
   *
   * Looks only under the `api` namespace: this is the API resume endpoint, and a
   * channel turn on the same session id is a different turn (see turnStreamKey).
   */
  attachTurnStream(
    sessionId: string,
    sink: TurnSink,
    opts: { afterSeq?: number; requestId?: string } = {},
  ): { ok: true; requestId: string; detach: () => void } | { ok: false; reason: 'gone' | 'mismatch' | 'truncated' | 'ahead' } {
    const turn = this.turnStreams.get(turnStreamKey('api', sessionId));
    if (!turn) return { ok: false, reason: 'gone' };
    if (opts.requestId && opts.requestId !== turn.requestId) return { ok: false, reason: 'mismatch' };
    const failure = turn.attach(sink, opts.afterSeq ?? 0);
    if (failure) return { ok: false, reason: failure };
    return { ok: true, requestId: turn.requestId, detach: () => turn.detach(sink) };
  }

  /**
   * Identity and wall-clock start of the session's current API turn, or undefined
   * when there is no resumable record.
   *
   * The resume endpoint needs both *before* it attaches, because attach() replays
   * synchronously into a sink built from them: `startedAt` so a replayed terminal
   * frame reports `duration_ms` for the turn rather than for the reconnect, and
   * `requestId` so a client that reconnected without one still learns the token it
   * needs to resume again from a cursor.
   */
  turnStreamInfo(sessionId: string): { requestId: string; startedAt: number } | undefined {
    const turn = this.turnStreams.get(turnStreamKey('api', sessionId));
    return turn ? { requestId: turn.requestId, startedAt: turn.startedAt } : undefined;
  }

  /**
   * Register file paths as attachments for the current API session turn.
   * Called by the api_reply MCP tool via the attachments endpoint.
   * Files must be absolute paths within the agent's media directory.
   */
  addApiAttachments(sessionId: string, filePaths: string[]): void {
    const existing = this.pendingApiAttachments.get(sessionId) ?? [];
    this.pendingApiAttachments.set(sessionId, [...existing, ...filePaths]);
  }

  /**
   * Pop and return buffered attachment paths for a session, then clear the buffer.
   * Converts absolute paths to relative media URLs for the API response.
   */
  /**
   * Close a turn that died without a result (#75): drain any attachments the
   * turn already registered (the files exist on disk — deliver them rather
   * than leak them into the NEXT turn's reply) and record a terminal
   * assistant row so history never ends on a dangling user message.
   * System-initiated turns (skipUserMessage) have nothing dangling to close —
   * only the buffer is drained.
   *
   * `partialText` is whatever the turn already streamed before it died. It is
   * prepended rather than discarded, so the single row this writes carries both
   * the work the client saw and the notice — never a failure row that erases a
   * half-finished reply, and never a failure row *plus* a separate reply row
   * (the callers' `settled` guard makes done() and fail() mutually exclusive).
   */
  private persistFailedApiTurn(chatId: string, sessionId: string, err: Error, skipUserMessage?: boolean, partialText?: string): void {
    const attachments = this.popApiAttachments(sessionId);
    if (skipUserMessage) return;
    const failTs = Date.now();
    const content = [partialText?.trim(), `\u26a0\ufe0f ${err.message}`].filter(Boolean).join('\n\n');
    this.sessionStore
      .appendMessage(this.agentConfig.id, sessionId, { role: 'assistant', content, ts: failTs })
      .catch(() => {});
    this.historyDb.insertMessage({
      chatId: `api-${chatId}`,
      sessionId,
      source: 'api',
      role: 'assistant',
      content,
      mediaFiles: attachments.length ? attachments.map((a) => `media/${a.relPath}`) : undefined,
      ts: failTs,
    });
  }

  popApiAttachments(sessionId: string): ApiAttachment[] {
    const paths = this.pendingApiAttachments.get(sessionId) ?? [];
    this.pendingApiAttachments.delete(sessionId);
    const mediaRoot = path.join(this.agentsBaseDir, this.agentConfig.id, 'media') + path.sep;
    return paths
      .map((absPath): ApiAttachment | null => {
        if (!absPath.startsWith(mediaRoot)) return null;
        if (!fs.existsSync(absPath)) return null;
        const rel = absPath.slice(mediaRoot.length).replace(/\\/g, '/');
        return { type: 'image', url: `/v1/agents/${encodeURIComponent(this.agentConfig.id)}/media/${rel}`, relPath: rel };
      })
      .filter((a): a is ApiAttachment => a !== null);
  }

  private evictApiSessionMapping(sessionId: string): void {
    // Evict the in-memory chat-id mapping only — safe no-op for non-api sessions.
    //
    // IMPORTANT: do NOT delete the session's media dir here. Stopping a session
    // (idle eviction or the idle cleaner) is a lifecycle event decoupled from
    // history. The screenshots under media/api-<sessionId>/ are referenced by
    // rows in history.db that outlive the running process, so removing them
    // here leaves dangling references → GET /media returns 404 → the client
    // renders "Unavailable". Media is correctly reclaimed elsewhere, tied to
    // history lifetime: MediaStore.clearChatMedia (/clear) and the daily
    // retention sweep (deleteMediaFiles for messages pruned by pruneOlderThan).
    this.apiChatIds.delete(sessionId);
  }

  getAgentsBaseDir(): string {
    return this.agentsBaseDir;
  }

  getAgentDir(): string {
    return this.agentDir;
  }

  getHistoryDb(): HistoryDB {
    return this.historyDb;
  }

  getAllSessionMeta(): Promise<Map<string, { name: string; imageConfig?: ImageParams; model?: string }>> {
    return this.sessionStore.getAllSessionMeta(this.agentConfig.id);
  }

  async listSessionsForChat(chatId: string, channel: ChatChannel): Promise<import('../types').SessionIndex> {
    return this.sessionStore.listSessions(this.agentConfig.id, chatId, channel);
  }

  async executeApiCommand(
    sessionId: string,
    chatId: string,
    command: string,
    opts?: { skipPersist?: boolean; model?: string },
  ): Promise<{ result: Record<string, unknown>; responseText: string }> {
    const agentId = this.agentConfig.id;
    const storeChatId = chatId;           // sessionStore adds channel prefix internally
    const dbChatId = `api-${chatId}`;    // historyDb uses full channel-chatId key
    const skipPersist = opts?.skipPersist ?? false;

    // Dispatch on the first token so commands with arguments (e.g. "/model sonnet",
    // "/stop now") resolve to their base command instead of falling through to the
    // unknown-command branch. The router gate is prefix-based, so these already pass.
    const cmd = command.trim().split(/\s+/)[0] ?? '';

    // Validate BEFORE persisting anything. Reuse the same api-channel gate as the router
    // so an unknown command throws with nothing written — no orphan user row is left, and
    // the router surfaces the error/500 exactly as before. After token dispatch + the
    // /sessions branch below, this is only reachable on a direct caller passing garbage.
    if (!AgentRunner.isApiBuiltinCommand(cmd)) {
      throw new Error(`Unknown command: ${cmd}`);
    }

    // Register session in the api-{chatId} index on first use (same as sendApiMessageStream)
    await this.sessionStore.ensureApiSession(agentId, storeChatId, sessionId).catch((err: unknown) => {
      this.logger.warn('Failed to register API session in index for command', { agentId, chatId, sessionId, error: (err as Error).message });
    });

    // Persist a command message to the permanent history DB ONLY — not the model's session
    // context (sessionStore). historyDb is what the web history endpoint reads, so this is
    // all the display + spinner fix needs. Keeping commands out of the JSONL context means
    // /model replies aren't replayed into the model, /compact counts stay accurate, /clear
    // leaves no dangling turn, and the api channel matches telegram (which persists commands
    // nowhere).
    //
    // skipPersist (wire param store_user_message=false) suppresses BOTH the user command and
    // the assistant reply: programmatic REST callers leave no trace in chat history at all.
    // `force` overrides that for notes that must stay visible regardless (see /stop below).
    const persist = (role: 'user' | 'assistant', content: string, force = false) => {
      if ((skipPersist && !force) || !content) return;
      this.historyDb.insertMessage({ chatId: dbChatId, sessionId, source: 'api', role, content, ts: Date.now() });
    };

    // Persist the full user command before executing so it appears in history.
    // Skip for /clear — clearSession() below wipes the table anyway; only the response survives.
    if (cmd !== '/clear') {
      persist('user', command);
    }

    let result: Record<string, unknown>;
    let responseText: string;
    let forcePersist = false;
    try {
      if (cmd === '/model') {
        const model = this.agentConfig.claude.model;
        const hasArg = command.trim().includes(' ');
        result = { model };
        responseText = hasArg
          ? `Current model: ${model}\n(To switch models use the model picker or the /api/v1/agents/:id/model endpoint — argument ignored.)`
          : `Current model: ${model}`;
      } else if (cmd === '/stop') {
        const session = this.sessions.get(sessionId);
        const stopped = session ? session.interrupt() : false;
        result = { stopped };
        responseText = stopped
          ? 'Session was interrupted before I could respond.'
          : 'No active session to stop.';
        // A turn was actually cut off — always leave a visible note in history so the
        // web Stop button (skipPersist:true, to suppress the "/stop" command echo) and
        // a typed /stop command show the same outcome instead of the button leaving a
        // silently-dangling user turn.
        forcePersist = stopped;
      } else if (cmd === '/restart') {
        this.restartProcess(sessionId).catch(() => {});
        result = { restarting: true };
        responseText = 'Session is restarting.';
      } else if (cmd === '/session') {
        const index = await this.sessionStore.listSessions(agentId, storeChatId, 'api').catch(() => null);
        const meta = index?.sessions.find((s) => s.id === sessionId);
        const effectiveModel = this.agentConfig.claude.model;
        // The api append path doesn't maintain the index messageCount, so count the flat store
        // (the real conversation) directly rather than trusting meta.messageCount.
        const messageCount = (await this.sessionStore.loadSession(agentId, sessionId).catch(() => [])).length;
        if (!meta) {
          result = { sessionId, sessionName: null, messageCount, archivedCount: 0, contextUsedPct: 0, model: effectiveModel };
          responseText = `Session: (unnamed)\nMessages: ${messageCount}\nContext used: 0%\nModel: ${effectiveModel}`;
        } else {
          const contextWindow = await this.contextWindowFor(effectiveModel);
          const contextUsedPct = Math.round(((meta.lastInputTokens ?? 0) / contextWindow) * 100);
          result = { sessionId, sessionName: meta.name, messageCount, archivedCount: meta.archivedCount ?? 0, contextUsedPct, model: effectiveModel };
          responseText = [
            `Session: ${meta.name ?? '(unnamed)'}`,
            `Messages: ${messageCount}${(meta.archivedCount ?? 0) > 0 ? ` (${meta.archivedCount} archived)` : ''}`,
            `Context used: ${contextUsedPct}%`,
            `Model: ${effectiveModel}`,
          ].join('\n');
        }
      } else if (cmd === '/sessions') {
        // Advertised for the api channel (BUILTIN_COMMANDS), so handle it here — mirrors the
        // telegram /sessions list. Marks the session this command runs in as (current).
        const index = await this.sessionStore.listSessions(agentId, storeChatId, 'api').catch(() => null);
        const list = index?.sessions ?? [];
        // Count each session's flat store directly — the api append path doesn't keep the
        // index messageCount in sync.
        const withCounts = await Promise.all(
          list.map(async (s) => ({
            id: s.id,
            name: s.name,
            messageCount: (await this.sessionStore.loadSession(agentId, s.id).catch(() => [])).length,
            current: s.id === sessionId,
          })),
        );
        result = { sessions: withCounts, count: withCounts.length };
        if (!withCounts.length) {
          responseText = 'No sessions.';
        } else {
          const lines = withCounts.map((s) => {
            const n = s.messageCount;
            const marker = s.current ? ' (current)' : '';
            return `• ${s.name ?? '(unnamed)'} — ${n} message${n === 1 ? '' : 's'}${marker}`;
          });
          responseText = `Sessions (${withCounts.length}):\n${lines.join('\n')}`;
        }
      } else if (cmd === '/clear') {
        const ch = 'api' as const;
        await this.sessionStore.clearTelegramSessionHistory(agentId, storeChatId, sessionId, ch);
        await this.sessionStore.updateSessionMeta(agentId, storeChatId, sessionId, {
          totalTokensUsed: 0,
          lastInputTokens: 0,
          archivedCount: 0,
          loadedAtSpawn: undefined,
          messageCountAtSpawn: undefined,
        }, ch);
        const mediaPaths = this.historyDb.clearSession(dbChatId, sessionId);
        MediaStore.deleteMediaFiles(this.agentsBaseDir, agentId, mediaPaths);
        this.restartProcess(sessionId).catch(() => {});
        result = { success: true };
        responseText = 'Session cleared.';
      } else if (cmd === '/compact') {
        const ch = 'api' as const;
        const activeSession = this.sessions.get(sessionId);
        const compactEffectiveModel = opts?.model ?? activeSession?.modelOverride ?? this.agentConfig.claude.model;
        const contextWindow = await this.contextWindowFor(compactEffectiveModel);
        const compactor = new SessionCompactor(this.sessionStore);
        const compactResult = await compactor.compact(agentId, storeChatId, sessionId, compactEffectiveModel, contextWindow, ch);
        await this.sessionStore.updateSessionMeta(agentId, storeChatId, sessionId, {
          loadedAtSpawn: undefined,
          archivedCount: undefined,
          messageCountAtSpawn: undefined,
        }, ch);
        await this.restartProcess(sessionId);
        result = { success: true, keptMessages: compactResult.afterMessages, archivedMessages: compactResult.beforeMessages - compactResult.afterMessages };
        responseText = `Session compacted. Kept ${compactResult.afterMessages} messages, archived ${compactResult.beforeMessages - compactResult.afterMessages}.`;
      } else {
        // Passed the gate but has no dispatch branch — BUILTIN_COMMANDS drifted from this
        // table. Throw so the failure surfaces (and ends history with an assistant turn via
        // the catch below) rather than returning an empty response.
        throw new Error(`Unhandled command: ${cmd}`);
      }
    } catch (err: unknown) {
      // Ensure history always ends with an assistant turn, even when execution fails midway
      // (e.g. /compact throws after the user row is persisted). Otherwise the trailing user
      // row re-triggers the web's stuck-spinner condition on reload. Rethrow so the router
      // still emits its SSE error event / REST 500.
      const errMsg = err instanceof Error ? err.message : String(err);
      persist('assistant', `Command failed: ${errMsg}`);
      throw err;
    }

    // Persist the human-readable response as an assistant turn so the conversation ends with
    // an assistant message (the web's computeIsPendingResponse needs last.role !== 'user').
    // forcePersist writes it even under skipPersist (set only when /stop cut a turn off).
    persist('assistant', responseText, forcePersist);

    return { result, responseText };
  }

  /**
   * Whether an inbound channel message came from a 1:1 chat with the bot.
   *
   * Gates the one channel command that reaches past its own chat: `/model <x>`
   * rewrites `config.json` for the whole agent and restarts every session in
   * every chat. The channel access gates do not cover that. Discord's, in a
   * guild, checks the guild, the channel, and a mention — never the user
   * (`allowFrom` in mcp/tools/discord/access.ts is DM-only), so without this
   * any member of an allowlisted channel could switch the model out from under
   * everyone else and kill their in-flight turns. LINE forwards group and room
   * messages the same way. Telegram's receiver answers `/model` itself behind
   * a private-chat + allowlist check and does not forward it here.
   *
   * Fails closed: a channel that does not report a chat type cannot switch.
   * Listing models (`/models`, bare `/model`) is unaffected — it reads nothing
   * and changes nothing.
   */
  private isDirectChat(meta: Record<string, string>): boolean {
    const kind = meta['chat_type'] ?? meta['line_chat_type'] ?? meta['slack_chat_type'];
    return kind === 'direct' || kind === 'user';
  }

  /**
   * Restart every non-api session so a model change actually takes effect.
   *
   * `setModel` only rewrites config — a session process was spawned with the
   * old model on its command line and keeps using it until it is restarted.
   * Reporting "model set" without this is a false success: the next turn still
   * runs on the previous model. Returns whether anything was restarted.
   */
  private async restartChannelSessions(): Promise<boolean> {
    const restartPromises: Promise<void>[] = [];
    for (const [key, session] of this.sessions) {
      if (session.source !== 'api') restartPromises.push(this.restartProcess(key));
    }
    await Promise.all(restartPromises);
    return restartPromises.length > 0;
  }

  /**
   * The model list this gateway offers: the live catalog when one is reachable,
   * the configured/static list otherwise (issue #409). Cached upstream, so the
   * six callers that only want one model's context window pay for at most one
   * fetch a minute between them.
   */
  private async availableModels(): Promise<ModelConfig[]> {
    const staticModels = this.gatewayConfig.gateway.models ?? DEFAULT_MODELS;
    return (await fetchModelCatalog(staticModels)) ?? staticModels;
  }

  /**
   * Context window for a model id. Resolving this through the live catalog is
   * what keeps `/session`'s "context used" percentage and `/compact`'s window
   * honest for a model that exists only upstream — before, any such model fell
   * through to the 200k default no matter how large its real window.
   */
  private async contextWindowFor(modelId: string): Promise<number> {
    const models = await this.availableModels();
    // Configured list second, not just as the catalog's fallback: the catalog
    // *replaces* the list rather than merging with it, so a configured model
    // the upstream catalog does not list (the local `[1m]` ids are exactly
    // that shape) would otherwise drop to the 200k default — reporting
    // /session context use against a fifth of the real window and handing
    // SessionCompactor a window small enough to compact far too early.
    return models.find((m) => m.id === modelId)?.contextWindow
      ?? (this.gatewayConfig.gateway.models ?? DEFAULT_MODELS).find((m) => m.id === modelId)?.contextWindow
      ?? DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * Models `/model <arg>` may switch to: what the catalog offers, plus the
   * configured list.
   *
   * The union is only for *resolution*, never for the `/models` listing — the
   * listing has to reflect what upstream actually offers, or a model removed
   * upstream would linger in the picker forever, which is the bug this all
   * started from. Without the union a user who switches to a live-only model
   * is trapped: their previous configured model is no longer nameable.
   */
  private async selectableModels(): Promise<ModelConfig[]> {
    const live = await this.availableModels();
    const configured = this.gatewayConfig.gateway.models ?? DEFAULT_MODELS;
    const ids = new Set(live.map((m) => m.id));
    return [...live, ...configured.filter((m) => !ids.has(m.id))];
  }

  async setModel(newModel: string): Promise<void> {
    // Allow any model string through — BYOK/third-party models (openrouter/* etc.)
    // are validated by the upstream provider, not the local config list.
    this.agentConfig.claude.model = newModel;
    try { await this.persistModelToConfig(newModel); } catch (err) {
      this.logger.error('Failed to persist model to config', { error: (err as Error).message });
    }
  }

  async listApiSessions(chatId: string): Promise<import('../types').SessionIndex> {
    return this.sessionStore.listSessions(this.agentConfig.id, chatId, 'api');
  }

  /**
   * Does `sessionId` already exist under `chatId`? The API layer calls this before
   * honouring a client-supplied `session_id`, so an unknown id is rejected instead
   * of silently becoming a brand-new session. Read-only — it never registers.
   */
  async apiSessionExists(chatId: string, sessionId: string): Promise<boolean> {
    return this.sessionStore.apiSessionExists(this.agentConfig.id, chatId, sessionId);
  }

  async createApiSession(chatId: string, prompt?: string, name?: string): Promise<import('../types').SessionMeta> {
    const sessionName = name ?? (prompt
      ? (prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt)
      : undefined);

    const meta = await this.sessionStore.createTelegramSession(this.agentConfig.id, chatId, sessionName, 'api');

    if (!name && prompt) {
      this.generateSessionNameInBackground(chatId, meta.id, prompt);
    }

    return meta;
  }

  private generateSessionNameInBackground(chatId: string, sessionId: string, prompt: string): void {
    (async () => {
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        const titlePrompt = `Summarise in 3-5 words as a session title (no punctuation, no quotes): ${prompt}`;
        const { stdout } = await execFileAsync(
          'claude',
          ['-p', titlePrompt, '--output-format', 'text', '--model', 'claude-haiku-4-5-20251001'],
          { timeout: 15000, encoding: 'utf-8' },
        );
        const aiName = stdout.trim().slice(0, 60) || undefined;
        if (aiName) {
          await this.sessionStore.updateSessionMeta(this.agentConfig.id, chatId, sessionId, { name: aiName }, 'api');
        }
      } catch (err) {
        this.logger.warn('Background session name generation failed', { sessionId, error: (err as Error).message });
      }
    })();
  }

  async getApiSessionInfo(chatId: string, sessionId: string): Promise<Record<string, unknown> | null> {
    const index = await this.sessionStore.listSessions(this.agentConfig.id, chatId, 'api').catch(() => null);
    const meta = index?.sessions.find((s) => s.id === sessionId);
    if (!meta) return null;
    const effectiveModel = this.agentConfig.claude.model;
    const contextWindow = await this.contextWindowFor(effectiveModel);
    const contextUsedPct = Math.round(((meta.lastInputTokens ?? 0) / contextWindow) * 100);
    return {
      sessionId: meta.id,
      sessionName: meta.name,
      messageCount: meta.messageCount,
      archivedCount: meta.archivedCount ?? 0,
      contextUsedPct,
      model: effectiveModel,
    };
  }

  async updateApiSession(chatId: string, sessionId: string, updates: { sessionName?: string }): Promise<{ sessionId: string; sessionName?: string }> {
    if (updates.sessionName) {
      // Ensure session exists in the file index (may be missing for older sessions stored only in SQLite)
      await this.sessionStore.ensureApiSession(this.agentConfig.id, chatId, sessionId).catch((err: unknown) => {
        this.logger.warn('Failed to register API session in index', { agentId: this.agentConfig.id, chatId, sessionId, error: (err as Error).message });
      });
      await this.sessionStore.updateSessionMeta(this.agentConfig.id, chatId, sessionId, { name: updates.sessionName }, 'api');
    }
    return { sessionId, ...(updates.sessionName ? { sessionName: updates.sessionName } : {}) };
  }

  async deleteApiSession(chatId: string, sessionId: string): Promise<void> {
    await this.sessionStore.deleteTelegramSession(this.agentConfig.id, chatId, sessionId, 'api').catch((err: unknown) => {
      // Legacy sessions (stored only in SQLite, no file index entry) are treated as already deleted
      if (err instanceof SessionNotInIndexError) return;
      throw err;
    });
    // Purge from SQLite so the session no longer appears in listSessions()
    const mediaPaths = this.historyDb.clearSession(`api-${chatId}`, sessionId);
    MediaStore.deleteMediaFiles(this.agentsBaseDir, this.agentConfig.id, mediaPaths);
  }

  /**
   * Send a message into an existing channel session (cross-channel continuation from UI).
   * The session process receives full history context from the session JSON (Layer 1).
   * The reply is streamed back via SSE callbacks; persistence is *not* this
   * method's job. A channel session already has two session-bound writers — the
   * long-lived output handler installed in spawnSession, and SessionProcess's own
   * parser — and writing here as well produced a second row per turn. See done().
   */
  async sendMessageToSession(
    rawChatId: string,
    channel: ChatChannel,
    sessionId: string,
    message: string,
    senderName: string | undefined,
    callbacks: ApiStreamCallbacks,
    opts: { timeoutMs: number; requestId?: string },
  ): Promise<() => void> {
    // Ensure the session process uses the correct channel source
    this.channelSourceMap.set(rawChatId, channel);

    // Channel sessions use agent-level model (not per-session)
    const session = await this.getOrSpawnSession(rawChatId, channel, sessionId);

    // Persist user message (Layer 1 session JSON + Layer 2 history DB)
    const uiUserTs = Date.now();
    await this.sessionStore.appendTelegramMessage(this.agentConfig.id, rawChatId, sessionId, {
      role: 'user',
      content: message,
      ts: uiUserTs,
    }, channel).catch(() => {});

    this.historyDb.insertMessage({
      chatId: `${channel}-${rawChatId}`,
      sessionId,
      source: 'ui',
      role: 'user',
      content: message,
      senderName,
      ts: uiUserTs,
    });

    const buffer: string[] = [];
    let settled = false;
    let lastPartialText = '';
    // Same event plumbing as the API path (#421) — one mechanism, not a
    // per-producer copy. The key is namespaced per producer (turnStreamKey), so
    // a channel turn and an API turn on one session id cannot displace each
    // other's record. Re-attaching is *not* part of the deal here: the resume
    // endpoint looks under `api` only, so this record exists to drive the live
    // sink and is released the moment the turn ends (see done()/fail()).
    const turn = this.turnStreams.start(turnStreamKey(channel, sessionId), opts.requestId ?? randomUUID());
    const initialSink = callbackSink(callbacks);
    turn.attach(initialSink, 0);
    const toolBlocks = new Map<number, { id: string; name: string; chunks: string[] }>();

    const done = (result: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Deliberately does NOT persist the reply. This turn targets a *channel*
      // session, and channel sessions already have two writers that are bound to
      // the session rather than to this turn:
      //   • history DB  — the long-lived proc.on('output') handler installed in
      //     spawnSession, which writes either the reply-tool text or the result
      //     text (and deliberately suppresses socket errors, request_too_large
      //     and corrupted-thinking output).
      //   • session JSON — SessionProcess's own parser, which appends for every
      //     `source !== 'api'` session.
      // Writing here as well produced two rows per cross-channel turn, and after
      // a reply-tool turn the second row held the model's trailing `result`
      // narration — text the user never received on the channel. The API path
      // (sendApiMessage*) still persists its own reply: there neither writer
      // exists, because `source === 'api'` disables SessionProcess's append and
      // API sessions get no channel output handler.
      //
      // No-op once the soft timeout has answered: TurnStream.complete() keeps
      // its first terminal frame.
      //
      // Released rather than kept for the replay grace window: this turn is filed
      // under the channel namespace and attachTurnStream() only looks under `api`,
      // so nothing can re-attach to it. See API.md — the live view is documented
      // as non-resumable, and holding its buffer for two minutes would cost
      // memory no client can spend.
      this.turnStreams.completeAndRelease(turn, resultEvent(result.trim(), []));
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      this.turnStreams.completeAndRelease(turn, errorEvent(err), err);
    };

    let globalTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (globalTimer) clearTimeout(globalTimer);
      session.off('output', onOutput);
    };

    const onClientDisconnect = () => { turn.detach(initialSink); };

    const onOutput = (line: string) => {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj['type'] === 'assistant') {
          const msg = obj['message'] as { content?: Array<{ type: string; text?: string; name?: string; id?: string; input?: unknown }> } | undefined;
          if (Array.isArray(msg?.content)) {
            let fullText = '';
            for (const block of msg!.content) {
              if (block.type === 'text' && block.text) fullText += block.text;
              // PTY mode (headless=false) emits tool_use blocks inside assistant messages
              if (block.type === 'tool_use' && block.name && block.id) {
                turn.emit({ type: 'tool_use', name: block.name, id: block.id, input: block.input as Record<string, unknown> | undefined });
              }
            }
            if (fullText.length > lastPartialText.length) {
              const delta = fullText.slice(lastPartialText.length);
              buffer.push(delta);
              turn.emit({ type: 'text_delta', text: delta });
            }
            lastPartialText = fullText;
          }
        }
        if (obj['type'] === 'text') {
          const text = (obj['text'] as string) ?? '';
          if (text) { buffer.push(text); turn.emit({ type: 'text_delta', text }); }
        }
        // stream_event from --output-format stream-json (tool_use + text_delta)
        this._applyStreamEvent(obj, toolBlocks, (event) => turn.emit(event), (text) => {
          buffer.push(text);
          // Update lastPartialText so the final 'assistant' message won't re-send the full text
          lastPartialText += text;
          turn.emit({ type: 'text_delta', text });
        });
        if (obj['type'] === 'result') {
          session.setProcessing(false);
          // Use || so empty-string result falls back to buffer (OpenRouter emits result:"").
          const resultText = (obj['result'] as string | undefined) || buffer.join('');
          done(resultText);
        }
      } catch { /* non-JSON */ }
    };

    globalTimer = setTimeout(() => {
      session.setProcessing(false);
      // TIMEOUT_SOFT, not TIMEOUT: this path has no hard cap and no resume
      // endpoint, so the turn keeps running with nobody listening on the wire
      // and its result lands in history alone. The API hard cap interrupts the
      // turn and means the opposite — see the code vocabulary on StreamEvent's
      // `error`.
      //
      // Detaching this turn's listener here costs nothing: this producer no
      // longer persists anything (see done()). The session's own long-lived
      // output handler and SessionProcess own both storage layers and are not
      // bound to this turn, so the late answer still lands in history.
      fail(Object.assign(new Error('Agent response timeout'), { code: 'TIMEOUT_SOFT' }));
    }, opts.timeoutMs);

    session.on('output', onOutput);

    const channelXml =
      `<channel source="ui" chat_id="${AgentRunner.escapeXmlAttr(rawChatId)}" session_id="${AgentRunner.escapeXmlAttr(sessionId)}" ` +
      `user="${AgentRunner.escapeXmlAttr(senderName ?? 'ui')}" ts="${new Date().toISOString()}">\n${message}\n</channel>`;

    session.setProcessing(true);
    session.sendMessage(channelXml);

    return onClientDisconnect;
  }

  private _applyStreamEvent(
    obj: Record<string, unknown>,
    toolBlocks: Map<number, { id: string; name: string; chunks: string[] }>,
    onChunk: (event: StreamEvent) => void,
    onTextDelta: (text: string) => void,
  ): void {
    if (obj['type'] !== 'stream_event') return;
    const event = obj['event'] as Record<string, unknown> | undefined;
    const index = event?.['index'] as number | undefined;

    if (event?.['type'] === 'content_block_start') {
      const cb = event['content_block'] as Record<string, unknown> | undefined;
      if (cb?.['type'] === 'tool_use' && index !== undefined) {
        toolBlocks.set(index, {
          id: (cb['id'] as string) ?? '',
          name: (cb['name'] as string) ?? '',
          chunks: [],
        });
      }
    }

    if (event?.['type'] === 'content_block_delta') {
      const delta = event['delta'] as Record<string, unknown> | undefined;
      if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text']) {
        onTextDelta(delta['text']);
      }
      if (delta?.['type'] === 'input_json_delta' && index !== undefined) {
        toolBlocks.get(index)?.chunks.push((delta['partial_json'] as string) ?? '');
      }
    }

    if (event?.['type'] === 'content_block_stop' && index !== undefined) {
      const block = toolBlocks.get(index);
      if (block) {
        toolBlocks.delete(index);
        try {
          const input = JSON.parse(block.chunks.join('') || '{}') as Record<string, unknown>;
          onChunk({ type: 'tool_use', name: block.name, id: block.id, input });
        } catch { /* malformed tool input JSON — skip */ }
      }
    }
  }

  /**
   * Expose the callback server port for integration tests that need to simulate
   * incoming Telegram messages by POSTing directly to the channel endpoint.
   */
  getCallbackPort(): number {
    return this.callbackPort;
  }

  /**
   * Send a message to all active sessions.
   * Used for heartbeat/cron tasks delivered out-of-band.
   *
   * If no Telegram sessions are active, a transient `__heartbeat__` API session is
   * spawned so that CronScheduler tasks can always run regardless of active user sessions.
   */
  sendMessage(message: string): void {
    if (this.sessions.size === 0) {
      // No active user sessions — spawn a shared heartbeat session so the prompt
      // reaches a subprocess and output events fire for CronScheduler/tests.
      this.getOrSpawnSession('__heartbeat__', 'api')
        .then((session) => {
          session.sendMessage(message);
          session.touch();
        })
        .catch((err) =>
          this.logger.error('sendMessage failed to spawn heartbeat session', {
            error: (err as Error).message,
          }),
        );
      return;
    }
    for (const session of this.sessions.values()) {
      session.sendMessage(message);
    }
  }
}
