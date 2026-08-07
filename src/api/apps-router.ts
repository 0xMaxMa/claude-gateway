import { Router, Request, Response } from 'express';
import { ApiKey } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import { AppsRegistry } from '../apps/registry';
import { AppInstaller } from '../apps/installer';
import { RegistryClient } from '../apps/registry-client';
import { assertValidHostPort } from '../apps/compose-generator';

type AuthedRequest = Request & { apiKey: ApiKey };

/**
 * Parse a request-body `ports` field into a validated host-port override map.
 * Returns undefined when absent. Throws (→ 400) on a non-object, a non-integer
 * value, or a banned / sub-1024 port — the same floor generateCompose enforces,
 * surfaced synchronously so callers get a clear error instead of a failed job.
 */
function parsePortsField(raw: unknown): Record<string, number> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('"ports" must be an object mapping port name to host port');
  }
  const out: Record<string, number> = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== 'number' || !Number.isInteger(val)) {
      throw new Error(`Port override "${name}" must be an integer`);
    }
    assertValidHostPort(name, val); // throws on banned / < 1024
    out[name] = val;
  }
  return out;
}

/**
 * Parse a request-body `env_vars` field into a validated string map. Returns
 * undefined when absent. Throws (→ 400) on a non-object or a non-string value.
 */
function parseEnvVarsField(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('"env_vars" must be an object');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error(`env var "${k}" must be a string`);
    }
    out[k] = v;
  }
  return out;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createAppsRouter(
  registry: AppsRegistry,
  installer: AppInstaller,
  registryClient: RegistryClient,
  apiKeys: ApiKey[],
): Router {
  const router = Router();

  // All apps endpoints require authentication
  if (apiKeys.length) {
    router.use(createApiAuthMiddleware(apiKeys));
  }

  // ── Registry browsing (read-only, any authenticated key) ─────────────────

  /** GET /api/v1/apps/registry — fetch community registry (5-min cached) */
  router.get('/v1/apps/registry', async (_req: Request, res: Response) => {
    try {
      const reg = await registryClient.fetchRegistry();
      res.json(reg);
    } catch (err) {
      res.status(502).json({ error: `Registry fetch failed: ${(err as Error).message}` });
    }
  });

  /** GET /api/v1/apps/registry/:name — versions of a specific app */
  router.get('/v1/apps/registry/:name', async (req: Request, res: Response) => {
    try {
      const app = await registryClient.findApp(req.params.name);
      if (!app) {
        res.status(404).json({ error: `App "${req.params.name}" not found in registry` });
        return;
      }
      res.json(app);
    } catch (err) {
      res.status(502).json({ error: `Registry fetch failed: ${(err as Error).message}` });
    }
  });

  // ── Installed apps (admin required for mutations) ─────────────────────────

  /** GET /api/v1/apps — list installed apps */
  router.get('/v1/apps', async (_req: Request, res: Response) => {
    try {
      const apps = await registry.list();
      // Reconcile each stored status against the live Docker runtime so a
      // container that crashed/was killed externally no longer reports running.
      const reconciled = await installer.reconcileStatuses(apps);
      res.json({ apps: reconciled });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** POST /api/v1/apps/install — async install → { jobId } */
  router.post('/v1/apps/install', (req: Request, res: Response) => {
    const authed = req as AuthedRequest;
    if (!isAdmin(authed.apiKey)) {
      res.status(403).json({ error: 'Admin access required to install apps' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    let portOverrides: Record<string, number> | undefined;
    try {
      portOverrides = parsePortsField(body.ports);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const options = {
      registryApp: typeof body.registry_app === 'string' ? body.registry_app : undefined,
      version: typeof body.version === 'string' ? body.version : undefined,
      githubUrl: typeof body.github_url === 'string' ? body.github_url : undefined,
      commit: typeof body.commit === 'string' ? body.commit : undefined,
      localPath: typeof body.local_path === 'string' ? body.local_path : undefined,
      envVars: typeof body.env_vars === 'object' && body.env_vars !== null && !Array.isArray(body.env_vars)
        ? (body.env_vars as Record<string, string>)
        : undefined,
      portOverrides,
    };

    if (!options.registryApp && !options.githubUrl && !options.localPath) {
      res.status(400).json({
        error: 'Provide one of: registry_app, github_url + commit, or local_path',
      });
      return;
    }

    try {
      const jobId = installer.install(options);
      res.status(202).json({ jobId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/v1/apps/inspect — read-only preview of an install source.
   * Fetches and parses the app.yaml (without installing) so callers can see the
   * required secrets (`secretKeys`) and auto-generated secrets (`generatedKeys`)
   * before install — essential for GitHub-URL apps that have no registry entry.
   * Admin-gated to match the install authorization floor.
   */
  router.post('/v1/apps/inspect', async (req: Request, res: Response) => {
    const authed = req as AuthedRequest;
    if (!isAdmin(authed.apiKey)) {
      res.status(403).json({ error: 'Admin access required to inspect apps' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const options = {
      registryApp: typeof body.registry_app === 'string' ? body.registry_app : undefined,
      version: typeof body.version === 'string' ? body.version : undefined,
      githubUrl: typeof body.github_url === 'string' ? body.github_url : undefined,
      commit: typeof body.commit === 'string' ? body.commit : undefined,
      localPath: typeof body.local_path === 'string' ? body.local_path : undefined,
    };

    if (!options.registryApp && !options.githubUrl && !options.localPath) {
      res.status(400).json({
        error: 'Provide one of: registry_app, github_url, or local_path',
      });
      return;
    }

    try {
      const info = await installer.inspectSource(options);
      res.json(info);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** GET /api/v1/apps/jobs/:jobId — poll install job status */
  router.get('/v1/apps/jobs/:jobId', (req: Request, res: Response) => {
    const job = installer.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(job);
  });

  /** GET /api/v1/apps/:name — app info + status */
  router.get('/v1/apps/:name', async (req: Request, res: Response) => {
    try {
      const entry = await registry.get(req.params.name);
      if (!entry) {
        res.status(404).json({ error: `App "${req.params.name}" not found` });
        return;
      }
      // Reconcile the stored status against the live Docker runtime before return.
      const reconciled = await installer.reconcileStatus(entry);
      res.json(reconciled);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** DELETE /api/v1/apps/:name — uninstall */
  router.delete('/v1/apps/:name', async (req: Request, res: Response) => {
    const authed = req as AuthedRequest;
    if (!isAdmin(authed.apiKey)) {
      res.status(403).json({ error: 'Admin access required to uninstall apps' });
      return;
    }

    try {
      await installer.uninstall(req.params.name);
      res.json({ deleted: true, name: req.params.name });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not installed')) {
        res.status(404).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  /** POST /api/v1/apps/:name/start|stop|restart */
  router.post(
    '/v1/apps/:name/:action(start|stop|restart)',
    async (req: Request, res: Response) => {
      const authed = req as AuthedRequest;
      if (!isAdmin(authed.apiKey)) {
        res.status(403).json({ error: 'Admin access required' });
        return;
      }

      const action = req.params.action as 'start' | 'stop' | 'restart';
      try {
        await installer.startStopRestart(req.params.name, action);
        res.json({ name: req.params.name, action });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('not installed')) {
          res.status(404).json({ error: msg });
        } else {
          res.status(500).json({ error: msg });
        }
      }
    },
  );

  /** GET /api/v1/apps/:name/version — version info + updateability */
  router.get('/v1/apps/:name/version', async (req: Request, res: Response) => {
    try {
      const entry = await registry.get(req.params.name);
      if (!entry) {
        res.status(404).json({ error: `App "${req.params.name}" not found` });
        return;
      }

      const info = await installer.getUpdateInfo(entry);
      res.json({
        installed: entry.version,
        installed_commit: entry.commit,
        latest: info.latestVersion,
        latest_commit: info.latestCommit,
        behind: info.updateable,
        updateable: info.updateable,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** POST /api/v1/apps/:name/update — async update → { jobId } */
  router.post('/v1/apps/:name/update', async (req: Request, res: Response) => {
    const authed = req as AuthedRequest;
    if (!isAdmin(authed.apiKey)) {
      res.status(403).json({ error: 'Admin access required to update apps' });
      return;
    }

    try {
      const entry = await registry.get(req.params.name);
      if (!entry) {
        res.status(404).json({ error: `App "${req.params.name}" not found` });
        return;
      }
      if (entry.source === 'local') {
        res.status(400).json({
          error: 'Local (symlinked) apps cannot be updated — reinstall from source instead',
        });
        return;
      }
      const jobId = installer.update(req.params.name);
      res.status(202).json({ jobId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/v1/apps/:name/reconfigure — async reconfigure → { jobId }.
   * Merges `env_vars` into the app's existing .env (keys not sent are kept) and
   * optionally overrides host `ports`, then force-recreates the container while
   * preserving its named volumes/data. Admin-gated to match install/update.
   */
  router.post('/v1/apps/:name/reconfigure', async (req: Request, res: Response) => {
    const authed = req as AuthedRequest;
    if (!isAdmin(authed.apiKey)) {
      res.status(403).json({ error: 'Admin access required to reconfigure apps' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    let envVars: Record<string, string> | undefined;
    let portOverrides: Record<string, number> | undefined;
    try {
      envVars = parseEnvVarsField(body.env_vars);
      portOverrides = parsePortsField(body.ports);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    const hasEnv = envVars !== undefined && Object.keys(envVars).length > 0;
    const hasPorts = portOverrides !== undefined && Object.keys(portOverrides).length > 0;
    if (!hasEnv && !hasPorts) {
      res.status(400).json({ error: 'Provide env_vars and/or ports to reconfigure' });
      return;
    }

    try {
      const entry = await registry.get(req.params.name);
      if (!entry) {
        res.status(404).json({ error: `App "${req.params.name}" not found` });
        return;
      }
      if (entry.source === 'local') {
        res.status(400).json({
          error: 'Local (symlinked) apps cannot be reconfigured — reinstall from source instead',
        });
        return;
      }
      // Reject overrides for ports the app does not declare — the registry entry
      // already carries the valid port names, so this is a clean 400 up front
      // rather than a failed job.
      if (hasPorts && portOverrides) {
        const knownPorts = new Set(entry.ports.map((p) => p.name));
        const unknown = Object.keys(portOverrides).filter((name) => !knownPorts.has(name));
        if (unknown.length > 0) {
          res.status(400).json({
            error: `Unknown port name(s): ${unknown.join(', ')}`,
          });
          return;
        }
      }
      // Cross-app host-port collision — deterministic, so reject up front (400).
      if (hasPorts && portOverrides) {
        const collision = await installer.findHostPortCollision(
          req.params.name,
          Object.entries(portOverrides).map(([name, hostPort]) => ({ name, hostPort })),
        );
        if (collision) {
          res.status(400).json({ error: collision });
          return;
        }
      }
      const jobId = installer.reconfigure(req.params.name, { envVars, portOverrides });
      res.status(202).json({ jobId });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('already being')) {
        res.status(409).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
