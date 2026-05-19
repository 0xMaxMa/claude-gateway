import { Router, Request, Response } from 'express';
import { ApiKey } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import { AppsRegistry } from '../apps/registry';
import { AppInstaller } from '../apps/installer';
import { RegistryClient } from '../apps/registry-client';

type AuthedRequest = Request & { apiKey: ApiKey };

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
      res.json({ apps });
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
    const options = {
      registryApp: typeof body.registry_app === 'string' ? body.registry_app : undefined,
      version: typeof body.version === 'string' ? body.version : undefined,
      githubUrl: typeof body.github_url === 'string' ? body.github_url : undefined,
      commit: typeof body.commit === 'string' ? body.commit : undefined,
      localPath: typeof body.local_path === 'string' ? body.local_path : undefined,
      envVars: typeof body.env_vars === 'object' && body.env_vars !== null
        ? (body.env_vars as Record<string, string>)
        : undefined,
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
      res.json(entry);
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

      if (entry.source !== 'registry') {
        res.json({
          installed: entry.version,
          installed_commit: entry.commit,
          latest: null,
          latest_commit: null,
          behind: false,
          updateable: false,
        });
        return;
      }

      try {
        const app = await registryClient.findApp(entry.name);
        if (!app) {
          res.json({
            installed: entry.version,
            installed_commit: entry.commit,
            latest: null,
            latest_commit: null,
            behind: false,
            updateable: false,
          });
          return;
        }
        const latest = app.versions[app.versions.length - 1];
        res.json({
          installed: entry.version,
          installed_commit: entry.commit,
          latest: latest?.version ?? null,
          latest_commit: latest?.commit ?? null,
          behind: latest ? latest.commit !== entry.commit : false,
          updateable: latest ? latest.commit !== entry.commit : false,
        });
      } catch {
        // Registry unreachable — return what we know
        res.json({
          installed: entry.version,
          installed_commit: entry.commit,
          latest: null,
          latest_commit: null,
          behind: false,
          updateable: false,
        });
      }
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
      if (entry.source !== 'registry') {
        res.status(400).json({
          error: 'Only registry-installed apps can be updated via this endpoint',
        });
        return;
      }
      const jobId = installer.update(req.params.name);
      res.status(202).json({ jobId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
