import { execFile, execSync } from 'child_process';
import { closeSync, openSync, readSync, realpathSync } from 'fs';
import { sep } from 'path';
import { compareSemver } from '../config/migrator';
import { RecoveryResult, npmCopyPresent, updateWithStagingRecovery } from './npm-staging';

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
 * claude-code is detected from the `claude` binary. It may be a native install
 * (updated with `claude update`) or an npm global (updated with npm, with the
 * staging-dir recovery); runNativeUpdate picks between them.
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

/**
 * Run a command without blocking the event loop (the HTTP API awaits package
 * updates, and an install can take minutes). Rejects with the child's stderr
 * attached, as `execSync` does, so `errorText` reads both the same way.
 */
function runAsync(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) {
        resolve();
        return;
      }
      const withStderr = err as Error & { stderr?: unknown };
      if (withStderr.stderr === undefined) withStderr.stderr = stderr;
      reject(withStderr);
    });
  });
}

/** `npm install -g <spec>`; resolves to null on success or npm's error text. */
async function npmInstallGlobal(spec: string): Promise<string | null> {
  try {
    await runAsync('npm', ['install', '-g', spec], 300_000);
    return null;
  } catch (err) {
    return errorText(err, 'install failed');
  }
}

function errorText(err: unknown, fallback: string): string {
  return (
    (err as { stderr?: Buffer | string }).stderr?.toString() ||
    (err as { message?: string }).message ||
    fallback
  );
}

/**
 * Whether the `claude` on PATH is a native-installer binary rather than the
 * npm package: anything that resolves inside the npm root is npm's, and a
 * `#!` script (such as a wrapper that picks among npm copies) is not proof of
 * a native install either.
 */
function pathBinIsNative(bin: string, npmRoot: string): boolean {
  let found: string;
  try {
    found = execSync(`command -v ${bin}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 }).trim();
    if (!found.startsWith('/')) return false;
    found = realpathSync(found);
  } catch {
    return false;
  }
  if (found.startsWith(realpathSync(npmRoot) + sep)) return false;
  const head = Buffer.alloc(2);
  let fd: number | undefined;
  try {
    fd = openSync(found, 'r');
    readSync(fd, head, 0, 2, 0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return head.toString('latin1') !== '#!';
}

/**
 * Update a native-updater package (claude-code) to `target`. On success returns
 * the version the installed binary now reports.
 *
 * claude-code can be a native install or an npm global; GetPod pods use npm.
 * For an npm global, `claude update` only runs `npm install -g` itself, so a
 * leftover npm staging dir makes it fail with ENOTEMPTY on every attempt
 * (issue #675). That layout is installed with npm directly, wrapped in
 * `updateWithStagingRecovery`, and checked by running the installed package's
 * own binaries rather than whatever `claude` PATH finds. npm is run directly
 * because the recovery may rename the package dir aside, which breaks the
 * `claude` that npm linked onto PATH.
 */
export async function runNativeUpdate(config: PackageConfig, target: string): Promise<RecoveryResult> {
  // Guarded here as well as at the call sites: without a bin there is no
  // updater to run, and shelling out would execute `undefined update`.
  const bin = config.bin;
  if (!bin) return { error: `no native updater configured for ${config.npm}` };

  let npmRoot = '';
  try {
    npmRoot = getNpmGlobalRoot();
  } catch {
    // No npm: a pure native install.
  }
  if (npmRoot && npmCopyPresent(npmRoot, config.npm) && !pathBinIsNative(bin, npmRoot)) {
    if (!SEMVER_RE.test(target)) return { error: `refusing to install invalid version: ${target}` };
    const spec = `${config.npm}@${target}`;
    try {
      return await updateWithStagingRecovery({
        npmRoot,
        packageName: config.npm,
        binName: bin,
        update: () => npmInstallGlobal(spec),
      });
    } catch (err) {
      return { error: `update recovery failed: ${errorText(err, 'unknown error')}` };
    }
  }

  try {
    await runAsync(bin, ['update'], 300_000);
  } catch (err) {
    return { error: errorText(err, 'update failed') };
  }
  const version = resolveCurrent(config);
  if (version === null) return { error: `update completed but \`${bin} --version\` reports no version` };
  return { error: null, version };
}

/**
 * Install `version` of an npm-global package (claude-gateway).
 *
 * A previously interrupted install can leave `.<pkg>-<hash>` staging dirs in the
 * npm global root that make the next install fail with ENOTEMPTY/ENOTDIR. The
 * install runs inside `updateWithStagingRecovery`, the same recovery claude-code
 * uses: a staging dir is removed only once the installed package is proven to
 * run, a broken package dir is moved aside rather than deleted and put back if
 * the install fails, and the result is checked by running the package's own
 * `<basename> --version` bin. Resolves to null on success, or the error text.
 */
export async function installNpmVersion(packageName: string, version: string): Promise<string | null> {
  if (!SEMVER_RE.test(version)) return `refusing to install invalid version: ${version}`;
  const spec = `${packageName}@${version}`;
  let npmRoot = '';
  try {
    npmRoot = getNpmGlobalRoot();
  } catch {
    // No npm root to recover in: npm reports its own error, if any.
  }
  if (!npmRoot) return npmInstallGlobal(spec);

  try {
    const result = await updateWithStagingRecovery({
      npmRoot,
      packageName,
      // The gateway's bin is named after the package (`claude-gateway`).
      binName: packageName.slice(packageName.lastIndexOf('/') + 1),
      update: () => npmInstallGlobal(spec),
    });
    return result.error;
  } catch (err) {
    return `update recovery failed: ${errorText(err, 'unknown error')}`;
  }
}
