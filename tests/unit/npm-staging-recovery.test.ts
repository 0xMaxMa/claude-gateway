/**
 * Issue #675: updating an npm-global claude-code fails with ENOTEMPTY every
 * time once an interrupted install has left a `.claude-code-<hash>` staging
 * dir behind.
 *
 * These tests run the real `npm install -g` against a throwaway prefix, so the
 * ENOTEMPTY is npm's own. A thin `npm` wrapper maps the
 * `npm install -g <pkg>@<version>` that runNativeUpdate runs onto a local
 * tarball and can inject failures; a fake `claude` stands in for a native
 * install.
 *
 * Isolation: jest's `process.env` is not what child processes inherit, so
 * every scenario runs `runNativeUpdate` in its own node process with an
 * explicit env. Its PATH holds only the fake `claude`, `node` and `npm` (no
 * real `claude`), `npm_config_prefix` points at the temp prefix, and the child
 * refuses to run unless `npm root -g`, `npm` and `claude` all resolve inside
 * the temp dir. Nothing outside the temp dir can be touched.
 */
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { acquireUpdateLock, probePackageDir } from '../../src/packages/npm-staging';
import type { RecoveryResult } from '../../src/packages/npm-staging';

const REPO = resolve(__dirname, '..', '..');
const PKG = '@fake-cc/claude-code';
/** Stands in for `@0xmaxma/claude-gateway`, which installNpmVersion updates. */
const GW_PKG = '@fake-gw/claude-gateway';

let tmp: string;
let prefix: string;
let npmRoot: string;
let scopeDir: string;
let mainDir: string;
let stagingDir: string;
let stateDir: string;
let env: NodeJS.ProcessEnv;

function writeExec(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A claude-code package dir whose `bin/claude` is runnable (or truncated). */
function writePackage(dir: string, version: string, runnable: boolean, name = PKG, bin = 'claude'): void {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, bin: { [bin]: `bin/${bin}` } }));
  writeExec(
    join(dir, 'bin', bin),
    runnable ? `echo "${version} (Claude Code)"` : 'echo "claude is truncated" >&2; exit 1',
  );
}

/** npm's own retire path (arborist lib/retire-path.js): the name every retry collides with. */
function npmRetirePath(from: string): string {
  const hash = createHash('sha1').update(from).digest('base64').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8);
  return join(dirname(from), `.${basename(from)}-${hash}`);
}

function runs(dir: string, bin = 'claude'): string | null {
  try {
    return execFileSync(join(dir, 'bin', bin), ['--version'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function counter(name: string): number {
  return existsSync(join(stateDir, name)) ? Number(readFileSync(join(stateDir, name), 'utf-8')) : 0;
}
/** `npm install -g` calls runNativeUpdate made. */
const installCalls = () => counter('installs');
/** `claude update` calls runNativeUpdate made. */
const claudeUpdateCalls = () => counter('claude-updates');

/** Put `claude` first on this test's PATH: a symlink to `target`, or a script. */
function claudeOnPath(target: { symlink: string } | { script: string; shebang: boolean }): void {
  const dir = join(stateDir, 'bin');
  mkdirSync(dir, { recursive: true });
  if ('symlink' in target) {
    symlinkSync(target.symlink, join(dir, 'claude'));
  } else {
    writeFileSync(join(dir, 'claude'), `${target.shebang ? '#!/bin/sh\n' : ''}${target.script}\n`);
    chmodSync(join(dir, 'claude'), 0o755);
  }
}

/** A native-installer `claude`: not a `#!` script and outside the npm root. */
const NATIVE_CLAUDE = [
  'case "$1" in',
  '  --version) echo "${PATH_CLAUDE_VERSION:-1.0.0} (Claude Code)" ;;',
  '  update) [ -n "$SLEEP" ] && sleep "$SLEEP"; echo $(( $(cat "$CC_STATE/claude-updates" 2>/dev/null || echo 0) + 1 )) > "$CC_STATE/claude-updates" ;;',
  'esac',
].join('\n');

/** Run `npm install -g` of the 1.0.1 tarball inside the sandbox. */
function sandboxNpmInstall(): { status: number | null; stderr: string } {
  const r = spawnSync('npm-real', ['install', '-g', '--offline', '--no-audit', '--no-fund', env.CC_TGZ as string], {
    env,
    encoding: 'utf-8',
  });
  return { status: r.status, stderr: r.stderr };
}

/** `runNativeUpdate` for the fake package, in a child process confined to the sandbox. */
function runNativeUpdateInSandbox(extra: Record<string, string> = {}): RecoveryResult {
  return runInSandbox('runNativeUpdate', extra).result as RecoveryResult;
}

/** `installNpmVersion` for the fake gateway package, confined the same way. */
function installNpmVersionInSandbox(extra: Record<string, string> = {}): string | null {
  return runInSandbox('installNpmVersion', { CC_TGZ: env.GW_TGZ as string, ...extra }).result as string | null;
}

/** `ticks` counts 50 ms timer callbacks that ran while the update was in flight. */
function runInSandbox(fn: 'runNativeUpdate' | 'installNpmVersion', extra: Record<string, string>): { result: unknown; ticks: number } {
  const r = spawnSandboxChild({ ...env, ...extra, SANDBOX_FN: fn });
  if (r.status !== 0) throw new Error(`sandbox child failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout) as { result: unknown; ticks: number };
}

function spawnSandboxChild(childEnv: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const script = `
    const { execSync } = require('child_process');
    const tmp = ${JSON.stringify(realpathSync(tmp))};
    const root = require('fs').realpathSync(execSync('npm root -g', { encoding: 'utf-8' }).trim());
    const which = (b) => require('fs').realpathSync(execSync('command -v ' + b, { encoding: 'utf-8', shell: '/bin/sh' }).trim());
    const claude = which('claude');
    const npm = which('npm');
    if (![root, claude, npm].every((p) => p.startsWith(tmp + '/'))) {
      process.stderr.write('refusing to run outside the sandbox: ' + [root, claude, npm].join(' '));
      process.exit(99);
    }
    const { runNativeUpdate, installNpmVersion } = require(${JSON.stringify(join(REPO, 'src', 'packages', 'registry'))});
    const config = { npm: ${JSON.stringify(PKG)}, channel: 'latest', detect: 'binary', bin: 'claude', update: 'native' };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    (async () => {
      const result = process.env.SANDBOX_FN === 'installNpmVersion'
        ? await installNpmVersion(${JSON.stringify(GW_PKG)}, '1.0.1')
        : await runNativeUpdate(config, '1.0.1');
      clearInterval(timer);
      process.stdout.write(JSON.stringify({ result: result === undefined ? null : result, ticks }));
    })();
  `;
  return spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
    cwd: REPO,
    env: childEnv,
    encoding: 'utf-8',
  });
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cc-staging-'));

  // PATH for the sandbox: node, npm (real, and the wrapper) and a default
  // `claude` only.
  const binDir = join(tmp, 'path');
  mkdirSync(binDir);
  symlinkSync(process.execPath, join(binDir, 'node'));
  symlinkSync(join(dirname(process.execPath), 'npm'), join(binDir, 'npm-real'));
  writeExec(
    join(binDir, 'npm'),
    [
      // `npm install -g <spec>`: record the spec, then install the 1.0.1
      // tarball. FAIL_TIMES fails the first N installs, NO_INSTALL exits 0
      // without installing, MUST_RUN names a binary that has to stay runnable
      // while the install runs. Anything else goes to the real npm.
      'if [ "$1" = install ] && [ "$2" = -g ]; then',
      '  for a in "$@"; do spec=$a; done; echo "$spec" >> "$CC_STATE/specs"',
      '  n=$(( $(cat "$CC_STATE/installs" 2>/dev/null || echo 0) + 1 )); echo $n > "$CC_STATE/installs"',
      '  if [ -n "$MUST_RUN" ] && ! "$MUST_RUN" --version >/dev/null 2>&1; then echo "no runnable claude during update" >&2; exit 3; fi',
      '  [ -n "$SLEEP" ] && sleep "$SLEEP"',
      // FAIL_CODE makes the failure read like npm's own (`npm error code ENOTEMPTY`).
      '  if [ "$n" -le "${FAIL_TIMES:-0}" ]; then echo "${FAIL_CODE:+npm error code $FAIL_CODE }simulated install failure $n" >&2; exit 1; fi',
      '  [ -n "$NO_INSTALL" ] && exit 0',
      '  exec npm-real install -g --offline --no-audit --no-fund "$CC_TGZ"',
      'fi',
      'exec npm-real "$@"',
    ].join('\n'),
  );
  // Default `claude`: a wrapper script (like GetPod's), which is not proof of
  // a native install. Its `update` must never run for an npm-global package.
  writeExec(
    join(binDir, 'claude'),
    [
      'case "$1" in',
      '  --version) echo "${PATH_CLAUDE_VERSION:-1.0.0} (Claude Code)" ;;',
      '  update) echo $(( $(cat "$CC_STATE/claude-updates" 2>/dev/null || echo 0) + 1 )) > "$CC_STATE/claude-updates"; exit 1 ;;',
      'esac',
    ].join('\n'),
  );

  for (const [dir, name, bin] of [
    ['src', PKG, 'claude'],
    ['gw-src', GW_PKG, 'claude-gateway'],
  ] as const) {
    const src = join(tmp, dir);
    writePackage(src, '1.0.1', true, name, bin);
    execFileSync(join(binDir, 'npm-real'), ['pack', '--silent', '--pack-destination', tmp], {
      cwd: src,
      stdio: 'pipe',
      env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: tmp, npm_config_cache: join(tmp, 'npm-cache') },
    });
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  prefix = mkdtempSync(join(tmp, 'prefix-'));
  stateDir = mkdtempSync(join(tmp, 'state-'));
  npmRoot = join(prefix, 'lib', 'node_modules');
  scopeDir = join(npmRoot, '@fake-cc');
  mainDir = join(scopeDir, 'claude-code');
  stagingDir = npmRetirePath(mainDir);
  mkdirSync(npmRoot, { recursive: true });
  env = {
    PATH: `${join(stateDir, 'bin')}:${join(tmp, 'path')}:/usr/bin:/bin`,
    HOME: tmp,
    npm_config_prefix: prefix,
    npm_config_cache: join(tmp, 'npm-cache'),
    npm_config_userconfig: join(tmp, 'npmrc'),
    npm_config_globalconfig: join(tmp, 'npmrc-global'),
    CC_STATE: stateDir,
    CC_TGZ: join(tmp, 'fake-cc-claude-code-1.0.1.tgz'),
    GW_TGZ: join(tmp, 'fake-gw-claude-gateway-1.0.1.tgz'),
  };
});

describe('sandbox guard', () => {
  it('refuses to call runNativeUpdate when npm would resolve outside the temp dir', () => {
    // Without npm_config_prefix, `npm root -g` is the host's real global root.
    const { npm_config_prefix: _omit, ...unsandboxed } = env;
    const r = spawnSandboxChild(unsandboxed);
    expect(r.status).toBe(99);
    expect(r.stderr).toContain('refusing to run outside the sandbox');
    expect(installCalls() + claudeUpdateCalls()).toBe(0);
  });
});

describe('npm ENOTEMPTY reproduction (the bug as npm produces it)', () => {
  it('a non-empty staging dir makes npm install -g fail with ENOTEMPTY; an absent package dir skips the rename', () => {
    writePackage(mainDir, '1.0.0', true);
    writePackage(stagingDir, '1.0.0', true);
    const blocked = sandboxNpmInstall();
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('ENOTEMPTY');

    rmSync(mainDir, { recursive: true, force: true });
    expect(sandboxNpmInstall().status).toBe(0);
    expect(runs(mainDir)).toBe('1.0.1 (Claude Code)');
  });
});

describe('runNativeUpdate on an npm-global claude-code with a stale staging dir (#675)', () => {
  it('AC1: runnable package dir + stale staging → staging removed first, npm installs the target', () => {
    writePackage(mainDir, '1.0.0', true);
    writePackage(stagingDir, '0.9.0', true);
    // A sibling package's staging dir is not ours to remove.
    const sibling = join(scopeDir, '.claude-code-foo-abc12345');
    mkdirSync(sibling, { recursive: true });

    expect(runNativeUpdateInSandbox()).toEqual({ error: null, version: '1.0.1' });
    expect(runs(mainDir)).toBe('1.0.1 (Claude Code)');
    expect(existsSync(stagingDir)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(readFileSync(join(stateDir, 'specs'), 'utf-8')).toBe(`${PKG}@1.0.1\n`);
    expect(claudeUpdateCalls()).toBe(0);
  });

  it('AC2a: the incident state (truncated package dir, working staging copy) → updated, staging removed only at the end', () => {
    writePackage(mainDir, '1.0.0', false);
    writePackage(stagingDir, '1.0.0', true);

    // The staging copy is what serves sessions: it must still run while npm runs.
    const result = runNativeUpdateInSandbox({ MUST_RUN: join(stagingDir, 'bin', 'claude') });

    expect(result).toEqual({ error: null, version: '1.0.1' });
    expect(runs(mainDir)).toBe('1.0.1 (Claude Code)');
    expect(existsSync(stagingDir)).toBe(false);
    expect(installCalls()).toBe(1);
  });

  it('AC2a: works when PATH `claude` is npm\'s link into the package dir that gets moved aside', () => {
    writePackage(mainDir, '1.0.0', false);
    writePackage(stagingDir, '1.0.0', true);
    claudeOnPath({ symlink: join(mainDir, 'bin', 'claude') });

    expect(runNativeUpdateInSandbox()).toEqual({ error: null, version: '1.0.1' });
    expect(runs(mainDir)).toBe('1.0.1 (Claude Code)');
  });

  it('AC2b: incident state + the update keeps failing → error naming the staging dir; both dirs as they were', () => {
    writePackage(mainDir, '1.0.0', false);
    writePackage(stagingDir, '1.0.0', true);

    const result = runNativeUpdateInSandbox({ FAIL_TIMES: '9', FAIL_CODE: 'ENOTEMPTY' });

    expect(result.error).toContain('simulated install failure');
    expect(result.error).toContain(stagingDir);
    expect(runs(stagingDir)).toBe('1.0.0 (Claude Code)');
    // The original package dir is restored, not deleted.
    expect(JSON.parse(readFileSync(join(mainDir, 'package.json'), 'utf-8')).version).toBe('1.0.0');
    expect(installCalls()).toBe(2);
  });

  it('AC3: npm reports ENOTEMPTY once while a staging dir exists → recovered and retried once', () => {
    writePackage(mainDir, '1.0.0', false);
    writePackage(stagingDir, '1.0.0', true);

    expect(runNativeUpdateInSandbox({ FAIL_TIMES: '1', FAIL_CODE: 'ENOTEMPTY' })).toEqual({ error: null, version: '1.0.1' });
    expect(installCalls()).toBe(2);
  });

  it('a failure that is not the staging collision is not retried, even with a staging dir', () => {
    writePackage(mainDir, '1.0.0', false);
    writePackage(stagingDir, '1.0.0', true);

    const result = runNativeUpdateInSandbox({ FAIL_TIMES: '9', FAIL_CODE: 'E404' });

    expect(result.error).toContain('npm error code E404 simulated install failure 1');
    expect(installCalls()).toBe(1);
    expect(runs(stagingDir)).toBe('1.0.0 (Claude Code)');
    expect(JSON.parse(readFileSync(join(mainDir, 'package.json'), 'utf-8')).version).toBe('1.0.0');
  });

  it('does not block the event loop while npm runs', () => {
    writePackage(mainDir, '1.0.0', true);

    const { result, ticks } = runInSandbox('runNativeUpdate', { SLEEP: '1' });

    expect(result).toEqual({ error: null, version: '1.0.1' });
    expect(ticks).toBeGreaterThanOrEqual(5);
  });

  it('AC4: a failure with no staging dir → no retry, the npm error unchanged', () => {
    writePackage(mainDir, '1.0.0', true);

    expect(runNativeUpdateInSandbox({ FAIL_TIMES: '9' })).toEqual({ error: 'simulated install failure 1\n' });
    expect(installCalls()).toBe(1);
    expect(runs(mainDir)).toBe('1.0.0 (Claude Code)');
  });

  it('AC5: the install exits 0 but the installed binary does not run → error, even though PATH `claude` answers', () => {
    writePackage(mainDir, '1.0.0', false);

    const result = runNativeUpdateInSandbox({ NO_INSTALL: '1', PATH_CLAUDE_VERSION: '1.0.1' });

    expect(result.error).toMatch(/update completed but .* is not runnable/);
  });

  it('AC5: incident state + the install exits 0 without fixing anything → error, staging copy kept', () => {
    writePackage(mainDir, '1.0.0', false);
    writePackage(stagingDir, '1.0.0', true);

    const result = runNativeUpdateInSandbox({ NO_INSTALL: '1' });

    expect(result.error).toMatch(/is not runnable/);
    expect(runs(stagingDir)).toBe('1.0.0 (Claude Code)');
    expect(JSON.parse(readFileSync(join(mainDir, 'package.json'), 'utf-8')).version).toBe('1.0.0');
  });

  it('AC7: another live updater holds the lock → fails fast and touches no dirs', () => {
    writePackage(mainDir, '1.0.0', false);
    writePackage(stagingDir, '1.0.0', true);
    const release = acquireUpdateLock(npmRoot);
    expect(release).not.toBeNull();
    try {
      const result = runNativeUpdateInSandbox();
      expect(result.error).toMatch(/another update .* is already running/);
      expect(installCalls()).toBe(0);
      expect(runs(stagingDir)).toBe('1.0.0 (Claude Code)');
      expect(existsSync(mainDir)).toBe(true);
    } finally {
      release?.();
    }
  });

  it('AC7: a lock left by a dead process is taken over; a fresh pid-less lock is not', () => {
    const lockFile = join(npmRoot, '.claude-gateway-update.lock');
    writePackage(mainDir, '1.0.0', true);

    writeFileSync(lockFile, '');
    expect(runNativeUpdateInSandbox().error).toMatch(/already running/);

    writeFileSync(lockFile, '2147483646');
    expect(runNativeUpdateInSandbox()).toEqual({ error: null, version: '1.0.1' });
    expect(existsSync(lockFile)).toBe(false);
  });

  it('a package dir left renamed aside by a killed update is restored before updating', () => {
    writePackage(join(npmRoot, '.claude-gateway-aside-_fake-cc_claude-code-1-1'), '1.0.0', true);
    // No package dir, no staging: the killed run had moved it aside.
    expect(runNativeUpdateInSandbox({ NO_INSTALL: '1' })).toEqual({ error: null, version: '1.0.0' });
    expect(runs(mainDir)).toBe('1.0.0 (Claude Code)');
    expect(existsSync(join(npmRoot, '.claude-gateway-aside-_fake-cc_claude-code-1-1'))).toBe(false);
  });
});

describe('runNativeUpdate on a native install', () => {
  it('AC8: no npm-global claude-code → `claude update` runs as before and PATH `claude` gives the version', () => {
    claudeOnPath({ script: NATIVE_CLAUDE, shebang: false });

    expect(runNativeUpdateInSandbox({ PATH_CLAUDE_VERSION: '1.0.1' })).toEqual({ error: null, version: '1.0.1' });
    expect(claudeUpdateCalls()).toBe(1);
    expect(installCalls()).toBe(0);
    expect(existsSync(join(npmRoot, '.claude-gateway-update.lock'))).toBe(false);
  });

  it('does not block the event loop while `claude update` runs', () => {
    claudeOnPath({ script: NATIVE_CLAUDE, shebang: false });

    const { result, ticks } = runInSandbox('runNativeUpdate', { PATH_CLAUDE_VERSION: '1.0.1', SLEEP: '1' });

    expect(result).toEqual({ error: null, version: '1.0.1' });
    expect(ticks).toBeGreaterThanOrEqual(5);
  });

  it('a native install beside an old broken npm copy → native updater, native version, npm copy untouched', () => {
    claudeOnPath({ script: NATIVE_CLAUDE, shebang: false });
    writePackage(mainDir, '0.5.0', false);
    writePackage(stagingDir, '0.5.0', true);

    expect(runNativeUpdateInSandbox({ PATH_CLAUDE_VERSION: '1.0.1' })).toEqual({ error: null, version: '1.0.1' });
    expect(claudeUpdateCalls()).toBe(1);
    expect(installCalls()).toBe(0);
    expect(existsSync(mainDir) && existsSync(stagingDir)).toBe(true);
  });
});

describe('installNpmVersion (claude-gateway) uses the same recovery', () => {
  let gwDir: string;
  let gwStaging: string;
  beforeEach(() => {
    gwDir = join(npmRoot, '@fake-gw', 'claude-gateway');
    gwStaging = npmRetirePath(gwDir);
  });
  const gwRuns = (dir: string) => runs(dir, 'claude-gateway');
  const gwVersion = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).version;

  it('runnable package dir + stale staging → staging removed, target installed', () => {
    writePackage(gwDir, '1.0.0', true, GW_PKG, 'claude-gateway');
    writePackage(gwStaging, '0.9.0', true, GW_PKG, 'claude-gateway');

    expect(installNpmVersionInSandbox()).toBeNull();
    expect(gwRuns(gwDir)).toBe('1.0.1 (Claude Code)');
    expect(existsSync(gwStaging)).toBe(false);
    expect(readFileSync(join(stateDir, 'specs'), 'utf-8')).toBe(`${GW_PKG}@1.0.1\n`);
  });

  it('broken package dir + the only working copy in staging + ENOTEMPTY every time → both kept', () => {
    writePackage(gwDir, '1.0.0', false, GW_PKG, 'claude-gateway');
    writePackage(gwStaging, '1.0.0', true, GW_PKG, 'claude-gateway');

    const error = installNpmVersionInSandbox({ FAIL_TIMES: '9', FAIL_CODE: 'ENOTEMPTY' });

    expect(error).toContain('ENOTEMPTY');
    expect(gwRuns(gwStaging)).toBe('1.0.0 (Claude Code)');
    expect(gwVersion(gwDir)).toBe('1.0.0');
    expect(installCalls()).toBe(2);
  });

  it('install exits 0 but the new copy does not run → error, the working staging copy kept', () => {
    writePackage(gwDir, '1.0.0', false, GW_PKG, 'claude-gateway');
    writePackage(gwStaging, '1.0.0', true, GW_PKG, 'claude-gateway');

    expect(installNpmVersionInSandbox({ NO_INSTALL: '1' })).toMatch(/is not runnable/);
    expect(gwRuns(gwStaging)).toBe('1.0.0 (Claude Code)');
    expect(gwVersion(gwDir)).toBe('1.0.0');
  });

  it('a non-collision failure is returned unchanged with no retry', () => {
    writePackage(gwDir, '1.0.0', true, GW_PKG, 'claude-gateway');

    expect(installNpmVersionInSandbox({ FAIL_TIMES: '9', FAIL_CODE: 'E404' })).toBe(
      'npm error code E404 simulated install failure 1\n',
    );
    expect(installCalls()).toBe(1);
    expect(gwRuns(gwDir)).toBe('1.0.0 (Claude Code)');
  });

  it('does not block the event loop while npm runs', () => {
    writePackage(gwDir, '1.0.0', true, GW_PKG, 'claude-gateway');

    const { result, ticks } = runInSandbox('installNpmVersion', { CC_TGZ: env.GW_TGZ as string, SLEEP: '1' });

    expect(result).toBeNull();
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});

describe('probePackageDir', () => {
  it('needs every entry point to run: a truncated platform binary fails even when bin/ runs', () => {
    writePackage(mainDir, '1.0.0', true);
    const platformBin = join(mainDir, 'node_modules', '@fake-cc', 'claude-code-linux-x64', 'claude');
    writeExec(platformBin, 'exit 1');
    expect(probePackageDir(mainDir, PKG, 'claude')).toBeNull();

    writeExec(platformBin, 'echo "1.0.0 (Claude Code)"');
    expect(probePackageDir(mainDir, PKG, 'claude')).toBe('1.0.0');
  });

  it('ignores a bin path that escapes the package dir', () => {
    mkdirSync(mainDir, { recursive: true });
    writeExec(join(scopeDir, 'outside'), 'echo "1.0.0"');
    writeFileSync(join(mainDir, 'package.json'), JSON.stringify({ name: PKG, bin: { claude: '../outside' } }));
    expect(probePackageDir(mainDir, PKG, 'claude')).toBeNull();
  });
});
