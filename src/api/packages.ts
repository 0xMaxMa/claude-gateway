import { Router, Request, Response } from 'express';
import { execSync } from 'child_process';
import { ApiKey } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';

type AuthedRequest = Request & { apiKey: ApiKey };

// URL param "name" → npm package name
const PACKAGE_MAP: Record<string, string> = {
  'claude-gateway': '@0xmaxma/claude-gateway',
  'claude-code': '@anthropic-ai/claude-code',
};

interface PackageInfo {
  package: string;
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
}

interface CacheEntry {
  data: PackageInfo[];
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

let versionCache: CacheEntry | null = null;

export function _resetCache(): void {
  versionCache = null;
}

function getNpmListVersion(packageName: string): string | null {
  try {
    const output = execSync(`npm list -g ${packageName} --depth=0 --json`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    const parsed = JSON.parse(output) as { dependencies?: Record<string, { version: string }> };
    return parsed.dependencies?.[packageName]?.version ?? null;
  } catch {
    return null;
  }
}

async function getLatestVersion(packageName: string): Promise<string | null> {
  const encodedName = packageName.replace('/', '%2F');
  const res = await fetch(`https://registry.npmjs.org/${encodedName}/latest`);
  if (!res.ok) return null;
  const data = (await res.json()) as { version?: string };
  return data.version ?? null;
}

async function fetchAllPackageVersions(): Promise<PackageInfo[]> {
  const pkgs = Object.values(PACKAGE_MAP);
  // Run all synchronous npm list calls before entering async Promise.all
  const currents = pkgs.map(getNpmListVersion);
  return Promise.all(
    pkgs.map(async (pkg, i) => {
      const current = currents[i];
      const latest = await getLatestVersion(pkg);
      return {
        package: pkg,
        current,
        latest,
        hasUpdate: !!(current && latest && current !== latest),
      };
    }),
  );
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
    const packageName = PACKAGE_MAP[name];
    if (!packageName) {
      res.status(404).json({ error: `unknown package: ${name}` });
      return;
    }

    const from = getNpmListVersion(packageName);

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

    // Already on latest — no install needed
    if (from === latest) {
      res.json({ package: packageName, from, to: from, updated: false, warning: null });
      return;
    }

    // Run npm install
    try {
      execSync(`npm install -g ${packageName}@latest`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
      });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? 'install failed';
      res.status(500).json({ error: stderr });
      return;
    }

    // Invalidate version cache after successful install
    versionCache = null;

    const to = getNpmListVersion(packageName);

    if (name === 'claude-gateway') {
      const isSystemd = !!process.env.INVOCATION_ID;
      const isPm2 = !!process.env.PM2_HOME || process.env.pm_id !== undefined;
      const isManaged = isSystemd || isPm2;

      res.json({
        package: packageName,
        from,
        to,
        updated: true,
        warning: isManaged ? 'service will restart' : 'process will stop — restart manually',
      });

      setTimeout(() => process.exit(0), 500);
    } else {
      res.json({ package: packageName, from, to, updated: true, warning: null });
    }
  });

  return router;
}
