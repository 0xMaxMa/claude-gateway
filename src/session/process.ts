import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chokidar from 'chokidar';
import { AgentConfig, GatewayConfig } from '../types';
import { SessionStore } from './store';
import { createLogger } from '../logger';
import { ptyStreamRegistry } from '../shell/pty-stream-registry';
import { neutralizeTuiTriggers } from '../shell/screen';
import {
  CODING_TOOLS,
  TOOL_LABELS,
  extractToolDetail,
  truncateDetail,
} from '../utils/tool-labels';

const MAX_HISTORY_MESSAGES = 50;
const AUTO_RESTART_DELAY_MS = 5_000;
const MAX_RESTARTS = 3;
// Bound how many times a single session may auto-respawn to recover from a
// corrupted thinking block, so a recovery that never helps can't loop forever.
const MAX_THINKING_RECOVERIES = 2;
const CHANNELS_ACTIVATION_PROMPT =
  'Channels mode is active. Wait for incoming messages from your channels and respond to them.';

export class SessionProcess extends EventEmitter {
  readonly sessionId: string;
  readonly chatId: string;
  readonly source: 'telegram' | 'discord' | 'api';
  private readonly sessionChannel: 'telegram' | 'discord';
  lastActivityAt = Date.now(); // accessible by AgentRunner for eviction sort
  readonly spawnedAt = Date.now();
  /** Backend used to run the subprocess. Set during start(); 'headless' until then. */
  backend: 'pty-shell' | 'headless' = 'headless';
  modelOverride?: string; // per-session model override (set by runner from SessionMeta)
  spawnContext: { loadedAtSpawn: number; archivedCount: number; messageCountAtSpawn: number } | null = null;
  private process: ChildProcess | null = null;
  private stopping = false;
  private restartCount = 0;
  private restartRequested = false;
  private _processing = false;
  private _pendingRestart = false;
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
  private thinkingRecoveryCount = 0;
  private _queryResolve?: (text: string) => void;
  private _queryBuffer = '';
  private _queryTimer?: ReturnType<typeof setTimeout>;
  private _querySettled = false;
  // For API sessions: history context to prepend to the first sendMessage() after a model-switch respawn
  private pendingInitialPrompt?: string;

  constructor(
    sessionId: string,
    source: 'telegram' | 'discord' | 'api',
    agentConfig: AgentConfig,
    gatewayConfig: GatewayConfig,
    sessionStore: SessionStore,
    chatId?: string,  // for telegram/discord: actual chatId; for api: same as sessionId
  ) {
    super();
    this.sessionId = sessionId;
    this.source = source;
    this.chatId = chatId ?? sessionId;
    this.sessionChannel = source === 'discord' ? 'discord' : 'telegram';
    this.agentConfig = agentConfig;
    this.gatewayConfig = gatewayConfig;
    this.sessionStore = sessionStore;
    this.logger = createLogger(
      `${agentConfig.id}:session:${sessionId}`,
      gatewayConfig.gateway.logDir,
    );
    // config.json lives 3 levels above workspace: <base>/<agentId>/workspace → <base>/config.json
    this.configPath = path.resolve(agentConfig.workspace, '..', '..', '..', 'config.json');
    const stateSubDir = source === 'discord' ? '.discord-state' : '.telegram-state';
    this.restartSignalPath = path.join(agentConfig.workspace, stateSubDir, `restart-${sessionId}`);
  }

  /**
   * Resolve the model for this session.
   * Priority: per-session override > config.json on disk > cached agentConfig.
   */
  private get typingDir(): string {
    const sub = this.source === 'discord' ? '.discord-state' : '.telegram-state';
    return path.join(this.agentConfig.workspace, sub, 'typing');
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
    const hasSummary =
      history.length > MAX_HISTORY_MESSAGES &&
      firstMsg?.role === 'system' &&
      typeof firstMsg.content === 'string' &&
      firstMsg.content.trimStart().startsWith(SUMMARY_MARKER);

    const recent = hasSummary
      ? [firstMsg, ...history.slice(-(MAX_HISTORY_MESSAGES - 1))]
      : history.slice(-MAX_HISTORY_MESSAGES);

    const loadedAtSpawn = recent.length;
    const archivedCount = history.length - recent.length;
    const messageCountAtSpawn = history.length;

    if (recent.length === 0) {
      return { historyPrompt: null, loadedAtSpawn, archivedCount, messageCountAtSpawn };
    }

    // If the last message is a dangling user turn (session was interrupted before Claude responded),
    // inject a synthetic assistant acknowledgement so the conversation structure stays valid.
    if (recent[recent.length - 1]?.role === 'user') {
      recent.push({ role: 'assistant', content: '[Session was interrupted before I could respond.]', ts: Date.now() });
    }

    const historyText = recent
      .map(m => {
        // system role carries injected summaries (e.g. [Image Context Summary]) from the runner
        if (m.role === 'system') return `System: ${m.content}`;
        return `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`;
      })
      .join('\n');

    return {
      // Defang any verbatim 32MB-overlay text captured into past messages before it
      // is re-typed into the TUI — otherwise the PTY screen-scraper (see
      // detectRequestTooLarge) re-detects it every spawn and the session restart-loops
      // even on a bare greeting. Headless backend is unaffected, but neutralizing at
      // the source keeps both backends safe.
      historyPrompt: `[Conversation history with this user:\n${neutralizeTuiTriggers(historyText)}]`,
      loadedAtSpawn,
      archivedCount,
      messageCountAtSpawn,
    };
  }

  /**
   * Read stdio MCP servers from Claude Code's user-scoped config (~/.claude/settings.json).
   * Returns empty object if file doesn't exist, can't be parsed, or has no mcpServers.
   */
  private readUserScopedMcp(): Record<string, unknown> {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return (parsed?.mcpServers as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
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

  private writeMcpConfig(): string | null {
    if (this.source === 'api' && !this.agentConfig.allow_tools) return null;

    const stateDir = path.join(this.agentConfig.workspace, '.telegram-state');
    const sessionDir = path.join(this.agentConfig.workspace, '.sessions', this.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

    const mcpServerPath = path.resolve(__dirname, '..', '..', 'mcp', 'server.ts');

    // Merge stdio servers from Claude Code user + project configs (project overrides user).
    // Skip "telegram" and "gateway" from both — gateway always generates its own config below.
    const userServers = this.readUserScopedMcp();
    const projectServers = this.readProjectScopedMcp();
    const extraServers: Record<string, unknown> = {};
    for (const [name, server] of Object.entries({ ...userServers, ...projectServers })) {
      if (name !== 'telegram' && name !== 'gateway') extraServers[name] = server;
    }

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
            GATEWAY_AGENT_ID: this.agentConfig.id,
            // Must be the base URL without /api suffix (e.g. http://127.0.0.1:10850).
            // MCP tools append /api/v1/... themselves — a trailing /api here causes double-prefix 404s.
            GATEWAY_API_URL: process.env.GATEWAY_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '10850'}`,
            GATEWAY_API_KEY: this.findApiKeyForAgent(this.agentConfig.id),
            GATEWAY_ORIGIN_CHANNEL: this.source,
            GATEWAY_WORKSPACE_DIR: this.agentConfig.workspace,
            GATEWAY_SHARED_SKILLS_DIR: path.join(os.homedir(), '.claude-gateway', 'shared-skills'),
            GATEWAY_SESSION_ID: this.sessionId,
            // For API sessions: absolute path to session media dir so browser screenshots land there
            GATEWAY_SESSION_MEDIA_DIR: this.source === 'api'
              ? path.resolve(this.agentConfig.workspace, '..', 'media', `api-${this.sessionId}`)
              : '',
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

    const claudeBinRaw = process.env.CLAUDE_BIN ?? 'claude';
    const claudeBinParts = claudeBinRaw.split(' ');
    let claudeBin = claudeBinParts[0];
    let allArgs = [...claudeBinParts.slice(1), ...args];

    // gateway.headless: false → run the interactive claude TUI under the
    // claude-pty-shell PTY wrapper (same stream-json protocol on stdio).
    // App-agents always stay headless: the wrapper (node-pty) lives on the
    // host and cannot wrap a binary inside a docker-exec container.
    const usePtyShell = this.gatewayConfig.gateway.headless === false && !isAppAgent;
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

    // env vars that must be forwarded into the container via `docker exec -e`
    let containerUid = 1000;
    try { containerUid = os.userInfo().uid; } catch { /* use 1000 */ }

    const containerEnv: Record<string, string> = {
      HOME: os.homedir(),
      CLAUDE_WORKSPACE: '/workspace',
      TELEGRAM_BOT_TOKEN: this.agentConfig.telegram?.botToken ?? '',
      GATEWAY_RESTART_SIGNAL_PATH: containerRestartPath,
    };
    if (process.env.GATEWAY_API_URL) containerEnv.GATEWAY_API_URL = process.env.GATEWAY_API_URL;
    const dockerEnvFlags = Object.entries(containerEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

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

    const proc = spawn(spawnBin, spawnArgs, {
      env: {
        ...process.env,
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

    // Send initial prompt only for Telegram/Discord sessions.
    // API sessions receive the first message directly via sendApiMessage(),
    // so we cannot send an activation prompt here — it would race with the
    // first API turn and cause sendApiMessage to resolve with the wrong result.
    // Instead, if there is conversation history to restore (model-switch respawn),
    // stash it in pendingInitialPrompt so sendMessage() prepends it to the first turn.
    if (this.source !== 'api') {
      const initialPrompt = historyPrompt
        ? `${historyPrompt}\n\n${CHANNELS_ACTIVATION_PROMPT}`
        : CHANNELS_ACTIVATION_PROMPT;
      proc.stdin?.write(SessionProcess.toStreamJsonTurn(initialPrompt) + '\n');
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
    // Track partial message text to avoid double-counting when --include-partial-messages is active.
    // Each partial `type: 'assistant'` event contains the FULL text so far, not a delta.
    let lastPartialText = '';
    // Track context from message_start events (first sub-call of each turn) for accurate context % display.
    // result.usage is cumulative across all sub-calls; message_start.usage reflects a single API call's context.
    let lastMessageStartContext = 0;

    proc.stdout?.on('data', (data: Buffer) => {
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
                if (this.source !== 'api') {
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
          }
        } catch {
          /* not JSON */
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      this.logger.warn('session stderr', { stderr: data.toString() });
    });

    proc.on('exit', (code, signal) => {
      this.logger.info('session subprocess exited', {
        code,
        signal,
        sessionId: this.sessionId,
      });
      if (ptyStreamSocketPath) ptyStreamRegistry.close(ptyStreamSocketPath);
      this.process = null;
      // Notify listeners that the underlying subprocess died. The runner relies
      // on this to tear down per-chat typing/processing state when a session is
      // stopped or restarted mid-turn (without a final result/session_idle).
      // Without it the typing indicator stays stuck until the 5-min stalled
      // detector fires. Idempotent on the listener side (writeTypingDone uses
      // rmSync(force)), so emitting on every child exit — including auto-restart
      // — is safe.
      this.emit('exit', code, signal);
      if (!this.stopping) this.scheduleRestart();
    });

    proc.on('error', (err) => {
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
      this.logger.error('Session max restarts reached', { sessionId: this.sessionId });
      this.emit('failed');
      return;
    }
    this.restartCount++;
    this.logger.warn(`Scheduling session restart in ${AUTO_RESTART_DELAY_MS}ms`, {
      attempt: this.restartCount,
    });
    setTimeout(() => {
      if (!this.stopping) {
        this.spawnProcess().catch(err =>
          this.logger.error('restart failed', { error: err.message }),
        );
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

  setProcessing(active: boolean): void {
    if (this._processing !== active) {
      this._processing = active;
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
    if (!this.process || this.process.killed) return false;
    if (!this._processing) return false;
    this.process.kill('SIGINT');
    return true;
  }

  markPendingRestart(): void {
    if (!this._processing) {
      this.emit('deferredRestartReady');
    } else {
      this._pendingRestart = true;
    }
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  isIdle(idleMs: number): boolean {
    return Date.now() - this.lastActivityAt > idleMs;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.restartWatcher?.close();
    this.restartWatcher = null;
    try { fs.rmSync(this.restartSignalPath, { force: true }); } catch {}
    if (this.source === 'telegram') {
      try { fs.rmSync(path.join(this.typingDir, `${this.chatId}.processing`), { force: true }); } catch {}
    }
    if (!this.process) return;

    return new Promise((resolve) => {
      const proc = this.process!;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      proc.once('exit', () => {
        if (forceKillTimer !== null) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        this.process = null;
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
