jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
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

const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'claude-gateway.service');

/** Resolving the unit's PATH probes `which claude`; only systemd/pm2 calls
 *  count as "did something". */
function expectNoManagerCalls(): void {
  for (const call of mockExecFileSync.mock.calls) {
    expect(['systemctl', 'pm2', 'sudo']).not.toContain(call[0]);
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
  it('renders a unit whose ExecStart is absolute and explicitly says `gateway start`', () => {
    const spec = resolveLaunchSpec({});
    expect(spec).not.toBeNull();
    const unit = renderSystemdUnit(spec!);

    const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart='));
    expect(execStart).toBeDefined();
    expect(execStart).toContain('gateway start');
    // A unit that just runs the binary with no command would now print help
    // and exit 0 on the legacy path — never generate one.
    expect(execStart).toMatch(/^ExecStart="\/.*" "\/.*index\.js" gateway start --config "\/.*"$/);
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('Restart=on-failure');
  });

  it('never writes a secret into the unit — only paths', () => {
    const unit = renderSystemdUnit(resolveLaunchSpec({})!);
    for (const line of unit.split('\n').filter((l) => l.startsWith('Environment='))) {
      expect(line).toMatch(/^Environment="(HOME|PATH|GATEWAY_CONFIG)=/);
    }
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
    expectNoManagerCalls();
    expect(stderr.join('')).toMatch(/--yes/);
  });

  it('--print shows the unit and exits 0 without touching disk or systemd', async () => {
    const code = await runService(['install'], { manager: 'systemd', print: true });
    expect(code).toBe(0);
    expect(stderr.join('')).toContain('gateway start');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expectNoManagerCalls();
  });

  it('--print for pm2 shows the exact argv without registering anything', async () => {
    const code = await runService(['install'], { manager: 'pm2', print: true });
    expect(code).toBe(0);
    expect(stderr.join('')).toContain('pm2 start');
    expectNoManagerCalls();
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

describe('service — argument validation', () => {
  it('a bare `service` is a usage error (1); `service --help` is a help request (0)', async () => {
    expect(await runService([], {})).toBe(1);
    expect(await runService([], { help: true })).toBe(0);
  });

  it('rejects an unknown action and an unknown manager without running anything', async () => {
    expect(await runService(['frobnicate'], { manager: 'systemd' })).toBe(1);
    expect(await runService(['install'], { manager: 'nope' })).toBe(1);
    expectNoManagerCalls();
  });
});

describe('service uninstall', () => {
  it('disables the unit, removes the file, and reloads systemd', async () => {
    const code = await runService(['uninstall'], { manager: 'systemd' });
    expect(code).toBe(0);
    expect(mockExecFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'disable', '--now', 'claude-gateway.service'], expect.anything());
    expect(fs.unlinkSync).toHaveBeenCalledWith(unitPath);
    expect(JSON.parse(stdout.join(''))).toEqual(expect.objectContaining({ installed: false }));
  });

  it('is idempotent when the unit was never installed', async () => {
    (fs.unlinkSync as jest.Mock).mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(await runService(['uninstall'], { manager: 'systemd' })).toBe(0);
  });
});
