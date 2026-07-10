import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Resolution of the `claude` executable shared by every host-side spawn site
 * (session subprocess in `process.ts`, `claude --print` in `compactor.ts`).
 *
 * The Claude Code native-installer migration (2026-07) moved the binary out of
 * the legacy npm/nvm layout into `~/.local`, so a gateway launched with a minimal
 * PATH can no longer find `claude` on PATH alone. Centralizing the probe here
 * keeps every spawn site consistent and avoids re-introducing the bug one call
 * site at a time.
 *
 * NOTE: this resolves against the HOST filesystem. App-agents run claude inside a
 * docker container, so they must NOT use this — a host path is meaningless in the
 * container. Those call sites keep bare `claude` (resolved by the container PATH).
 */

/** Directory holding the native-installer stable `claude` symlink (`~/.local/bin`). */
export function nativeClaudeBinDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.local', 'bin');
}

/** True if `p` is an existing, executable regular file (symlinks are followed). */
export function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `cmd` against a PATH string, returning the first executable hit. */
function findOnPath(cmd: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Return the newest executable `claude` under a native-installer versions dir.
 * Each version may be the binary itself (`versions/<ver>`) or a directory
 * containing it (`versions/<ver>/claude`). Newest is decided by numeric-aware
 * descending name sort so `2.1.206` beats `2.1.99`.
 */
function newestNativeVersion(versionsDir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(versionsDir);
  } catch {
    return null;
  }
  const sorted = entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const name of sorted) {
    const base = path.join(versionsDir, name);
    if (isExecutableFile(base)) return base;
    const nested = path.join(base, 'claude');
    if (isExecutableFile(nested)) return nested;
  }
  return null;
}

export type ClaudeBinSource = 'PATH' | 'native-bin' | 'native-versions' | 'legacy-npm' | 'fallback';

export interface ClaudeBinResolution {
  /** Binary to spawn — a resolved absolute path, or bare `claude` as a last resort. */
  bin: string;
  /** Which probe resolved it (`fallback` = nothing found, spawning bare `claude`). */
  source: ClaudeBinSource;
  /** Ordered list of locations probed, for actionable error logging. */
  searched: string[];
}

/**
 * Resolve the `claude` executable when `CLAUDE_BIN` is not set. Probe order:
 *   1. bare `claude` on PATH — respects the operator's environment when present
 *   2. native stable symlink `~/.local/bin/claude`
 *   3. newest native version under `~/.local/share/claude/versions/`
 *   4. legacy npm-under-nvm `~/.nvm/versions/node/<v>/bin/claude`
 * If every probe misses, fall back to bare `claude` so spawn still runs (and the
 * failure surfaces through the caller's error log with the searched paths).
 *
 * LIMITATION: the PATH probe accepts the first *executable* `claude` it finds,
 * so a broken drop-in shim that is executable but exits non-zero (the exact
 * failure that motivated this) still wins here. Detecting that would require
 * running the binary, which is out of scope (see issue #192 — the deployed host
 * shim is an ops fix). The child PATH is hardened with the native bin dir (see
 * pathWithNativeBin) so a genuine native install is preferred when both exist.
 */
export function resolveClaudeBin(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): ClaudeBinResolution {
  const searched: string[] = [];

  searched.push('claude (PATH)');
  if (findOnPath('claude', env.PATH)) {
    return { bin: 'claude', source: 'PATH', searched };
  }

  const nativeBin = path.join(nativeClaudeBinDir(homeDir), 'claude');
  searched.push(nativeBin);
  if (isExecutableFile(nativeBin)) {
    return { bin: nativeBin, source: 'native-bin', searched };
  }

  const versionsDir = path.join(homeDir, '.local', 'share', 'claude', 'versions');
  searched.push(path.join(versionsDir, '*'));
  const nativeVersion = newestNativeVersion(versionsDir);
  if (nativeVersion) {
    return { bin: nativeVersion, source: 'native-versions', searched };
  }

  const nvmDir = path.join(homeDir, '.nvm', 'versions', 'node');
  searched.push(path.join(nvmDir, '*', 'bin', 'claude'));
  try {
    for (const node of fs.readdirSync(nvmDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const candidate = path.join(nvmDir, node, 'bin', 'claude');
      if (isExecutableFile(candidate)) {
        return { bin: candidate, source: 'legacy-npm', searched };
      }
    }
  } catch {
    /* no nvm layout */
  }

  return { bin: 'claude', source: 'fallback', searched };
}

/**
 * PATH with the native-installer bin dir prepended when it holds an executable
 * `claude`, so a spawned child resolves the native install ahead of a stale
 * legacy shim even if the gateway itself launched with a pre-migration PATH.
 * Returns the original PATH unchanged when there is no native install.
 */
export function pathWithNativeBin(
  homeDir: string = os.homedir(),
  pathEnv: string | undefined = process.env.PATH,
): string | undefined {
  const nativeBinDir = nativeClaudeBinDir(homeDir);
  return isExecutableFile(path.join(nativeBinDir, 'claude'))
    ? `${nativeBinDir}${path.delimiter}${pathEnv ?? ''}`
    : pathEnv;
}
