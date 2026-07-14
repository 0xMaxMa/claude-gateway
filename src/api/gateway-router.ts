import express, { Request, Response } from 'express';
import * as http from 'node:http';
import { exec } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Server } from 'http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { AgentRunner } from '../agent/runner';
import { AgentConfig, AgentStats, ApiKey, GatewayConfig, HeartbeatResult } from '../types';
import { ptyStreamRegistry } from '../shell/pty-stream-registry';
import { shouldRoutePtyInput, MAX_PTY_INPUT_BYTES } from '../shell/control-channel';
import { getWatcherHealth } from '../watch/factory';
import { CronScheduler } from '../cron/scheduler';
import { CronManager } from '../cron/manager';
import { generateDashboardHtml } from '../ui/web-ui';
import { createApiRouter } from './router';
import { createCronRouter } from './cron-router';
import { createWorkspaceRouter } from './workspace-router';
import { createSkillsRouter } from './skills-router';
import { createPackagesRouter } from './packages';
import { createWebhooksRouter } from './webhooks-router';
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

/**
 * Resolve the network interface the server binds to (Issue #201). Precedence:
 * GATEWAY_BIND env → gateway.bind config → localhost-only default. Empty/blank
 * values fall through, so an unset or whitespace override never accidentally
 * binds all interfaces. The localhost default keeps the dashboard/API off the
 * local network out of the box.
 */
export function resolveBindHost(
  envBind: string | undefined,
  configuredBind: string | undefined,
): string {
  const env = envBind?.trim();
  const configured = configuredBind?.trim();
  return env || configured || '127.0.0.1';
}

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

  /** Core count is constant for the process lifetime — read once instead of
   *  calling os.cpus() (a syscall) on every /processes poll. Used to normalize
   *  ps per-core %CPU into a 0–100% figure on the dashboard. */
  private static readonly NUM_CPUS = Math.max(1, os.cpus().length);

  /** Short-lived WS auth tickets: ticket → { agentId, sessionId, expiresAt }. One-time use. */
  private readonly ptyStreamTickets = new Map<string, { agentId: string; sessionId: string; expiresAt: number }>();
  private ticketPruner: ReturnType<typeof setInterval> | null = null;

  /** Short-lived dashboard session tokens (10 min TTL). Issued at /dashboard serve time
   *  so the raw API key is never embedded in the HTML page source. */
  private readonly dashboardTokens = new Map<string, number>(); // token → expiresAt

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
    if (process.env.DEV_MODE) {
      process.stderr.write('[gateway] DEV_MODE=1 active — module cache busted on every /dashboard request. Never enable in production.\n');
    }
    // Public webhook ingress (LINE + future apps) MUST be mounted before
    // express.json() — each app handler needs the raw request bytes for its own
    // signature validation. This whole /webhooks zone bypasses API-key auth;
    // every app authenticates itself (see webhooks-router.ts).
    this.app.use(
      '/webhooks',
      createWebhooksRouter(this.agents, this.gatewayConfig?.gateway?.logDir ?? '/tmp'),
    );

    this.app.use(express.json());

    // Ephemeral WS ticket — exchange a short-lived token for PTY stream access.
    // MUST be registered before the apiRouter middleware so it handles its own auth
    // (dashboard token or API key) without the apiRouter's auth gate intercepting first.
    // The ticket is one-time-use with a 30s TTL so neither the API key nor the
    // dashboard token appears in WS URLs (server access logs / browser history).
    // Accepts two credential types:
    //   • X-Api-Key / Bearer — full API key (programmatic clients)
    //   • X-Dash-Token       — dashboard session token (browser, 10 min, issued at /dashboard)
    this.app.post('/api/v1/pty-stream-ticket', (req: Request, res: Response) => {
      const apiKeys = this.gatewayConfig?.gateway?.api?.keys ?? [];
      const authHeader = (req.headers['authorization'] as string | undefined) ?? '';
      const xApiKey = (req.headers['x-api-key'] as string | undefined) ?? '';
      const xDashToken = (req.headers['x-dash-token'] as string | undefined) ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : xApiKey.trim();

      // Validate: API key OR a live dashboard token.
      const now = Date.now();
      const dashExpiry = xDashToken ? (this.dashboardTokens.get(xDashToken) ?? 0) : 0;
      const dashValid = dashExpiry > now;
      if (dashValid) {
        // Dashboard tokens are one-time-use: revoke immediately after auth so a
        // leaked page source can't be replayed (each /dashboard visit gets a fresh one).
        this.dashboardTokens.delete(xDashToken);
      }
      if (!dashValid && (!token || !apiKeys.some((k) => k.key === token))) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const body = (req.body as { agentId?: string; sessionId?: string }) ?? {};
      const agentId = body.agentId ?? '';
      const sessionId = body.sessionId ?? '';
      if (!agentId || !this.agents.has(agentId)) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      // Bind the ticket to a specific session. Validate the session actually
      // belongs to this agent so a ticket can't be minted for an arbitrary
      // stream key. hasSockets() at WS time is the final gate on liveness.
      const sessionExists = (this.agents.get(agentId)?.getSessionsSummary() ?? [])
        .some((s) => s.sessionId === sessionId);
      if (!sessionId || !sessionExists) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const ticket = crypto.randomBytes(16).toString('hex');
      const expiresAt = Date.now() + 30_000;
      this.ptyStreamTickets.set(ticket, { agentId, sessionId, expiresAt });
      res.json({ ticket, expiresAt: new Date(expiresAt).toISOString() });
    });

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
      // Issue a short-lived dashboard token (10 min) instead of embedding the raw
      // API key in the HTML. A view-source leak exposes only a token that can
      // exclusively obtain PTY stream tickets — not make arbitrary API calls.
      const dashToken = crypto.randomBytes(16).toString('hex');
      this.dashboardTokens.set(dashToken, Date.now() + 10 * 60 * 1000);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (process.env.DEV_MODE) {
        // Hot-reload: bust module cache so each browser refresh picks up the latest compiled web-ui.js
        const webUiPath = require.resolve('../ui/web-ui');
        delete require.cache[webUiPath];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { generateDashboardHtml: fresh } = require('../ui/web-ui') as typeof import('../ui/web-ui');
        res.send(fresh(dashToken));
      } else {
        res.send(generateDashboardHtml(dashToken));
      }
    });

    // Process tree endpoint — returns raw ps data for dashboard.
    // Async exec + 3s cache: avoids blocking the event loop on every dashboard poll.
    this.app.get('/processes', (_req: Request, res: Response) => {
      const now = Date.now();
      if (this.processesCache && now - this.processesCache.ts < GatewayRouter.PROCESSES_CACHE_TTL_MS) {
        res.json({ processes: this.processesCache.data, numCpus: GatewayRouter.NUM_CPUS });
        return;
      }
      exec(
        "ps -eo pid,ppid,stat,%cpu,%mem,rss,args --no-headers 2>/dev/null | grep -E 'claude|bun.*gateway|bun.*mcp|bun.*receiver|node.*dist/' | grep -v grep | grep -v vscode",
        { encoding: 'utf8', timeout: 5000 },
        (err, stdout) => {
          if (err) process.stderr.write(`[processes] ps error: ${err.message}\n`);
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
          res.json({ processes, numCpus: GatewayRouter.NUM_CPUS });
        },
      );
    });

    // PTY screen snapshot — plain text, ANSI stripped. For agents that need to
    // observe what is currently displayed in the PTY shell to detect hangs, menu
    // states, or unexpected output without parsing escape codes.
    // Auth: X-Api-Key or Authorization: Bearer header (API keys only — no dashboard token,
    // as this endpoint is intended for programmatic/agent access, not the browser).
    this.app.get('/api/v1/sessions/:sessionId/screen', (req: Request, res: Response) => {
      const apiKeys = this.gatewayConfig?.gateway?.api?.keys ?? [];
      const authHeader = (req.headers['authorization'] as string | undefined) ?? '';
      const xApiKey = (req.headers['x-api-key'] as string | undefined) ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : xApiKey.trim();
      if (!token || !apiKeys.some((k) => k.key === token)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const sessionId = req.params['sessionId'] ?? '';
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required' });
        return;
      }

      if (!ptyStreamRegistry.hasSockets(sessionId)) {
        res.status(404).json({ error: 'Session not found or not running in PTY mode' });
        return;
      }

      ptyStreamRegistry.screenText(sessionId).then((snapshot) => {
        if (!snapshot) {
          res.status(404).json({ error: 'No screen data available for this session' });
          return;
        }
        res.json(snapshot);
      }).catch(() => {
        res.status(500).json({ error: 'Failed to read screen state' });
      });
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
        // PTY streams are keyed per session, so liveness is per session too.
        const sessions = runner.getSessionsSummary().map((s) => ({
          ...s,
          hasPtyStream: ptyStreamRegistry.hasSockets(s.sessionId),
        }));
        const hasPtyStream = sessions.some((s) => s.hasPtyStream);

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
          hasPtyStream,
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
        // Degraded file watchers (e.g. inotify ENOSPC). Empty array when healthy.
        watchers: getWatcherHealth(),
      });
    });
  }

  async start(port: number): Promise<void> {
    // Bind resolution precedence: GATEWAY_BIND env → gateway.bind config →
    // localhost-only default. The default is "127.0.0.1" so the dashboard/API
    // are not exposed to the local network out of the box; operators opt into
    // wider exposure via config or the env var (e.g. "0.0.0.0" behind a proxy).
    const host = resolveBindHost(process.env.GATEWAY_BIND, this.gatewayConfig?.gateway?.bind);
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

      // Cap inbound frame size at the WS layer so oversized frames are rejected
      // before we ever allocate a string from them (Issue #201). The only inbound
      // frames on this socket are interactive keystrokes, already bounded to
      // MAX_PTY_INPUT_BYTES; the headroom (8×) tolerates paste bursts while still
      // refusing abusive payloads. maxPayload only limits frames the server
      // *receives* — server → client PTY output is unaffected.
      this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PTY_INPUT_BYTES * 8 });
      const apiKeys = this.gatewayConfig?.gateway?.api?.keys ?? [];

      // Prune expired tickets and dashboard tokens every 60s.
      this.ticketPruner = setInterval(() => {
        const now = Date.now();
        for (const [k, v] of this.ptyStreamTickets) {
          if (v.expiresAt < now) this.ptyStreamTickets.delete(k);
        }
        for (const [k, exp] of this.dashboardTokens) {
          if (exp < now) this.dashboardTokens.delete(k);
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
          const sessionId = entry.sessionId;
          if (!this.agents.has(agentId)) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
          }
          this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
            this.attachPtyStreamSocket(ws, agentId, sessionId);
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
        // Streams are per-session; programmatic clients pass ?session=<sessionId>.
        const sessionId = params.get('session') ?? '';
        if (!sessionId) {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }

        this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          this.attachPtyStreamSocket(ws, agentId, sessionId);
        });
      });
    });
  }

  /**
   * Subscribe an authenticated WebSocket to a session's PTY output stream and
   * route inbound frames back into the live PTY (Issue #201). Output is one-way
   * (server → browser); inbound keystrokes are opt-in per browser via the Shell
   * Process Viewer's mode toggle (client-side UX), so a viewer only sends bytes
   * while in input mode. Access to this socket is protected upstream: the caller
   * has already authenticated (ticket or API key) and the gateway binds to
   * localhost by default (`gateway.bind`) — set a non-loopback bind only behind
   * a trusted proxy. Bytes are bounded (text-only, size-capped) and routed to
   * the owning session; a headless session (no PTY) silently drops them
   * (sendInputToSession → false).
   */
  private attachPtyStreamSocket(ws: WebSocket, agentId: string, sessionId: string): void {
    if (!ptyStreamRegistry.hasSockets(sessionId)) {
      ws.close(4404, 'session not running in PTY mode');
      return;
    }
    ptyStreamRegistry.subscribe(sessionId, ws);
    ws.on('close', () => ptyStreamRegistry.unsubscribe(sessionId, ws));
    ws.on('error', () => ptyStreamRegistry.unsubscribe(sessionId, ws));

    ws.on('message', (data: RawData, isBinary: boolean) => {
      // Text frames carry raw keystroke bytes from xterm's onData; binary frames
      // and oversized/empty payloads are dropped rather than routed into the PTY
      // (shared gate with the wrapper).
      const text = isBinary ? '' : data.toString('utf8');
      if (!shouldRoutePtyInput(isBinary, text)) return;
      this.agents.get(agentId)?.sendInputToSession(sessionId, text);
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
    // Terminate live WebSocket clients first. The dashboard PTY viewer holds these
    // open indefinitely; without an explicit terminate, server.close() below would
    // wait forever for them to drain (the "Ctrl+C twice" hang).
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
      this.wss.close();
    }
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      // Force-close idle and active keep-alive HTTP connections. The dashboard's
      // 3s/6s polling keeps connections alive, so server.close() — which only stops
      // accepting new connections and waits for existing ones — would otherwise hang.
      // closeAllConnections() is available on Node 18.2+.
      this.server.closeAllConnections?.();
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

