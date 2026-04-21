import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { AgentConfig } from '../types';
import { createLogger } from '../logger';

const AUTO_RESTART_DELAY_MS = 5_000;
const MAX_RESTARTS = 3;

export class DiscordReceiver {
  private process: ChildProcess | null = null;
  private stopping = false;
  private restartCount = 0;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly callbackPort: number,
    private readonly logDir: string,
  ) {
    this.logger = createLogger(`${agentConfig.id}:discord-receiver`, logDir);
  }

  start(): void {
    this.stopping = false;
    this.restartCount = 0;
    this.spawnProcess();
  }

  private spawnProcess(): void {
    const receiverPath = path.resolve(__dirname, '..', '..', 'mcp', 'tools', 'discord', 'receiver-server.ts');
    const stateDir = path.join(this.agentConfig.workspace, '.discord-state');

    this.process = spawn('bun', [receiverPath], {
      env: {
        ...process.env,
        DISCORD_BOT_TOKEN: this.agentConfig.discord?.botToken ?? '',
        DISCORD_STATE_DIR: stateDir,
        DISCORD_DM_POLICY: this.agentConfig.discord?.dmPolicy ?? 'pairing',
        DISCORD_DM_ALLOWLIST: (this.agentConfig.discord?.dmAllowlist ?? []).join(','),
        DISCORD_GUILD_ALLOWLIST: (this.agentConfig.discord?.guildAllowlist ?? []).join(','),
        DISCORD_CHANNEL_ALLOWLIST: (this.agentConfig.discord?.channelAllowlist ?? []).join(','),
        GATEWAY_AGENT_ID: this.agentConfig.id,
        CLAUDE_CHANNEL_CALLBACK: `http://127.0.0.1:${this.callbackPort}/channel`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (d: Buffer) =>
      this.logger.debug('discord receiver stdout', { data: d.toString().trim() }),
    );
    this.process.stderr?.on('data', (d: Buffer) =>
      this.logger.info('discord receiver', { data: d.toString().trim() }),
    );
    this.process.on('exit', (code, signal) => {
      this.logger.info('DiscordReceiver exited', { code, signal });
      this.process = null;
      if (!this.stopping) this.scheduleRestart();
    });
    this.process.on('error', (err) =>
      this.logger.error('DiscordReceiver error', { error: err.message }),
    );
    this.logger.info('DiscordReceiver started');
  }

  private scheduleRestart(): void {
    if (this.restartCount >= MAX_RESTARTS) {
      this.logger.error('DiscordReceiver max restarts reached');
      return;
    }
    this.restartCount++;
    this.logger.warn(`Restarting DiscordReceiver in ${AUTO_RESTART_DELAY_MS}ms`, {
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
