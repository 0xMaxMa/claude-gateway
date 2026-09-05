import { spawn, ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chokidar from 'chokidar';
import { AgentConfig, GatewayConfig } from '../types';
import { resolveSharedConfig, sharedVaultDir } from '../agent/knowledge';
import { resolveDreamingConfig } from '../agent/dreaming/config';
import { toChatChannel, type ChatChannel, type ChatChannelOrApi } from '../history/types';
import { SessionStore } from './store';
import { createLogger } from '../logger';
import { ptyStreamRegistry } from '../shell/pty-stream-registry';
import { neutralizeTuiTriggers } from '../shell/screen';
import { resolveClaudeBin, pathWithNativeBin } from './claude-bin';
import { claudeSettingsEnv, readClaudeSettings } from '../config/claude-settings';
import {
  CODING_TOOLS,
  TOOL_LABELS,
  extractToolDetail,
  truncateDetail,
} from '../utils/tool-labels';
import { resolveEnabledConnectors } from '../connectors/resolve';
import { isReservedConnectorId } from '../connectors/custom';

export const MAX_HISTORY_MESSAGES = 50;

/**
 * Digest of one resolved connector's mcpServers entry — command, args and the
 * substituted secret alike. Hashed rather than kept verbatim so a rotated
 * access_token is comparable without holding a second copy of it in memory for
 * the life of the session; only equality is ever asked of it.
 */
function connectorFingerprint(server: unknown): string {
  return createHash('sha256').update(JSON.stringify(server) ?? 'undefined').digest('hex');
}

/**
 * Claude credential / API-routing env vars forwarded from the host into an
 * app-agent container. Deliberately narrow — auth and endpoint only. Model and
 * behaviour settings come from the agent's own config, not the host env.
 *
 * The keys that prove an identity, as opposed to merely selecting an endpoint.
 * These resolve as a group so a container is never handed two credentials from
 * two different sources — see resolveContainerAuthEnv().
 */
const CONTAINER_CREDENTIAL_KEYS: readonly string[] = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];

/**
 * The credential keys plus the endpoint selector. Derived from
 * CONTAINER_CREDENTIAL_KEYS rather than repeated, so the two lists cannot drift:
 * a credential added to one is automatically forwarded by the other.
 *
 * ANTHROPIC_BASE_URL is not a credential — it only selects an endpoint — so it
 * sits outside the group that resolves atomically in resolveContainerAuthEnv().
 */
const CONTAINER_AUTH_ENV_KEYS: readonly string[] = [
  ...CONTAINER_CREDENTIAL_KEYS,
  'ANTHROPIC_BASE_URL',
];

// The MCP reply tools that deliver an agent's user-facing message to a channel.
// Their text lives in the tool_use `input.text`, not in an assistant text block,
// so it is never captured by `assistantBuffer` — the reply is delivered to the
// user but was previously never mirrored into the resumable session store.
const CHANNEL_REPLY_TOOLS = new Set([
  'mcp__gateway__telegram_reply',
  'mcp__gateway__discord_reply',
  'mcp__gateway__line_reply',
]);

// Tool names whose tool_use dispatches genuinely background work: the call
// itself returns immediately (a task/agent id), and completion is delivered
// later as a separate, asynchronously-injected turn (a task-notification) —
// never as this tool_use's own tool_result. A session that ends its own turn
// right after dispatching one of these is legitimately idle *from the CLI's
// perspective* while real work is still in flight elsewhere. See
// BACKGROUND_AGENT_GRACE_MS and hasLikelyOutstandingBackgroundWork() below.
// Monitor fits the same contract (returns a task id immediately, delivers
// each match as a later notification) — without it here, a session whose
// only outstanding work is a Monitor task gets no retention grace: its
// Telegram typing indicator (retainBackgroundWorkingState() is Telegram-only)
// is torn down, AND restartOrDefer()/startIdleCleaner() (both channel-wide,
// not Telegram-specific) see it as plain-idle and may SIGKILL or evict it —
// while the monitor is still genuinely running (#413).
const BACKGROUND_DISPATCH_TOOLS = new Set(['Agent', 'Workflow', 'Monitor']);
// How long a session is treated as "may still have outstanding background
// work" after dispatching one of BACKGROUND_DISPATCH_TOOLS, once its own turn
// has ended. Generous enough to cover a multi-agent review of a large diff
// (the incident that motivated this — a config-driven restart SIGHUP'd a
// session mid-review, killing 3 in-flight review sub-agents with it, see
// issue referenced in restartOrDefer below); bounded so a dispatch that never
// reports back (crashed, errored) can't block a config rollout forever. This
// is the default for Agent/Workflow, and for a Monitor dispatch with no
// longer-lived declared bound — see computeBackgroundGraceMs below for the
// Monitor-specific cases (#415).
const BACKGROUND_AGENT_GRACE_MS = 15 * 60 * 1000;
// Ceiling on the grace window for a Monitor declared to run far longer than
// BACKGROUND_AGENT_GRACE_MS (a `timeout_ms` beyond it, or `persistent: true`
// — "session-length watches... runs until TaskStop or session ends"). Without
// this, such a Monitor loses SIGKILL/eviction protection well before it
// finishes (#415) — but an UNBOUNDED grace would defeat the crash-safety
// property BACKGROUND_AGENT_GRACE_MS exists for (a dispatch whose Monitor
// process died without ever reporting back must still eventually stop
// blocking a restart/eviction). 24h comfortably covers any real operational
// use of `persistent: true` within one session's lifetime while still being
// a bound, not "forever".
const BACKGROUND_MONITOR_MAX_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * How long a single BACKGROUND_DISPATCH_TOOLS dispatch should be treated as
 * "may still be outstanding" — see BACKGROUND_AGENT_GRACE_MS /
 * BACKGROUND_MONITOR_MAX_GRACE_MS above. Agent/Workflow (and a Monitor with
 * no declared bound beyond the default) get the standard grace window; a
 * Monitor that declares a longer `timeout_ms` or `persistent: true` gets a
 * window sized to actually cover it, capped at BACKGROUND_MONITOR_MAX_GRACE_MS.
 */
function computeBackgroundGraceMs(toolName: string, input: unknown): number {
  if (toolName !== 'Monitor') return BACKGROUND_AGENT_GRACE_MS;
  const monitorInput = input as { persistent?: unknown; timeout_ms?: unknown } | undefined;
  if (monitorInput?.persistent === true) return BACKGROUND_MONITOR_MAX_GRACE_MS;
  const declaredTimeout =
    typeof monitorInput?.timeout_ms === 'number' && monitorInput.timeout_ms > 0
      ? monitorInput.timeout_ms
      : 0;
  // A little headroom past the monitor's own timeout so a notification that
  // arrives right at expiry isn't racing the retention window's own expiry.
  // declaredTimeout is always >= 0, so declaredTimeout + BACKGROUND_AGENT_GRACE_MS
  // is always >= BACKGROUND_AGENT_GRACE_MS — no separate floor needed.
  return Math.min(BACKGROUND_MONITOR_MAX_GRACE_MS, declaredTimeout + BACKGROUND_AGENT_GRACE_MS);
}

// Shared wording for a turn that ended (gracefully or via a mid-turn exit) with no
// assistant text at all — used both to patch the in-memory prompt fed to the next
// spawn (buildInitialPrompt below) and, in AgentRunner, to persist a real assistant
// message to durable history so a dangling last-message-from-user turn doesn't leave
// the web sidebar's "typing…" indicator stuck (isSessionPending only clears once the
// last committed message is from the assistant).
export const INTERRUPTED_NO_REPLY_TEXT = 'Session was interrupted before I could respond.';

/**
 * Resolve the per-spawn history re-injection cap with precedence
 * per-agent → global → MAX_HISTORY_MESSAGES. Non-finite or negative values are
 * ignored (treated as unset) so a malformed config falls back safely instead of
 * injecting a negative or unbounded window; fractional values are floored.
 * 0 is a valid value meaning "inject no history".
 */
export function resolveMaxHistoryMessages(
  agentMax?: number,
  globalMax?: number,
): number {
  const valid = (n?: number): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (valid(agentMax)) return Math.floor(agentMax);
  if (valid(globalMax)) return Math.floor(globalMax);
  return MAX_HISTORY_MESSAGES;
}
const AUTO_RESTART_DELAY_MS = 5_000;
const MAX_RESTARTS = 3;
// A respawned child that stays alive at least this long counts as a healthy run
// rather than a member of a crash loop: on its eventual death the crash budget
// (restartCount) is reset so sporadic crashes spread across a long-lived
// session don't slowly accumulate toward a false permanent `failed`. Must be
// comfortably longer than the crash-loop window (AUTO_RESTART_DELAY_MS *
// MAX_RESTARTS = 15s) so a genuine tight crash loop never survives it and the
// MAX_RESTARTS backstop still fires. See issue #371.
const RESTART_COUNT_RESET_MS = 60_000;
// Bound how many times a single session may auto-respawn to recover from a
// corrupted thinking block, so a recovery that never helps can't loop forever.
const MAX_THINKING_RECOVERIES = 2;
const CHANNELS_ACTIVATION_PROMPT =
  'Channels mode is active. Wait for incoming messages from your channels and respond to them.';

// Built-in Claude Code tools denied when an API agent runs with allow_tools:false.
// For such agents writeMcpConfig() skips the gateway MCP server, but the built-in
// tools (Bash/Read/Write/WebFetch/...) still load, so an injected "no-tools" agent
// could exfil the owner's secrets via curl/WebFetch. Passing these to
// --disallowedTools makes allow_tools:false a real capability boundary, not just a
// prompt hint. Verified against the installed claude CLI (--disallowed-tools). The
// list is comma-joined into ONE arg (the flag accepts a comma/space-separated list).
const NO_TOOLS_DISALLOWED = [
  'Task', 'Agent', 'Bash', 'BashOutput', 'KillShell', 'KillBash',
  'Glob', 'Grep', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'TodoWrite', 'ExitPlanMode', 'Skill',
].join(',');

// Per-channel state directory suffix — single source of truth for what used
// to be the same 4-branch ternary repeated at both call sites below.
const STATE_SUBDIR: Record<ChatChannel, string> = {
  telegram: '.telegram-state',
  discord: '.discord-state',
  line: '.line-state',
  slack: '.slack-state',
};

export class SessionProcess extends EventEmitter {
  readonly sessionId: string;
  readonly chatId: string;
  readonly source: ChatChannelOrApi;
  private readonly sessionChannel: ChatChannel;
  lastActivityAt = Date.now(); // accessible by AgentRunner for eviction sort
  // Wall-clock time of the most recent BACKGROUND_DISPATCH_TOOLS tool_use seen
  // in this session's own turn, while no NEWER turn has started since. Cleared
  // whenever a fresh turn begins (setProcessing(true)) since by then the
  // dispatch either reported back (the notification woke this turn) or has
  // been superseded by unrelated new work — either way the idle-window concern
  // this field exists for no longer applies. Read via
  // hasLikelyOutstandingBackgroundWork().
  private lastBackgroundAgentDispatchAt: number | null = null;
  // Grace window for the dispatch recorded in lastBackgroundAgentDispatchAt —
  // see computeBackgroundGraceMs(). Meaningless while that field is null.
  private backgroundGraceMs: number = BACKGROUND_AGENT_GRACE_MS;
  // True when the tracked dispatch includes a Monitor (vs. Agent/Workflow only).
  // A Monitor represents an independent background watcher that keeps running
  // alongside ordinary conversation — unlike Agent/Workflow, an unrelated new
  // turn starting does NOT mean it resolved or was superseded, so
  // setProcessing(true) must not clear its grace window early (#415 review).
  private backgroundDispatchIsMonitor = false;
  private backgroundWaitTimer: ReturnType<typeof setTimeout> | null = null;
  readonly spawnedAt = Date.now();
  /** Backend used to run the subprocess. Set during start(); 'headless' until then. */
  backend: 'pty-shell' | 'headless' = 'headless';
  modelOverride?: string; // per-session model override (set by runner from SessionMeta)
  // Per-spawn cap on how many history messages buildInitialPrompt re-injects.
  // Defaults to MAX_HISTORY_MESSAGES; the runner lowers it (set before start())
  // when recovering from a repeated request_too_large (32MB) so each retry
  // re-loads less context until it drops under Anthropic's request ceiling.
  // 0 = inject no history at all (fully fresh context).
  historyLimit: number = MAX_HISTORY_MESSAGES;
  // Safe-mode override (Epic #195, Phase 3): when true, this session is forced
  // to the headless backend even if gateway.headless===false. The runner sets
  // it from SafeModeManager before start() so a repeatedly-wedged PTY agent
  // keeps serving via headless without a gateway restart. Reversible: cleared
  // on the next spawn once safe mode exits.
  forceHeadless: boolean = false;
  spawnContext: { loadedAtSpawn: number; archivedCount: number; messageCountAtSpawn: number } | null = null;
  private process: ChildProcess | null = null;
  private stopping = false;
  private restartCount = 0;
  // Wall-clock time the current (or most recent) child was spawned. Used by the
  // exit handler to measure how long that child survived, so a death after
  // sustained healthy uptime resets the crash budget instead of counting toward
  // MAX_RESTARTS. See RESTART_COUNT_RESET_MS.
  private lastSpawnAt = 0;
  // True while a crash-triggered respawn is in flight — from the moment
  // scheduleRestart() arms the AUTO_RESTART_DELAY_MS timer until the replacement
  // child has attached (emit 'restarted') or the respawn failed/was abandoned.
  // The runner reads this via isRestartScheduled() to distinguish "a restart is
  // coming, wait for it" from "dead with nothing coming, respawn fresh" — the
  // latter would otherwise wedge on waitForSessionRestart's full timeout. #371.
  private _restartScheduled = false;
  private restartRequested = false;
  private _processing = false;
  private _pendingRestart = false;
  // True once we have OBSERVED the child actually exit (the 'exit' handler
  // fired). Distinct from Node's ChildProcess.killed, which flips true the
  // instant ANY signal is delivered — including a graceful /stop SIGINT that
  // the pty-shell traps and SURVIVES (it forwards ESC to interrupt the TUI turn
  // and keeps running). Liveness checks must use _exited, never .killed: a
  // survived-SIGINT child is still alive, and treating it as dead wedges the
  // session forever (isRunning() → false → the next turn waits on a restart
  // that never comes; see runner.ts waitForSessionRestart). Reset to false on
  // every fresh spawn.
  private _exited = false;
  // Set by interrupt() right before SIGINT, cleared at the start of the next
  // sendMessage(). Lets a caller's process-exit handler tell a /stop-triggered
  // exit (CLI's SIGINT handler fell through to default termination instead of
  // flushing a terminal `result` line) apart from a genuine crash — see
  // consumeInterruptFlag().
  private interruptRequested = false;
  private restartWatcher: chokidar.FSWatcher | null = null;
  private readonly sessionStore: SessionStore;
  private readonly agentConfig: AgentConfig;
  private readonly gatewayConfig: GatewayConfig;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly configPath: string;
  private readonly restartSignalPath: string;
  queryMode = false;
  // Latest context-window token usage (input context + output) for the most
  // recent turn. Surfaced read-only for the status dashboard. Best-effort —
  // reset to 0 until the first tokenUsage event fires.
  private lastTotalTokens = 0;
  // Real model from Claude stream, updated per turn. Persisted to SessionMeta.
  _lastModel = '';
  private thinkingRecoveryCount = 0;
  // tool_use ids of channel replies already mirrored to sessionStore, so a reply
  // is persisted exactly once even though its tool_use block can recur across the
  // partial + final stream events of the same turn. Reset at every turn boundary
  // (the 'result' handler), so it never grows without bound across a long session.
  private persistedReplyToolIds = new Set<string>();
  // Binary path last spawned and the last non-empty stderr line, retained so a
  // fatal `Session max restarts reached` names what actually failed (e.g. an
  // unresolvable `claude` binary) instead of ending in silence. `stderrBuffer`
  // holds an unterminated trailing fragment so a line split across two `data`
  // chunks is not captured as two partial lines.
  private lastClaudeBin = 'claude';
  private lastStderrLine: string | null = null;
  private stderrBuffer = '';
  // Log the resolved-binary source once per instance, not on every restart spawn.
  private resolvedBinLogged = false;
  private _queryResolve?: (text: string) => void;
  private _queryBuffer = '';
  private _queryTimer?: ReturnType<typeof setTimeout>;
  private _querySettled = false;
  // For API sessions: history context to prepend to the first sendMessage() after a model-switch respawn
  private pendingInitialPrompt?: string;
  // Fingerprint per connector actually written into THIS session's mcp-config.json,
  // rewritten on every spawn by writeMcpConfig(). It answers the only question a
  // connector-triggered restart needs to ask — "is what this subprocess is running
  // with still what the connector resolves to?" — which neither the agent's current
  // enablement nor mcp-token.env can answer after the fact: a rotated token resolves
  // enabled either way, and a deleted one resolves to nothing for a session that is
  // still holding it. See connectorConfigChanged.
  //
  // `null` until writeMcpConfig has run, and it stays null for the sessions that get
  // no generated config at all (`source === 'api'` without allow_tools). An empty Map
  // would be a different claim — "spawned, with no connectors" — and would make every
  // newly connected connector look like a change to a session that cannot use MCP
  // servers in the first place.
  private spawnedConnectors: Map<string, string> | null = null;

  constructor(
    sessionId: string,
    source: ChatChannelOrApi,
    agentConfig: AgentConfig,
    gatewayConfig: GatewayConfig,
    sessionStore: SessionStore,
    chatId?: string,  // for telegram/discord: actual chatId; for api: same as sessionId
  ) {
    super();
    this.sessionId = sessionId;
    this.source = source;
    this.chatId = chatId ?? sessionId;
    this.sessionChannel = toChatChannel(source);
    this.agentConfig = agentConfig;
    this.gatewayConfig = gatewayConfig;
    this.sessionStore = sessionStore;
    this.logger = createLogger(
      `${agentConfig.id}:session:${sessionId}`,
      gatewayConfig.gateway.logDir,
    );
    // config.json lives 3 levels above workspace: <base>/<agentId>/workspace → <base>/config.json
    this.configPath = path.resolve(agentConfig.workspace, '..', '..', '..', 'config.json');
    this.restartSignalPath = path.join(agentConfig.workspace, STATE_SUBDIR[this.sessionChannel], `restart-${sessionId}`);
  }

  /**
   * Resolve the model for this session.
   * Priority: per-session override > config.json on disk > cached agentConfig.
   */
  private get typingDir(): string {
    return path.join(this.agentConfig.workspace, STATE_SUBDIR[this.sessionChannel], 'typing');
  }

  private appendToStore(msg: { role: 'user' | 'assistant' | 'system'; content: string; ts: number }): Promise<void> {
    return this.source !== 'api'
      ? this.sessionStore.appendTelegramMessage(this.agentConfig.id, this.chatId, this.sessionId, msg, this.sessionChannel)
      : this.sessionStore.appendMessage(this.agentConfig.id, this.sessionId, msg);
  }

  /** Public accessor for the model this session currently resolves to (for status/UI). */
  get model(): string {
    return this.readFreshModel();
  }

  /** Latest context-window token usage for this session (for status/UI). */
  get totalTokens(): number {
    return this.lastTotalTokens;
  }

  /** Real model from the last Claude stream, updated per turn. */
  get lastModel(): string {
    return this._lastModel;
  }

  private readFreshModel(): string {
    // Per-session model override takes priority
    if (this.modelOverride) return this.modelOverride;
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const config = JSON.parse(raw) as { agents?: Array<{ id: string; claude?: { model?: string } }> };
      const found = config.agents?.find(a => a.id === this.agentConfig.id);
      if (found?.claude?.model) return found.claude.model;
    } catch {
      // fallback to cached value
    }
    return this.agentConfig.claude.model;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.restartCount = 0;
    this.setupRestartWatcher();
    await this.spawnProcess();
  }

  /**
   * Watch for a restart signal file written by the agent.
   * When detected, kill the current Claude process — scheduleRestart() will
   * re-spawn it with the latest model from config.json.
   */
  private setupRestartWatcher(): void {
    if (this.restartWatcher) return;
    this.restartWatcher = chokidar.watch(this.restartSignalPath, { ignoreInitial: true });
    this.restartWatcher.on('add', () => {
      // Read signal file content before deleting — may contain a notify payload
      let notifyPayload: { chat_id: string; text: string } | null = null;
      try {
        const content = fs.readFileSync(this.restartSignalPath, 'utf-8').trim();
        if (content) {
          const parsed = JSON.parse(content);
          notifyPayload = parsed.notify ?? null;
        }
      } catch { /* empty or unparseable — no notify */ }
      try { fs.rmSync(this.restartSignalPath, { force: true }); } catch {}
      this.restartRequested = true;
      this.logger.info('Graceful restart requested', { sessionId: this.sessionId, hasNotify: !!notifyPayload });
      // Inject a marker into session history so the next spawned session
      // knows the restart is complete and does not repeat it.
      // If notify payload is present, include instruction for the agent to send a message after restart.
      const marker = notifyPayload
        ? `[System: Graceful restart completed successfully. Do not restart again. IMPORTANT: Send a Telegram reply to chat_id "${notifyPayload.chat_id}" with the message: "${notifyPayload.text}"]`
        : '[System: Graceful restart completed successfully. Do not restart again.]';
      const restartMsg = { role: 'assistant' as const, content: marker, ts: Date.now() };
      this.appendToStore(restartMsg).catch(err => this.logger.warn('Failed to write restart marker', { error: err.message }));
      if (this.process) {
        this.process.kill('SIGTERM');
      }
    });
  }

  private async buildInitialPrompt(): Promise<{ historyPrompt: string | null; loadedAtSpawn: number; archivedCount: number; messageCountAtSpawn: number }> {
    const history = this.source !== 'api'
      ? await this.sessionStore.loadTelegramSession(this.agentConfig.id, this.chatId, this.sessionId, this.sessionChannel)
      : await this.sessionStore.loadSession(this.agentConfig.id, this.sessionId);

    // If history exceeds the limit and history[0] is a compaction summary, rescue it
    // so the model retains context from before the truncation window.
    const SUMMARY_MARKER = '[Conversation Summary]';
    const firstMsg = history[0];
    // Clamp to a sane range; the runner uses this to escalate-shrink history on
    // repeated request_too_large (50→40→30→20→10→0). limit === 0 → no history.
    const limit = Math.max(0, this.historyLimit);
    const hasSummary =
      limit > 1 &&
      history.length > limit &&
      firstMsg?.role === 'system' &&
      typeof firstMsg.content === 'string' &&
      firstMsg.content.trimStart().startsWith(SUMMARY_MARKER);

    const recent = limit <= 0
      ? []
      : hasSummary
        ? [firstMsg, ...history.slice(-(limit - 1))]
        : history.slice(-limit);

    const loadedAtSpawn = recent.length;
    const archivedCount = history.length - recent.length;
    const messageCountAtSpawn = history.length;

    if (recent.length === 0) {
      return { historyPrompt: null, loadedAtSpawn, archivedCount, messageCountAtSpawn };
    }

    // If the last message is a dangling user turn (session was interrupted before Claude responded),
    // inject a synthetic assistant acknowledgement so the conversation structure stays valid.
    if (recent[recent.length - 1]?.role === 'user') {
      recent.push({ role: 'assistant', content: INTERRUPTED_NO_REPLY_TEXT, ts: Date.now() });
    }

    const historyText = recent
      .map(m => {
        // system role carries injected summaries (e.g. [Image Context Summary]) from the runner
        if (m.role === 'system') return `System: ${m.content}`;
        return `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`;
      })
      .join('\n');

    return {
      // Defense-in-depth: defang any verbatim 32MB-overlay text captured into past
      // messages before it is re-typed into the TUI. The primary fix routes the real
      // error off the screen-scraper to the transcript's `<synthetic>` record (see
      // TranscriptTailer.onRequestTooLarge) — but neutralizing the re-injected copy
      // keeps the poisoned overlay text off the screen entirely and out of any future scraper.
      historyPrompt: `[Conversation history with this user:\n${neutralizeTuiTriggers(historyText)}]`,
      loadedAtSpawn,
      archivedCount,
      messageCountAtSpawn,
    };
  }

  /**
   * Read stdio MCP servers from Claude Code's user-scoped config
   * (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`).
   * Returns empty object if file doesn't exist, can't be parsed, or has no mcpServers.
   */
  private readUserScopedMcp(): Record<string, unknown> {
    const servers = readClaudeSettings()?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
    return servers as Record<string, unknown>;
  }

  /**
   * Resolve the Claude credentials handed to an app-agent container this spawn.
   *
   * Container agents used to receive their credentials as a read-only bind mount
   * of the host ~/.claude/settings.json. A Docker *file* bind mount pins an
   * inode rather than a path, and Claude Code rewrites that file by atomic
   * rename — so the first host settings change left every long-lived container
   * reading a deleted inode. Claude Code silently ignores a settings.json whose
   * inode is unlinked, so the agent stayed healthy and answered every real user
   * "Not logged in · Please run /login" until someone recreated the container.
   *
   * That mechanism was verified directly rather than inferred: with content held
   * byte-identical (same md5) and only the link count differing, a container
   * reading the unlinked inode reported "Not logged in" and sent no request,
   * while the same file at nlink=1 authenticated normally.
   *
   * Resolving by path here is immune to that: the container is handed the
   * current credentials every time a session subprocess is spawned. Because the
   * unlinked file is *ignored* rather than merely stale, the forwarded env is
   * what the CLI ends up using — so a container stuck on a stale mount recovers
   * on its next session spawn, with no container recreate. Note the cadence is
   * per spawn, not per turn: one `docker exec` serves a whole session and later
   * turns are written to its stdin, so a rotated credential reaches a live
   * session only when it is respawned (idle reap, restart or config change).
   *
   * settings.json wins over the gateway's own environment. That matches Claude
   * Code, which applies the file's `env` block over whatever it inherited (also
   * verified: with both sources set to different endpoints, every request went
   * to the file's), and it keeps the live file as the single source of truth — a
   * long-lived gateway started with an exported token would otherwise pin the
   * container to a credential that can never be rotated without restarting the
   * service.
   *
   * Credentials resolve as a GROUP, not key by key. If the file declares an
   * identity at all, the gateway's environment must not contribute a *different*
   * one: forwarding a file OAuth token alongside an environment
   * ANTHROPIC_API_KEY would hand the container two identities and let the CLI
   * choose between them silently. A base URL only selects an endpoint, so it is
   * not part of that group and keeps its own independent fallback.
   */
  private resolveContainerAuthEnv(): Record<string, string> {
    // Resolved through the shared helper so an operator who relocated the config
    // with CLAUDE_CONFIG_DIR is honoured here too. Hardcoding ~/.claude would
    // read a path that does not exist and forward nothing — reproducing the very
    // "Not logged in" failure this method was written to prevent.
    const fileEnv = claudeSettingsEnv();

    // Presence, not validity: a credential key spelled out in settings.json is
    // authoritative for the whole group even when its value is malformed, so a
    // broken token can never silently fall back to a different identity.
    const fileDeclaresCredential = CONTAINER_CREDENTIAL_KEYS.some((k) => k in fileEnv);

    const resolved: Record<string, string> = {};
    const dropped: Array<{ key: string; reason: string }> = [];
    for (const key of CONTAINER_AUTH_ENV_KEYS) {
      let value: unknown;
      let origin: string;
      if (key in fileEnv) {
        value = fileEnv[key];
        origin = 'settings.json';
      } else if (fileDeclaresCredential && CONTAINER_CREDENTIAL_KEYS.includes(key)) {
        continue; // the file owns the identity — don't mix in another one
      } else {
        value = process.env[key];
        origin = 'gateway env';
      }
      // settings.json is untrusted input: forward only a clean, non-empty
      // string. A NUL byte throws at spawn, and a newline is never legitimate
      // in a credential or a base URL.
      if (value === undefined) continue; // simply not set anywhere — not a defect
      if (typeof value !== 'string') {
        dropped.push({ key, reason: `${origin} value is ${typeof value}, not a string` });
        continue;
      }
      if (value.length === 0) {
        dropped.push({ key, reason: `${origin} value is empty` });
        continue;
      }
      if (/[\0\r\n]/.test(value)) {
        dropped.push({ key, reason: `${origin} value contains a NUL or newline` });
        continue;
      }
      resolved[key] = value;
    }

    // Never fail silently. The bug this whole path exists to fix presented as a
    // container that looked healthy while answering real users "Not logged in",
    // so a spawn that forwards no credential at all must say so — otherwise a
    // malformed token in settings.json reproduces the original symptom with the
    // original silence. `dropped` names the reason without ever logging a value.
    const forwardedCredentials = CONTAINER_CREDENTIAL_KEYS.filter((k) => k in resolved);
    if (forwardedCredentials.length === 0) {
      this.logger.warn(
        'No Claude credential could be resolved for this container agent — it will likely report "Not logged in"',
        { sessionId: this.sessionId, dropped, checked: CONTAINER_AUTH_ENV_KEYS },
      );
    } else if (dropped.length > 0) {
      this.logger.debug('Some container auth env vars were not forwarded', {
        sessionId: this.sessionId,
        dropped,
      });
    }
    return resolved;
  }

  /**
   * Read stdio MCP servers from Claude Code's project-scoped config (~/.claude.json).
   * Looks up projects[workspace].mcpServers for the agent's workspace path.
   * Returns empty object if not found or on any error.
   */
  private readProjectScopedMcp(): Record<string, unknown> {
    try {
      const claudeJsonPath = path.join(os.homedir(), '.claude.json');
      const parsed = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
      const projectServers = parsed?.projects?.[this.agentConfig.workspace]?.mcpServers;
      return (projectServers as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * True when `resolvedServer` — what `connectorId` resolves to for this agent
   * right now, or `undefined` when it resolves to nothing — differs from what
   * this session's subprocess was actually spawned with.
   *
   * This is the whole restart decision for a connector change, and it has to be
   * asked per session rather than per agent. The three cases a caller has:
   *   - a token rotated: both sides present, different value → restart
   *   - a connector deleted or its refresh given up on: `undefined` here,
   *     present at spawn → restart (asking mcp-token.env instead answers "not
   *     connected", i.e. "nobody uses it", for the sessions still holding it)
   *   - a connector just connected: present here, absent at spawn → restart
   * and one case that used to cost every session on the box a respawn: nothing
   * about this connector changed for this session → no restart. That matters
   * because the refresh sweep fires on a timer, so an agent-level answer
   * restarted every session of every agent roughly once per token lifetime.
   *
   * A session that has never written an mcp-config.json is never a candidate: it
   * either has not spawned yet, and will read the current state when it does, or
   * it is a tool-less API session that gets no MCP servers at all.
   */
  connectorConfigChanged(connectorId: string, resolvedServer: unknown): boolean {
    if (!this.spawnedConnectors) return false;
    const now = resolvedServer === undefined ? undefined : connectorFingerprint(resolvedServer);
    return this.spawnedConnectors.get(connectorId) !== now;
  }

  private writeMcpConfig(): string | null {
    if (this.source === 'api' && !this.agentConfig.allow_tools) return null;

    const stateDir = path.join(this.agentConfig.workspace, '.telegram-state');
    const sessionsRoot = path.join(this.agentConfig.workspace, '.sessions');
    const sessionDir = path.join(sessionsRoot, this.sessionId);
    // Defense-in-depth: a sessionId containing '../' would escape the .sessions
    // directory. Reject anything that resolves outside it.
    const sessionDirRel = path.relative(sessionsRoot, sessionDir);
    if (sessionDirRel.startsWith('..') || path.isAbsolute(sessionDirRel)) {
      throw new Error('invalid session id');
    }
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

    const mcpServerPath = path.resolve(__dirname, '..', '..', 'mcp', 'server.ts');

    // Merge stdio servers from Claude Code user + project configs (project overrides user).
    // Skip the gateway's own server names from both — gateway always generates its own
    // config below (RESERVED_CONNECTOR_IDS; connector ids can no longer land here at all).
    const userServers = this.readUserScopedMcp();
    const projectServers = this.readProjectScopedMcp();
    const extraServers: Record<string, unknown> = {};
    for (const [name, server] of Object.entries({ ...userServers, ...projectServers })) {
      if (!isReservedConnectorId(name)) extraServers[name] = server;
    }

    // Connectors enabled for THIS agent AND connected (every secret present in
    // mcp-token.env). Resolved fresh each spawn so a web "connect" is picked up
    // without a daemon restart. Secrets land only in this 0600 mcp-config.json.
    const connectorServers = resolveEnabledConnectors(
      this.agentConfig,
      this.gatewayConfig.gateway.customConnectors,
      this.gatewayConfig.gateway.connectorsDefaultEnabled ?? true,
    );
    const spawnedConnectors = new Map<string, string>();
    for (const [name, server] of Object.entries(connectorServers)) {
      // Defence in depth: slugify() and /oauth/receive both refuse these ids now,
      // so this can only fire on an entry hand-written into config.json.
      if (isReservedConnectorId(name)) continue;
      // Connector wins over a same-named user/project server — it is the one the
      // gateway can actually vouch for the credentials of. Worth a line, though:
      // the user configured that other server in their own Claude Code config and
      // gets no other signal that it stopped being the thing under this name.
      if (name in extraServers) {
        console.warn(
          `session/process: connector '${name}' overrides the same-named MCP server from` +
            ` the user/project Claude Code config for agent=${this.agentConfig.id}`,
        );
      }
      extraServers[name] = server;
      spawnedConnectors.set(name, connectorFingerprint(server));
    }
    this.spawnedConnectors = spawnedConnectors;

    const mcpConfig = {
      mcpServers: {
        ...extraServers,
        // Gateway always wins — must stay last to override any accidental collision
        gateway: {
          command: 'bun',
          args: [mcpServerPath],
          env: {
            TELEGRAM_BOT_TOKEN: this.agentConfig.telegram?.botToken ?? '',
            TELEGRAM_STATE_DIR: stateDir,
            TELEGRAM_SEND_ONLY: 'true', // ALWAYS — session subprocesses never poll
            DISCORD_BOT_TOKEN: this.agentConfig.discord?.botToken ?? '',
            DISCORD_STATE_DIR: path.join(this.agentConfig.workspace, '.discord-state'),
            DISCORD_GUILD_ALLOWLIST: (this.agentConfig.discord?.guildAllowlist ?? []).join(','),
            DISCORD_CHANNEL_ALLOWLIST: (this.agentConfig.discord?.channelAllowlist ?? []).join(','),
            DISCORD_DM_POLICY: this.agentConfig.discord?.dmPolicy ?? 'disabled',
            DISCORD_DM_ALLOWLIST: (this.agentConfig.discord?.dmAllowlist ?? []).join(','),
            // LINE outbound: line_reply pushes via the Messaging API. The MCP
            // subprocess only sees the env we hand it, so the token must be
            // forwarded explicitly. The SDK targets api.line.me by default.
            LINE_CHANNEL_ACCESS_TOKEN: this.agentConfig.line?.channelAccessToken ?? '',
            // Refresh mode (slow-LLM postback button): when on, the gateway is the
            // sole LINE sender, so line_reply must NOT send from the subprocess.
            // Mirrors the runner's `slowResponseThreshold > 0` gate.
            LINE_REPLY_REFRESH:
              this.agentConfig.line && (this.agentConfig.line.slowResponseThreshold ?? 45) > 0
                ? '1'
                : '',
            // Slack outbound: slack_reply posts via chat.postMessage. Unlike LINE
            // there's no gateway-side reply manager to defer to (no reply-token TTL
            // to work around), so no refresh-mode env is needed — the subprocess
            // always sends directly.
            SLACK_BOT_TOKEN: this.agentConfig.slack?.botToken ?? '',
            GATEWAY_AGENT_ID: this.agentConfig.id,
            // Must be the base URL without /api suffix (e.g. http://127.0.0.1:10850).
            // MCP tools append /api/v1/... themselves — a trailing /api here causes double-prefix 404s.
            GATEWAY_API_URL: process.env.GATEWAY_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '10850'}`,
            GATEWAY_API_KEY: this.findApiKeyForAgent(this.agentConfig.id),
            GATEWAY_ORIGIN_CHANNEL: this.source,
            GATEWAY_WORKSPACE_DIR: this.agentConfig.workspace,
            GATEWAY_SHARED_SKILLS_DIR: path.join(os.homedir(), '.claude-gateway', 'shared-skills'),
            // Shared KB vault dir (planning-64 K3), so memory_search corpus:"shared"
            // can reach the cross-agent vault. Empty when shared KB is disabled.
            GATEWAY_SHARED_KB_DIR: this.resolveSharedKbDir(),
            // The Bun MCP subprocess's own `process.execPath` is the `bun` binary, not
            // `node` — spawning the compiled reindex-cli.js (needs `node:sqlite`) with
            // that would fail (`No such built-in module: node:sqlite`), silently, since
            // memory_shared_create/_update/_delete's reindex trigger runs detached/stdio:'ignore'. Forward the
            // GATEWAY PROCESS's own execPath (real Node, guaranteed >=22 by `engines`) so
            // the mcp side can spawn the CLI with the right runtime.
            GATEWAY_NODE_EXEC_PATH: process.execPath,
            // planning-66: gate the read-path retrieval recorder (memory_search →
            // kb_retrieval_log) so the staleness GC's LRU/feedback signal is only
            // collected when the agent actually runs the GC.
            GATEWAY_RECORD_RETRIEVALS: this.resolveRecordRetrievals(),
            GATEWAY_SESSION_ID: this.sessionId,
            // For API sessions: absolute path to session media dir so browser screenshots land there
            GATEWAY_SESSION_MEDIA_DIR: this.source === 'api'
              ? path.resolve(this.agentConfig.workspace, '..', 'media', `api-${this.sessionId}`)
              : '',
            // Image-generation tool (generate_image) — targets an image provider that
            // may differ from the LLM: IMAGE_BASE_URL/IMAGE_API_KEY override, falling
            // back to ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN when they share a provider.
            // The MCP subprocess only sees the env we hand it, so every var module.ts
            // reads must be forwarded explicitly. Empty base URL ⇒ tool disabled.
            IMAGE_BASE_URL: process.env.IMAGE_BASE_URL ?? '',
            ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? '',
            IMAGE_API_KEY: process.env.IMAGE_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? '',
            IMAGE_DISABLED: process.env.IMAGE_DISABLED ?? '',
            IMAGE_POLL_TIMEOUT_MS: process.env.IMAGE_POLL_TIMEOUT_MS ?? '',
            // #444: the share bridge's env vars were renamed IMAGE_SHARE_* ->
            // SHARE_* when it stopped being image-only. Forward BOTH so an
            // operator who set either name keeps working; the MCP side reads
            // the neutral name first and falls back to the legacy one.
            SHARE_MAX_REFS: process.env.SHARE_MAX_REFS ?? '',
            IMAGE_SHARE_MAX_REFS: process.env.IMAGE_SHARE_MAX_REFS ?? '',
            // Short-lived public media URLs (LINE image delivery). line_image
            // mints a share token via the gateway share bridge (using
            // GATEWAY_API_KEY, injected above) and builds a `/shared/<token>` URL —
            // no HMAC / separate public-token secret. The public base URL is derived
            // by the gateway from the inbound LINE webhook and written to
            // `<workspace>/../.public-base`, which line_image reads at call-time
            // (no public-base-URL env var).
            GATEWAY_MEDIA_URL_TTL_MS: process.env.GATEWAY_MEDIA_URL_TTL_MS ?? '',
          },
        },
      },
    };

    const configPath = path.join(sessionDir, 'mcp-config.json');
    fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });

    const serverNames = Object.keys(mcpConfig.mcpServers);
    this.logger.debug('MCP config written', { sessionId: this.sessionId, servers: serverNames });

    return configPath;
  }

  /** Find the first API key that has access to this agent (agents: '*' or includes agentId). */
  private findApiKeyForAgent(agentId: string): string {
    const keys = this.gatewayConfig.gateway.api?.keys;
    if (!keys?.length) return '';
    // Prefer a key scoped to this agent; fall back to wildcard or admin key.
    const match = keys.find(k =>
      (Array.isArray(k.agents) && k.agents.includes(agentId)) ||
      k.agents === '*' ||
      k.admin
    );
    return match?.key ?? '';
  }

  /** Resolved shared-KB vault dir for this agent, or '' when shared KB is disabled. */
  private resolveSharedKbDir(): string {
    const cfg = resolveSharedConfig(
      this.agentConfig.knowledge?.shared,
      this.gatewayConfig.gateway.knowledge?.shared,
    );
    return cfg.enabled ? sharedVaultDir(cfg) : '';
  }

  /**
   * "1" when the read-path retrieval recorder should log memory_search hits into
   * kb_retrieval_log. Either enabled lifecycle tier can consume the same
   * append-only log: personal dreaming staleness or shared-KB staleness.
   */
  private resolveRecordRetrievals(): string {
    const personal = resolveDreamingConfig(
      this.agentConfig.dreaming,
      this.gatewayConfig.gateway.dreaming,
    ).staleness;
    const shared = resolveSharedConfig(
      this.agentConfig.knowledge?.shared,
      this.gatewayConfig.gateway.knowledge?.shared,
    ).staleness;
    return (personal.enabled && personal.recordRetrievals) || (shared.enabled && shared.recordRetrievals) ? '1' : '';
  }

  private buildArgs(mcpConfigPath: string | null, model: string): string[] {
    const args: string[] = [
      '--model', model,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--print',
      '--verbose',
    ];

    if (mcpConfigPath) {
      // NOTE: --strict-mcp-config is intentionally omitted.
      // With --strict-mcp-config, Claude Code blocks all plugin MCP servers (e.g. figma).
      // Without it, enabled plugins (figma, etc.) load automatically alongside --mcp-config.
      args.unshift('--mcp-config', mcpConfigPath);
    }

    // Built-in: gateway sessions always run with permissions skipped.
    // (The old claude.dangerouslySkipPermissions config is gone.)
    args.push('--dangerously-skip-permissions');

    // Enforce allow_tools:false as a real boundary. Gated on the SAME condition as
    // writeMcpConfig() (source==='api' && !allow_tools): those sessions get no MCP
    // server, but built-in tools would still run and could exfil owner secrets.
    // Tool-enabled agents (any channel source, or api with allow_tools:true) are
    // strictly unaffected — their spawn args stay byte-identical.
    if (this.source === 'api' && !this.agentConfig.allow_tools) {
      args.push('--disallowedTools', NO_TOOLS_DISALLOWED);
    }

    for (const flag of this.agentConfig.claude.extraFlags ?? []) {
      args.push(flag);
    }

    return args;
    // NOTE: NO --channels flag — messages arrive via stdin injection, not Telegram channels
  }

  private static toStreamJsonTurn(text: string): string {
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  }

  private async spawnProcess(): Promise<void> {
    const { historyPrompt, loadedAtSpawn, archivedCount, messageCountAtSpawn } = await this.buildInitialPrompt();
    this.spawnContext = { loadedAtSpawn, archivedCount, messageCountAtSpawn };

    // Determine if this is a docker-exec app-agent before computing paths
    const isAppAgent = this.agentConfig.type === 'app-agent' && !!this.agentConfig.container;

    const mcpConfigPath = this.writeMcpConfig();

    // For app-agents, Claude runs inside the container where /workspace is mounted.
    // Convert host paths (agentConfig.workspace-relative) to container paths (/workspace/...).
    const toContainerPath = (hostPath: string): string =>
      `/workspace/${path.relative(this.agentConfig.workspace, hostPath)}`;
    const effectiveMcpPath = (isAppAgent && mcpConfigPath) ? toContainerPath(mcpConfigPath) : mcpConfigPath;
    const containerRestartPath = isAppAgent ? toContainerPath(this.restartSignalPath) : this.restartSignalPath;

    const freshModel = this.readFreshModel();
    const args = this.buildArgs(effectiveMcpPath, freshModel);

    // Resolve the claude binary. An explicit CLAUDE_BIN (which may carry args) is
    // trusted verbatim; otherwise probe PATH and the native-installer / legacy
    // install locations so a gateway launched with a minimal PATH still finds it.
    let claudeBinRaw: string;
    if (process.env.CLAUDE_BIN) {
      claudeBinRaw = process.env.CLAUDE_BIN;
    } else if (isAppAgent) {
      // App-agents run claude INSIDE the container; host-side resolution would
      // point at a host path that need not exist in the container. Keep bare
      // `claude` so the container's own PATH resolves it (agentConfig.claudeBin
      // overrides below when the image installs claude elsewhere).
      claudeBinRaw = 'claude';
    } else {
      const resolution = resolveClaudeBin();
      claudeBinRaw = resolution.bin;
      if (resolution.source === 'fallback') {
        this.logger.warn('Could not resolve the claude binary — spawning bare "claude" as a last resort', {
          sessionId: this.sessionId,
          searched: resolution.searched,
          hint: 'set CLAUDE_BIN to the claude executable path (native install: ~/.local/bin/claude)',
        });
      } else if (resolution.source !== 'PATH' && !this.resolvedBinLogged) {
        // Log the non-PATH resolution once per instance; auto-restarts re-resolve
        // the same location and would otherwise repeat this line on every spawn.
        this.resolvedBinLogged = true;
        this.logger.info('Resolved claude binary from an install location', {
          sessionId: this.sessionId,
          bin: resolution.bin,
          source: resolution.source,
        });
      }
    }
    const claudeBinParts = claudeBinRaw.split(' ');
    let claudeBin = claudeBinParts[0];
    let allArgs = [...claudeBinParts.slice(1), ...args];

    // gateway.headless: false → run the interactive claude TUI under the
    // claude-pty-shell PTY wrapper (same stream-json protocol on stdio).
    // App-agents always stay headless: the wrapper (node-pty) lives on the
    // host and cannot wrap a binary inside a docker-exec container.
    // Safe mode (forceHeadless) overrides the configured PTY backend so a
    // repeatedly-failing wrapper degrades to headless instead of re-wedging.
    const usePtyShell =
      this.gatewayConfig.gateway.headless === false && !isAppAgent && !this.forceHeadless;
    this.backend = usePtyShell ? 'pty-shell' : 'headless';
    let ptyRealBin: string | null = null;
    // Pre-calculate heartbeat path so we can pass it to the PTY shell before spawn.
    // API sessions are excluded: the stalled detector is receiver-side (Telegram/Discord)
    // and never watches API sessions — writing a heartbeat file for them would be a no-op.
    const ptyTypingDir = (usePtyShell && this.source !== 'api') ? this.typingDir : null;
    const ptyHeartbeatPath = ptyTypingDir ? path.join(ptyTypingDir, `${this.chatId}.heartbeat`) : null;
    if (usePtyShell) {
      const wrapperPath = path.resolve(__dirname, '..', 'shell', 'claude-pty-shell.js');
      // The wrapper resolves the real binary via CLAUDE_REAL_BIN; never let it
      // point back at the wrapper itself (legacy CLAUDE_BIN drop-in setups).
      ptyRealBin = claudeBinRaw.includes('claude-pty-shell') ? 'claude' : claudeBinRaw;
      claudeBin = process.execPath;
      allArgs = [wrapperPath, ...args];
      // NOTE: the interactive TUI backend does NOT append a [1m] context suffix.
      // Triggering the server-side 1M billing tier from the TUI requires real 1M
      // credits on the account; without them the session silently drops back to
      // 200k mid-conversation. Until credits are provisioned, the TUI runs at the
      // standard context window. (A model string with an explicit [1m] suffix in
      // config is still passed through verbatim by buildArgs.)
    } else if (this.gatewayConfig.gateway.headless === false && isAppAgent) {
      this.logger.warn('gateway.headless=false is not supported for app-agents — using headless backend', {
        sessionId: this.sessionId,
      });
    }

    this.logger.info('Spawning session subprocess', {
      sessionId: this.sessionId,
      source: this.source,
      backend: usePtyShell ? 'pty-shell' : 'headless',
    });

    const spawnBin = isAppAgent ? 'docker' : claudeBin;
    // Record the claude binary targeted this spawn so a fatal restart failure
    // can name it (app-agents run claude inside the container).
    this.lastClaudeBin = isAppAgent ? (this.agentConfig.claudeBin ?? claudeBinRaw) : claudeBinRaw;

    // env vars that must be forwarded into the container via `docker exec -e`
    let containerUid = 1000;
    try { containerUid = os.userInfo().uid; } catch { /* use 1000 */ }

    const containerEnv: Record<string, string> = {
      HOME: os.homedir(),
      CLAUDE_WORKSPACE: '/workspace',
      GATEWAY_RESTART_SIGNAL_PATH: containerRestartPath,
    };
    if (process.env.GATEWAY_API_URL) containerEnv.GATEWAY_API_URL = process.env.GATEWAY_API_URL;

    // Secrets are forwarded by NAME only (`-e KEY`, no `=value`), which makes
    // Docker read the value from this process's own environment (set on the spawn
    // below). The value therefore never lands on the docker argv, where any local
    // user could read it out of `ps`: /proc/<pid>/cmdline is world-readable on a
    // stock kernel, whereas /proc/<pid>/environ is owner-only.
    //
    // TELEGRAM_BOT_TOKEN travels by name for exactly the same reason as the
    // Claude credentials — it is a bearer token for the agent's whole bot
    // account. It is already placed in the spawn env below, unconditionally.
    const containerAuthEnv = isAppAgent ? this.resolveContainerAuthEnv() : {};
    const byNameKeys = ['TELEGRAM_BOT_TOKEN', ...Object.keys(containerAuthEnv)];
    const dockerEnvFlags = [
      ...Object.entries(containerEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ...byNameKeys.flatMap((k) => ['-e', k]),
    ];

    const spawnArgs = isAppAgent
      ? [
          'exec', '--workdir', '/workspace', '--user', String(containerUid), '-i',
          ...dockerEnvFlags,
          this.agentConfig.container!,
          this.agentConfig.claudeBin ?? claudeBin,
          ...allArgs,
        ]
      : allArgs;

    let ptyStreamSocketPath: string | null = null;
    if (usePtyShell) {
      // Key the stream by sessionId, not agentId: one agent may run several
      // concurrent sessions, each needing its own isolated PTY mirror.
      ptyStreamSocketPath = ptyStreamRegistry.socketPath(this.sessionId);
      ptyStreamRegistry.listen(this.sessionId, ptyStreamSocketPath);
    }

    // Ensure the native-installer bin dir is on the child's PATH when it exists,
    // so a bare `claude` resolves even if the gateway itself was launched with a
    // minimal PATH that predates the native-installer migration.
    const hardenedPath = pathWithNativeBin();

    const proc = spawn(spawnBin, spawnArgs, {
      env: {
        ...process.env,
        ...containerAuthEnv,
        ...(hardenedPath ? { PATH: hardenedPath } : {}),
        CLAUDE_WORKSPACE: isAppAgent ? '/workspace' : this.agentConfig.workspace,
        TELEGRAM_BOT_TOKEN: this.agentConfig.telegram?.botToken ?? '',
        GATEWAY_RESTART_SIGNAL_PATH: this.restartSignalPath,
        ...(ptyRealBin ? { CLAUDE_REAL_BIN: ptyRealBin } : {}),
        ...(ptyHeartbeatPath ? { PTY_SHELL_HEARTBEAT_PATH: ptyHeartbeatPath } : {}),
        ...(ptyStreamSocketPath ? { PTY_SHELL_STREAM_SOCKET: ptyStreamSocketPath } : {}),
      },
      cwd: this.agentConfig.workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process = proc;
    // Fresh child is alive: clear any exit observed for a prior process (e.g.
    // after an auto-restart), so isRunning()/interrupt() see it as live.
    this._exited = false;
    this.lastSpawnAt = Date.now();

    // Send initial prompt only for Telegram/Discord sessions.
    // API sessions receive the first message directly via sendApiMessage(),
    // so we cannot send an activation prompt here — it would race with the
    // first API turn and cause sendApiMessage to resolve with the wrong result.
    // Instead, if there is conversation history to restore (model-switch respawn),
    // stash it in pendingInitialPrompt so sendMessage() prepends it to the first turn.
    //
    // Non-API sessions with history also use pendingInitialPrompt to avoid a
    // double-response bug: if the session died while an interactive menu was pending
    // (e.g. ExitPlanMode Pre-flight Summary), sending history + activation immediately
    // makes Claude respond to that context as Turn 1, then the user's reply (e.g. "Y")
    // becomes Turn 2 — two separate responses forwarded to the channel. Deferring
    // history to sendMessage() bundles [history + activation + user reply] into a
    // single turn so Claude produces exactly one response.
    if (this.source !== 'api') {
      if (historyPrompt) {
        // Has history: defer to first incoming user message to prevent double-response.
        this.pendingInitialPrompt = `${historyPrompt}\n\n${CHANNELS_ACTIVATION_PROMPT}`;
      } else {
        // No history: send activation-only prompt immediately (fresh session).
        proc.stdin?.write(SessionProcess.toStreamJsonTurn(CHANNELS_ACTIVATION_PROMPT) + '\n');
      }
    } else if (historyPrompt) {
      this.pendingInitialPrompt = historyPrompt;
    }

    // Capture stdout — emit output events + persist assistant replies
    const typingDir = this.source !== 'api' ? this.typingDir : null;
    const heartbeatPath = typingDir ? path.join(typingDir, `${this.chatId}.heartbeat`) : null;
    const statusPath    = typingDir ? path.join(typingDir, `${this.chatId}.status`)    : null;

    const writeStatus = (status: string, detail?: string): void => {
      if (statusPath) {
        const payload = detail
          ? JSON.stringify({ status, detail })
          : status;
        try { fs.writeFileSync(statusPath, payload) } catch {}
      }
    };

    // CODING_TOOLS and TOOL_LABELS imported from shared utility above

    let assistantBuffer = '';
    // Reply-tool texts already mirrored to the store during the CURRENT turn, so
    // the end-of-turn assistantBuffer persist can skip an identical narration
    // text block and avoid writing the same message twice. Cleared each turn.
    const replyTextsThisTurn = new Set<string>();
    // Track partial message text to avoid double-counting when --include-partial-messages is active.
    // Each partial `type: 'assistant'` event contains the FULL text so far, not a delta.
    let lastPartialText = '';
    // Track context from message_start events (first sub-call of each turn) for accurate context % display.
    // result.usage is cumulative across all sub-calls; message_start.usage reflects a single API call's context.
    let lastMessageStartContext = 0;

    proc.stdout?.on('data', (data: Buffer) => {
      // Child produced output => the session is doing real work right now. Count
      // this as activity so the idle reaper measures "time since the session last
      // did anything", not just "time since the parent last injected a message".
      // Without this, a self-paced loop (a /loop in dynamic mode using
      // ScheduleWakeup) that wakes itself and works entirely inside this child
      // process stays invisible to the idle timer and gets reaped mid-flight.
      this.touch();
      // Update heartbeat so the receiver's stalled detector knows Claude is active
      if (heartbeatPath) {
        try { fs.writeFileSync(heartbeatPath, String(Date.now())) } catch {}
      }
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        this.emit('output', line);
        this.logger.debug('session output', { line });
        // Try to capture assistant text for SessionStore + update status file
        try {
          const obj = JSON.parse(line);
          // stream-json assistant message (partial or final)
          if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
            // Capture the real model from the stream
            if (typeof obj.message?.model === 'string') {
              this._lastModel = obj.message.model;
            }
            // Extract full text from all text blocks in this message
            let fullText = '';
            for (const block of obj.message.content) {
              if (block.type === 'text') fullText += block.text;
            }

            const isPartial = obj.stop_reason === null || obj.stop_reason === undefined;

            if (isPartial) {
              // Partial message: update buffer with only the delta
              // (fullText is cumulative, so delta = new portion)
              if (fullText.length > lastPartialText.length) {
                const delta = fullText.slice(lastPartialText.length);
                if (this.queryMode) { this._queryBuffer += delta; } else { assistantBuffer += delta; }
              }
              lastPartialText = fullText;
            } else {
              // Final message: use full text, reset partial tracking
              if (fullText.length > lastPartialText.length) {
                const delta = fullText.slice(lastPartialText.length);
                if (this.queryMode) { this._queryBuffer += delta; } else { assistantBuffer += delta; }
              }
              lastPartialText = '';
            }

            // Record a background-dispatch tool_use (see BACKGROUND_DISPATCH_TOOLS)
            // so restartOrDefer can tell "genuinely idle" apart from "idle because
            // it just fired off async work and is waiting on a task-notification".
            // Only the final (non-partial) message carries a fully materialised
            // tool_use block, same as the reply-mirror check above. A single
            // message can dispatch more than one background tool at once (e.g. a
            // sub-agent Task alongside a persistent Monitor) — take the MAX grace
            // across all of them, not just the first match, so a longer-lived
            // dispatch later in the array can't be shadowed by a shorter one
            // earlier in it (#415 review). The same shadowing risk exists ACROSS
            // messages and turns too: a still-outstanding Monitor must never be
            // demoted by a LATER Agent/Workflow dispatch, even when that later
            // dispatch's raw expiry timestamp is numerically greater — a plain
            // Agent/Workflow's grace is fixed at BACKGROUND_AGENT_GRACE_MS, the
            // same floor a default (no timeout_ms/persistent) Monitor gets, so a
            // subsequent Agent/Workflow dispatched even moments later always has
            // a later raw expiry than that Monitor despite offering none of its
            // turn-survival protection (setProcessing(true) resets non-Monitor
            // tracking on the very next unrelated turn). Comparing only raw
            // expiry let that demotion through silently, reintroducing #413
            // through the code meant to guard it (found in manual review, round
            // 6). Only another Monitor dispatch — never Agent/Workflow — may
            // overwrite a still-outstanding Monitor, and only when its own
            // expiry is at least as protective (BG17's no-shrink guarantee).
            if (!isPartial && !this.queryMode) {
              let dispatchedGraceMs: number | null = null;
              let dispatchedIsMonitor = false;
              for (const block of obj.message.content) {
                if (block.type === 'tool_use' && typeof block.name === 'string' && BACKGROUND_DISPATCH_TOOLS.has(block.name)) {
                  const graceMs = computeBackgroundGraceMs(block.name, block.input);
                  dispatchedGraceMs = dispatchedGraceMs === null ? graceMs : Math.max(dispatchedGraceMs, graceMs);
                  if (block.name === 'Monitor') dispatchedIsMonitor = true;
                }
              }
              if (dispatchedGraceMs !== null) {
                const now = Date.now();
                const existingIsProtectiveMonitor =
                  this.backgroundDispatchIsMonitor && this.isTrackedDispatchStillOutstanding();
                const newExpiry = now + dispatchedGraceMs;
                const existingExpiry = existingIsProtectiveMonitor
                  ? this.lastBackgroundAgentDispatchAt! + this.backgroundGraceMs
                  : -Infinity;
                const canOverwrite =
                  !existingIsProtectiveMonitor || (dispatchedIsMonitor && newExpiry >= existingExpiry);
                if (canOverwrite) {
                  this.lastBackgroundAgentDispatchAt = now;
                  this.backgroundGraceMs = dispatchedGraceMs;
                  this.backgroundDispatchIsMonitor = dispatchedIsMonitor;
                  // The tracked deadline just changed — any timer already armed
                  // by retainBackgroundWorkingState() against the OLD deadline is
                  // now stale and must not be left to fire on the old schedule
                  // (it would wipe this fresh dispatch out early). Clearing here
                  // forces the next retainBackgroundWorkingState() call to re-arm
                  // against the new deadline (manual review round).
                  this.clearBackgroundWaitTimer();
                }
              }
            }

            // Mirror channel replies (telegram_reply/discord_reply/line_reply) into
            // the resumable session store at delivery time. The user-facing text is
            // carried in the tool_use input, not a text block, so assistantBuffer
            // never sees it — without this, a turn whose entire output is a reply
            // tool call (e.g. a long synthesized report, or any background-event or
            // reply-tool-only turn) is delivered to the user yet lost from the store
            // and vanishes on resume. Persisting here — keyed off the tool_use event,
            // not the end-of-turn 'result' — also survives a subprocess that exits
            // before the turn completes. Only act on the final (non-partial) message,
            // where the tool_use input is fully materialised.
            if (!isPartial && !this.queryMode && this.source !== 'api') {
              for (const block of obj.message.content) {
                if (
                  block.type === 'tool_use' &&
                  typeof block.name === 'string' &&
                  CHANNEL_REPLY_TOOLS.has(block.name) &&
                  typeof block.id === 'string' &&
                  !this.persistedReplyToolIds.has(block.id)
                ) {
                  const input = block.input as { text?: unknown } | undefined;
                  const replyText = typeof input?.text === 'string' ? input.text.trim() : '';
                  // Skip an empty reply, and skip a reply whose exact text was
                  // already mirrored earlier in THIS turn — e.g. a channel delivery
                  // that failed and the model retried with a fresh tool_use id — so
                  // the resume window shows the message once, not once per retry.
                  if (replyText && !replyTextsThisTurn.has(replyText)) {
                    this.persistedReplyToolIds.add(block.id);
                    replyTextsThisTurn.add(replyText);
                    this.appendToStore({ role: 'assistant', content: replyText, ts: Date.now() }).catch(() => {});
                  }
                }
              }
            }

            if (!this.queryMode) {
              // Detect tool use to write status (same as before)
              const toolBlock = obj.message.content.find(
                (b: { type: string }) => b.type === 'tool_use',
              );
              if (toolBlock) {
                const detail = extractToolDetail(toolBlock.name ?? '', toolBlock.input ?? {});
                writeStatus(CODING_TOOLS.has(toolBlock.name ?? '') ? 'coding' : 'tool', detail);
              } else if (!isPartial && obj.message.content.some((b: { type: string }) => b.type === 'text')) {
                // Only update thinking status on final messages, not every partial
                const textBlock = obj.message.content.find((b: { type: string; text?: string }) => b.type === 'text');
                const textSnippet = textBlock?.text ? truncateDetail(`🧠 ${textBlock.text}`) : undefined;
                writeStatus('thinking', textSnippet);
              }
            }
          }
          // task_started / task_progress
          if (obj.type === 'system' && (obj.subtype === 'task_started' || obj.subtype === 'task_progress')) {
            const taskDesc = typeof obj.description === 'string' ? obj.description : '';
            if (obj.subtype === 'task_started') {
              writeStatus('tool', truncateDetail(`🤖 ${taskDesc}`));
            } else {
              const toolName = typeof obj.last_tool_name === 'string' ? obj.last_tool_name : '';
              const toolLabel = TOOL_LABELS[toolName] ?? { emoji: '🔧', verb: toolName };
              writeStatus('tool', truncateDetail(`${toolLabel.emoji} ${taskDesc}`));
            }
          }
          // rate_limit_event
          if (obj.type === 'rate_limit_event') {
            writeStatus('waiting', '⏳ Rate limited, retrying...');
          }
          // text delta (standalone, not from assistant messages)
          if (obj.type === 'text') {
            if (this.queryMode) { this._queryBuffer += obj.text ?? ''; } else { assistantBuffer += obj.text ?? ''; }
          }
          // Capture context size from message_start (first sub-call of each turn)
          if (obj.type === 'stream_event' && obj.event?.type === 'message_start') {
            const msUsage = obj.event.message?.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
            if (msUsage) {
              lastMessageStartContext = (msUsage.input_tokens ?? 0) + (msUsage.cache_read_input_tokens ?? 0) + (msUsage.cache_creation_input_tokens ?? 0);
            }
          }
          // result = end of turn
          if (obj.type === 'result') {
            lastPartialText = ''; // reset for next turn
            writeStatus(obj.is_error ? 'error' : 'done');
            // A clean turn means the in-memory history is healthy again — refill the budget.
            if (!obj.is_error) this.thinkingRecoveryCount = 0;
            // A previous turn's thinking block was corrupted (e.g. interrupted mid-stream),
            // and Claude Code keeps replaying it from in-memory history → every turn 400s.
            // Detect strictly on the failed result's error text (not assistant deltas) so an
            // agent merely discussing the error phrase can never trigger a spurious respawn.
            const corruptedThinking =
              this.source !== 'api' &&
              !this.queryMode &&
              obj.is_error === true &&
              SessionProcess.isThinkingCorruptionError(typeof obj.result === 'string' ? obj.result : '');
            if (this.queryMode) {
              if (this._queryTimer) clearTimeout(this._queryTimer);
              if (!this._querySettled) {
                this._querySettled = true;
                const resolve = this._queryResolve;
                this.queryMode = false;
                this._queryResolve = undefined;
                resolve?.(this._queryBuffer.trim());
              }
              this._queryBuffer = '';
              assistantBuffer = '';
            } else if (corruptedThinking) {
              // Don't persist the 400 API error text as an assistant message — respawn
              // to reload clean text-only history and break the loop.
              assistantBuffer = '';
              lastMessageStartContext = 0;
              this.recoverFromCorruptedThinking();
            } else {
              if (assistantBuffer.trim()) {
                // For non-API sessions (Telegram/Discord), persist here via appendTelegramMessage.
                // For API sessions, runner.ts already persists via appendMessage — skip to avoid double-write.
                // Skip when this exact text was already mirrored as a channel reply
                // in this turn, so a narration text block that duplicates the reply
                // is not stored twice.
                if (this.source !== 'api' && !replyTextsThisTurn.has(assistantBuffer.trim())) {
                  const assistantMsg = { role: 'assistant' as const, content: assistantBuffer.trim(), ts: Date.now() };
                  this.appendToStore(assistantMsg).catch(() => {});
                }
                assistantBuffer = '';
              }
              // Emit tokenUsage using message_start context (accurate per-call context window usage)
              // rather than result.usage which is cumulative across all sub-calls in the turn.
              const usage = obj.usage as { output_tokens?: number } | undefined;
              const outputTokens = usage?.output_tokens ?? 0;
              const totalTokens = lastMessageStartContext + outputTokens;
              if (lastMessageStartContext > 0) {
                this.lastTotalTokens = totalTokens;
                this.emit('tokenUsage', { inputTokens: lastMessageStartContext, outputTokens, totalTokens });
              }
              lastMessageStartContext = 0;
            }
            // Both reply-dedup structures are per-turn and must reset at EVERY turn
            // boundary — including the queryMode and corrupted-thinking result
            // branches above, which previously left them populated. persistedReplyToolIds
            // (an instance field surviving respawn) would otherwise grow without bound,
            // and a reply text left in replyTextsThisTurn could suppress an identical
            // narration in a later turn. The partial→final and narration-vs-reply
            // dedups both only ever span a single turn, so turn-scoped reset is correct.
            this.persistedReplyToolIds.clear();
            replyTextsThisTurn.clear();
          }
        } catch {
          /* not JSON */
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      // Buffer across chunks: split into complete lines and retain any unterminated
      // trailing fragment so a line split on a chunk boundary is not seen as two.
      this.stderrBuffer += text;
      const lines = this.stderrBuffer.split('\n');
      this.stderrBuffer = lines.pop() ?? '';
      const lastLine = lines.map(l => l.trim()).filter(Boolean).pop();
      if (lastLine) this.lastStderrLine = lastLine;
      this.logger.warn('session stderr', { stderr: text });
    });

    proc.on('exit', (code, signal) => {
      // Flush any unterminated trailing stderr fragment (a process that dies
      // mid-line writes no final newline) so it can still surface as lastStderr.
      const trailing = this.stderrBuffer.trim();
      if (trailing) this.lastStderrLine = trailing;
      this.stderrBuffer = '';
      this.logger.info('session subprocess exited', {
        code,
        signal,
        sessionId: this.sessionId,
      });
      if (ptyStreamSocketPath) ptyStreamRegistry.close(ptyStreamSocketPath);
      this.process = null;
      this._exited = true;
      this.resetBackgroundDispatchState();
      // Notify listeners that the underlying subprocess died. The runner relies
      // on this to tear down per-chat typing/processing state when a session is
      // stopped or restarted mid-turn (without a final result/session_idle).
      // Without it the typing indicator stays stuck until the 5-min stalled
      // detector fires. Idempotent on the listener side (writeTypingDone uses
      // rmSync(force)), so emitting on every child exit — including auto-restart
      // — is safe.
      this.emit('exit', code, signal);
      // A child that ran healthily for a sustained period before dying is not
      // part of a crash loop — reset the crash budget so an occasional crash
      // over a long-lived session doesn't slowly accumulate toward MAX_RESTARTS
      // and trip a false permanent `failed` (which would tear down a healthy
      // session and, for an API session, previously wedge it — see #371). A
      // rapid crash loop never survives RESTART_COUNT_RESET_MS, so the
      // MAX_RESTARTS backstop is preserved.
      if (this.lastSpawnAt && Date.now() - this.lastSpawnAt >= RESTART_COUNT_RESET_MS) {
        this.restartCount = 0;
      }
      if (!this.stopping) this.scheduleRestart();
    });

    proc.on('error', (err) => {
      // A missing/unresolvable binary surfaces here as an ENOENT `error` event
      // (e.g. `spawn /path/claude ENOENT`), NOT on stderr — capture it so the
      // fatal max-restarts log can name the real cause and fire the CLAUDE_BIN
      // hint. This is the exact failure the binary-resolution work targets.
      this.lastStderrLine = err.message;
      this.logger.error('session subprocess error', { error: err.message });
    });
  }

  private scheduleRestart(): void {
    // Graceful self-restart requested by agent — reset counter so it doesn't
    // count against MAX_RESTARTS (this is an intentional restart, not a crash).
    if (this.restartRequested) {
      this.restartRequested = false;
      this.restartCount = 0;
    }
    if (this.restartCount >= MAX_RESTARTS) {
      // Match both the CLI's own "binary not found" text and Node's spawn ENOENT
      // (the shape a genuinely unresolvable claude binary produces).
      const binNotFound = /binary not found|ENOENT/i.test(this.lastStderrLine ?? '');
      this.logger.error('Session max restarts reached', {
        sessionId: this.sessionId,
        claudeBin: this.lastClaudeBin,
        lastStderr: this.lastStderrLine ?? null,
        ...(binNotFound
          ? { hint: 'claude executable is not resolvable — set CLAUDE_BIN to the claude path (native install: ~/.local/bin/claude)' }
          : {}),
      });
      this.emit('failed');
      return;
    }
    this.restartCount++;
    // A crash-triggered respawn is now committed (timer armed below). Mark it in
    // flight so waitForSessionRestart knows to wait for the replacement child
    // rather than fail fast. Cleared once the respawn settles (or is skipped).
    this._restartScheduled = true;
    this.logger.warn(`Scheduling session restart in ${AUTO_RESTART_DELAY_MS}ms`, {
      attempt: this.restartCount,
    });
    setTimeout(() => {
      if (!this.stopping) {
        this.spawnProcess()
          // Tell anyone waiting on this SessionProcess (getOrSpawnSession's
          // !isRunning() gap, below) that a new child is attached and
          // sendMessage() will no longer silently no-op. Emitted on every
          // successful crash-triggered respawn — cheap, and nothing currently
          // listens outside that one call site.
          .then(() => {
            this._restartScheduled = false;
            this.emit('restarted');
          })
          .catch(err => {
            this._restartScheduled = false;
            this.logger.error('restart failed', { error: err.message });
            this.emit('restartFailed', err);
          });
      } else {
        // stop() won the race before the timer fired — no respawn will happen.
        // Wake any waiter blocked on this restart (waitForSessionRestart) so it
        // rejects immediately instead of hanging for the full timeout: the
        // restarted/restartFailed/failed event it waits on would otherwise never
        // fire. Clearing the flag first also lets a fresh getOrSpawnSession call
        // take the respawn-fresh path. See #371.
        this._restartScheduled = false;
        this.emit('restartFailed', new Error('Session restart abandoned: session stopping'));
      }
    }, AUTO_RESTART_DELAY_MS);
  }

  /**
   * Detect the Anthropic API 400 raised when a previously-emitted thinking block
   * is sent back altered. Match the full API signature (not loose keywords) so it
   * only fires on the genuine error text, never on prose that mentions thinking blocks.
   * Callers must gate this on a failed result (is_error === true).
   */
  static isThinkingCorruptionError(errorText: string): boolean {
    return errorText.includes('blocks in the latest assistant message cannot be modified');
  }

  /**
   * Recover from a corrupted thinking block by respawning the subprocess.
   * The gateway stores history as plain text, so buildInitialPrompt() reloads a
   * thinking-block-free prompt on respawn — clearing the offending in-memory turn
   * that Claude Code was replaying on every request.
   */
  private recoverFromCorruptedThinking(): void {
    if (this.restartRequested || this.stopping) return; // already respawning
    if (this.thinkingRecoveryCount >= MAX_THINKING_RECOVERIES) {
      this.logger.error('Thinking-block recovery limit reached — not respawning again', {
        sessionId: this.sessionId,
      });
      return;
    }
    this.thinkingRecoveryCount++;
    this.logger.warn('Corrupted thinking block detected (400) — respawning to restore clean history', {
      sessionId: this.sessionId,
      attempt: this.thinkingRecoveryCount,
    });
    // Reuse graceful-restart semantics so the respawn doesn't count as a crash.
    this.restartRequested = true;
    this.setProcessing(false);
    if (this.process) this.process.kill('SIGTERM');
  }

  sendMessage(text: string): void {
    if (!this.process?.stdin?.writable) {
      this.logger.warn('Cannot send message: subprocess not running', {
        sessionId: this.sessionId,
      });
      return;
    }
    // A new turn starting means any prior interrupt() is no longer "the last
    // thing that happened" — don't let it misattribute a future crash.
    this.interruptRequested = false;
    // Signal queued state + ensure typing signal file exists for this turn.
    // If the previous turn already called stop() and cleared the typing loop,
    // re-creating the signal file here lets stop() restart the loop for queued turns.
    if (this.source !== 'api') {
      const typingDir = this.typingDir;
      const typingSignalPath = path.join(typingDir, this.chatId);
      const statusPath = path.join(typingDir, `${this.chatId}.status`);
      try {
        fs.mkdirSync(typingDir, { recursive: true });
        fs.writeFileSync(typingSignalPath, String(Date.now()));
        fs.writeFileSync(statusPath, 'queued');
      } catch {}
    }
    // Prepend pending API history context if present.
    const fullText = this.pendingInitialPrompt
      ? `${this.pendingInitialPrompt}\n\n${text}`
      : text;
    this.pendingInitialPrompt = undefined;
    this.process.stdin.write(SessionProcess.toStreamJsonTurn(fullText) + '\n');
  }

  /**
   * Send a control keystroke to the PTY wrapper (Epic #195, Phase 3b). Only
   * meaningful on the interactive (pty-shell) backend — the headless backend has
   * no TUI to press keys into, so this is a no-op there. `key` and `option` are
   * validated again by the wrapper against its closed control vocabulary; a bad
   * value is rejected there rather than reaching the PTY.
   */
  sendControl(key: string, option?: number): void {
    if (this.backend !== 'pty-shell') {
      this.logger.debug('Ignoring control keystroke on headless backend', {
        sessionId: this.sessionId,
        key,
      });
      return;
    }
    if (!this.process?.stdin?.writable) {
      this.logger.warn('Cannot send control: subprocess not running', {
        sessionId: this.sessionId,
      });
      return;
    }
    const msg: Record<string, unknown> = { type: 'control', key };
    if (typeof option === 'number') msg['option'] = option;
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  /**
   * Send raw interactive-terminal input to the PTY wrapper (Issue #201). Used by
   * the dashboard's Terminal Viewer input mode to type any key into the
   * live TUI. Only meaningful on the interactive (pty-shell) backend — the
   * headless backend has no TUI, so this is a no-op there. The wrapper bounds
   * the size again before writing to the PTY. Returns true when the bytes were
   * handed to the subprocess stdin.
   */
  sendInput(data: string): boolean {
    if (this.backend !== 'pty-shell') {
      this.logger.debug('Ignoring interactive input on headless backend', {
        sessionId: this.sessionId,
      });
      return false;
    }
    if (typeof data !== 'string' || data.length === 0) return false;
    if (!this.process?.stdin?.writable) {
      this.logger.warn('Cannot send input: subprocess not running', {
        sessionId: this.sessionId,
      });
      return false;
    }
    this.process.stdin.write(JSON.stringify({ type: 'input', data }) + '\n');
    return true;
  }

  query(prompt: string, timeoutMs = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('Cannot query: subprocess not running'));
        return;
      }
      this._querySettled = false;
      this._queryResolve = resolve;
      this._queryBuffer = '';
      this.queryMode = true;
      this._queryTimer = setTimeout(() => {
        if (this._querySettled) return;
        this._querySettled = true;
        this.queryMode = false;
        this._queryResolve = undefined;
        reject(new Error('query timeout'));
      }, timeoutMs);
      this.sendMessage(prompt);
    });
  }

  get isProcessing(): boolean { return this._processing; }

  private clearBackgroundWaitTimer(): void {
    if (this.backgroundWaitTimer !== null) {
      clearTimeout(this.backgroundWaitTimer);
      this.backgroundWaitTimer = null;
    }
  }

  // The single predicate for "is the currently tracked background dispatch
  // still within its own grace window" — shared by hasLikelyOutstandingBackgroundWork()
  // (the read path restartOrDefer/startIdleCleaner/retainBackgroundWorkingState
  // all trust) and the dispatch-overwrite decision below, so the two can never
  // silently disagree (manual review round).
  private isTrackedDispatchStillOutstanding(): boolean {
    return (
      this.lastBackgroundAgentDispatchAt !== null &&
      Date.now() - this.lastBackgroundAgentDispatchAt < this.backgroundGraceMs
    );
  }

  // Clears the three fields that together describe "is there a background
  // dispatch we should still treat as outstanding" back to their defaults, and
  // the timer armed against them. Centralised (rather than repeated at each
  // lifecycle site) so a future field added to this trio can't be forgotten at
  // one of them (manual review round — this is exactly the kind of scattered
  // reset that let an earlier version of this file's stale-timer bug slip
  // through unnoticed).
  private resetBackgroundDispatchState(): void {
    this.lastBackgroundAgentDispatchAt = null;
    this.backgroundGraceMs = BACKGROUND_AGENT_GRACE_MS;
    this.backgroundDispatchIsMonitor = false;
    this.clearBackgroundWaitTimer();
  }

  /**
   * Extend Telegram's working state only while a parent session is waiting for
   * background Agent/Workflow/Monitor work. A bounded expiry (BACKGROUND_AGENT_GRACE_MS,
   * fixed from the dispatch timestamp — not renewed by later activity) releases
   * the state if the dispatch never sends its completion notification within
   * that window. A Monitor started with a longer `timeout_ms` or `persistent:
   * true` can legitimately outlive this window; see the note above
   * BACKGROUND_AGENT_GRACE_MS.
   */
  retainBackgroundWorkingState(): boolean {
    if (this.source !== 'telegram' || !this.hasLikelyOutstandingBackgroundWork()) return false;

    const processingPath = path.join(this.typingDir, `${this.chatId}.processing`);
    try {
      fs.mkdirSync(this.typingDir, { recursive: true });
      fs.writeFileSync(processingPath, String(Date.now()));
    } catch (err) {
      this.logger.warn('Failed to retain .processing sentinel for background work', {
        chatId: this.chatId,
        error: (err as Error).message,
      });
    }

    if (this.backgroundWaitTimer === null) {
      const elapsed = Date.now() - this.lastBackgroundAgentDispatchAt!;
      const remaining = Math.max(0, this.backgroundGraceMs - elapsed);
      this.backgroundWaitTimer = setTimeout(() => {
        this.backgroundWaitTimer = null;
        this.resetBackgroundDispatchState();
        if (!this._processing) {
          try { fs.rmSync(processingPath, { force: true }); } catch {}
          this.emit('backgroundWorkExpired');
        }
      }, remaining);
      this.backgroundWaitTimer.unref();
    }
    return true;
  }

  setProcessing(active: boolean): void {
    if (this._processing !== active) {
      this._processing = active;
      if (active) {
        // A fresh turn is starting. For an Agent/Workflow-only dispatch: either
        // the notification it was waiting on just woke this turn, or unrelated
        // new work superseded it (moot either way) — isProcessing now covers
        // this session correctly on its own, so clear it.
        // A Monitor dispatch is different: it represents an independent
        // background watcher that keeps running alongside ordinary
        // conversation, not a one-shot "waiting for this exact notification"
        // — an unrelated new turn starting is NOT evidence it resolved, so its
        // grace window must survive this turn and keep expiring on its own
        // schedule (#415 review; without this, an unrelated chat message
        // arriving during a persistent Monitor's run silently strips its
        // SIGKILL/eviction protection early).
        if (!this.backgroundDispatchIsMonitor) {
          this.resetBackgroundDispatchState();
        }
      }
      this.emit('processingChange', active);
      if (this.source === 'telegram') {
        const processingPath = path.join(this.typingDir, `${this.chatId}.processing`);
        try {
          if (active) {
            fs.mkdirSync(this.typingDir, { recursive: true });
            fs.writeFileSync(processingPath, String(Date.now()));
          } else {
            fs.rmSync(processingPath, { force: true });
          }
        } catch (err) {
          this.logger.warn('Failed to write/delete .processing sentinel', { chatId: this.chatId, error: (err as Error).message });
        }
      }
      if (!active && this._pendingRestart) {
        this.emit('deferredRestartReady');
      }
    }
  }

  interrupt(): boolean {
    // .killed is NOT liveness — it flips true on the FIRST SIGINT and stays
    // true, so a prior /stop would make every later interrupt() no-op even on a
    // live, actively-processing turn. Gate on _exited (child actually gone).
    if (!this.process || this._exited) return false;
    if (!this._processing) return false;
    this.interruptRequested = true;
    this.process.kill('SIGINT');
    return true;
  }

  /**
   * Reads and clears the interrupt() flag. True means the process exit a
   * caller is currently handling followed a /stop SIGINT rather than an
   * unrelated crash — e.g. so the exit can resolve the turn the same way a
   * gracefully-flushed interrupted `result` line would, instead of surfacing
   * a "process exited unexpectedly" error for something the user asked for.
   */
  consumeInterruptFlag(): boolean {
    const requested = this.interruptRequested;
    this.interruptRequested = false;
    return requested;
  }

  markPendingRestart(): void {
    if (!this._processing) {
      this.emit('deferredRestartReady');
    } else {
      this._pendingRestart = true;
    }
  }

  /**
   * True once a deferred restart has been armed (the session was busy when the
   * restart was requested, so teardown waits for the current turn to end). The
   * runner reads this to avoid flushing a queued turn into a session that is
   * about to be torn down — the queue is re-driven into the fresh session after
   * the restart instead (see the deferredRestartReady handler in runner.ts).
   */
  hasPendingRestart(): boolean {
    return this._pendingRestart;
  }

  /**
   * True while a crash-triggered auto-restart is in flight — armed by
   * scheduleRestart() on child death and cleared once the replacement child
   * attaches ('restarted'), the respawn fails ('restartFailed'), or the restart
   * is abandoned because stop() raced in. Distinct from hasPendingRestart(),
   * which tracks a *deferred* (graceful, turn-boundary) restart. The runner
   * reads this to tell "a restart is coming, wait for it" apart from "dead with
   * nothing coming, respawn a fresh session" — the latter would otherwise block
   * on waitForSessionRestart's full timeout and wedge the caller. See #371.
   */
  isRestartScheduled(): boolean {
    return this._restartScheduled;
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  isIdle(idleMs: number): boolean {
    return Date.now() - this.lastActivityAt > idleMs;
  }

  /**
   * True when this session's own turn has ended (not `isProcessing`) but it
   * recently dispatched a BACKGROUND_DISPATCH_TOOLS tool_use — i.e. it looks
   * idle from the outside while that dispatch may still be doing real work.
   * `restartOrDefer` treats this the same as `isProcessing` so a
   * config-driven restart never SIGKILLs a session mid-dispatch, regardless of
   * which restart tier triggered it. The grace window itself is per-dispatch —
   * see computeBackgroundGraceMs().
   */
  hasLikelyOutstandingBackgroundWork(): boolean {
    if (this._processing) return false;
    return this.isTrackedDispatchStillOutstanding();
  }

  isRunning(): boolean {
    // Use _exited (child's 'exit' observed), NOT .killed — .killed is true after
    // any signal send, including a /stop SIGINT the pty-shell survives, which
    // would falsely report a healthy interrupted session as not-running.
    return this.process !== null && !this._exited;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.resetBackgroundDispatchState();
    await this.restartWatcher?.close();
    this.restartWatcher = null;
    try { fs.rmSync(this.restartSignalPath, { force: true }); } catch {}
    if (this.source === 'telegram') {
      try { fs.rmSync(path.join(this.typingDir, `${this.chatId}.processing`), { force: true }); } catch {}
    }
    // mcp-config.json under here holds fully-substituted secrets (channel bot
    // tokens, GATEWAY_API_KEY, connector OAuth tokens) — it must not outlive
    // the session that needed it (issue #460). Recreated automatically on the
    // next spawn, so removing it here is safe across restarts. Deferred until
    // the process has actually exited below (not removed up front here) — the
    // subprocess (or, for a container agent, the still-running container that
    // bind-mounts this path) can be alive for up to the 10s graceful-shutdown
    // window immediately after this point, and must not find it gone under it.
    const removeSessionDir = (): void => {
      try {
        fs.rmSync(path.join(this.agentConfig.workspace, '.sessions', this.sessionId), { recursive: true, force: true });
      } catch {}
    };
    if (!this.process) {
      removeSessionDir();
      return;
    }

    return new Promise((resolve) => {
      const proc = this.process!;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      proc.once('exit', () => {
        if (forceKillTimer !== null) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        this.process = null;
        removeSessionDir();
        resolve();
      });
      proc.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        forceKillTimer = null;
        if (this.process) proc.kill('SIGKILL');
      }, 10_000);
    });
  }
}
