import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chokidar from 'chokidar';
import { AgentConfig, GatewayConfig } from '../types';
import { SessionStore } from './store';
import { createLogger } from '../logger';

const MAX_HISTORY_MESSAGES = 50;
const AUTO_RESTART_DELAY_MS = 5_000;
const MAX_RESTARTS = 3;
const CHANNELS_ACTIVATION_PROMPT =
  'Channels mode is active. Wait for incoming messages from your channels and respond to them.';

export class SessionProcess extends EventEmitter {
  readonly sessionId: string;
  readonly chatId: string;
  readonly source: 'telegram' | 'api';
  lastActivityAt = Date.now(); // accessible by AgentRunner for eviction sort
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

  constructor(
    sessionId: string,
    source: 'telegram' | 'api',
    agentConfig: AgentConfig,
    gatewayConfig: GatewayConfig,
    sessionStore: SessionStore,
    chatId?: string,  // for telegram: actual chatId; for api: same as sessionId
  ) {
    super();
    this.sessionId = sessionId;
    this.source = source;
    this.chatId = chatId ?? sessionId;
    this.agentConfig = agentConfig;
    this.gatewayConfig = gatewayConfig;
    this.sessionStore = sessionStore;
    this.logger = createLogger(
      `${agentConfig.id}:session:${sessionId}`,
      gatewayConfig.gateway.logDir,
    );
    // config.json lives 3 levels above workspace: <base>/<agentId>/workspace → <base>/config.json
    this.configPath = path.resolve(agentConfig.workspace, '..', '..', '..', 'config.json');
    this.restartSignalPath = path.join(agentConfig.workspace, '.telegram-state', `restart-${sessionId}`);
  }

  /**
   * Read model from config.json on disk so restarts pick up changes made after startup.
   * Falls back to the cached agentConfig.claude.model if config can't be read.
   */
  private readFreshModel(): string {
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
      const appendRestartMarker = this.source === 'telegram'
        ? this.sessionStore.appendTelegramMessage(this.agentConfig.id, this.chatId, this.sessionId, restartMsg)
        : this.sessionStore.appendMessage(this.agentConfig.id, this.sessionId, restartMsg);
      appendRestartMarker.catch(err => this.logger.warn('Failed to write restart marker', { error: err.message }));
      if (this.process) {
        this.process.kill('SIGTERM');
      }
    });
  }

  private async buildInitialPrompt(): Promise<{ prompt: string; loadedAtSpawn: number; archivedCount: number; messageCountAtSpawn: number }> {
    const history = this.source === 'telegram'
      ? await this.sessionStore.loadTelegramSession(this.agentConfig.id, this.chatId, this.sessionId)
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
      return { prompt: CHANNELS_ACTIVATION_PROMPT, loadedAtSpawn, archivedCount, messageCountAtSpawn };
    }

    const historyText = recent
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    return {
      prompt: `[Conversation history with this user:\n${historyText}]\n\n${CHANNELS_ACTIVATION_PROMPT}`,
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
    if (this.source === 'api') return null; // API sessions don't need gateway MCP

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
            TELEGRAM_BOT_TOKEN: this.agentConfig.telegram.botToken,
            TELEGRAM_STATE_DIR: stateDir,
            TELEGRAM_SEND_ONLY: 'true', // ALWAYS — session subprocesses never poll
            DISCORD_BOT_TOKEN: this.agentConfig.discord?.botToken ?? '',
            DISCORD_STATE_DIR: path.join(this.agentConfig.workspace, '.discord-state'),
            DISCORD_GUILD_ALLOWLIST: (this.agentConfig.discord?.guildAllowlist ?? []).join(','),
            DISCORD_CHANNEL_ALLOWLIST: (this.agentConfig.discord?.channelAllowlist ?? []).join(','),
            DISCORD_DM_POLICY: this.agentConfig.discord?.dmPolicy ?? 'disabled',
            DISCORD_DM_ALLOWLIST: (this.agentConfig.discord?.dmAllowlist ?? []).join(','),
            GATEWAY_AGENT_ID: this.agentConfig.id,
            GATEWAY_API_URL: process.env.GATEWAY_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`,
            GATEWAY_API_KEY: this.findApiKeyForAgent(this.agentConfig.id),
            GATEWAY_ORIGIN_CHANNEL: 'telegram',
            GATEWAY_WORKSPACE_DIR: this.agentConfig.workspace,
            GATEWAY_SHARED_SKILLS_DIR: path.join(os.homedir(), '.claude-gateway', 'shared-skills'),
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
    const match = keys.find(k => k.agents === '*' || (Array.isArray(k.agents) && k.agents.includes(agentId)));
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

    if (this.agentConfig.claude.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
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
    const { prompt: initialPrompt, loadedAtSpawn, archivedCount, messageCountAtSpawn } = await this.buildInitialPrompt();
    this.spawnContext = { loadedAtSpawn, archivedCount, messageCountAtSpawn };
    const mcpConfigPath = this.writeMcpConfig();
    const freshModel = this.readFreshModel();
    const args = this.buildArgs(mcpConfigPath, freshModel);

    const claudeBinRaw = process.env.CLAUDE_BIN ?? 'claude';
    const claudeBinParts = claudeBinRaw.split(' ');
    const claudeBin = claudeBinParts[0];
    const allArgs = [...claudeBinParts.slice(1), ...args];

    this.logger.info('Spawning session subprocess', {
      sessionId: this.sessionId,
      source: this.source,
    });

    const proc = spawn(claudeBin, allArgs, {
      env: {
        ...process.env,
        CLAUDE_WORKSPACE: this.agentConfig.workspace,
        TELEGRAM_BOT_TOKEN: this.agentConfig.telegram.botToken,
        GATEWAY_RESTART_SIGNAL_PATH: this.restartSignalPath,
      },
      cwd: this.agentConfig.workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process = proc;

    // Send initial prompt only for Telegram sessions.
    // API sessions receive the first message directly via sendApiMessage(),
    // so no activation prompt is needed and sending one would race with
    // the first API turn, causing sendApiMessage to resolve with the wrong result.
    if (this.source === 'telegram') {
      proc.stdin?.write(SessionProcess.toStreamJsonTurn(initialPrompt) + '\n');
    }

    // Capture stdout — emit output events + persist assistant replies
    const typingDir = path.join(this.agentConfig.workspace, '.telegram-state', 'typing');
    const heartbeatPath = this.source === 'telegram'
      ? path.join(typingDir, `${this.chatId}.heartbeat`)
      : null;
    const statusPath = this.source === 'telegram'
      ? path.join(typingDir, `${this.chatId}.status`)
      : null;

    const writeStatus = (status: string, detail?: string): void => {
      if (statusPath) {
        const payload = detail
          ? JSON.stringify({ status, detail })
          : status;
        try { fs.writeFileSync(statusPath, payload) } catch {}
      }
    };

    const CODING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

    const TOOL_LABELS: Record<string, { emoji: string; verb: string }> = {
      Read:         { emoji: '📖', verb: 'Reading' },
      Edit:         { emoji: '✏️', verb: 'Editing' },
      Write:        { emoji: '📝', verb: 'Writing' },
      MultiEdit:    { emoji: '❤️‍🔥', verb: 'Editing' },
      NotebookEdit: { emoji: '📕', verb: 'Editing notebook' },
      Grep:         { emoji: '🔦', verb: 'Searching for' },
      Glob:         { emoji: '📂', verb: 'Finding files' },
      Bash:         { emoji: '💻', verb: 'Running' },
      WebFetch:     { emoji: '🌐', verb: 'Fetching' },
      WebSearch:    { emoji: '🔎', verb: 'Searching' },
      Agent:        { emoji: '🤖', verb: 'Running agent' },
      Task:         { emoji: '👉', verb: 'Running task' },
      TodoWrite:    { emoji: '📋', verb: 'Updating tasks' },
    };

    function shortenPath(p: string): string {
      // Keep last 2 segments for context (e.g. "src/api-router.ts" not just "api-router.ts")
      const parts = p.split('/');
      return parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || p;
    }

    function truncateDetail(s: string, maxLines = 5, maxChars = 300): string {
      const lines = s.split('\n').filter(l => l.trim());
      const trimmedByLines = lines.length > maxLines;
      const kept = lines.slice(0, maxLines);
      let result = kept.join('\n');
      if (result.length > maxChars) {
        result = result.slice(0, maxChars) + '...';
      } else if (trimmedByLines) {
        result += '\n...';
      }
      return result;
    }

    function extractToolDetail(name: string, input: Record<string, unknown>): string {
      const label = TOOL_LABELS[name] ?? { emoji: '🔧', verb: name };
      const { emoji, verb } = label;

      // Build context parts based on tool type
      switch (name) {
        case 'Read':
        case 'Edit':
        case 'Write':
        case 'MultiEdit':
        case 'NotebookEdit': {
          const file = typeof input.file_path === 'string' ? shortenPath(input.file_path) : '';
          const desc = typeof input.description === 'string' ? ` — ${input.description}` : '';
          return truncateDetail(`${emoji} ${verb}: ${file}${desc}`);
        }
        case 'Grep': {
          const pattern = typeof input.pattern === 'string' ? `"${input.pattern}"` : '';
          const path = typeof input.path === 'string' ? ` in ${shortenPath(input.path)}` : '';
          return truncateDetail(`${emoji} ${verb}: ${pattern}${path}`);
        }
        case 'Glob': {
          const pattern = typeof input.pattern === 'string' ? `"${input.pattern}"` : '';
          return truncateDetail(`${emoji} ${verb}: ${pattern}`);
        }
        case 'Bash': {
          const desc = typeof input.description === 'string' ? input.description : '';
          const cmd = typeof input.command === 'string' ? input.command : '';
          return truncateDetail(`${emoji} ${verb}: ${desc || cmd}`);
        }
        case 'WebFetch': {
          const url = typeof input.url === 'string' ? input.url : '';
          return truncateDetail(`${emoji} ${verb}: ${url}`);
        }
        case 'WebSearch': {
          const query = typeof input.query === 'string' ? input.query : '';
          return truncateDetail(`${emoji} ${verb}: "${query}"`);
        }
        case 'Agent':
        case 'Task': {
          const desc = typeof input.description === 'string' ? input.description : '';
          const prompt = typeof input.prompt === 'string' ? input.prompt : '';
          return truncateDetail(`${emoji} ${verb}: ${desc || prompt}`);
        }
        case 'TodoWrite': {
          const todos = Array.isArray(input.todos) ? input.todos as { content?: string; status?: string }[] : [];
          const active = todos.find(t => t.status === 'in_progress');
          const detail = active?.content ?? `${todos.length} items`;
          return truncateDetail(`${emoji} ${verb}: ${detail}`);
        }
        default: {
          // Generic fallback: try description, then name
          const desc = typeof input.description === 'string' ? input.description : '';
          return truncateDetail(`${emoji} ${verb}: ${desc || '...'}`);
        }
      }
    }

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
              // Partial message: update assistantBuffer with only the delta
              // (fullText is cumulative, so delta = new portion)
              if (fullText.length > lastPartialText.length) {
                assistantBuffer += fullText.slice(lastPartialText.length);
              }
              lastPartialText = fullText;
            } else {
              // Final message: use full text, reset partial tracking
              if (fullText.length > lastPartialText.length) {
                assistantBuffer += fullText.slice(lastPartialText.length);
              }
              lastPartialText = '';
            }

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
          if (obj.type === 'text') assistantBuffer += obj.text ?? '';
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
            if (assistantBuffer.trim()) {
              const assistantMsg = { role: 'assistant' as const, content: assistantBuffer.trim(), ts: Date.now() };
              const appendAssistant = this.source === 'telegram'
                ? this.sessionStore.appendTelegramMessage(this.agentConfig.id, this.chatId, this.sessionId, assistantMsg)
                : this.sessionStore.appendMessage(this.agentConfig.id, this.sessionId, assistantMsg);
              appendAssistant.catch(() => {});
              assistantBuffer = '';
            }
            // Emit tokenUsage using message_start context (accurate per-call context window usage)
            // rather than result.usage which is cumulative across all sub-calls in the turn.
            const usage = obj.usage as { output_tokens?: number } | undefined;
            const outputTokens = usage?.output_tokens ?? 0;
            const totalTokens = lastMessageStartContext + outputTokens;
            if (lastMessageStartContext > 0) {
              this.emit('tokenUsage', { inputTokens: lastMessageStartContext, outputTokens, totalTokens });
            }
            lastMessageStartContext = 0;
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
      this.process = null;
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

  sendMessage(text: string): void {
    if (!this.process?.stdin?.writable) {
      this.logger.warn('Cannot send message: subprocess not running', {
        sessionId: this.sessionId,
      });
      return;
    }
    // Signal queued state so the typing loop can update the reaction immediately
    if (this.source === 'telegram') {
      const statusPath = path.join(
        this.agentConfig.workspace,
        '.telegram-state',
        'typing',
        `${this.sessionId}.status`,
      );
      try { fs.writeFileSync(statusPath, 'queued') } catch {}
    }
    this.process.stdin.write(SessionProcess.toStreamJsonTurn(text) + '\n');
  }

  get isProcessing(): boolean { return this._processing; }

  setProcessing(active: boolean): void {
    if (this._processing !== active) {
      this._processing = active;
      this.emit('processingChange', active);
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
    if (!this.process) return;

    return new Promise((resolve) => {
      const proc = this.process!;
      proc.once('exit', () => {
        this.process = null;
        resolve();
      });
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (this.process) proc.kill('SIGKILL');
      }, 10_000);
    });
  }
}
