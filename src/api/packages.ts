import { Router, Request, Response } from 'express';
import { ApiKey } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import {
  PACKAGES,
  PackageInfo,
  fetchAllPackageVersions,
  getLatestVersion,
  getNpmListVersion,
  installNpmLatest,
  resolveCurrent,
  runNativeUpdate,
  updateAvailable,
} from '../packages/registry';

type AuthedRequest = Request & { apiKey: ApiKey };

/**
 * HTTP surface over src/packages/registry.ts. This module owns only the
 * request-scoped concerns — auth, the 5-minute version cache, the
 * one-update-at-a-time lock, and the self-restart after the gateway updates
 * itself. Detection and install strategy live in the shared registry so the
 * CLI (`claude-gateway update`) behaves identically.
 */

interface CacheEntry {
  data: PackageInfo[];
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

let versionCache: CacheEntry | null = null;
let isUpdating = false;

export function _resetCache(): void {
  versionCache = null;
}

export function _resetLock(): void {
  isUpdating = false;
}

export function _setLock(): void {
  isUpdating = true;
}

export function createPackagesRouter(apiKeys?: ApiKey[]): Router {
  const router = Router();

  if (apiKeys?.length) {
    router.use(createApiAuthMiddleware(apiKeys));
  }

  // GET /api/v1/packages — version check for both packages (cached 5 min)
  router.get('/v1/packages', async (req: Request, res: Response) => {
    if (apiKeys?.length) {
      const apiKey = (req as AuthedRequest).apiKey;
      if (!isAdmin(apiKey)) {
        res.status(403).json({ error: 'admin API key required' });
        return;
      }
    }

    if (versionCache && versionCache.expiresAt > Date.now()) {
      res.json({ packages: versionCache.data });
      return;
    }

    let packages: PackageInfo[];
    try {
      packages = await fetchAllPackageVersions();
    } catch {
      res.status(503).json({ error: 'registry unavailable' });
      return;
    }

    versionCache = { data: packages, expiresAt: Date.now() + CACHE_TTL_MS };
    res.json({ packages });
  });

  // POST /api/v1/packages/:name/update — install latest and restart if needed
  router.post('/v1/packages/:name/update', async (req: Request, res: Response) => {
    if (apiKeys?.length) {
      const apiKey = (req as AuthedRequest).apiKey;
      if (!isAdmin(apiKey)) {
        res.status(403).json({ error: 'admin API key required' });
        return;
      }
    }

    const { name } = req.params as { name: string };
    const config = PACKAGES[name];
    if (!config) {
      res.status(404).json({ error: `unknown package: ${name}` });
      return;
    }
    const packageName = config.npm;

    const from = resolveCurrent(config);

    let latest: string | null;
    try {
      latest = await getLatestVersion(packageName);
    } catch {
      res.status(503).json({ error: 'registry unavailable' });
      return;
    }

    if (!latest) {
      res.status(503).json({ error: 'registry unavailable' });
      return;
    }

    // Already on latest (or ahead of it) — no install needed
    if (from && !updateAvailable(from, latest)) {
      res.json({ package: packageName, from, to: from, updated: false, warning: null });
      return;
    }

    // Reject if another update is already in progress
    if (isUpdating) {
      res.status(409).json({ error: 'update already in progress' });
      return;
    }

    isUpdating = true;
    try {
      // Native-installer packages (e.g. claude-code) update the binary on PATH
      // via their own updater. npm install -g would write a separate npm copy
      // that isn't the running binary, so it must not be used here.
      if (config.update === 'native' && config.bin) {
        const updateErr = runNativeUpdate(config);
        if (updateErr !== null) {
          res.status(500).json({ error: updateErr });
          return;
        }

        // Invalidate version cache and re-read the actual binary version.
        // The native updater may legitimately be a no-op (already newest on its
        // own channel), so report `updated` from whether the version changed.
        versionCache = null;
        const to = resolveCurrent(config);
        res.json({ package: packageName, from, to, updated: to !== from, warning: null });
        return;
      }

      // npm-global packages (e.g. claude-gateway) update via npm install -g.
      const installErr = installNpmLatest(packageName);
      if (installErr !== null) {
        res.status(500).json({ error: installErr });
        return;
      }

      // Invalidate version cache after successful install
      versionCache = null;

      const to = getNpmListVersion(packageName);

      if (name === 'claude-gateway') {
        // `claimSupervisorEnv()` scrubs the inherited markers at boot and records
        // the supervisor in their place; the raw markers are still honoured for
        // a server embedded without going through that entry point.
        const claimed = process.env.CLAUDE_GATEWAY_SUPERVISOR;
        const isSystemd = claimed === 'systemd' || !!process.env.INVOCATION_ID;
        const isPm2 = claimed === 'pm2' || !!process.env.PM2_HOME || process.env.pm_id !== undefined;
        const isManaged = isSystemd || isPm2;

        res.json({
          package: packageName,
          from,
          to,
          updated: true,
          warning: isManaged ? 'service will restart' : 'process will stop — restart manually',
        });

        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
      } else {
        res.json({ package: packageName, from, to, updated: true, warning: null });
      }
    } finally {
      isUpdating = false;
    }
  });

  return router;
}
