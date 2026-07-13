import { Router, Request, Response } from 'express';
import { execSync } from 'child_process';
import { readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { ApiKey } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import { compareSemver } from '../config/migrator';

type AuthedRequest = Request & { apiKey: ApiKey };

// Per-package resolver strategy.
//   npm    — npm registry name (used to look up `latest` for every package,
//            and to detect/update packages installed as an npm global)
//   detect — how the currently-installed version is resolved:
//              'npm'    → `npm list -g` (npm global package)
//              'binary' → shell out to the binary on PATH (native installer)
//   bin    — binary name for detect: 'binary' / update: 'native'
//   update — how the Update action installs the latest version:
//              'npm'    → `npm install -g <pkg>@latest`
//              'native' → the package's own native updater (`<bin> update`)
interface PackageConfig {
  npm: string;
  detect: 'npm' | 'binary';
  bin?: string;
  update: 'npm' | 'native';
}

// URL param "name" → package config.
// claude-gateway is a genuine npm global — keep npm detect/update.
// claude-code ships via the native installer (no longer an npm global), so
// detect from the `claude` binary and update via its native updater.
const PACKAGES: Record<string, PackageConfig> = {
  'claude-gateway': { npm: '@0xmaxma/claude-gateway', detect: 'npm', update: 'npm' },
  'claude-code': {
    npm: '@anthropic-ai/claude-code',
    detect: 'binary',
    bin: 'claude',
    update: 'native',
  },
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

// Resolve the installed version by shelling out to the binary on PATH
// (e.g. `claude --version` → "2.1.207 (Claude Code)"). Parses the leading
// semver (with optional prerelease) and returns null on any failure —
// binary missing, non-zero exit, or unparseable output. `bin` is always a
// trusted constant from PACKAGES, never request-derived.
function getBinaryVersion(bin: string): string | null {
  try {
    const output = execSync(`${bin} --version`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    // `claude --version` prints the version first (e.g. "2.1.207 (Claude Code)").
    // Anchor to the start of the trimmed output so a version-like token later in
    // the line can never be mistaken for the installed version.
    const match = output.trim().match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Resolve the currently-installed version per the package's detect strategy.
function resolveCurrent(config: PackageConfig): string | null {
  if (config.detect === 'binary' && config.bin) {
    return getBinaryVersion(config.bin);
  }
  return getNpmListVersion(config.npm);
}

// An update is available only when `latest` is strictly newer than `current`.
// Using semver ordering (not `current !== latest`) avoids a false "update
// available" when the installed version is *ahead* of the npm-registry latest
// — e.g. a native-installer channel that leads the npm dist-tag.
function updateAvailable(current: string | null, latest: string | null): boolean {
  return !!(current && latest && compareSemver(latest, current) > 0);
}

async function getLatestVersion(packageName: string): Promise<string | null> {
  const encodedName = packageName.replace('/', '%2F');
  const res = await fetch(`https://registry.npmjs.org/${encodedName}/latest`);
  if (!res.ok) return null;
  const data = (await res.json()) as { version?: string };
  return data.version ?? null;
}

async function fetchAllPackageVersions(): Promise<PackageInfo[]> {
  const configs = Object.values(PACKAGES);
  // Run all synchronous current-version lookups before entering async Promise.all
  const currents = configs.map(resolveCurrent);
  return Promise.all(
    configs.map(async (config, i) => {
      const current = currents[i];
      const latest = await getLatestVersion(config.npm);
      return {
        package: config.npm,
        current,
        latest,
        hasUpdate: updateAvailable(current, latest),
      };
    }),
  );
}

function getNpmGlobalRoot(): string {
  return execSync('npm root -g', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim();
}

function cleanStaleNpmTempDirs(npmRoot: string, packageName: string): void {
  const match = packageName.match(/^(@[^/]+)\/(.+)$/);
  if (!match) return;
  const [, scope, basename] = match;

  const scopeDir = join(npmRoot, scope);
  let entries: string[];
  try {
    entries = readdirSync(scopeDir, { withFileTypes: false }) as string[];
  } catch {
    return;
  }

  const prefix = `.${basename}-`;
  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      try {
        rmSync(join(scopeDir, entry), { recursive: true, force: true });
      } catch {
        // best-effort: ignore errors on individual temp dir removal
      }
    }
  }
}

function removePackageDir(npmRoot: string, packageName: string): void {
  const match = packageName.match(/^(@[^/]+)\/(.+)$/);
  if (!match) return;
  const [, scope, basename] = match;
  try {
    rmSync(join(npmRoot, scope, basename), { recursive: true, force: true });
  } catch {
    // best-effort
  }
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
        let updateErr: unknown = null;
        try {
          execSync(`${config.bin} update`, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 300_000,
          });
        } catch (err) {
          updateErr = err;
        }

        if (updateErr !== null) {
          const stderr =
            (updateErr as { stderr?: Buffer }).stderr?.toString() ??
            (updateErr as { message?: string }).message ??
            'update failed';
          res.status(500).json({ error: stderr });
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
      // Resolve npm global root for temp dir cleanup
      let npmRoot = '';
      try {
        npmRoot = getNpmGlobalRoot();
      } catch {
        // non-fatal: skip pre-clean if npm root unavailable
      }

      // Pre-clean any stale npm temp dirs left by previous interrupted installs
      if (npmRoot) {
        cleanStaleNpmTempDirs(npmRoot, packageName);
      }

      let installErr: unknown = null;
      try {
        execSync(`npm install -g ${packageName}@latest`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 300_000,
        });
      } catch (err) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
        if (npmRoot && (stderr.includes('ENOTEMPTY') || stderr.includes('ENOTDIR'))) {
          // Remove stale temp dirs and the partially-installed package dir, then retry once
          cleanStaleNpmTempDirs(npmRoot, packageName);
          removePackageDir(npmRoot, packageName);
          try {
            execSync(`npm install -g ${packageName}@latest`, {
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 300_000,
            });
          } catch (retryErr) {
            installErr = retryErr;
          }
        } else {
          installErr = err;
        }
      }

      if (installErr !== null) {
        const stderr = (installErr as { stderr?: Buffer }).stderr?.toString() ?? 'install failed';
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
