jest.mock('../../src/cli/manager', () => ({ detectManager: jest.fn() }));

import { detectManager } from '../../src/cli/manager';
import { runDoctor } from '../../src/cli/commands/doctor';
import type { CliConfigView } from '../../src/cli/http-client';

interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

describe('cli doctor', () => {
  let stdout: string[];
  let stderr: string[];
  let writeSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  const realFetch = global.fetch;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(chunk.toString());
      return true;
    });
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(chunk.toString());
      return true;
    });
    (detectManager as jest.Mock).mockReset().mockReturnValue('systemd');
  });

  afterEach(() => {
    writeSpy.mockRestore();
    errSpy.mockRestore();
    global.fetch = realFetch;
  });

  function report(): DoctorReport {
    return JSON.parse(stdout.join(''));
  }

  const configWithKey: CliConfigView = { keys: [{ key: 'sk-admin-doctor-test', agents: '*', admin: true }] };

  it('every check passes → ok:true, exit 0', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

    const code = await runDoctor({}, configWithKey);

    expect(code).toBe(0);
    const body = report();
    expect(body.ok).toBe(true);
    expect(body.checks.map((c) => c.name)).toEqual(['config', 'apiKey', 'url', 'manager', 'health']);
    expect(body.checks.every((c) => c.ok)).toBe(true);
  });

  it('an unreachable gateway fails only the health check and exits 1', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const code = await runDoctor({}, configWithKey);

    expect(code).toBe(1);
    const body = report();
    expect(body.ok).toBe(false);
    expect(body.checks.find((c) => c.name === 'health')).toEqual(expect.objectContaining({ ok: false, detail: 'no response' }));
    expect(body.checks.find((c) => c.name === 'config')?.ok).toBe(true);
  });

  it('no config/keys at all fails config + apiKey checks and exits 1', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

    const code = await runDoctor({}, {});

    expect(code).toBe(1);
    const body = report();
    expect(body.checks.find((c) => c.name === 'config')).toEqual(expect.objectContaining({ ok: false }));
    expect(body.checks.find((c) => c.name === 'apiKey')).toEqual(expect.objectContaining({ ok: false }));
  });

  it('a --key flag resolves apiKey even with no config keys', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

    const code = await runDoctor({ key: 'sk-from-flag' }, {});

    const body = report();
    expect(body.checks.find((c) => c.name === 'apiKey')).toEqual(expect.objectContaining({ ok: true }));
    expect(code).toBe(1); // config check still fails (no config keys present)
  });

  it('detectManager() === "unknown" fails the manager check and exits 1', async () => {
    (detectManager as jest.Mock).mockReturnValue('unknown');
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

    const code = await runDoctor({}, configWithKey);

    expect(code).toBe(1);
    expect(report().checks.find((c) => c.name === 'manager')).toEqual(expect.objectContaining({ ok: false, detail: 'unknown' }));
  });

  it('never prints the resolved API key itself, on stdout or stderr', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

    await runDoctor({}, configWithKey);

    expect(stdout.join('')).not.toContain('sk-admin-doctor-test');
    expect(stderr.join('')).not.toContain('sk-admin-doctor-test');
  });
});
