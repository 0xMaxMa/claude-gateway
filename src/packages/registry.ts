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
//   npm    — npm registry name (used to look up the target version for every
//            package, and to detect/update packages installed as an npm global)
//   channel — npm dist-tag updates follow by default (see getTargetVersion)
//   detect — how the currently-installed version is resolved:
//              'npm'    → `npm list -g` (npm global package)
//              'binary' → shell out to the binary on PATH (native installer)
//   bin    — binary name for detect: 'binary' / update: 'native'
//   update — how the Update action installs the target version:
//              'npm'    → `npm install -g <pkg>@<version>`
//              'native' → the package's own native updater (`<bin> update`)
/** `stable` is moved by `make promote`; `latest` is every release. */
export type ReleaseChannel = 'stable' | 'latest';

export interface PackageConfig {
  npm: string;
  channel: ReleaseChannel;
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
  'claude-gateway': { npm: '@0xmaxma/claude-gateway', channel: 'stable', detect: 'npm', update: 'npm' },
  'claude-code': {
    npm: '@anthropic-ai/claude-code',
    channel: 'latest',
    detect: 'binary',
    bin: 'claude',
    update: 'native',
  },
};

export interface PackageInfo {
  package: string;
  current: string | null;
  /** The version an update installs, from the `channel` dist-tag. */
  target: string | null;
  /** Same value as `target`, kept for consumers written before channels. */
  latest: string | null;
  channel: ReleaseChannel | null;
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

// Registry data is untrusted and the version ends up in an `npm install` shell
// command, so anything that is not a plain semver is treated as no answer.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface TargetVersion {
  version: string;
  channel: ReleaseChannel;
}

/**
 * The version an update should install: the package's own channel, or
 * `latest` when `opts.latest` is set. A package that has never been promoted
 * has no `stable` dist-tag, so it falls back to `latest`. Returns null when
 * the registry answer is unusable; throws when the registry is unreachable.
 */
export async function getTargetVersion(
  config: PackageConfig,
  opts: { latest?: boolean } = {},
): Promise<TargetVersion | null> {
  const encodedName = config.npm.replace('/', '%2F');
  const res = await fetch(`https://registry.npmjs.org/-/package/${encodedName}/dist-tags`);
  if (!res.ok) return null;
  const tags = (await res.json()) as Record<string, unknown>;
  const wanted: ReleaseChannel = opts.latest ? 'latest' : config.channel;
  const channel: ReleaseChannel = typeof tags[wanted] === 'string' ? wanted : 'latest';
  const version = tags[channel];
  return typeof version === 'string' && SEMVER_RE.test(version) ? { version, channel } : null;
}

export async function fetchAllPackageVersions(): Promise<PackageInfo[]> {
  const configs = Object.values(PACKAGES);
  // Run all synchronous current-version lookups before entering async Promise.all
  const currents = configs.map(resolveCurrent);
  return Promise.all(
    configs.map(async (config, i) => {
      const current = currents[i];
      const target = await getTargetVersion(config);
      return {
        package: config.npm,
        current,
        target: target?.version ?? null,
        latest: target?.version ?? null,
        channel: target?.channel ?? null,
        hasUpdate: updateAvailable(current, target?.version ?? null),
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
 * Install `version` of an npm-global package.
 *
 * A previously interrupted install can leave `.<pkg>-<hash>` staging dirs in the
 * npm global root that make the next install fail with ENOTEMPTY/ENOTDIR, so
 * those are pre-cleaned and the install is retried once after removing the
 * half-written package directory. Returns null on success, or the error text.
 */
export function installNpmVersion(packageName: string, version: string): string | null {
  if (!SEMVER_RE.test(version)) return `refusing to install invalid version: ${version}`;
  const spec = `${packageName}@${version}`;
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
    execSync(`npm install -g ${spec}`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000 });
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
      execSync(`npm install -g ${spec}`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000 });
      return null;
    } catch (retryErr) {
      return errorText(retryErr, 'install failed');
    }
  }
}
