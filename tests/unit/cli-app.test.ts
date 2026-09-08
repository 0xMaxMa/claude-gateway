/**
 * `app list|start|stop|restart|uninstall|install` — a thin CLI wrapper over
 * `/v1/apps` (src/api/apps-router.ts). These tests pin: the HTTP method/path
 * mapping for every verb, the non-interactive confirmation gate on
 * `uninstall`, `<source>` classification for `install`, and that `install`
 * without `--wait` never claims the app is installed (only that the job was
 * accepted).
 */
const mockRequest = jest.fn();
/** Mutable so a test can give the plan a `fallbackUrl` — that is the only
 *  shape in which `resolveReachableUrl()` probes /health at all. */
const mockUrlPlan: { baseUrl: string; fallbackUrl?: string } = { baseUrl: 'http://127.0.0.1:10850' };

jest.mock('../../src/cli/http-client', () => ({
  ...jest.requireActual('../../src/cli/http-client'),
  request: (...args: unknown[]) => mockRequest(...args),
  loadCliConfig: () => ({}),
  resolveUrlPlan: () => mockUrlPlan,
  resolveKey: () => 'sk-admin-test',
}));

import { runCli } from '../../src/cli';
import { TransportError } from '../../src/cli/http-client';
import { parseInstallSource } from '../../src/cli/commands/app';

type Sent = { method: string; path: string; baseUrl: string; key?: string; body?: Record<string, unknown> };

describe('app — <source> classification (parseInstallSource)', () => {
  it('treats an http(s):// URL as a GitHub source', () => {
    expect(parseInstallSource('https://github.com/myorg/my-app')).toEqual({
      github_url: 'https://github.com/myorg/my-app',
    });
    expect(parseInstallSource('http://github.com/myorg/my-app')).toEqual({
      github_url: 'http://github.com/myorg/my-app',
    });
  });

  it('treats a path starting with /, ./, ../, or ~ as a local source, resolved to absolute', () => {
    expect(parseInstallSource('/home/dev/my-app')).toEqual({ local_path: '/home/dev/my-app' });
    expect(parseInstallSource('./my-app').local_path).toMatch(/\/my-app$/);
    expect(parseInstallSource('./my-app').local_path?.startsWith('/')).toBe(true);
    expect(parseInstallSource('../my-app').local_path?.startsWith('/')).toBe(true);
    expect(parseInstallSource('~/projects/my-app').local_path).not.toMatch(/^~/);
    expect(parseInstallSource('~/projects/my-app').local_path?.startsWith('/')).toBe(true);
  });

  it('treats anything else as a registry app name', () => {
    expect(parseInstallSource('agent-note')).toEqual({ registry_app: 'agent-note' });
    expect(parseInstallSource('getpod-manager')).toEqual({ registry_app: 'getpod-manager' });
  });

  it('does not mistake `~other-user/...` for the current user\'s home (code-review round)', () => {
    // expandHome() only expands the exact '~' / '~/...' forms; resolving
    // anything else would produce a bogus path with a literal `~alice`
    // segment. Falling through to registry_app instead surfaces a clear
    // "not found in registry" from the server rather than a confusing
    // filesystem error against a path nobody meant to construct.
    expect(parseInstallSource('~alice/my-app')).toEqual({ registry_app: '~alice/my-app' });
  });
});

describe('app', () => {
  let stdout: string[];
  let stderr: string[];
  let outSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let ttyDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    mockRequest.mockReset().mockResolvedValue({ status: 200, ok: true, data: { ok: true } });
    outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      stdout.push(c.toString());
      return true;
    });
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr.push(c.toString());
      return true;
    });
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    delete mockUrlPlan.fallbackUrl;
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  });

  /**
   * A usage error is the caller's, not the network's. `resolveReachableUrl()`
   * probes /health whenever the plan has a fallback, and on failure prints
   * "Cannot reach the gateway at … using …" — which, printed *above* the real
   * "Missing argument", reads as a connectivity problem for a command that was
   * never going to make a request in the first place.
   */
  describe('argument validation happens before the gateway is probed (code-review round)', () => {
    beforeEach(() => {
      mockUrlPlan.fallbackUrl = 'http://localhost:10850';
    });

    it.each(['start', 'stop', 'restart', 'uninstall', 'install'] as const)(
      '`app %s` with no positional never probes /health',
      async (verb) => {
        const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
        try {
          expect(await runCli(['app', verb])).toBe(1);
          expect(fetchSpy).not.toHaveBeenCalled();
          expect(stderr.join('')).not.toMatch(/Cannot reach the gateway/);
          expect(stderr.join('')).toMatch(/^Missing argument/);
        } finally {
          fetchSpy.mockRestore();
        }
      },
    );

    it.each([
      ['--version on a GitHub source', ['install', 'https://github.com/myorg/my-app', '--version', '1.0.0']],
      ['--commit on a registry source', ['install', 'agent-note', '--commit', 'a'.repeat(40)]],
      ['a malformed --env', ['install', 'agent-note', '--env', 'NOT-VALID']],
      ['a malformed --ports', ['install', 'agent-note', '--ports', 'web=notanumber']],
    ])('`app install` with %s never probes /health either', async (_label, argv) => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
      try {
        expect(await runCli(['app', ...(argv as string[])])).toBe(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(stderr.join('')).not.toMatch(/Cannot reach the gateway/);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('a valid invocation still probes and still falls back — the check was moved, not removed', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      try {
        expect(await runCli(['app', 'list'])).toBe(0);
        expect(fetchSpy).toHaveBeenCalled();
        expect(stderr.join('')).toMatch(/Cannot reach the gateway/);
        expect((mockRequest.mock.calls[0][0] as Sent).baseUrl).toBe('http://localhost:10850');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it('a bare `app` prints its verbs and exits 1; `--help` exits 0 on stdout', async () => {
    expect(await runCli(['app'])).toBe(1);
    expect(stderr.join('')).toContain('list|start|stop|restart|uninstall|install');

    stderr = [];
    expect(await runCli(['app', '--help'])).toBe(0);
    expect(stdout.join('')).toContain('claude-gateway app');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects an unknown verb', async () => {
    const code = await runCli(['app', 'frobnicate']);
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('Unknown: app frobnicate');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('`app list` calls GET /v1/apps and prints the result', async () => {
    mockRequest.mockResolvedValue({ status: 200, ok: true, data: { apps: [{ name: 'agent-note' }] } });
    const code = await runCli(['app', 'list']);
    expect(code).toBe(0);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const sent = mockRequest.mock.calls[0][0] as Sent;
    expect(sent.method).toBe('GET');
    expect(sent.path).toBe('/v1/apps');
    expect(JSON.parse(stdout.join(''))).toEqual({ apps: [{ name: 'agent-note' }] });
  });

  it.each(['start', 'stop', 'restart'] as const)('`app %s <name>` POSTs /v1/apps/:name/%s', async (verb) => {
    mockRequest.mockResolvedValue({ status: 200, ok: true, data: { name: 'agent-note', action: verb } });
    const code = await runCli(['app', verb, 'agent-note']);
    expect(code).toBe(0);
    const sent = mockRequest.mock.calls[0][0] as Sent;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe(`/v1/apps/agent-note/${verb}`);
  });

  it.each(['start', 'stop', 'restart'] as const)('`app %s` without a name is a usage error, not a request', async (verb) => {
    const code = await runCli(['app', verb]);
    expect(code).toBe(1);
    expect(stderr.join('')).toContain(`Missing argument: app ${verb} <name>`);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('`app uninstall <name>` refuses non-interactively without --yes', async () => {
    const code = await runCli(['app', 'uninstall', 'agent-note']);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/Refusing to uninstall non-interactively without --yes/);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('`app uninstall <name> --yes` sends DELETE /v1/apps/:name', async () => {
    mockRequest.mockResolvedValue({ status: 200, ok: true, data: { deleted: true, name: 'agent-note' } });
    const code = await runCli(['app', 'uninstall', 'agent-note', '--yes']);
    expect(code).toBe(0);
    const sent = mockRequest.mock.calls[0][0] as Sent;
    expect(sent.method).toBe('DELETE');
    expect(sent.path).toBe('/v1/apps/agent-note');
  });

  it('`app uninstall` without a name is a usage error', async () => {
    const code = await runCli(['app', 'uninstall']);
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('Missing argument: app uninstall <name>');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  describe('install', () => {
    it('requires a <source> argument', async () => {
      const code = await runCli(['app', 'install']);
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('Missing argument: app install <source>');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('maps a plain name to a registry install, with --version', async () => {
      mockRequest.mockResolvedValue({ status: 202, ok: true, data: { jobId: 'job-1' } });
      const code = await runCli(['app', 'install', 'agent-note', '--version', '1.0.0']);
      expect(code).toBe(0);
      const sent = mockRequest.mock.calls[0][0] as Sent;
      expect(sent.method).toBe('POST');
      expect(sent.path).toBe('/v1/apps/install');
      expect(sent.body).toEqual({ registry_app: 'agent-note', version: '1.0.0' });
      // Accepted, never claimed installed.
      expect(stderr.join('')).toMatch(/Install accepted \(job job-1\)/);
      expect(stderr.join('')).not.toMatch(/installed successfully/i);
    });

    it('maps a GitHub URL to a github install, with --commit and --env', async () => {
      mockRequest.mockResolvedValue({ status: 202, ok: true, data: { jobId: 'job-2' } });
      const commit = 'a'.repeat(40);
      const code = await runCli([
        'app',
        'install',
        'https://github.com/myorg/my-app',
        '--commit',
        commit,
        '--env',
        'DATABASE_URL=postgres://x,FOO=bar',
      ]);
      expect(code).toBe(0);
      const sent = mockRequest.mock.calls[0][0] as Sent;
      expect(sent.body).toEqual({
        github_url: 'https://github.com/myorg/my-app',
        commit,
        env_vars: { DATABASE_URL: 'postgres://x', FOO: 'bar' },
      });
    });

    it('maps a local path (./, ../, ~, or /) to a local install, with --ports', async () => {
      mockRequest.mockResolvedValue({ status: 202, ok: true, data: { jobId: 'job-3' } });
      const code = await runCli(['app', 'install', '/home/dev/my-app', '--ports', 'web=4000']);
      expect(code).toBe(0);
      const sent = mockRequest.mock.calls[0][0] as Sent;
      expect(sent.body).toEqual({ local_path: '/home/dev/my-app', ports: { web: 4000 } });
    });

    it('rejects --version on a non-registry source', async () => {
      const code = await runCli(['app', 'install', 'https://github.com/myorg/my-app', '--version', '1.0.0']);
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('--version only applies to a registry source');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('rejects --commit on a non-GitHub source', async () => {
      const code = await runCli(['app', 'install', 'agent-note', '--commit', 'a'.repeat(40)]);
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('--commit only applies to a GitHub source');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('rejects a malformed --env entry before making any request', async () => {
      const code = await runCli(['app', 'install', 'agent-note', '--env', 'NOT-VALID']);
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('Invalid --env entry');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('rejects a malformed --ports entry before making any request', async () => {
      const code = await runCli(['app', 'install', 'agent-note', '--ports', 'web=notanumber']);
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('Invalid --ports value');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('rejects a --ports entry with an empty value instead of silently sending port 0 (code-review round)', async () => {
      // `Number('')` is 0, not NaN — a bare "web=" (e.g. a typo dropping the
      // port number) must be reported as malformed, not silently coerced.
      const code = await runCli(['app', 'install', 'agent-note', '--ports', 'web=']);
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('Invalid --ports value for "web"');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('--wait polls the job and reports success once it completes', async () => {
      mockRequest
        .mockResolvedValueOnce({ status: 202, ok: true, data: { jobId: 'job-4' } })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          data: { id: 'job-4', status: 'completed', logs: ['Cloned', 'Built', 'Started'] },
        });
      const code = await runCli(['app', 'install', 'agent-note', '--wait']);
      expect(code).toBe(0);
      expect(mockRequest).toHaveBeenCalledTimes(2);
      const pollSent = mockRequest.mock.calls[1][0] as Sent;
      expect(pollSent.method).toBe('GET');
      expect(pollSent.path).toBe('/v1/apps/jobs/job-4');
      expect(stderr.join('')).toContain('Cloned');
      expect(stderr.join('')).toContain('Built');
      expect(JSON.parse(stdout.join(''))).toEqual(
        expect.objectContaining({ id: 'job-4', status: 'completed' }),
      );
    });

    it('--wait reports failure and a non-zero exit code when the job fails', async () => {
      mockRequest
        .mockResolvedValueOnce({ status: 202, ok: true, data: { jobId: 'job-5' } })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          data: { id: 'job-5', status: 'failed', logs: ['Build failed'], error: 'compose build exited 1' },
        });
      const code = await runCli(['app', 'install', 'agent-note', '--wait']);
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('Install failed: compose build exited 1');
    });

    it('--wait tolerates a single transient poll failure instead of aborting the whole wait (code-review round)', async () => {
      // A brief network blip mid-poll must not be reported as an install
      // failure — the job keeps running server-side regardless of whether
      // this one poll could reach it. Only a TransportError (never reached
      // the gateway at all) is worth retrying.
      jest.useFakeTimers();
      mockRequest
        .mockResolvedValueOnce({ status: 202, ok: true, data: { jobId: 'job-6' } })
        .mockRejectedValueOnce(new TransportError('Cannot reach gateway at http://127.0.0.1:10850: ECONNRESET'))
        .mockResolvedValueOnce({ status: 200, ok: true, data: { id: 'job-6', status: 'completed', logs: [] } });
      try {
        const promise = runCli(['app', 'install', 'agent-note', '--wait']);
        await jest.advanceTimersByTimeAsync(5_000);
        const code = await promise;
        expect(code).toBe(0);
        expect(mockRequest).toHaveBeenCalledTimes(3);
        expect(stderr.join('')).toMatch(/Poll failed, retrying: .*ECONNRESET/);
        expect(JSON.parse(stdout.join(''))).toEqual(expect.objectContaining({ id: 'job-6', status: 'completed' }));
      } finally {
        jest.useRealTimers();
      }
    });

    it('--wait redacts the job logs on stdout too, not only the streamed stderr copy (code-review round)', async () => {
      // printResult(job) serialises the whole JobState, `logs` included — so
      // printing the job raw undid, in the same command, the redaction applied
      // to the copy streamed to stderr four lines earlier.
      const secret = 'sk-livekey' + 'A'.repeat(30);
      mockRequest
        .mockResolvedValueOnce({ status: 202, ok: true, data: { jobId: 'job-8' } })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          data: { id: 'job-8', status: 'completed', logs: [`exporting API_KEY=${secret}`] },
        });
      const code = await runCli(['app', 'install', 'agent-note', '--wait']);
      expect(code).toBe(0);
      expect(stdout.join('')).not.toContain(secret);
      expect(stderr.join('')).not.toContain(secret);
      expect(JSON.parse(stdout.join('')).logs[0]).toContain('«redacted»');
    });

    it('--wait redacts the logs of a FAILED job on stdout as well (code-review round)', async () => {
      const secret = 'sk-livekey' + 'B'.repeat(30);
      mockRequest
        .mockResolvedValueOnce({ status: 202, ok: true, data: { jobId: 'job-9' } })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          data: { id: 'job-9', status: 'failed', logs: [`token=${secret}`], error: 'build failed' },
        });
      const code = await runCli(['app', 'install', 'agent-note', '--wait']);
      expect(code).toBe(1);
      expect(stdout.join('')).not.toContain(secret);
    });

    it('--wait fails fast on a non-transport poll error (404 job not found) instead of retrying for 30 minutes (code-review round)', async () => {
      // The gateway ANSWERED here (with an error), unlike the transient case
      // above — e.g. its in-memory job map was cleared by a restart, or the
      // admin key was revoked mid-poll. Retrying would never help.
      mockRequest
        .mockResolvedValueOnce({ status: 202, ok: true, data: { jobId: 'job-7' } })
        .mockRejectedValueOnce(new Error('HTTP 404 GET /v1/apps/jobs/job-7: Job not found'));
      const code = await runCli(['app', 'install', 'agent-note', '--wait']);
      expect(code).toBe(1);
      expect(mockRequest).toHaveBeenCalledTimes(2);
      expect(stderr.join('')).toContain('Could not poll job job-7: HTTP 404 GET /v1/apps/jobs/job-7: Job not found');
      expect(stderr.join('')).not.toMatch(/retrying/);
    });
  });
});
