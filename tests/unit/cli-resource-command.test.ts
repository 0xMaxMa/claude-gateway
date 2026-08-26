/**
 * Generated `<noun> <verb>` commands — the contract around their help stream
 * and their flags.
 *
 * Both defects here shared a shape: the command did something other than what
 * the user asked for, and still exited 0. Help was written to stderr while the
 * documented contract (CLI.md) puts a requested listing on stdout, so
 * `crons list --help | grep …` matched nothing; and a flag outside the
 * generated manifest was parsed, dropped, and never mentioned, so a typo
 * created a job missing that field and a command whose manifest declared no
 * flags at all sent an empty body the server applied as a no-op.
 */
const mockRequest = jest.fn();

jest.mock('../../src/cli/http-client', () => ({
  ...jest.requireActual('../../src/cli/http-client'),
  request: (...args: unknown[]) => mockRequest(...args),
  loadCliConfig: () => ({ keys: [{ key: 'sk-test', admin: true }] }),
  resolveUrlPlan: () => ({ baseUrl: 'http://127.0.0.1:10850' }),
  resolveKey: () => 'sk-test',
}));

import { runCli } from '../../src/cli';

describe('generated resource commands', () => {
  let stdout: string[];
  let stderr: string[];
  let outSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    mockRequest.mockReset().mockResolvedValue({ data: { ok: true } });
    outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      stdout.push(c.toString());
      return true;
    });
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr.push(c.toString());
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  // U-RC-375a — asked-for help is output, not diagnostics. `printNounHelp`
  // already routed by `requested`; the per-verb renderer computed the same
  // stream and then wrote to stderr regardless, so only this one was wrong.
  it('U-RC-375a: `<noun> <verb> --help` writes help to stdout', async () => {
    const code = await runCli(['crons', 'list', '--help']);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('crons list');
    expect(stderr.join('')).toBe('');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  // U-RC-375b — the noun-level renderer must keep behaving the same way, so
  // the two paths cannot drift apart again unnoticed.
  it('U-RC-375b: `<noun> --help` still writes to stdout', async () => {
    const code = await runCli(['crons', '--help']);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('crons');
    expect(stderr.join('')).toBe('');
  });

  // U-RC-375c — a usage error is diagnostics: still stderr, still non-zero.
  it('U-RC-375c: an unusable invocation still reports on stderr and fails', async () => {
    const code = await runCli(['crons', 'nope']);

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('Unknown command: crons nope');
    expect(stdout.join('')).toBe('');
  });

  // U-RC-375d — the typo case. `--schedul` used to be dropped silently and the
  // job was created without a schedule, exit 0.
  it('U-RC-375d: a mistyped flag is refused instead of dropped', async () => {
    const code = await runCli([
      'crons',
      'create',
      '--agentId',
      'a1',
      '--name',
      'nightly',
      '--schedul',
      '0 3 * * *',
    ]);

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('Unknown flag(s): --schedul');
    // Nothing may reach the API: the whole point is that the half-specified
    // job is never created.
    expect(mockRequest).not.toHaveBeenCalled();
  });

  // U-RC-375e — `crons update` declared no flags, so every field the user
  // typed vanished and the PUT carried no body at all. The manager applied
  // `{}` and the CLI printed the unchanged job as success.
  it('U-RC-375e: `crons update` sends the fields it was given', async () => {
    const code = await runCli(['crons', 'update', 'job-1', '--name', 'renamed']);

    expect(code).toBe(0);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const sent = mockRequest.mock.calls[0][0] as { method: string; path: string; body?: Record<string, unknown> };
    expect(sent.method).toBe('PUT');
    expect(sent.path).toBe('/v1/crons/job-1');
    expect(sent.body).toEqual({ name: 'renamed' });
  });

  // U-RC-375f — global flags are not the command's own, and must stay accepted.
  it('U-RC-375f: global flags are not mistaken for typos', async () => {
    const code = await runCli(['crons', 'list', '--json', '--url', 'http://x:1', '--key', 'sk-1']);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
