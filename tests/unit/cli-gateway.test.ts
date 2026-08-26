jest.mock('../../src/cli/manager', () => ({
  detectManager: jest.fn(),
  defaultPidfilePath: () => '/tmp/fake-gateway.pid',
  readLocalGateway: () => ({ pid: 1 }),
  pidLooksLikeGateway: jest.fn(() => true),
}));
jest.mock('fs', () => ({ readFileSync: jest.fn() }));
jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { detectManager, pidLooksLikeGateway } from '../../src/cli/manager';
import { runGatewayLifecycle } from '../../src/cli/commands/gateway';
import type { CliConfigView } from '../../src/cli/http-client';

/**
 * `gateway restart` on a bare foreground process only sends SIGTERM — there is
 * no supervisor to respawn it. A caller (script, cron job) reading the exit code
 * must be able to tell that apart from an actual completed restart.
 */
let stdout: string[] = [];
let outSpy: jest.SpyInstance;

beforeEach(() => {
  stdout = [];
  outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(chunk.toString());
    return true;
  });
});

afterEach(() => outSpy.mockRestore());

describe('cli gateway lifecycle exit codes', () => {
  const config: CliConfigView = {};
  let killSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true as never);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('foreground restart sends SIGTERM but exits non-zero (no respawn happened)', async () => {
    (detectManager as jest.Mock).mockReturnValue('foreground');
    (fs.readFileSync as jest.Mock).mockReturnValue('4242\n');

    const code = await runGatewayLifecycle(['restart'], {}, config);

    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(code).toBe(1);
  });

  it('foreground stop sends SIGTERM and exits zero (stop is the whole job)', async () => {
    (detectManager as jest.Mock).mockReturnValue('foreground');
    (fs.readFileSync as jest.Mock).mockReturnValue('4242\n');

    const code = await runGatewayLifecycle(['stop'], {}, config);

    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(code).toBe(0);
  });

  it('user systemd restart uses systemctl --user and never escalates', async () => {
    (detectManager as jest.Mock).mockReturnValue('systemd-user');

    const code = await runGatewayLifecycle(['restart'], {}, config);

    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'claude-gateway.service'], expect.anything());
    expect(execFileSync).not.toHaveBeenCalledWith('sudo', expect.anything(), expect.anything());
    expect(code).toBe(0);
  });

  it('system-scoped systemd restart escalates through sudo when not already root', async () => {
    (detectManager as jest.Mock).mockReturnValue('systemd-system');
    const uidSpy = jest.spyOn(process, 'getuid').mockReturnValue(1000);

    const code = await runGatewayLifecycle(['restart'], {}, config);

    expect(execFileSync).toHaveBeenCalledWith('sudo', ['systemctl', 'restart', 'claude-gateway.service'], expect.anything());
    expect(code).toBe(0);
    uidSpy.mockRestore();
  });

  it('system-scoped systemd restart skips sudo when already root', async () => {
    (detectManager as jest.Mock).mockReturnValue('systemd-system');
    const uidSpy = jest.spyOn(process, 'getuid').mockReturnValue(0);

    const code = await runGatewayLifecycle(['restart'], {}, config);

    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['restart', 'claude-gateway.service'], expect.anything());
    expect(code).toBe(0);
    uidSpy.mockRestore();
  });

  it('pm2 restart delegates to pm2 and exits zero', async () => {
    (detectManager as jest.Mock).mockReturnValue('pm2');

    const code = await runGatewayLifecycle(['restart'], {}, config);

    expect(execFileSync).toHaveBeenCalledWith('pm2', ['restart', 'gateway'], expect.anything());
    expect(code).toBe(0);
  });

  it('a bare `gateway` is a usage error (1) while `gateway --help` is a help request (0)', async () => {
    expect(await runGatewayLifecycle([], {}, config)).toBe(1);
    expect(await runGatewayLifecycle([], { help: true }, config)).toBe(0);
  });

  it('`gateway start` is not served by the CLI runner — the entry point handles it', async () => {
    expect(await runGatewayLifecycle(['start'], {}, config)).toBe(1);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('unknown manager does nothing and exits non-zero', async () => {
    (detectManager as jest.Mock).mockReturnValue('unknown');

    const code = await runGatewayLifecycle(['restart'], {}, config);

    expect(killSpy).not.toHaveBeenCalled();
    expect(code).toBe(1);
  });
});

/**
 * `gateway status` reports the process on this host — `manager` comes from
 * local detection, so `health` has to be measured the same way. Probing
 * config.publicUrl would answer for a reverse proxy that may front a different
 * instance entirely.
 */
describe('cli gateway status', () => {
  const config: CliConfigView = { publicUrl: 'https://proxy.example.com/gateway', bind: '0.0.0.0' };
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (detectManager as jest.Mock).mockReturnValue('systemd-user');
  });

  afterEach(() => fetchSpy?.mockRestore());

  it('probes the local bind, not publicUrl, and exits 0 when healthy', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);

    const code = await runGatewayLifecycle(['status'], {}, config);

    expect(code).toBe(0);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://127.0.0.1:10850/health');
    expect(JSON.parse(stdout.join(''))).toEqual({
      manager: 'systemd-user',
      url: 'http://127.0.0.1:10850',
      health: 'up',
      detail: 'gateway responding',
    });
  });

  it('reports health down and exits non-zero when the probe fails', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const code = await runGatewayLifecycle(['status'], {}, config);

    expect(code).toBe(1);
    expect(JSON.parse(stdout.join('')).health).toBe('down');
    expect(JSON.parse(stdout.join('')).detail).toBe('no response');
  });

  /** `health` alone cannot tell an address that rejected the request apart from
   *  one that answered nothing, and that is the whole difference between a
   *  misconfigured proxy and a gateway that is not running. */
  it('keeps the HTTP status of an address that answered but is not healthy', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);

    const code = await runGatewayLifecycle(['status'], {}, config);

    expect(code).toBe(1);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ health: 'down', detail: 'HTTP 401 (answered, but not a healthy gateway)' });
  });

  it('honours an explicit --url for checking another host', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);

    await runGatewayLifecycle(['status'], { url: 'http://other:8080' }, config);

    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://other:8080/health');
  });

  it('--json prints one compact line', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);

    await runGatewayLifecycle(['status'], { json: true }, config);

    expect(stdout.join('').trim().split('\n')).toHaveLength(1);
  });
});

/**
 * The pidfile records a number, not an identity. A gateway killed with SIGKILL
 * or reaped by the OOM killer never removes it, and the kernel eventually hands
 * that pid to something else — at which point `detectManager()` still answers
 * `foreground` (signal-0 succeeds) and this branch would SIGTERM a stranger
 * while reporting a successful stop.
 */
describe('cli gateway foreground stop verifies the pid', () => {
  const config: CliConfigView = {};
  let killSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let stderr: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    stderr = [];
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true as never);
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr.push(c.toString());
      return true;
    });
    (detectManager as jest.Mock).mockReturnValue('foreground');
    (fs.readFileSync as jest.Mock).mockReturnValue('4242\n10850\n');
  });

  afterEach(() => {
    killSpy.mockRestore();
    errSpy.mockRestore();
  });

  // U-GW-375a — the case the guard exists for.
  it('U-GW-375a: refuses to signal a pid that is not a gateway', async () => {
    (pidLooksLikeGateway as jest.Mock).mockReturnValue(false);

    const code = await runGatewayLifecycle(['stop'], {}, config);

    expect(code).toBe(1);
    expect(killSpy).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('does not look like a gateway');
  });

  // U-GW-375b — and still stops a real one, so the guard is not just "never
  // signal anything".
  it('U-GW-375b: still stops a verified gateway', async () => {
    (pidLooksLikeGateway as jest.Mock).mockReturnValue(true);

    const code = await runGatewayLifecycle(['stop'], {}, config);

    expect(code).toBe(0);
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
  });

  // U-GW-375c — restart takes the same branch, so it needs the same guard.
  it('U-GW-375c: restart refuses an unverified pid too', async () => {
    (pidLooksLikeGateway as jest.Mock).mockReturnValue(false);

    const code = await runGatewayLifecycle(['restart'], {}, config);

    expect(code).toBe(1);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
