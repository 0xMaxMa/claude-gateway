import express, { Request, Response } from 'express';
import { Server } from 'http';
import { AgentRunner } from '../agent/runner';
import { AgentConfig, AgentStats, ApiKey, GatewayConfig, HeartbeatResult } from '../types';
import { CronScheduler } from '../cron/scheduler';
import { CronManager } from '../cron/manager';
import { generateDashboardHtml } from '../ui/web-ui';
import { createApiRouter } from './router';
import { createCronRouter } from './cron-router';
import { createWorkspaceRouter } from './workspace-router';
import { createSkillsRouter } from './skills-router';
import { createPackagesRouter } from './packages';

export class GatewayRouter {
  private readonly agents: Map<string, AgentRunner>;
  private readonly configs: Map<string, AgentConfig>;
  private readonly app: express.Application;
  private server: Server | null = null;

  /** Per-agent message counters (output lines from subprocess) */
  private readonly messagesReceived: Map<string, number> = new Map();
  private readonly messagesSent: Map<string, number> = new Map();

  /** Per-agent last activity timestamps */
  private readonly lastActivityAt: Map<string, Date> = new Map();

  /** Per-agent recent sessions (last 5): Map<agentId, Array<sessionInfo>> */
  private readonly recentSessions: Map<string, Array<{ chatId: string; messageCount: number; lastActivity: Date }>> = new Map();

  /** Optional per-agent cron schedulers (for /status endpoint) */
  private readonly schedulers: Map<string, CronScheduler> = new Map();

  /** Gateway start time */
  private readonly startedAt = new Date();

  /** Optional gateway config (used to mount API router) */
  private readonly gatewayConfig?: GatewayConfig;

  /** Optional persistent cron manager */
  private readonly cronManager?: CronManager;

  /** Path to config.json for agent CRUD operations */
  private readonly configPath?: string;

  constructor(
    agents: Map<string, AgentRunner>,
    configs: Map<string, AgentConfig>,
    schedulers?: Map<string, CronScheduler>,
    gatewayConfig?: GatewayConfig,
    cronManager?: CronManager,
    configPath?: string,
  ) {
    this.agents = agents;
    this.configs = configs;
    this.gatewayConfig = gatewayConfig;
    this.cronManager = cronManager;
    this.configPath = configPath;
    this.app = express();

    // Initialise counters for all known agents
    for (const [id, runner] of agents) {
      this.messagesReceived.set(id, 0);
      this.messagesSent.set(id, 0);
      this.recentSessions.set(id, []);

      // Track output lines from subprocess as messagesSent (guard for test mocks)
      if (typeof (runner as unknown as { on?: unknown }).on === 'function') {
        runner.on('output', () => {
          this.messagesSent.set(id, (this.messagesSent.get(id) ?? 0) + 1);
          this.lastActivityAt.set(id, new Date());
        });
      }
    }

    if (schedulers) {
      for (const [id, scheduler] of schedulers) {
        this.schedulers.set(id, scheduler);
      }
    }

    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // Mount API router after body parser so req.body is populated
    if (this.gatewayConfig?.gateway?.api?.keys?.length) {
      const apiRouter = createApiRouter(
        this.agents,
        this.configs,
        this.gatewayConfig.gateway.api.keys,
        this.configPath,
        this.gatewayConfig.gateway.models,
      );
      this.app.use('/api', apiRouter);
    }

    // Mount workspace file routes
    if (this.gatewayConfig?.gateway?.api?.keys?.length) {
      const workspaceRouter = createWorkspaceRouter(
        this.configs,
        this.gatewayConfig.gateway.api.keys,
      );
      this.app.use('/api', workspaceRouter);
    }

    // Mount skills routes
    if (this.gatewayConfig?.gateway?.api?.keys?.length) {
      const skillsRouter = createSkillsRouter(
        this.configs,
        this.gatewayConfig.gateway.api.keys,
        this.agents,
      );
      this.app.use('/api', skillsRouter);
    }

    // Mount package update routes (admin-only)
    if (this.gatewayConfig?.gateway?.api?.keys?.length) {
      const packagesRouter = createPackagesRouter(this.gatewayConfig.gateway.api.keys);
      this.app.use('/api', packagesRouter);
    }

    // Mount cron manager routes with same API key auth as agent router
    if (this.cronManager) {
      const cronRouter = createCronRouter(
        this.cronManager,
        this.gatewayConfig?.gateway?.api?.keys,
        new Set(this.configs.keys()),
      );
      this.app.use('/api', cronRouter);
    }

    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', agents: [...this.agents.keys()] });
    });

    // Web UI dashboard
    this.app.get('/ui', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(generateDashboardHtml());
    });

    // Status endpoint — per-agent stats + heartbeat history
    this.app.get('/status', (_req: Request, res: Response) => {
      const uptimeMs = Date.now() - this.startedAt.getTime();

      const agentsStatus = [...this.agents.entries()].map(([id, runner]) => {
        const scheduler = this.schedulers.get(id);
        const history = scheduler?.getHistory();
        const agentConfig = this.configs.get(id);
        const taskDefs = (agentConfig?.heartbeat as unknown as undefined) ?? undefined;
        void taskDefs; // not used directly; task names come from history

        // Collect unique task names from history
        const allResults: HeartbeatResult[] = history ? history.getHistory(id) : [];
        const taskNames = [...new Set(allResults.map((r) => r.taskName))];

        // Get the most recent result for each known task
        const lastResults = taskNames.map((taskName) => {
          const last = history?.getLastResult(id, taskName);
          if (!last) return null;
          return {
            taskName: last.taskName,
            suppressed: last.suppressed,
            rateLimited: last.rateLimited,
            durationMs: last.durationMs,
            ts: last.ts,
          };
        }).filter(Boolean);

        const lastActivity = this.lastActivityAt.get(id);
        const sessions = (this.recentSessions.get(id) ?? []).slice(0, 5).map((s) => ({
          chatId: s.chatId,
          messageCount: s.messageCount,
          lastActivity: s.lastActivity.toISOString(),
        }));

        return {
          id,
          isRunning: runner.isRunning(),
          messagesReceived: this.messagesReceived.get(id) ?? 0,
          messagesSent: this.messagesSent.get(id) ?? 0,
          lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
          heartbeat: {
            tasks: taskNames,
            lastResults,
          },
          sessions,
        };
      });

      res.json({
        agents: agentsStatus,
        uptime: Math.floor(uptimeMs / 1000),
        startedAt: this.startedAt.toISOString(),
      });
    });
  }

  async start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, () => {
        resolve();
      });
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use. Stop the existing process or set a different PORT env var.`));
        } else {
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  getApp(): express.Application {
    return this.app;
  }

  // ─── Lookup / stats API ─────────────────────────────────────────────────

  /**
   * Find agent config by bot token.
   */
  getAgentByToken(token: string): AgentConfig | undefined {
    for (const [, config] of this.configs) {
      if (config.telegram?.botToken === token) {
        return config;
      }
    }
    return undefined;
  }

  /**
   * List all agent configs.
   */
  listAgents(): AgentConfig[] {
    return [...this.configs.values()];
  }

  /**
   * Hot-reload API keys by mutating the existing array in-place.
   * The auth middleware captures apiKeys by reference, so mutations
   * are picked up automatically without remounting the router.
   */
  updateApiKeys(newKeys: ApiKey[]): void {
    if (!this.gatewayConfig?.gateway?.api?.keys) return;
    const keys = this.gatewayConfig.gateway.api.keys;
    keys.splice(0, keys.length, ...newKeys);
  }

  /**
   * Return per-agent stats.
   */
  getAgentStats(): AgentStats[] {
    const stats: AgentStats[] = [];
    for (const [id, runner] of this.agents) {
      const lastActivity = this.lastActivityAt.get(id);
      stats.push({
        id,
        isRunning: runner.isRunning(),
        messagesReceived: this.messagesReceived.get(id) ?? 0,
        messagesSent: this.messagesSent.get(id) ?? 0,
        lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
      });
    }
    return stats;
  }

}

