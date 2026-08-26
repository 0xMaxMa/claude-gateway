jest.mock('../../src/cli/manager', () => ({ detectManager: jest.fn(), readLocalGateway: jest.fn(() => ({ pid: 1 })) }));

import { detectManager, readLocalGateway } from '../../src/cli/manager';
import { runDoctor } from '../../src/cli/commands/doctor';
import type { CliConfigView } from '../../src/cli/http-client';

interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string; info?: boolean }>;
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
    (readLocalGateway as jest.Mock).mockReset().mockReturnValue({ pid: 1 });
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

  it('an aborted probe says it timed out rather than just "no response"', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    global.fetch = jest.fn().mockRejectedValue(abort);

    const code = await runDoctor({}, configWithKey);

    expect(code).toBe(1);
    expect(report().checks.find((c) => c.name === 'health')?.detail).toMatch(/timed out/);
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

  /**
   * A gateway behind a reverse proxy has two addresses for one process. The
   * CLI uses the local one when a gateway is live on this host, and probes the
   * other for context only — its state must not decide the exit code, because
   * the CLI is not talking to it.
   */
  describe('two addresses for one gateway', () => {
    const proxied: CliConfigView = { ...configWithKey, publicUrl: 'https://proxy.example.com/gateway', bind: '0.0.0.0' };

    it('uses the local address and reports the public one as informational', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

      const code = await runDoctor({}, proxied);

      const body = report();
      expect(body.checks.map((c) => c.name)).toEqual(['config', 'apiKey', 'url', 'manager', 'health', 'publicUrl', 'publicHealth']);
      expect(body.checks.find((c) => c.name === 'url')?.detail).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(body.checks.find((c) => c.name === 'publicHealth')?.info).toBe(true);
      expect(code).toBe(0);
    });

    it('a proxy rejecting an unauthenticated probe does not fail doctor', async () => {
      // The exact shape that made `doctor` exit 1 on a perfectly healthy host:
      // the proxy answers 401 to an unauthenticated /health. The CLI does not
      // use that address, so it is context, not a verdict.
      global.fetch = jest.fn().mockImplementation((url: string) =>
        String(url).startsWith('http://127.0.0.1')
          ? Promise.resolve({ ok: true } as Response)
          : Promise.resolve({ ok: false, status: 401 } as Response),
      );

      const code = await runDoctor({}, proxied);

      const body = report();
      expect(body.ok).toBe(true);
      expect(code).toBe(0);
      const pub = body.checks.find((c) => c.name === 'publicHealth')!;
      expect(pub.ok).toBe(false);
      expect(pub.info).toBe(true);
      expect(pub.detail).toContain('HTTP 401');
      expect(pub.detail).not.toContain('no response');
      expect(stderr.join('')).toMatch(/the public URL answered HTTP 401/);
    });

    it('falls back to publicUrl when no gateway is live on this host', async () => {
      (readLocalGateway as jest.Mock).mockReturnValue(null);
      global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

      await runDoctor({}, proxied);

      expect(report().checks.find((c) => c.name === 'url')?.detail).toBe('https://proxy.example.com/gateway');
    });

    it('when told to use a remote URL, a healthy local gateway is the informational one', async () => {
      // $CLAUDE_GATEWAY_URL overrides the local preference, so `health` is the
      // remote probe again — and a failure there is fatal, with the local
      // address offered as the fix.
      const prev = process.env.CLAUDE_GATEWAY_URL;
      process.env.CLAUDE_GATEWAY_URL = 'https://proxy.example.com/gateway';
      try {
        global.fetch = jest.fn().mockImplementation((url: string) =>
          String(url).startsWith('http://127.0.0.1') ? Promise.resolve({ ok: true } as Response) : Promise.reject(new Error('ECONNREFUSED')),
        );

        const code = await runDoctor({}, proxied);

        const body = report();
        expect(body.checks.map((c) => c.name)).toEqual(['config', 'apiKey', 'url', 'manager', 'health', 'localUrl', 'localHealth']);
        expect(body.checks.find((c) => c.name === 'health')?.ok).toBe(false);
        expect(body.checks.find((c) => c.name === 'localHealth')?.ok).toBe(true);
        expect(stderr.join('')).toMatch(/Drop --url \/ \$CLAUDE_GATEWAY_URL/);
        expect(code).toBe(1);
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_GATEWAY_URL;
        else process.env.CLAUDE_GATEWAY_URL = prev;
      }
    });

    /** `--url` names the gateway to diagnose. Answering with *this* host's
     *  publicUrl as context is noise about a machine nobody asked about; the
     *  gateway running here is the one useful thing to mention. */
    it('never offers this host\'s publicUrl as context for a --url pointing elsewhere', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

      await runDoctor({ url: 'http://other-host:8080' }, proxied);

      const body = report();
      expect(body.checks.find((c) => c.name === 'url')?.detail).toBe('http://other-host:8080');
      expect(body.checks.map((c) => c.name)).not.toContain('publicUrl');
      expect(JSON.stringify(body)).not.toContain('proxy.example.com');
      // The local gateway is still worth naming — it is on the machine running
      // the command, and its state is not implied by the remote answer.
      expect(body.checks.find((c) => c.name === 'localUrl')?.detail).toBe('http://127.0.0.1:10850');
    });

    it('skips the second probe when there is only one address', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

      await runDoctor({}, configWithKey);

      const names = report().checks.map((c) => c.name);
      expect(names).not.toContain('publicHealth');
      expect(names).not.toContain('localHealth');
    });
  });

  it('honours the global --json flag like every other command', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

    await runDoctor({ json: true }, configWithKey);

    expect(stdout.join('').trim().split('\n')).toHaveLength(1);
    expect(report().ok).toBe(true);
  });

  it('never prints the resolved API key itself, on stdout or stderr', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

    await runDoctor({}, configWithKey);

    expect(stdout.join('')).not.toContain('sk-admin-doctor-test');
    expect(stderr.join('')).not.toContain('sk-admin-doctor-test');
  });
});
