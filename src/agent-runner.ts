import { EventEmitter } from 'events';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { AgentConfig, GatewayConfig, Logger } from './types';
import { createLogger } from './logger';
import { SessionProcess } from './session-process';
import { SessionStore } from './session-store';
import { TelegramReceiver } from './telegram-receiver';

const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const DEFAULT_MAX_CONCURRENT = 20;

export class AgentRunner extends EventEmitter {
  private readonly agentConfig: AgentConfig;
  private readonly gatewayConfig: GatewayConfig;
  private readonly logger: Logger;
  private stopping = false;
  private callbackServer: http.Server | null = null;
  private callbackPort = 0;

  // Session pool
  private readonly sessions = new Map<string, SessionProcess>();
  private receiver: TelegramReceiver | null = null;
  private readonly sessionStore: SessionStore;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrent: number;
  private idleCleanerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(agentConfig: AgentConfig, gatewayConfig: GatewayConfig, logger?: Logger) {
    super();
    this.agentConfig = agentConfig;
    this.gatewayConfig = gatewayConfig;
    this.logger = logger ?? createLogger(agentConfig.id, gatewayConfig.gateway.logDir);

    // Resolve agentsBaseDir: workspace is at <agentsBaseDir>/<agentId>/workspace
    const agentsBaseDir = path.resolve(agentConfig.workspace, '..', '..');
    this.sessionStore = new SessionStore(agentsBaseDir);

    this.idleTimeoutMs =
      (agentConfig.session?.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES) * 60 * 1000;
    this.maxConcurrent = agentConfig.session?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /**
   * Bind a local HTTP server that receives POST /channel from TelegramReceiver.
   * Each payload is routed to the appropriate SessionProcess by chat_id.
   */
  private async startCallbackServer(): Promise<void> {
    this.callbackPort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
      srv.on('error', reject);
    });

    this.callbackServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
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

          // Append user message to session store
          this.sessionStore
            .appendMessage(this.agentConfig.id, chatId, {
              role: 'user',
              content,
              ts: Date.now(),
            })
            .catch(() => {});

          // Route to session, inject as channel XML
          this.getOrSpawnSession(chatId, 'telegram')
            .then((session) => {
              const channelXml = AgentRunner.buildChannelXml(params);
              session.sendMessage(channelXml);
              session.touch();
              this.logger.debug('Injected channel turn into session', {
                chatId,
                user: meta['user'],
              });
            })
            .catch((err) => {
              this.logger.error('Failed to route message to session', {
                chatId,
                error: (err as Error).message,
              });
            });
        } catch (err) {
          this.logger.warn('Failed to parse channel callback body', {
            error: (err as Error).message,
          });
        }
      });
    });

    this.callbackServer.listen(this.callbackPort, '127.0.0.1');
    this.logger.info('Channel callback server listening', { port: this.callbackPort });
  }

  private static buildChannelXml(params: {
    content?: string;
    meta?: Record<string, string>;
  }): string {
    const meta = params.meta ?? {};
    return (
      `<channel source="telegram" chat_id="${meta['chat_id'] ?? ''}" ` +
      `message_id="${meta['message_id'] ?? ''}" user="${meta['user'] ?? ''}" ` +
      `ts="${meta['ts'] ?? new Date().toISOString()}">${params.content ?? ''}</channel>`
    );
  }

  private async getOrSpawnSession(
    sessionId: string,
    source: 'telegram' | 'api',
  ): Promise<SessionProcess> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    // Evict oldest idle session if at capacity
    if (this.sessions.size >= this.maxConcurrent) {
      const sorted = [...this.sessions.entries()].sort(
        ([, a], [, b]) => a.lastActivityAt - b.lastActivityAt,
      );
      const idleEntry = sorted.find(([, p]) => p.isIdle(0));
      if (idleEntry) {
        await idleEntry[1].stop();
        this.sessions.delete(idleEntry[0]);
        this.logger.info('Evicted idle session', { sessionId: idleEntry[0] });
      } else {
        throw new Error(`Session pool full: ${this.maxConcurrent} concurrent sessions`);
      }
    }

    const proc = new SessionProcess(
      sessionId,
      source,
      this.agentConfig,
      this.gatewayConfig,
      this.sessionStore,
    );
    await proc.start();
    this.sessions.set(sessionId, proc);
    this.logger.info('Spawned session', {
      sessionId,
      source,
      total: this.sessions.size,
    });
    return proc;
  }

  private startIdleCleaner(): void {
    this.idleCleanerTimer = setInterval(async () => {
      for (const [id, proc] of this.sessions) {
        if (proc.isIdle(this.idleTimeoutMs)) {
          this.logger.info('Stopping idle session', { sessionId: id });
          await proc.stop();
          this.sessions.delete(id);
        }
      }
    }, 5 * 60 * 1000);
  }

  async start(bootstrapPrompt?: string): Promise<void> {
    void bootstrapPrompt; // reserved for future use
    this.stopping = false;
    await this.startCallbackServer();
    this.receiver = new TelegramReceiver(
      this.agentConfig,
      this.callbackPort,
      this.gatewayConfig.gateway.logDir,
    );
    this.receiver.start();
    this.startIdleCleaner();
    this.logger.info('AgentRunner started', { agentId: this.agentConfig.id });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.idleCleanerTimer !== null) {
      clearInterval(this.idleCleanerTimer);
      this.idleCleanerTimer = null;
    }
    this.callbackServer?.close();
    this.callbackServer = null;
    this.receiver?.stop();
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
    this.sessions.clear();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.stopping = false;
    await this.start();
  }

  isRunning(): boolean {
    return this.receiver?.isRunning() ?? false;
  }

  /**
   * Send a message to all active sessions.
   * Used for heartbeat/cron tasks delivered out-of-band.
   */
  sendMessage(message: string): void {
    if (this.sessions.size === 0) {
      this.logger.warn('sendMessage called but no active sessions');
      return;
    }
    for (const session of this.sessions.values()) {
      session.sendMessage(message);
    }
  }
}
