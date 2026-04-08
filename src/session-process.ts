import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { AgentConfig, GatewayConfig } from './types';
import { SessionStore } from './session-store';
import { createLogger } from './logger';

const MAX_HISTORY_MESSAGES = 50;
const AUTO_RESTART_DELAY_MS = 5_000;
const MAX_RESTARTS = 3;
const CHANNELS_ACTIVATION_PROMPT =
  'Channels mode is active. Wait for incoming messages from your channels and respond to them.';

export class SessionProcess extends EventEmitter {
  readonly sessionId: string;
  readonly source: 'telegram' | 'api';
  lastActivityAt = Date.now(); // accessible by AgentRunner for eviction sort
  private process: ChildProcess | null = null;
  private stopping = false;
  private restartCount = 0;
  private readonly sessionStore: SessionStore;
  private readonly agentConfig: AgentConfig;
  private readonly gatewayConfig: GatewayConfig;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    sessionId: string,
    source: 'telegram' | 'api',
    agentConfig: AgentConfig,
    gatewayConfig: GatewayConfig,
    sessionStore: SessionStore,
  ) {
    super();
    this.sessionId = sessionId;
    this.source = source;
    this.agentConfig = agentConfig;
    this.gatewayConfig = gatewayConfig;
    this.sessionStore = sessionStore;
    this.logger = createLogger(
      `${agentConfig.id}:session:${sessionId}`,
      gatewayConfig.gateway.logDir,
    );
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.restartCount = 0;
    await this.spawnProcess();
  }

  private async buildInitialPrompt(): Promise<string> {
    const history = await this.sessionStore.loadSession(this.agentConfig.id, this.sessionId);
    const recent = history.slice(-MAX_HISTORY_MESSAGES);

    if (recent.length === 0) {
      return CHANNELS_ACTIVATION_PROMPT;
    }

    const historyText = recent
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    return `[Conversation history with this user:\n${historyText}]\n\n${CHANNELS_ACTIVATION_PROMPT}`;
  }

  private writeMcpConfig(): string | null {
    if (this.source === 'api') return null; // API sessions don't need Telegram plugin

    const stateDir = path.join(this.agentConfig.workspace, '.telegram-state');
    const sessionDir = path.join(this.agentConfig.workspace, '.sessions', this.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

    const pluginPath = path.resolve(__dirname, '..', 'plugins', 'telegram', 'server.ts');
    const mcpConfig = {
      mcpServers: {
        telegram: {
          command: 'bun',
          args: [pluginPath],
          env: {
            TELEGRAM_BOT_TOKEN: this.agentConfig.telegram.botToken,
            TELEGRAM_STATE_DIR: stateDir,
            TELEGRAM_SEND_ONLY: 'true', // ALWAYS — session subprocesses never poll
          },
        },
      },
    };

    const configPath = path.join(sessionDir, 'mcp-config.json');
    fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
    return configPath;
  }

  private buildArgs(mcpConfigPath: string | null): string[] {
    const args: string[] = [
      '--model', this.agentConfig.claude.model,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--print',
      '--verbose',
    ];

    if (mcpConfigPath) {
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
    const initialPrompt = await this.buildInitialPrompt();
    const mcpConfigPath = this.writeMcpConfig();
    const args = this.buildArgs(mcpConfigPath);

    const claudeBinRaw = process.env.CLAUDE_BIN ?? 'claude';
    const claudeBinParts = claudeBinRaw.split(' ');
    const claudeBin = claudeBinParts[0];
    const allArgs = [...claudeBinParts.slice(1), ...args];

    this.logger.info('Spawning session subprocess', {
      sessionId: this.sessionId,
      source: this.source,
    });

    const proc = spawn(claudeBin, allArgs, {
      env: { ...process.env, CLAUDE_WORKSPACE: this.agentConfig.workspace, TELEGRAM_BOT_TOKEN: this.agentConfig.telegram.botToken },
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
    let assistantBuffer = '';
    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        this.emit('output', line);
        this.logger.debug('session output', { line });
        // Try to capture assistant text for SessionStore
        try {
          const obj = JSON.parse(line);
          // stream-json assistant message
          if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
            for (const block of obj.message.content) {
              if (block.type === 'text') assistantBuffer += block.text;
            }
          }
          // text delta
          if (obj.type === 'text') assistantBuffer += obj.text ?? '';
          // result = end of turn
          if (obj.type === 'result' && assistantBuffer.trim()) {
            this.sessionStore
              .appendMessage(this.agentConfig.id, this.sessionId, {
                role: 'assistant',
                content: assistantBuffer.trim(),
                ts: Date.now(),
              })
              .catch(() => {});
            assistantBuffer = '';
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
    this.process.stdin.write(SessionProcess.toStreamJsonTurn(text) + '\n');
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
