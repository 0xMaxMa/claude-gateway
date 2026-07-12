import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { AgentConfig } from '../types';
import { createLogger } from '../logger';

const AUTO_RESTART_DELAY_MS = 5_000;
const MAX_RESTARTS = 3;
// After MAX_RESTARTS fast attempts, fall back to a slow indefinite retry
// instead of giving up permanently — self-heals if the admin fixes the
// underlying cause later (e.g. a Discord Developer Portal intent toggle)
// without needing to notice and manually reconnect.
const SLOW_RESTART_DELAY_MS = 5 * 60_000;

export class DiscordReceiver {
  private process: ChildProcess | null = null;
  private stopping = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
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
        // Legacy seed value: when no explicit dmPolicy is configured (the common
        // token-only case), 'pairing' flows through access.ts:migrateAccess to
        // { dmPolicy:'allowlist', pairing:true } — i.e. a new agent comes up with
        // pairing ON so the owner can DM the bot and self-approve via a code.
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
    const slowPhase = this.restartCount >= MAX_RESTARTS;
    const delay = slowPhase ? SLOW_RESTART_DELAY_MS : AUTO_RESTART_DELAY_MS;
    if (!slowPhase) this.restartCount++;
    this.logger.warn(`Restarting DiscordReceiver in ${delay}ms`, {
      attempt: this.restartCount,
      slowPhase,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnProcess();
    }, delay);
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.process?.kill('SIGTERM');
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
