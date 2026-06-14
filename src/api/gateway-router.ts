import express, { Request, Response } from 'express';
import * as http from 'node:http';
import { exec } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { AgentRunner } from '../agent/runner';
import { AgentConfig, AgentStats, ApiKey, GatewayConfig, HeartbeatResult } from '../types';
import { ptyStreamRegistry } from '../shell/pty-stream-registry';
import { CronScheduler } from '../cron/scheduler';
import { CronManager } from '../cron/manager';
import { generateDashboardHtml } from '../ui/web-ui';
import { createApiRouter } from './router';
import { createCronRouter } from './cron-router';
import { createWorkspaceRouter } from './workspace-router';
import { createSkillsRouter } from './skills-router';
import { createPackagesRouter } from './packages';
import { AppsRegistry } from '../apps/registry';
import { AppInstaller } from '../apps/installer';
import { RegistryClient } from '../apps/registry-client';
import { createAppsRouter } from './apps-router';
import { ComposePort } from '../apps/compose-generator';

const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function getGatewayVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const GATEWAY_VERSION = getGatewayVersion();

// ─── Proxy types ──────────────────────────────────────────────────────────────

interface ProxyRoute {
  port: number;
  type: 'api' | 'web';
  rateLimit: number;
}

/** Extract hostname from DOCKER_HOST (tcp://host:port) for app container proxy. */
function resolveAppProxyHost(): string {
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost?.startsWith('tcp://')) {
    const url = new URL(dockerHost);
    return url.hostname;
  }
  return '127.0.0.1';
}

const APP_PROXY_HOST = resolveAppProxyHost();

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

/** Simple token-bucket rate limiter keyed by "appName:portName". */
class RateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  allow(key: string, maxPerSecond: number): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: maxPerSecond, lastRefill: now };
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(maxPerSecond, bucket.tokens + elapsed * maxPerSecond);
    bucket.lastRefill = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return true;
    }
    this.buckets.set(key, bucket);
    return false;
  }

  delete(key: string): void {
    this.buckets.delete(key);
  }
}

export class GatewayRouter {
  private readonly agents: Map<string, AgentRunner>;

  // ─── App proxy ──────────────────────────────────────────────────────────
  /** "appName:portName" → ProxyRoute */
  private readonly routeMap = new Map<string, ProxyRoute>();
  private readonly rateLimiter = new RateLimiter();
  private readonly configs: Map<string, AgentConfig>;
  private readonly app: express.Application;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;

  /** Cached /processes result (3s TTL, avoids blocking execSync on every poll). */
  private processesCache: { data: unknown[]; ts: number } | null = null;
  private static readonly PROCESSES_CACHE_TTL_MS = 3_000;

  /** Short-lived WS auth tickets: ticket → { agentId, expiresAt }. One-time use. */
  private readonly ptyStreamTickets = new Map<string, { agentId: string; expiresAt: number }>();
  private ticketPruner: ReturnType<typeof setInterval> | null = null;

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

  /** Optional app store components */
  private readonly appsRegistry?: AppsRegistry;
  private readonly appInstaller?: AppInstaller;
  private readonly appRegistryClient?: RegistryClient;

  constructor(
    agents: Map<string, AgentRunner>,
    configs: Map<string, AgentConfig>,
    schedulers?: Map<string, CronScheduler>,
    gatewayConfig?: GatewayConfig,
    cronManager?: CronManager,
    configPath?: string,
    appsRegistry?: AppsRegistry,
    appInstaller?: AppInstaller,
    appRegistryClient?: RegistryClient,
  ) {
    this.agents = agents;
    this.configs = configs;
    this.gatewayConfig = gatewayConfig;
    this.cronManager = cronManager;
    this.configPath = configPath;
    this.appsRegistry = appsRegistry;
    this.appInstaller = appInstaller;
    this.appRegistryClient = appRegistryClient;
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

    // Mount apps router (admin routes for installing/managing apps)
    if (
      this.appsRegistry &&
      this.appInstaller &&
      this.appRegistryClient &&
      this.gatewayConfig?.gateway?.api?.keys?.length
    ) {
      const appsRouter = createAppsRouter(
        this.appsRegistry,
        this.appInstaller,
        this.appRegistryClient,
        this.gatewayConfig.gateway.api.keys,
      );
      this.app.use('/api', appsRouter);
    }

    // Reverse proxy: /app/:name/:portName/* → http://127.0.0.1:<port>/*
    // This must be registered AFTER API routes to avoid conflicts.
    this.app.use('/app/:name/:portName', (req: Request, res: Response) => {
      if (!APP_NAME_RE.test(req.params.name) || !APP_NAME_RE.test(req.params.portName)) {
        res.status(400).json({ error: 'Invalid app or port name' });
        return;
      }
      const key = `${req.params.name}:${req.params.portName}`;
      const route = this.routeMap.get(key);
      if (!route) {
        res.status(404).json({ error: 'App or port not found' });
        return;
      }

      // Rate limiting
      if (!this.rateLimiter.allow(key, route.rateLimit)) {
        res.status(429).json({ error: 'Rate limit exceeded' });
        return;
      }

      // Path forwarding: api strips /app/:name/:portName prefix; web keeps full path
      // because web apps are built with basePath=/app/:name/:portName and handle it themselves.
      const targetPath = route.type === 'api'
        ? (req.path || '/')
        : (req.originalUrl || '/');

      const options: http.RequestOptions = {
        hostname: APP_PROXY_HOST,
        port: route.port,
        path: targetPath,
        method: req.method,
        headers: { ...req.headers, host: `${APP_PROXY_HOST}:${route.port}` },
      };

      // express.json() drains req stream; re-serialize parsed body so proxy gets correct bytes.
      let proxyBody: Buffer | undefined;
      if (req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        proxyBody = Buffer.from(JSON.stringify(req.body), 'utf-8');
        options.headers = {
          ...options.headers,
          'content-type': 'application/json',
          'content-length': proxyBody.length.toString(),
        };
      }

      const proxy = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      });
      proxy.on('error', (err: Error) => {
        if (!res.headersSent) {
          res.status(502).json({ error: `App unavailable: ${err.message}` });
        }
      });
      if (proxyBody) {
        proxy.end(proxyBody);
      } else {
        proxy.end();
      }
    });

    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', agents: [...this.agents.keys()] });
    });

    // Web dashboard
    this.app.get('/dashboard', (_req: Request, res: Response) => {
      const firstKey = (this.gatewayConfig?.gateway?.api?.keys ?? [])[0]?.key ?? '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (process.env.DEV_MODE) {
        // Hot-reload: bust module cache so each browser refresh picks up the latest compiled web-ui.js
        const webUiPath = require.resolve('../ui/web-ui');
        delete require.cache[webUiPath];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { generateDashboardHtml: fresh } = require('../ui/web-ui') as typeof import('../ui/web-ui');
        res.send(fresh(firstKey));
      } else {
        res.send(generateDashboardHtml(firstKey));
      }
    });

    // Process tree endpoint — returns raw ps data for dashboard.
    // Async exec + 3s cache: avoids blocking the event loop on every dashboard poll.
    this.app.get('/processes', (_req: Request, res: Response) => {
      const now = Date.now();
      if (this.processesCache && now - this.processesCache.ts < GatewayRouter.PROCESSES_CACHE_TTL_MS) {
        res.json({ processes: this.processesCache.data });
        return;
      }
      exec(
        "ps -eo pid,ppid,stat,%cpu,%mem,rss,args --no-headers 2>/dev/null | grep -E 'claude|bun.*gateway|bun.*mcp|bun.*receiver|node.*dist/' | grep -v grep | grep -v vscode",
        { encoding: 'utf8', timeout: 5000 },
        (_err, stdout) => {
          const processes = (stdout ?? '').trim().split('\n').filter(Boolean).map((line) => {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
            if (!m) return null;
            return {
              pid: parseInt(m[1]),
              ppid: parseInt(m[2]),
              stat: m[3],
              cpu: parseFloat(m[4]),
              mem: parseFloat(m[5]),
              rssKb: parseInt(m[6]),
              args: m[7].trim(),
            };
          }).filter(Boolean);
          this.processesCache = { data: processes, ts: Date.now() };
          res.json({ processes });
        },
      );
    });

    // Ephemeral WS ticket — exchange a short-lived token for PTY stream access.
    // The ticket is one-time-use with a 30s TTL so the API key never appears in WS URLs
    // (which would expose it in server access logs and browser history).
    this.app.post('/api/v1/pty-stream-ticket', (req: Request, res: Response) => {
      const apiKeys = this.gatewayConfig?.gateway?.api?.keys ?? [];
      const authHeader = (req.headers['authorization'] as string | undefined) ?? '';
      const xApiKey = (req.headers['x-api-key'] as string | undefined) ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : xApiKey.trim();
      if (!token || !apiKeys.some((k) => k.key === token)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const agentId = (req.body as { agentId?: string })?.agentId ?? '';
      if (!agentId || !this.agents.has(agentId)) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      const ticket = crypto.randomBytes(16).toString('hex');
      const expiresAt = Date.now() + 30_000;
      this.ptyStreamTickets.set(ticket, { agentId, expiresAt });
      res.json({ ticket, expiresAt: new Date(expiresAt).toISOString() });
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
        const sessions = runner.getSessionsSummary();

        // An agent with a channel receiver configured (telegram/discord) has a
        // meaningful running/stopped state. API-only agents have no receiver — they
        // are always available as long as the gateway has them loaded.
        const hasChannel = !!(agentConfig?.telegram?.botToken || agentConfig?.discord?.botToken);

        return {
          id,
          isRunning: runner.isRunning(),
          hasChannel,
          messagesReceived: this.messagesReceived.get(id) ?? 0,
          messagesSent: this.messagesSent.get(id) ?? 0,
          lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
          hasPtyStream: ptyStreamRegistry.hasSockets(id),
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
        version: GATEWAY_VERSION,
      });
    });
  }

  async start(port: number): Promise<void> {
    const host = process.env.GATEWAY_BIND ?? '0.0.0.0';
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, host, () => {
        resolve();
      });
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use. Stop the existing process or set a different PORT env var.`));
        } else {
          reject(err);
        }
      });

      this.wss = new WebSocketServer({ noServer: true });
      const apiKeys = this.gatewayConfig?.gateway?.api?.keys ?? [];

      // Prune expired tickets every 60s.
      this.ticketPruner = setInterval(() => {
        const now = Date.now();
        for (const [k, v] of this.ptyStreamTickets) {
          if (v.expiresAt < now) this.ptyStreamTickets.delete(k);
        }
      }, 60_000);
      this.ticketPruner.unref();

      this.server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
        const url = req.url ?? '';
        const match = url.match(/\/api\/v1\/agents\/([^/?]+)\/pty-stream(?:\?.*)?$/);
        if (!match) {
          socket.destroy();
          return;
        }

        const params = new URL(url, 'http://localhost').searchParams;

        // Auth path 1: ephemeral ticket (?ticket=<hex>) — one-time-use, 30s TTL.
        // The dashboard obtains a ticket via POST /api/v1/pty-stream-ticket before
        // opening the WebSocket so the API key never appears in the WS URL.
        const ticketParam = params.get('ticket') ?? '';
        if (ticketParam) {
          const entry = this.ptyStreamTickets.get(ticketParam);
          if (!entry || entry.expiresAt < Date.now()) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          this.ptyStreamTickets.delete(ticketParam); // one-time use
          const agentId = entry.agentId;
          if (!this.agents.has(agentId)) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
          }
          this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
            if (!ptyStreamRegistry.hasSockets(agentId)) {
              ws.close(4404, 'agent not running in PTY mode');
              return;
            }
            ptyStreamRegistry.subscribe(agentId, ws);
            ws.on('close', () => ptyStreamRegistry.unsubscribe(agentId, ws));
            ws.on('error', () => ptyStreamRegistry.unsubscribe(agentId, ws));
          });
          return;
        }

        // Auth path 2: Bearer token or X-Api-Key header (for non-browser clients).
        const authHeader = (req.headers['authorization'] as string | undefined) ?? '';
        const xApiKey = (req.headers['x-api-key'] as string | undefined) ?? '';
        const token = authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : xApiKey.trim();
        if (!token || !apiKeys.some((k) => k.key === token)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        const agentId = decodeURIComponent(match[1]!);
        if (!this.agents.has(agentId)) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }

        this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          if (!ptyStreamRegistry.hasSockets(agentId)) {
            ws.close(4404, 'agent not running in PTY mode');
            return;
          }
          ptyStreamRegistry.subscribe(agentId, ws);
          ws.on('close', () => ptyStreamRegistry.unsubscribe(agentId, ws));
          ws.on('error', () => ptyStreamRegistry.unsubscribe(agentId, ws));
        });
      });
    });
  }

  // ─── Proxy route management ──────────────────────────────────────────────

  /** Register a proxy route for an installed app port. Hot-takes effect immediately. */
  registerProxyRoute(
    appName: string,
    portName: string,
    port: number,
    type: 'api' | 'web',
    rateLimit: number,
  ): void {
    this.routeMap.set(`${appName}:${portName}`, { port, type, rateLimit });
  }

  /** Remove all proxy routes for an app (called on uninstall). */
  deregisterProxyRoutes(appName: string): void {
    // Snapshot keys first — mutating a Map while iterating its live iterator is unsafe
    const toDelete = [...this.routeMap.keys()].filter((k) => k.startsWith(`${appName}:`));
    for (const key of toDelete) {
      this.routeMap.delete(key);
      this.rateLimiter.delete(key);
    }
  }

  /** Re-register proxy routes from apps.json on gateway startup (crash-safe). */
  async loadProxyRoutes(registry: AppsRegistry): Promise<void> {
    const apps = await registry.list();
    for (const app of apps) {
      if (app.status !== 'running') continue;
      for (const port of app.ports) {
        this.registerProxyRoute(app.name, port.name, port.hostPort, port.type, port.rateLimit);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.ticketPruner) clearInterval(this.ticketPruner);
    this.wss?.close();
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

