import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { AgentConfig } from './types';
import { createLogger } from './logger';

const AUTO_RESTART_DELAY_MS = 5_000;
const MAX_RESTARTS = 3;

export class TelegramReceiver {
  private process: ChildProcess | null = null;
  private stopping = false;
  private restartCount = 0;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly callbackPort: number,
    private readonly logDir: string,
  ) {
    this.logger = createLogger(`${agentConfig.id}:receiver`, logDir);
  }

  start(): void {
    this.stopping = false;
    this.restartCount = 0;
    this.spawnProcess();
  }

  private spawnProcess(): void {
    const receiverPath = path.resolve(__dirname, '..', 'mcp', 'gateway', 'tools', 'telegram', 'receiver-server.ts');
    const stateDir = path.join(this.agentConfig.workspace, '.telegram-state');

    this.process = spawn('bun', [receiverPath], {
      env: {
        ...process.env,
        TELEGRAM_RECEIVER_MODE: 'true',
        TELEGRAM_BOT_TOKEN: this.agentConfig.telegram.botToken,
        TELEGRAM_STATE_DIR: stateDir,
        CLAUDE_CHANNEL_CALLBACK: `http://127.0.0.1:${this.callbackPort}/channel`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (d: Buffer) =>
      this.logger.debug('receiver stdout', { data: d.toString().trim() }),
    );
    this.process.stderr?.on('data', (d: Buffer) =>
      this.logger.info('receiver', { data: d.toString().trim() }),
    );
    this.process.on('exit', (code, signal) => {
      this.logger.info('TelegramReceiver exited', { code, signal });
      this.process = null;
      if (!this.stopping) this.scheduleRestart();
    });
    this.process.on('error', (err) =>
      this.logger.error('TelegramReceiver error', { error: err.message }),
    );
    this.logger.info('TelegramReceiver started');
  }

  private scheduleRestart(): void {
    if (this.restartCount >= MAX_RESTARTS) {
      this.logger.error('TelegramReceiver max restarts reached');
      return;
    }
    this.restartCount++;
    this.logger.warn(`Restarting TelegramReceiver in ${AUTO_RESTART_DELAY_MS}ms`, {
      attempt: this.restartCount,
    });
    setTimeout(() => {
      if (!this.stopping) this.spawnProcess();
    }, AUTO_RESTART_DELAY_MS);
  }

  stop(): void {
    this.stopping = true;
    this.process?.kill('SIGTERM');
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
