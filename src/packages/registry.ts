import { execSync } from 'child_process';
import { readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { compareSemver } from '../config/migrator';

/**
 * Version detection and self-update for the two packages the gateway manages:
 * itself and the Claude Code binary it drives.
 *
 * Shared by the HTTP API (src/api/packages.ts) and the CLI (`claude-gateway
 * update`, `claude-gateway claude update`) so both apply exactly the same
 * detect/update strategy — the CLI must never invent a second way to install
 * a package, or the dashboard and the terminal would disagree about what is
 * running.
 */

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
export interface PackageConfig {
  npm: string;
  detect: 'npm' | 'binary';
  bin?: string;
  update: 'npm' | 'native';
}

/**
 * Package id (URL param / CLI noun) → config.
 * claude-gateway is a genuine npm global — keep npm detect/update.
 * claude-code ships via the native installer (no longer an npm global), so
 * detect from the `claude` binary and update via its native updater.
 */
export const PACKAGES: Record<string, PackageConfig> = {
  'claude-gateway': { npm: '@0xmaxma/claude-gateway', detect: 'npm', update: 'npm' },
  'claude-code': {
    npm: '@anthropic-ai/claude-code',
    detect: 'binary',
    bin: 'claude',
    update: 'native',
  },
};

export interface PackageInfo {
  package: string;
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
}

export function getNpmListVersion(packageName: string): string | null {
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

/** Resolve the currently-installed version per the package's detect strategy. */
export function resolveCurrent(config: PackageConfig): string | null {
  if (config.detect === 'binary' && config.bin) {
    return getBinaryVersion(config.bin);
  }
  return getNpmListVersion(config.npm);
}

// An update is available only when `latest` is strictly newer than `current`.
// Using semver ordering (not `current !== latest`) avoids a false "update
// available" when the installed version is *ahead* of the npm-registry latest
// — e.g. a native-installer channel that leads the npm dist-tag.
export function updateAvailable(current: string | null, latest: string | null): boolean {
  return !!(current && latest && compareSemver(latest, current) > 0);
}

export async function getLatestVersion(packageName: string): Promise<string | null> {
  const encodedName = packageName.replace('/', '%2F');
  const res = await fetch(`https://registry.npmjs.org/${encodedName}/latest`);
  if (!res.ok) return null;
  const data = (await res.json()) as { version?: string };
  return data.version ?? null;
}

export async function fetchAllPackageVersions(): Promise<PackageInfo[]> {
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

function errorText(err: unknown, fallback: string): string {
  return (
    (err as { stderr?: Buffer }).stderr?.toString() ||
    (err as { message?: string }).message ||
    fallback
  );
}

/**
 * Run the package's own native updater (`<bin> update`).
 * Returns null on success, or the updater's error text.
 */
export function runNativeUpdate(config: PackageConfig): string | null {
  // Guarded here as well as at the call sites: without a bin there is no
  // updater to run, and shelling out would execute `undefined update`.
  if (!config.bin) return `no native updater configured for ${config.npm}`;
  try {
    execSync(`${config.bin} update`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000 });
    return null;
  } catch (err) {
    return errorText(err, 'update failed');
  }
}

/**
 * Install the latest version of an npm-global package.
 *
 * A previously interrupted install can leave `.<pkg>-<hash>` staging dirs in the
 * npm global root that make the next install fail with ENOTEMPTY/ENOTDIR, so
 * those are pre-cleaned and the install is retried once after removing the
 * half-written package directory. Returns null on success, or the error text.
 */
export function installNpmLatest(packageName: string): string | null {
  let npmRoot = '';
  try {
    npmRoot = getNpmGlobalRoot();
  } catch {
    // non-fatal: skip pre-clean if npm root unavailable
  }

  if (npmRoot) {
    cleanStaleNpmTempDirs(npmRoot, packageName);
  }

  try {
    execSync(`npm install -g ${packageName}@latest`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000 });
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    if (!npmRoot || !(stderr.includes('ENOTEMPTY') || stderr.includes('ENOTDIR'))) {
      return errorText(err, 'install failed');
    }
    // Remove stale temp dirs and the partially-installed package dir, then retry once
    cleanStaleNpmTempDirs(npmRoot, packageName);
    removePackageDir(npmRoot, packageName);
    try {
      execSync(`npm install -g ${packageName}@latest`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000 });
      return null;
    } catch (retryErr) {
      return errorText(retryErr, 'install failed');
    }
  }
}
