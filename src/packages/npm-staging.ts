import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';

/**
 * Recovery for an npm-global package whose install left a `.<name>-<hash>`
 * staging dir behind (issue #675).
 *
 * npm moves the installed package dir to that staging name before writing the
 * new version. If an earlier install was interrupted, the staging dir already
 * exists and holds files, so the rename fails with ENOTEMPTY on every later
 * install. When the package dir is absent npm has nothing to move and skips
 * the rename.
 *
 * The staging dir can be the only working copy: after a disk-full install the
 * package dir held a truncated binary and the `claude` wrapper ran the staging
 * copy. So nothing here removes a dir unless a runnable replacement has been
 * proven first, and the broken package dir is renamed aside, never deleted,
 * until the new install passes the probe.
 */

const VERSION_RE = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

export interface NpmPackageLayout {
  /** `<npm root>/@scope` (or the npm root for an unscoped package). */
  parentDir: string;
  /** `<npm root>/@scope/<name>`; may not exist. */
  packageDir: string;
  /** Existing `.<name>-<hash>` staging dirs next to `packageDir`. */
  stagingDirs: string[];
}

export function npmPackageLayout(npmRoot: string, packageName: string): NpmPackageLayout | null {
  const match = packageName.match(/^(?:(@[^/]+)\/)?([^/@][^/]*)$/);
  if (!match) return null;
  const [, scope, basename] = match;
  const parentDir = scope ? join(npmRoot, scope) : npmRoot;
  let entries: string[] = [];
  try {
    entries = readdirSync(parentDir);
  } catch {
    // No scope dir yet: nothing installed and nothing staged.
  }
  // npm names a staging dir `.<name>-` + an 8-character hash (arborist
  // retire-path.js). Matching the hash length keeps a sibling package such as
  // `<name>-foo` and its own staging dirs out.
  const prefix = `.${basename}-`;
  const isStaging = (e: string) => e.startsWith(prefix) && /^[A-Za-z0-9_-]{8}$/.test(e.slice(prefix.length));
  return {
    parentDir,
    packageDir: join(parentDir, basename),
    stagingDirs: entries.filter(isStaging).map((e) => join(parentDir, e)),
  };
}

/** Executable entry points a package dir provides for `binName`: the bin its
 *  package.json declares (what npm links onto PATH) and any platform-package
 *  binary under `node_modules/<scope>/<name>-*` (what the `claude` wrapper
 *  runs). Paths that resolve outside `packageDir` are ignored. */
function entryPoints(packageDir: string, packageName: string, binName: string): string[] {
  const root = resolve(packageDir);
  const inside = (p: string) => p.startsWith(root + sep);
  const found: string[] = [];

  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { bin?: unknown };
    const declared =
      typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin as Record<string, unknown> | undefined)?.[binName];
    if (typeof declared === 'string') {
      const p = resolve(root, declared);
      if (inside(p) && existsSync(p)) found.push(p);
    }
  } catch {
    // Missing or unreadable package.json: rely on the platform binaries.
  }

  const [scope, basename] = packageName.startsWith('@') ? packageName.split('/') : ['', packageName];
  const platformParent = scope ? join(root, 'node_modules', scope) : join(root, 'node_modules');
  try {
    for (const entry of readdirSync(platformParent)) {
      if (!entry.startsWith(`${basename}-`)) continue;
      const p = join(platformParent, entry, binName);
      if (inside(p) && existsSync(p)) found.push(p);
    }
  } catch {
    // No platform packages.
  }
  return found;
}

/**
 * Run every entry point of `packageDir` with `--version`. Returns the version
 * when at least one exists and all of them exit 0 and print a version, else
 * null. A truncated binary fails here even though a `claude` found on PATH may
 * still answer.
 */
export function probePackageDir(packageDir: string, packageName: string, binName: string): string | null {
  const bins = entryPoints(packageDir, packageName, binName);
  if (bins.length === 0) return null;
  let version: string | null = null;
  for (const bin of bins) {
    try {
      const out = execFileSync(bin, ['--version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      const m = out.trim().match(VERSION_RE);
      if (!m) return null;
      version ??= m[1];
    } catch {
      return null;
    }
  }
  return version;
}

const LOCK_NAME = '.claude-gateway-update.lock';
/** A lock file with no readable pid this old is a leftover, not a starting owner. */
const PIDLESS_LOCK_GRACE_MS = 60_000;

/** An exclusive lock for the claude-code recovery, shared by the API and the
 *  CLI (the API's in-process flag cannot see a CLI run). Returns a release
 *  function, or null when another live process holds it. */
export function acquireUpdateLock(npmRoot: string): (() => void) | null {
  const lockFile = join(npmRoot, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return () => {
        try {
          rmSync(lockFile, { force: true });
        } catch {
          // A lock that cannot be removed is reported by the next caller.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (attempt > 0) return null;
      const seen = readLock(lockFile);
      if (!seen.stale) return null;
      // Take the stale lock over by renaming it to a name only this process
      // uses, then check it is still the lock judged stale. If a concurrent
      // caller replaced it in between, put theirs back and back off.
      const claimed = `${lockFile}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(lockFile, claimed);
      } catch {
        return null;
      }
      const taken = readLock(claimed);
      if (taken.content !== seen.content) {
        try {
          renameSync(claimed, lockFile);
        } catch {
          // The other caller's lock is gone either way; it re-checks on release.
        }
        return null;
      }
      rmSync(claimed, { force: true });
    }
  }
  return null;
}

function readLock(lockFile: string): { content: string | null; stale: boolean } {
  let content: string;
  let mtimeMs: number;
  try {
    content = readFileSync(lockFile, 'utf-8').trim();
    mtimeMs = statSync(lockFile).mtimeMs;
  } catch {
    return { content: null, stale: false };
  }
  const pid = Number(content);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { content, stale: Date.now() - mtimeMs > PIDLESS_LOCK_GRACE_MS };
  }
  try {
    process.kill(pid, 0);
    return { content, stale: false };
  } catch (err) {
    return { content, stale: (err as NodeJS.ErrnoException).code === 'ESRCH' };
  }
}

export type RecoveryResult = { error: string } | { error: null; version: string };

export interface StagingRecoveryOptions {
  npmRoot: string;
  packageName: string;
  binName: string;
  /** Runs the updater. Resolves to null on success or its error text. It must
   *  not depend on the package dir, which may be renamed aside while it runs,
   *  and it must not block the event loop: the HTTP API awaits it. */
  update: () => Promise<string | null>;
}

/** npm's error codes for the rename that collides with a leftover staging dir
 *  (npm prints `npm error code ENOTEMPTY`). Only these are worth a retry. */
function isStagingCollision(errorText: string): boolean {
  return errorText.includes('ENOTEMPTY') || errorText.includes('ENOTDIR');
}

/**
 * Run `update` with the staging-dir recovery around it:
 *
 * - package dir runnable + staging dirs → remove the staging dirs (the package
 *   dir is the proven replacement), then update.
 * - package dir not runnable + staging dirs → rename the package dir aside so
 *   npm skips the rename that collides with the staging dir, keep the staging
 *   dirs (they may be what is serving sessions), then update.
 * - After the update, probe the package dir. Only when it is runnable are the
 *   staging dirs and the renamed-aside dir removed. Otherwise the renamed dir
 *   is put back, so a failure leaves the state as it was.
 * - A failure is retried once when npm reports the staging-dir collision
 *   (ENOTEMPTY/ENOTDIR) and a staging dir still exists. Any other failure is
 *   returned as is: a retry would not change it and doubles the wait.
 */
export async function updateWithStagingRecovery(opts: StagingRecoveryOptions): Promise<RecoveryResult> {
  const { npmRoot, packageName, binName, update } = opts;
  const release = acquireUpdateLock(npmRoot);
  if (!release) {
    return { error: `another update of ${packageName} is already running (lock in ${npmRoot})` };
  }
  try {
    restoreOrphanedAside(npmRoot, packageName, binName);
    let lastError = 'update failed';
    for (let attempt = 0; attempt < 2; attempt++) {
      const layout = npmPackageLayout(npmRoot, packageName);
      if (!layout) return { error: `cannot locate ${packageName} under ${npmRoot}` };
      const aside = prepare(layout, npmRoot, packageName, binName);

      const updateErr = await update();
      if (updateErr === null) {
        const version = probePackageDir(layout.packageDir, packageName, binName);
        if (version !== null) {
          // The new install is proven, so the leftovers can go. Best-effort: a
          // dir that survives is removed by the next update's first step.
          for (const dir of [...currentStaging(npmRoot, packageName), ...(aside ? [aside] : [])]) {
            try {
              rmSync(dir, { recursive: true, force: true });
            } catch {
              // leave it for the next run
            }
          }
          return { error: null, version };
        }
        rollback(layout, aside, packageName, binName);
        return {
          error:
            `update completed but ${layout.packageDir} is not runnable` +
            describeStaging(npmRoot, packageName),
        };
      }

      rollback(layout, aside, packageName, binName);
      lastError = updateErr;
      if (!isStagingCollision(updateErr) || currentStaging(npmRoot, packageName).length === 0) break;
    }
    return { error: lastError + describeStaging(npmRoot, packageName) };
  } finally {
    release();
  }
}

function currentStaging(npmRoot: string, packageName: string): string[] {
  return npmPackageLayout(npmRoot, packageName)?.stagingDirs ?? [];
}

/** Clear the way for npm. Returns the path the package dir was renamed to, if it was. */
function prepare(layout: NpmPackageLayout, npmRoot: string, packageName: string, binName: string): string | null {
  if (layout.stagingDirs.length === 0) return null;
  if (probePackageDir(layout.packageDir, packageName, binName) !== null) {
    for (const dir of layout.stagingDirs) rmSync(dir, { recursive: true, force: true });
    return null;
  }
  if (!existsSync(layout.packageDir)) return null;
  // Same filesystem as the package dir, so the rename is atomic. The name is
  // not a staging-dir name, so npm and this module never treat it as one.
  const aside = join(npmRoot, `${asidePrefix(packageName)}${process.pid}-${Date.now()}`);
  renameSync(layout.packageDir, aside);
  return aside;
}

/** Whether `npmRoot` holds any copy of the package: installed, staged by npm,
 *  or renamed aside by an update that was killed. */
export function npmCopyPresent(npmRoot: string, packageName: string): boolean {
  const layout = npmPackageLayout(npmRoot, packageName);
  if (!layout) return false;
  if (existsSync(layout.packageDir) || layout.stagingDirs.length > 0) return true;
  try {
    return readdirSync(npmRoot).some((e) => e.startsWith(asidePrefix(packageName)));
  } catch {
    return false;
  }
}

function asidePrefix(packageName: string): string {
  return `.claude-gateway-aside-${packageName.replace(/[@/]/g, '_')}-`;
}

/**
 * A process killed mid-update leaves the package dir renamed aside. Put it back
 * when the package dir is missing; drop it once the package dir is runnable.
 * An aside dir next to a package dir that does not run is left for a person:
 * neither copy is proven, so neither is deleted.
 */
function restoreOrphanedAside(npmRoot: string, packageName: string, binName: string): void {
  const layout = npmPackageLayout(npmRoot, packageName);
  if (!layout) return;
  const prefix = asidePrefix(packageName);
  let entries: string[];
  try {
    entries = readdirSync(npmRoot);
  } catch {
    return;
  }
  for (const entry of entries.filter((e) => e.startsWith(prefix)).sort().reverse()) {
    const aside = join(npmRoot, entry);
    if (!existsSync(layout.packageDir)) {
      // npm removes a scope dir it leaves empty.
      mkdirSync(layout.parentDir, { recursive: true });
      renameSync(aside, layout.packageDir);
    } else if (probePackageDir(layout.packageDir, packageName, binName) !== null) {
      rmSync(aside, { recursive: true, force: true });
    }
  }
}

/** Undo `prepare` after a failed update: a runnable package dir stays, an
 *  unrunnable one is replaced by the renamed-aside original. */
function rollback(layout: NpmPackageLayout, aside: string | null, packageName: string, binName: string): void {
  if (!aside) return;
  if (existsSync(layout.packageDir)) {
    if (probePackageDir(layout.packageDir, packageName, binName) !== null) {
      rmSync(aside, { recursive: true, force: true });
      return;
    }
    rmSync(layout.packageDir, { recursive: true, force: true });
  }
  renameSync(aside, layout.packageDir);
}

function describeStaging(npmRoot: string, packageName: string): string {
  const layout = npmPackageLayout(npmRoot, packageName);
  if (!layout || layout.stagingDirs.length === 0) return '';
  return (
    `\nThe install at ${layout.packageDir} conflicts with leftover staging dir(s): ` +
    `${layout.stagingDirs.join(', ')}. They were kept because the installed copy could not be ` +
    'proven runnable; one of them may be the copy still in use. Remove whichever does not run.'
  );
}
