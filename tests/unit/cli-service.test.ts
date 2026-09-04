jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  readFileSync: jest.fn(),
  chmodSync: jest.fn(),
  chownSync: jest.fn(),
  statSync: jest.fn(),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { renderSystemdUnit, pm2StartArgs, resolveLaunchSpec, runService, servicePath } from '../../src/cli/commands/service';

/**
 * `service install` writes a unit that systemd will start at boot, with no
 * shell and no inherited environment. The two things that make such a unit
 * work are absolute paths and an explicit start command — a relative path or a
 * bare `claude-gateway` (which now prints help) yields a unit that silently
 * fails or restart-loops. These tests pin both, plus the confirmation gate.
 */

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;
const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>;
const mockReadFileSync = fs.readFileSync as unknown as jest.Mock;

const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'claude-gateway.service');
const systemUnitPath = '/etc/systemd/system/claude-gateway.service';
const gwuserHome = '/home/gwuser';

/** `resolveRunAsUser()` looks the --run-as user up via `getent passwd`
 *  before building the launch spec — every --scope system --run-as gwuser
 *  test needs this mocked too now, not just systemctl. Wraps a
 *  systemctl-focused implementation with a getent response for 'gwuser'. */
function withGetentGwuser(systemctlImpl: (file: string, args: string[]) => Buffer): (file: string, args: string[]) => Buffer {
  return (file, args) => {
    if (file === 'getent' && args[0] === 'passwd' && args[1] === 'gwuser') {
      return Buffer.from(`gwuser:x:1500:1500:gwuser,,,:${gwuserHome}:/bin/bash\n`);
    }
    return systemctlImpl(file, args);
  };
}

/**
 * Assert nothing was *changed*. Read-only probes are fine and expected —
 * resolving the unit's PATH runs `which claude`, and uninstall reads the
 * current state before deciding what to do — so this checks for the verbs that
 * actually mutate a service, not for any subprocess at all.
 */
const MUTATING_VERBS = ['enable', 'disable', 'daemon-reload', 'delete', 'save', 'start', 'stop', 'restart'];
function expectNoStateChange(): void {
  for (const [file, args] of mockExecFileSync.mock.calls as unknown as Array<[string, string[]]>) {
    if (file === 'sudo') throw new Error('unexpected privilege escalation');
    for (const verb of args ?? []) expect(MUTATING_VERBS).not.toContain(verb);
  }
}

let stdout: string[];
let stderr: string[];
let outSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
let ttyDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  // Default: an already-existing WorkingDirectory is owned by gwuser's uid
  // already, matching the default --run-as used throughout this file — so
  // the "already correct, no-op" chown path is what most tests exercise
  // unless a test deliberately overrides it.
  (fs.statSync as jest.Mock).mockReturnValue({ uid: 1500 });
  stdout = [];
  stderr = [];
  outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(chunk.toString());
    return true;
  });
  errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString());
    return true;
  });
  ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
});

describe('service — generated launch configuration', () => {
  /**
   * The unit launches the thin entry (dist/entry.js), which decides between the
   * CLI and the server before either is loaded. index.js remains a working boot
   * entry, and is used when a partially-updated install has no entry.js yet —
   * writing a unit that points at a file which is not there would leave the
   * service failing at boot with nothing to explain it.
   */
  // U-SV-375a
  it('U-SV-375a: launches entry.js, falling back to index.js when it is absent', () => {
    mockExistsSync.mockImplementation(() => true);
    expect(resolveLaunchSpec({})!.entry).toMatch(/entry\.js$/);

    mockExistsSync.mockImplementation((p) => !String(p).endsWith('entry.js'));
    expect(resolveLaunchSpec({})!.entry).toMatch(/index\.js$/);
  });

  it('renders a unit whose ExecStart is absolute and explicitly says `gateway start`', () => {
    const spec = resolveLaunchSpec({});
    expect(spec).not.toBeNull();
    const unit = renderSystemdUnit(spec!);

    const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart='));
    expect(execStart).toBeDefined();
    expect(execStart).toContain('gateway start');
    // A unit that just runs the binary with no command would now print help
    // and exit 0 on the legacy path — never generate one.
    // entry.js is the thin dispatcher the bin points at; index.js is the
    // fallback used when a partially-updated install predates the split. Either
    // is a valid launch target, so the shape is what this asserts.
    expect(execStart).toMatch(/^ExecStart="\/.*" "\/.*(entry|index)\.js" gateway start --config "\/.*"$/);
    expect(unit).toContain('WantedBy=default.target');
    // `on-failure` treats a graceful exit(0) as success and never restarts —
    // exactly the failure mode in issue #450 (an API-triggered update
    // SIGTERMs the gateway expecting a restart it never gets). `always`
    // restarts unconditionally, which also covers the update-triggered exit.
    expect(unit).toContain('Restart=always');
    expect(unit).not.toContain('Restart=on-failure');
  });

  it('uses Type=exec, not Type=simple — reported "started" only once the actual execve() succeeds', () => {
    // simple would report the unit started right after fork(), before
    // knowing whether ExecStart could even be exec'd at all.
    const unit = renderSystemdUnit(resolveLaunchSpec({})!);
    expect(unit).toContain('Type=exec');
    expect(unit).not.toContain('Type=simple');
  });

  it('sets OOMPolicy=continue so an OOM-killed child process cannot take the whole gateway down', () => {
    // systemd's default OOMPolicy=stop treats an OOM-killed process anywhere
    // in this unit's cgroup as the unit failing, which combined with
    // Restart=always restarts the entire gateway for an OOM kill of, say, an
    // agent's own dev server — dropping every other agent's session too
    // (issue #454). `continue` logs the kill without restarting the unit.
    const unit = renderSystemdUnit(resolveLaunchSpec({})!);
    expect(unit).toContain('OOMPolicy=continue');
  });

  it('never writes a secret into the unit — only paths', () => {
    const unit = renderSystemdUnit(resolveLaunchSpec({})!);
    for (const line of unit.split('\n').filter((l) => l.startsWith('Environment='))) {
      expect(line).toMatch(/^Environment="(HOME|PATH|GATEWAY_CONFIG)=/);
    }
  });

  it('leaves WorkingDirectory unquoted — systemd rejects a quoted path there', () => {
    // Verified with `systemd-analyze verify`: quoting this one yields
    // "WorkingDirectory= path is not absolute". Every *other* value is quoted,
    // so this exception needs a test or it reads like an oversight and gets
    // "fixed" into a broken unit.
    const unit = renderSystemdUnit(resolveLaunchSpec({})!);
    const line = unit.split('\n').find((l) => l.startsWith('WorkingDirectory='));
    expect(line).toBeDefined();
    expect(line).not.toContain('"');
    expect(line!.slice('WorkingDirectory='.length).startsWith('/')).toBe(true);
  });

  it('escapes quotes and backslashes in a config path so the value cannot break out', () => {
    const unit = renderSystemdUnit({
      node: '/usr/bin/node',
      entry: '/opt/cg/dist/index.js',
      cwd: '/home/u/.claude-gateway',
      config: '/home/u/we"ird\\path/config.json',
      home: '/home/u',
      pathEnv: '/usr/bin',
    });
    expect(unit).toContain('we\\"ird\\\\path');
  });

  it('honours --config and $GATEWAY_CONFIG for the unit config path', () => {
    expect(resolveLaunchSpec({ config: '/custom/cg.json' })!.config).toBe('/custom/cg.json');
    const prev = process.env.GATEWAY_CONFIG;
    process.env.GATEWAY_CONFIG = '/env/cg.json';
    try {
      expect(resolveLaunchSpec({})!.config).toBe('/env/cg.json');
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_CONFIG;
      else process.env.GATEWAY_CONFIG = prev;
    }
  });

  it('refuses to generate anything when the entry point is missing', () => {
    mockExistsSync.mockReturnValue(false);
    expect(resolveLaunchSpec({})).toBeNull();
  });

  it('pins a boot-safe PATH instead of inheriting the interactive shell PATH', () => {
    const dirs = servicePath().split(':');
    // The node that will run the gateway must be first — a unit started at boot
    // has no nvm/shell rc to put it there.
    expect(dirs[0]).toBe(path.dirname(process.execPath));
    expect(dirs).toContain('/usr/bin');
    expect(new Set(dirs).size).toBe(dirs.length); // no duplicates
    for (const dir of dirs) expect(path.isAbsolute(dir)).toBe(true);
  });

  it('starts the PM2 process with the same explicit command', () => {
    const args = pm2StartArgs(resolveLaunchSpec({})!);
    expect(args.slice(-4)).toEqual(['gateway', 'start', '--config', resolveLaunchSpec({})!.config]);
    expect(args).toContain('--name');
  });
});

describe('service install — confirmation gate', () => {
  it('refuses to install non-interactively without --yes and writes nothing', async () => {
    const code = await runService(['install'], { manager: 'systemd' });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/--yes/);
  });

  it('--print shows the unit and exits 0 without touching disk or systemd', async () => {
    const code = await runService(['install'], { manager: 'systemd', print: true });
    expect(code).toBe(0);
    expect(stderr.join('')).toContain('gateway start');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
  });

  it('--print for pm2 shows the exact argv without registering anything', async () => {
    const code = await runService(['install'], { manager: 'pm2', print: true });
    expect(code).toBe(0);
    expect(stderr.join('')).toContain('pm2 start');
    expectNoStateChange();
  });

  it('probes the local bind for health, never config.publicUrl', async () => {
    // A proxy in front of a still-running old instance would answer for a
    // service that never started — install must not call that success.
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      await runService(['install'], { manager: 'systemd', yes: true }, { publicUrl: 'https://proxy.example.com/gateway', bind: '0.0.0.0' });
      const probed = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(probed.length).toBeGreaterThan(0);
      for (const url of probed) {
        expect(url).not.toContain('proxy.example.com');
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/health$/);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('--yes installs the user unit, enables it, and reports it (health probed)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', yes: true });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(unitPath, expect.stringContaining('gateway start'), expect.objectContaining({ mode: 0o600 }));
      expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload'], expect.anything());
      expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'enable', '--now', 'claude-gateway.service'], expect.anything());
      // user scope only — installing a service must never need sudo
      expect(mockExecFileSync).not.toHaveBeenCalledWith('sudo', expect.anything(), expect.anything());
      expect(JSON.parse(stdout.join(''))).toEqual(expect.objectContaining({ manager: 'systemd-user', health: 'up' }));
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('service install — system-scope conflict (issue #450)', () => {
  /** A same-named unit already exists at *system* scope and is enabled. */
  function systemUnitEnabled(): void {
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && !args.includes('--user') && args[0] === 'is-enabled') {
        return Buffer.from('enabled\n');
      }
      return Buffer.from('');
    }) as unknown as typeof execFileSync);
  }

  it('refuses to install — writes nothing, runs no systemctl mutation — when a system-scope unit is enabled', async () => {
    systemUnitEnabled();
    const code = await runService(['install'], { manager: 'systemd', yes: true });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/system scope/);
    expect(stderr.join('')).toMatch(/sudo systemctl disable --now claude-gateway\.service/);
  });

  it('--force installs anyway despite the conflict', async () => {
    systemUnitEnabled();
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', yes: true, force: true });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(unitPath, expect.stringContaining('gateway start'), expect.objectContaining({ mode: 0o600 }));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('re-checks for a conflict right before writing — a unit that appears while confirm() was waiting on the operator still refuses', async () => {
    // Simulates the TOCTOU window: no conflict at the pre-prompt check, but
    // one has appeared by the time confirm() resolves and the code is about
    // to write. `is-enabled` is queried once per systemScopeConflict() call —
    // once before the prompt, once again right after — so the first call
    // reports no conflict and every call after reports one.
    let isEnabledCalls = 0;
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && !args.includes('--user') && args[0] === 'is-enabled') {
        isEnabledCalls++;
        return Buffer.from(isEnabledCalls === 1 ? 'disabled\n' : 'enabled\n');
      }
      return Buffer.from('');
    }) as unknown as typeof execFileSync);

    const code = await runService(['install'], { manager: 'systemd', yes: true });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(stderr.join('')).toMatch(/system scope/);
    expect(isEnabledCalls).toBeGreaterThanOrEqual(2);
  });

  it('does not refuse when a system-scope unit exists but is only "static", not "enabled"', async () => {
    // A unit can exist and answer `is-enabled` successfully without being
    // `enabled` (e.g. a static unit with no [Install] section) — the check
    // must compare the literal value, not just whether the command succeeded.
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && !args.includes('--user') && args[0] === 'is-enabled') {
        return Buffer.from('static\n');
      }
      if (file === 'systemctl' && !args.includes('--user') && args[0] === 'is-active') {
        return Buffer.from('inactive\n');
      }
      return Buffer.from('');
    }) as unknown as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', yes: true });
      expect(code).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('checks system scope, not user scope, for the conflict', async () => {
    systemUnitEnabled();
    await runService(['install'], { manager: 'systemd', yes: true });
    // The system-scope check must not be confused with (or piggyback on) the
    // user-scope `systemdState()` reads used elsewhere in this file.
    const isChecks = (mockExecFileSync.mock.calls as unknown as Array<[string, string[]]>).filter(
      ([file, args]) => file === 'systemctl' && (args[0] === 'is-enabled' || args[0] === 'is-active'),
    );
    expect(isChecks.length).toBeGreaterThan(0);
    for (const [, args] of isChecks) expect(args).not.toContain('--user');
  });
});

describe('service — argument validation', () => {
  it('a bare `service` is a usage error (1); `service --help` is a help request (0)', async () => {
    expect(await runService([], {})).toBe(1);
    expect(await runService([], { help: true })).toBe(0);
  });

  it('rejects an unknown action and an unknown manager without running anything', async () => {
    expect(await runService(['frobnicate'], { manager: 'systemd' })).toBe(1);
    expect(await runService(['install'], { manager: 'nope' })).toBe(1);
    expectNoStateChange();
  });
});

describe('service uninstall', () => {
  /** systemd reports the (user-scope) unit as installed+active until it is
   *  removed. Scoped to the user-scope path specifically, not a blanket
   *  `mockReturnValue(true)` — with scope auto-detection now probing both
   *  paths when --scope is omitted (issue #457 review), a blanket true would
   *  make the system-scope path look installed too and trip the "both
   *  scopes installed, say which one" refusal instead of exercising what
   *  this helper is actually named for. */
  function unitIsLive(): void {
    mockExistsSync.mockImplementation((p: unknown) => String(p) === unitPath);
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && args.includes('is-active')) return Buffer.from('active\n');
      if (file === 'systemctl' && args.includes('is-enabled')) return Buffer.from('enabled\n');
      return Buffer.from('');
    }) as unknown as typeof execFileSync);
  }

  it('refuses to stop a running service non-interactively without --yes', async () => {
    unitIsLive();
    const code = await runService(['uninstall'], { manager: 'systemd' });
    expect(code).toBe(1);
    expectNoStateChange();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('refuses the pm2 path the same way', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify([{ name: 'gateway', pm2_env: { status: 'online' } }])) as never);
    const code = await runService(['uninstall'], { manager: 'pm2' });
    expect(code).toBe(1);
    expectNoStateChange();
  });

  it('does not prompt at all when nothing is installed', async () => {
    // Asking to stop a service that isn't there just trains people to answer
    // these prompts without reading them.
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue(Buffer.from('') as never);
    expect(await runService(['uninstall'], { manager: 'systemd' })).toBe(0);
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/nothing to remove/);
  });

  it('says PM2 is not installed rather than blaming its process list', async () => {
    mockExecFileSync.mockImplementation((() => {
      const err = new Error('spawnSync pm2 ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }) as unknown as typeof execFileSync);
    expect(await runService(['uninstall'], { manager: 'pm2' })).toBe(0);
    expect(stderr.join('')).toMatch(/PM2 is not installed/);
  });

  it('disables the unit, removes the file, and reloads systemd', async () => {
    // installed before the call, gone after it
    mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false);
    mockExecFileSync.mockReturnValue(Buffer.from('') as never);

    // Explicit scope: with --scope omitted, detectServiceScope() now makes
    // its own existsSync probe first (issue #457 review) — pass it directly
    // so this test's mockReturnValueOnce sequencing still lines up with the
    // single existsSync read systemdState() makes inside systemdUninstall().
    const code = await runService(['uninstall'], { manager: 'systemd', scope: 'user', yes: true });

    expect(code).toBe(0);
    expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'disable', '--now', 'claude-gateway.service'], expect.anything());
    expect(fs.unlinkSync).toHaveBeenCalledWith(unitPath);
    expect(JSON.parse(stdout.join(''))).toEqual(expect.objectContaining({ installed: false }));
  });

  it('is idempotent when the unit file vanished between the state read and the unlink', async () => {
    mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false);
    mockExecFileSync.mockReturnValue(Buffer.from('') as never);
    (fs.unlinkSync as jest.Mock).mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(await runService(['uninstall'], { manager: 'systemd', scope: 'user', yes: true })).toBe(0);
  });

  it('reports the observed state, not the intent, when the unit survives removal', async () => {
    // `disable --now` failing is swallowed (it may simply not be installed), so
    // the report has to come from systemd, or a still-running service would be
    // announced as stopped.
    unitIsLive();
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && args.includes('is-active')) return Buffer.from('active\n');
      if (file === 'systemctl' && args.includes('is-enabled')) return Buffer.from('enabled\n');
      if (file === 'systemctl' && args.includes('disable')) throw new Error('permission denied');
      return Buffer.from('');
    }) as unknown as typeof execFileSync);

    const code = await runService(['uninstall'], { manager: 'systemd', yes: true });

    expect(code).toBe(1);
    expect(JSON.parse(stdout.join(''))).toEqual(expect.objectContaining({ active: true, installed: true }));
    expect(stderr.join('')).toMatch(/still present/);
  });
});

describe('service — --print is install-only', () => {
  it('rejects --print on status and uninstall instead of ignoring it', async () => {
    // Silently accepting it would let someone believe `uninstall --print` was
    // a dry run.
    expect(await runService(['uninstall'], { manager: 'systemd', print: true })).toBe(1);
    expect(await runService(['status'], { manager: 'systemd', print: true })).toBe(1);
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/--print only applies to/);
  });
});

describe('service — unit customization: --after / --env-file / --env (issue #457)', () => {
  it('appends extra After= targets on top of the default network-online.target', () => {
    const unit = renderSystemdUnit(resolveLaunchSpec({})!, { scope: 'user', after: ['docker.service', 'foo.target'], extraEnv: {} });
    const line = unit.split('\n').find((l) => l.startsWith('After='));
    expect(line).toBe('After=network-online.target docker.service foo.target');
  });

  it('adds EnvironmentFile=-<path> when envFile is set', () => {
    const unit = renderSystemdUnit(resolveLaunchSpec({})!, {
      scope: 'user',
      after: [],
      extraEnv: {},
      envFile: '/etc/claude-gateway/extra.env',
    });
    // Unquoted, like WorkingDirectory= — systemd reads a quoted value here as
    // part of the path and rejects it (verified with `systemd-analyze verify`).
    expect(unit).toContain('EnvironmentFile=-/etc/claude-gateway/extra.env');
    expect(unit).not.toContain('EnvironmentFile=-"');
  });

  it('adds extra Environment="KEY=VALUE" lines, quoted the same way as the built-in vars', () => {
    const unit = renderSystemdUnit(resolveLaunchSpec({})!, {
      scope: 'user',
      after: [],
      extraEnv: { DOCKER_BUILDKIT: '0', FOO: 'bar baz' },
    });
    expect(unit).toContain('Environment="DOCKER_BUILDKIT=0"');
    expect(unit).toContain('Environment="FOO=bar baz"');
  });

  it('CLI: parses comma-separated --after and --env into the rendered unit', async () => {
    // Explicit default: a prior test in this file may have left a custom
    // execFileSync implementation behind (jest.clearAllMocks() clears call
    // history, not implementations), which would otherwise leak in here.
    mockExecFileSync.mockReturnValue(Buffer.from('') as never);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], {
        manager: 'systemd',
        yes: true,
        after: 'docker.service,other.target',
        env: 'FOO=bar,BAZ=qux',
      });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        unitPath,
        expect.stringContaining('After=network-online.target docker.service other.target'),
        expect.anything(),
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(unitPath, expect.stringContaining('Environment="FOO=bar"'), expect.anything());
      expect(mockWriteFileSync).toHaveBeenCalledWith(unitPath, expect.stringContaining('Environment="BAZ=qux"'), expect.anything());
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects a malformed --env entry and writes nothing', async () => {
    const code = await runService(['install'], { manager: 'systemd', yes: true, env: 'not-a-pair' });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/Invalid --env entry/);
  });

  it('rejects --env attempting to override a reserved variable', async () => {
    const code = await runService(['install'], { manager: 'systemd', yes: true, env: 'PATH=/evil' });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/installer itself/);
  });

  it('rejects a line break in an --env value instead of letting it inject an extra unit directive', async () => {
    const code = await runService(['install'], { manager: 'systemd', yes: true, env: 'FOO=bar\nExecStart=/bin/evil' });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/line break/);
  });

  it('rejects a line break in an --after target', async () => {
    const code = await runService(['install'], { manager: 'systemd', yes: true, after: 'docker.service\n[Service]\nExecStart=/bin/evil' });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/line break/);
  });

  it('rejects a line break in --env-file', async () => {
    const code = await runService(['install'], { manager: 'systemd', yes: true, 'env-file': '/etc/x\n[Service]\nExecStart=/bin/evil' });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/line break/);
  });

  it('rejects a line break in --run-as', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', yes: true, 'run-as': 'gwuser\nExecStart=/bin/evil' });
      expect(code).toBe(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(stderr.join('')).toMatch(/line break/);
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
    }
  });

  it('rejects a NUL byte in an --env value the same way as a line break', async () => {
    // Matches the settings.json value guard in src/session/process.ts, which
    // rejects the same two byte classes for the same reason (NUL throws at
    // spawn; a newline is never legitimate mid-value).
    const code = await runService(['install'], { manager: 'systemd', yes: true, env: 'FOO=bar\0baz' });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/NUL byte/);
  });
});

describe('service install/uninstall/status — --scope system (issue #457)', () => {
  afterEach(() => {
    if ((process.getuid as unknown as jest.Mock)?.mockRestore) (process.getuid as unknown as jest.Mock).mockRestore();
  });

  it('rejects an unknown --scope', async () => {
    const code = await runService(['install'], { manager: 'systemd', scope: 'nope' });
    expect(code).toBe(1);
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/Unknown --scope/);
  });

  it('rejects --scope system combined with --manager pm2', async () => {
    const code = await runService(['install'], { manager: 'pm2', scope: 'system', 'run-as': 'gwuser', yes: true });
    expect(code).toBe(1);
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/only applies to the systemd manager/);
  });

  it('refuses --scope system install when not running as root — never escalates via sudo', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(1000);
    mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
    const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/must be run as root/);
  });

  it('shows the --print preview for --scope system even when not root — a pure read must never need root', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(1000);
    mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
    try {
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', print: true });
      expect(code).toBe(0);
      expect(stderr.join('')).toContain('User=gwuser');
      expect(stderr.join('')).toContain(`WorkingDirectory=${gwuserHome}/.claude-gateway`);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expectNoStateChange();
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
    }
  });

  it('refuses --scope system uninstall when not running as root', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(1000);
    const code = await runService(['uninstall'], { manager: 'systemd', scope: 'system', yes: true });
    expect(code).toBe(1);
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/must be run as root/);
  });

  it('requires --run-as for --scope system install, even as root', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    const code = await runService(['install'], { manager: 'systemd', scope: 'system', yes: true });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(stderr.join('')).toMatch(/--run-as/);
  });

  it('writes /etc/systemd/system unit with User= and WantedBy=multi-user.target, as root with --run-as', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        systemUnitPath,
        expect.stringContaining('User=gwuser'),
        expect.objectContaining({ mode: 0o644 }),
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(systemUnitPath, expect.stringContaining('WantedBy=multi-user.target'), expect.anything());
      // The unit runs as gwuser, so its WorkingDirectory/HOME/config must be
      // gwuser's — not root's, even though this install itself runs as root.
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        systemUnitPath,
        expect.stringContaining(`WorkingDirectory=${gwuserHome}/.claude-gateway`),
        expect.anything(),
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(systemUnitPath, expect.stringContaining(`Environment="HOME=${gwuserHome}"`), expect.anything());
      expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['daemon-reload'], expect.anything());
      expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['enable', '--now', 'claude-gateway.service'], expect.anything());
      // system scope must never shell out to sudo either — same rule as user scope
      expect(mockExecFileSync).not.toHaveBeenCalledWith('sudo', expect.anything(), expect.anything());
      expect(JSON.parse(stdout.join(''))).toEqual(expect.objectContaining({ manager: 'systemd-system', health: 'up' }));
      // system scope has no login session to survive — the hint is meaningless there
      expect(stderr.join('')).not.toMatch(/loginctl/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not refuse a system-scope install against its own already-enabled unit', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      mockExecFileSync.mockImplementation((withGetentGwuser(((file: string, args: string[]) => {
        if (file === 'systemctl' && args[0] === 'is-enabled') return Buffer.from('enabled\n');
        if (file === 'systemctl' && args[0] === 'is-active') return Buffer.from('active\n');
        return Buffer.from('');
      }) as (file: string, args: string[]) => Buffer) as unknown) as typeof execFileSync);
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(0);
      // The self-conflict guard specifically must not fire; the success
      // message legitimately mentions "system scope" too, so match the exact
      // refusal wording rather than the substring.
      expect(stderr.join('')).not.toMatch(/already exists at system scope/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not double-space the systemctl hint for system scope (no --user token to join)', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      mockExecFileSync.mockImplementation((withGetentGwuser(((file: string, args: string[]) => {
        if (file === 'systemctl' && args.includes('enable')) throw new Error('boom');
        return Buffer.from('');
      }) as (file: string, args: string[]) => Buffer) as unknown) as typeof execFileSync);
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('Inspect it with: systemctl status claude-gateway.service --no-pager');
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
    }
  });

  it('service status against a system-scope unit reports systemd-system and never passes --user', async () => {
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && args[0] === 'is-active') return Buffer.from('active\n');
      if (file === 'systemctl' && args[0] === 'is-enabled') return Buffer.from('enabled\n');
      return Buffer.from('');
    }) as unknown as typeof execFileSync);
    const code = await runService(['status'], { manager: 'systemd', scope: 'system' });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toEqual(expect.objectContaining({ manager: 'systemd-system', unit: systemUnitPath, active: true }));
    for (const [file, args] of mockExecFileSync.mock.calls as unknown as Array<[string, string[]]>) {
      if (file === 'systemctl') expect(args).not.toContain('--user');
    }
  });

  it('uninstalls a system-scope unit without --user flags, as root', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      // installed before the call, gone after — same convention as the
      // user-scope uninstall test above; is-active/is-enabled report false
      // throughout, which is fine since `installed` alone (via existsSync)
      // already carries the before/after distinction this test needs.
      mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false);
      mockExecFileSync.mockReturnValue(Buffer.from('') as never);
      const code = await runService(['uninstall'], { manager: 'systemd', scope: 'system', yes: true });
      expect(code).toBe(0);
      expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['disable', '--now', 'claude-gateway.service'], expect.anything());
      expect(fs.unlinkSync).toHaveBeenCalledWith(systemUnitPath);
      for (const [file, args] of mockExecFileSync.mock.calls as unknown as Array<[string, string[]]>) {
        if (file === 'systemctl') expect(args).not.toContain('--user');
      }
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
    }
  });
});

describe('service install — restart-on-change for an already-running unit (issue #457)', () => {
  it('restarts an already-active unit when the rendered content changed', async () => {
    mockReadFileSync.mockReturnValue('OLD CONTENT\n');
    // Scoped to --user: an unscoped 'is-active' match would also answer the
    // system-scope conflict pre-check, which must stay "inactive" here — this
    // test is a user-scope install, not a system-scope one.
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && args.includes('--user') && args.includes('is-active')) return Buffer.from('active\n');
      return Buffer.from('');
    }) as unknown as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', yes: true });
      expect(code).toBe(0);
      expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'claude-gateway.service'], expect.anything());
      // Restart alone doesn't guarantee the unit is enabled — the previous
      // active state could have been active-but-disabled — so the restart
      // path must still explicitly enable it, just via a separate call
      // instead of the combined `enable --now` the non-restart path uses.
      expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'enable', 'claude-gateway.service'], expect.anything());
      expect(mockExecFileSync).not.toHaveBeenCalledWith('systemctl', ['--user', 'enable', '--now', 'claude-gateway.service'], expect.anything());
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not restart an already-active unit when the rendered content is unchanged', async () => {
    // Pre-populate with the exact bytes the default spec would render, so the
    // "unchanged" branch is exercised honestly rather than by omission.
    mockReadFileSync.mockReturnValue(renderSystemdUnit(resolveLaunchSpec({})!));
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && args.includes('--user') && args.includes('is-active')) return Buffer.from('active\n');
      return Buffer.from('');
    }) as unknown as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', yes: true });
      expect(code).toBe(0);
      expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'enable', '--now', 'claude-gateway.service'], expect.anything());
      expect(mockExecFileSync).not.toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'claude-gateway.service'], expect.anything());
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not restart a fresh install of an inactive unit even though there was no previous content to compare', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    // Explicit default, not an inherited one: a prior test in this file may
    // have left a custom execFileSync implementation behind.
    mockExecFileSync.mockReturnValue(Buffer.from('') as never);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', yes: true });
      expect(code).toBe(0);
      expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'enable', '--now', 'claude-gateway.service'], expect.anything());
      expect(mockExecFileSync).not.toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'claude-gateway.service'], expect.anything());
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('service install — cross-scope conflict, both directions (issue #457 review)', () => {
  it('refuses a --scope system install when a user-scope unit is already enabled', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      mockExecFileSync.mockImplementation((withGetentGwuser(((file: string, args: string[]) => {
        if (file === 'systemctl' && args.includes('--user') && args.includes('is-enabled')) return Buffer.from('enabled\n');
        return Buffer.from('');
      }) as (file: string, args: string[]) => Buffer) as unknown) as typeof execFileSync);
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expectNoStateChange();
      expect(stderr.join('')).toMatch(/already exists at user scope/);
      expect(stderr.join('')).toMatch(/systemctl --user disable --now claude-gateway\.service/);
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
    }
  });

  it('--force installs --scope system anyway despite an active user-scope unit', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      mockExecFileSync.mockImplementation((withGetentGwuser(((file: string, args: string[]) => {
        if (file === 'systemctl' && args.includes('--user') && args.includes('is-enabled')) return Buffer.from('enabled\n');
        return Buffer.from('');
      }) as (file: string, args: string[]) => Buffer) as unknown) as typeof execFileSync);
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true, force: true });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(systemUnitPath, expect.stringContaining('User=gwuser'), expect.anything());
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('still refuses a plain --scope user install when a system-scope unit is enabled (original issue #450 direction, unchanged)', async () => {
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && !args.includes('--user') && args[0] === 'is-enabled') return Buffer.from('enabled\n');
      return Buffer.from('');
    }) as unknown as typeof execFileSync);
    const code = await runService(['install'], { manager: 'systemd', yes: true });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(stderr.join('')).toMatch(/already exists at system scope/);
    expect(stderr.join('')).toMatch(/sudo systemctl disable --now claude-gateway\.service/);
  });
});

describe('service status/uninstall — scope auto-detection when --scope is omitted (issue #457 review)', () => {
  it('status with no --scope finds a system-scope-only install instead of reporting not-installed', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p) === systemUnitPath);
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && !args.includes('--user') && args[0] === 'is-active') return Buffer.from('active\n');
      if (file === 'systemctl' && !args.includes('--user') && args[0] === 'is-enabled') return Buffer.from('enabled\n');
      return Buffer.from('');
    }) as unknown as typeof execFileSync);
    const code = await runService(['status'], { manager: 'systemd' });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toEqual(expect.objectContaining({ manager: 'systemd-system', unit: systemUnitPath, active: true }));
  });

  it('uninstall with no --scope finds and removes a system-scope-only install instead of silently reporting success', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      // No user-scope unit ever. System-scope: installed for the scope-detect
      // read and the before-state read, gone by the final state read after
      // removal — same "installed, then gone" shape as the plain uninstall
      // test above, just keyed by path since two paths are probed now.
      let systemPathReads = 0;
      mockExistsSync.mockImplementation((p: unknown) => {
        if (String(p) === unitPath) return false;
        systemPathReads++;
        return systemPathReads <= 2;
      });
      mockExecFileSync.mockReturnValue(Buffer.from('') as never);
      const code = await runService(['uninstall'], { manager: 'systemd', yes: true });
      expect(code).toBe(0);
      expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['disable', '--now', 'claude-gateway.service'], expect.anything());
      expect(fs.unlinkSync).toHaveBeenCalledWith(systemUnitPath);
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
    }
  });

  it('install still always defaults to --scope user even when the (unrelated) entry-point/other-scope existsSync checks are true — never auto-detects a scope for install', async () => {
    // detectServiceScope() special-cases action==='install' to return 'user'
    // unconditionally, without even reading existsSync — so this only needs
    // the default beforeEach mock (existsSync → true everywhere, which is
    // also what resolveLaunchSpec()'s own entry-point check needs to succeed).
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', yes: true });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(unitPath, expect.anything(), expect.anything());
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('service install — --env-file requires a value (issue #457 review)', () => {
  it('rejects a bare --env-file with no path instead of silently treating it as omitted', async () => {
    // The shared CLI parser reads a flag with no following value (last token,
    // or immediately followed by another flag) as boolean true — a plain
    // `typeof !== 'string'` check would silently read that as "not passed".
    const code = await runService(['install'], { manager: 'systemd', yes: true, 'env-file': true });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/--env-file requires a path/);
  });
});

describe('service install — chmod is applied explicitly, not left to writeFileSync (issue #457 review)', () => {
  it('chmods the unit file to 0600 after writing it at user scope', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', yes: true });
      expect(code).toBe(0);
      expect(fs.chmodSync).toHaveBeenCalledWith(unitPath, 0o600);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("chmods the unit file to 0644 after writing it at system scope — writeFileSync's mode is a no-op on an existing file", async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(0);
      expect(fs.chmodSync).toHaveBeenCalledWith(systemUnitPath, 0o644);
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe('service status/uninstall — both scopes installed at once (issue #457 review round 2)', () => {
  /** A --force system-scope install alongside a still-active user-scope one
   *  is exactly how this state can arise in practice. */
  function bothScopesInstalled(): void {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && args.includes('is-active')) return Buffer.from('active\n');
      if (file === 'systemctl' && args.includes('is-enabled')) return Buffer.from('enabled\n');
      return Buffer.from('');
    }) as unknown as typeof execFileSync);
  }

  it('refuses a scope-omitted status when both a user-scope and a system-scope unit are installed', async () => {
    bothScopesInstalled();
    const code = await runService(['status'], { manager: 'systemd' });
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/Both a user-scope and a system-scope/);
  });

  it('refuses a scope-omitted uninstall when both scopes are installed — never silently acts on only one', async () => {
    bothScopesInstalled();
    const code = await runService(['uninstall'], { manager: 'systemd', yes: true });
    expect(code).toBe(1);
    expectNoStateChange();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(stderr.join('')).toMatch(/Both a user-scope and a system-scope/);
  });

  it('an explicit --scope still works normally even when both are installed', async () => {
    bothScopesInstalled();
    const code = await runService(['status'], { manager: 'systemd', scope: 'system' });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toEqual(expect.objectContaining({ manager: 'systemd-system' }));
  });

  it('a pm2 request is unaffected by two systemd scopes both being installed — scope is irrelevant to pm2', async () => {
    bothScopesInstalled();
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify([{ name: 'gateway', pm2_env: { status: 'online' } }])) as never);
    const code = await runService(['status'], { manager: 'pm2' });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toEqual(expect.objectContaining({ manager: 'pm2' }));
  });
});

describe('service install — --run-as only applies to --scope system (issue #457 review round 2)', () => {
  it('rejects --run-as passed with the default (user) scope instead of silently dropping it', async () => {
    const code = await runService(['install'], { manager: 'systemd', yes: true, 'run-as': 'gwuser' });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/--run-as only applies to --scope system/);
  });

  it('trims --run-as before writing it into User=, matching how --after/--env are normalized', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': '  gwuser  ', yes: true });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(systemUnitPath, expect.stringContaining('User=gwuser\n'), expect.anything());
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe('service install — systemd-only flags rejected under --manager pm2 (issue #457 review round 2)', () => {
  it.each(['after', 'env', 'env-file', 'run-as'])('rejects --%s with --manager pm2 instead of silently dropping it', async (flagName) => {
    const code = await runService(['install'], { manager: 'pm2', yes: true, [flagName]: 'x' });
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(new RegExp(`--${flagName} only applies to the systemd manager`));
  });
});

describe('service install — a non-ENOENT read error on the existing unit is surfaced, not swallowed (issue #457 review round 2)', () => {
  it('aborts and reports the read failure instead of silently treating it as a fresh install', async () => {
    mockReadFileSync.mockImplementation(() => {
      const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    const code = await runService(['install'], { manager: 'systemd', yes: true });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/Could not read the existing unit/);
  });
});

describe('service install — --after target names cannot contain whitespace (issue #457 review round 3)', () => {
  it('rejects a space inside a single --after entry instead of silently splitting it into two targets', async () => {
    const code = await runService(['install'], { manager: 'systemd', yes: true, after: 'foo.target bar.service' });
    expect(code).toBe(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoStateChange();
    expect(stderr.join('')).toMatch(/cannot contain whitespace/);
  });

  it('still accepts properly comma-separated targets with no embedded whitespace', () => {
    const unit = renderSystemdUnit(resolveLaunchSpec({})!, { scope: 'user', after: ['docker.service', 'foo.target'], extraEnv: {} });
    expect(unit).toContain('After=network-online.target docker.service foo.target');
  });
});

describe('service install — --scope system resolves --run-as user\'s real home (issue #457 review, external report)', () => {
  it('refuses when the --run-as user cannot be resolved via getent, instead of falling back to the installer\'s own home', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      // getent fails for every user — simulates a nonexistent --run-as user,
      // or getent itself being unavailable.
      mockExecFileSync.mockImplementation((() => {
        throw new Error('getent: gwuser: not found');
      }) as unknown as typeof execFileSync);
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expectNoStateChange();
      expect(stderr.join('')).toMatch(/Could not resolve --run-as gwuser/);
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
    }
  });

  it('chowns a freshly-created WorkingDirectory to the --run-as user — root creates it, but the unit runs as someone else', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      // The gateway's own cwd doesn't exist yet; everything else the code
      // touches (entry.js resolution, PATH candidates) still needs to.
      mockExistsSync.mockImplementation((p: unknown) => String(p) !== `${gwuserHome}/.claude-gateway`);
      mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(0);
      expect(fs.mkdirSync).toHaveBeenCalledWith(`${gwuserHome}/.claude-gateway`, { recursive: true });
      expect(fs.chownSync).toHaveBeenCalledWith(`${gwuserHome}/.claude-gateway`, 1500, 1500);
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('does not chown an already-existing WorkingDirectory — trusts ownership from prior use rather than reassigning it', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      // Default beforeEach mock: existsSync → true everywhere, including
      // gwuser's .claude-gateway — it already exists.
      mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(0);
      expect(fs.chownSync).not.toHaveBeenCalled();
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('the rendered unit config path is also under the --run-as user\'s home, not the installer\'s', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        systemUnitPath,
        expect.stringContaining(`GATEWAY_CONFIG=${gwuserHome}/.claude-gateway/config.json`),
        expect.anything(),
      );
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('a plain --scope user install is unaffected — still uses the installer\'s own os.homedir(), no getent lookup at all', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', yes: true });
      expect(code).toBe(0);
      for (const [file] of mockExecFileSync.mock.calls as unknown as Array<[string]>) {
        expect(file).not.toBe('getent');
      }
      expect(mockWriteFileSync).toHaveBeenCalledWith(unitPath, expect.stringContaining(`Environment="HOME=${os.homedir()}"`), expect.anything());
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('service install — --config/--env-file `~` expansion and $GATEWAY_CONFIG under --scope system (manual /code-review round)', () => {
  it('expands a `~/...` --config path against the --run-as user\'s home, not the installing root process\'s', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', config: '~/custom.json', yes: true });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        systemUnitPath,
        expect.stringContaining(`GATEWAY_CONFIG=${gwuserHome}/custom.json`),
        expect.anything(),
      );
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('expands a `~/...` --env-file path against the --run-as user\'s home, not root\'s', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], {
        manager: 'systemd',
        scope: 'system',
        'run-as': 'gwuser',
        'env-file': '~/secrets.env',
        yes: true,
      });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(systemUnitPath, expect.stringContaining(`EnvironmentFile=-${gwuserHome}/secrets.env`), expect.anything());
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('ignores $GATEWAY_CONFIG from the installing (root) process\'s environment for --scope system', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const prevEnv = process.env.GATEWAY_CONFIG;
    process.env.GATEWAY_CONFIG = '/root/some-other-config.json';
    try {
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        systemUnitPath,
        expect.stringContaining(`GATEWAY_CONFIG=${gwuserHome}/.claude-gateway/config.json`),
        expect.anything(),
      );
      expect(mockWriteFileSync).not.toHaveBeenCalledWith(systemUnitPath, expect.stringContaining('some-other-config.json'), expect.anything());
    } finally {
      if (prevEnv === undefined) delete process.env.GATEWAY_CONFIG;
      else process.env.GATEWAY_CONFIG = prevEnv;
      (process.getuid as unknown as jest.Mock).mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('a plain --scope user install still honours $GATEWAY_CONFIG — only --scope system suppresses it', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const prevEnv = process.env.GATEWAY_CONFIG;
    process.env.GATEWAY_CONFIG = '/env/cg.json';
    try {
      const code = await runService(['install'], { manager: 'systemd', yes: true });
      expect(code).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledWith(unitPath, expect.stringContaining('GATEWAY_CONFIG=/env/cg.json'), expect.anything());
    } finally {
      if (prevEnv === undefined) delete process.env.GATEWAY_CONFIG;
      else process.env.GATEWAY_CONFIG = prevEnv;
      fetchSpy.mockRestore();
    }
  });
});

describe('service install — chown reasserts ownership when --run-as changes on an existing WorkingDirectory (manual /code-review round)', () => {
  it('chowns an existing WorkingDirectory still owned by a previous --run-as user to the new one', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    (fs.statSync as jest.Mock).mockReturnValue({ uid: 9999 }); // some other, stale owner
    mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(0);
      expect(fs.chownSync).toHaveBeenCalledWith(`${gwuserHome}/.claude-gateway`, 1500, 1500);
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('does not chown when the existing WorkingDirectory already belongs to the current --run-as target', async () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    (fs.statSync as jest.Mock).mockReturnValue({ uid: 1500 }); // already gwuser
    mockExecFileSync.mockImplementation((withGetentGwuser(() => Buffer.from('')) as unknown) as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const code = await runService(['install'], { manager: 'systemd', scope: 'system', 'run-as': 'gwuser', yes: true });
      expect(code).toBe(0);
      expect(fs.chownSync).not.toHaveBeenCalled();
    } finally {
      (process.getuid as unknown as jest.Mock).mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe('service install — exit code distinguishes health-check timeout from an actual failure (manual /code-review round)', () => {
  it('systemd: exits 2 (not 1) when install/enable succeeded but /health never answers', async () => {
    jest.useFakeTimers();
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false } as Response);
    try {
      const promise = runService(['install'], { manager: 'systemd', yes: true });
      // 20 attempts * 500ms interval, plus slack for the probe's own await chain.
      await jest.advanceTimersByTimeAsync(20 * 500 + 5_000);
      const code = await promise;
      expect(code).toBe(2);
      // The install itself genuinely succeeded — only health is unconfirmed.
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(JSON.parse(stdout.join(''))).toEqual(expect.objectContaining({ health: 'down' }));
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('systemd: still exits 1, not 2, when install/enable itself fails outright', async () => {
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'systemctl' && args.includes('enable')) throw new Error('boom');
      return Buffer.from('');
    }) as unknown as typeof execFileSync);
    const code = await runService(['install'], { manager: 'systemd', yes: true });
    expect(code).toBe(1);
    expect(mockWriteFileSync).toHaveBeenCalled(); // unit was written before the enable call failed
  });

  it('pm2: exits 2 (not 1) when registration succeeded but /health never answers', async () => {
    jest.useFakeTimers();
    mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
      if (file === 'pm2' && args[0] === 'jlist') return Buffer.from('[]');
      return Buffer.from('');
    }) as unknown as typeof execFileSync);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false } as Response);
    try {
      const promise = runService(['install'], { manager: 'pm2', yes: true });
      await jest.advanceTimersByTimeAsync(20 * 500 + 5_000);
      const code = await promise;
      expect(code).toBe(2);
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
