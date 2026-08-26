import express from 'express';
import * as http from 'http';
import { createCronRouter } from '../../src/api/cron-router';
import { createMetaRouter } from '../../src/api/meta-router';
import { runCli } from '../../src/cli';
import { ApiKey } from '../../src/types';

/**
 * End-to-end CLI test: a real Express server mounting the converted cron router
 * and the meta router, driven through the actual runCli() → http-client path.
 * Proves friendly commands, the api passthrough, query mapping, and auth all
 * work against a live server.
 */

const KEY = 'e2e-admin-key';
const apiKeys: ApiKey[] = [{ key: KEY, description: 'e2e', agents: '*', admin: true }];

// Minimal CronManager stand-in — only the methods the routes call.
function makeManager() {
  const jobs: Array<Record<string, unknown>> = [
    { id: 'job-1', agentId: 'agent-1', name: 'nightly', enabled: true },
    { id: 'job-2', agentId: 'agent-2', name: 'hourly', enabled: true },
  ];
  let nextId = 3;
  return {
    list: (agentId?: string) => (agentId ? jobs.filter((j) => j.agentId === agentId) : jobs),
    status: () => ({ running: true, jobCount: jobs.length }),
    get: (id: string) => jobs.find((j) => j.id === id),
    run: async (id: string) => ({ id, status: 'ok', jobId: id }),
    getRuns: async (_id: string, _limit: number) => [{ status: 'ok' }],
    create: async (body: Record<string, unknown>) => {
      const job = { id: `job-${nextId++}`, enabled: true, ...body };
      jobs.push(job);
      return job;
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) throw new Error('Job not found');
      Object.assign(job, patch);
      return job;
    },
    remove: async (id: string) => {
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx === -1) throw new Error('Job not found');
      jobs.splice(idx, 1);
    },
  };
}

let server: http.Server;
let baseUrl: string;
let stdout: string[];
let writeSpy: jest.SpyInstance;
let stderr: string[];
let stderrSpy: jest.SpyInstance;

beforeAll((done) => {
  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(express.json());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/api', createCronRouter(makeManager() as any, apiKeys, new Set(['agent-1', 'agent-2'])));
  app.use('/api', createMetaRouter(apiKeys));
  server = app.listen(0, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => {
  stdout = [];
  writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(chunk.toString());
    return true;
  });
  stderr = [];
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString());
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  stderrSpy.mockRestore();
});

// Never let a real ~/.claude-gateway/config.json leak in — force an empty config.
const base = (extra: string[]) => ['--config', '/nonexistent-config.json', '--url', baseUrl, '--key', KEY, ...extra];

/**
 * The CLI's result document, ignoring anything else that reached stdout.
 *
 * The spy is on `process.stdout.write` for the whole process, so an async
 * writer left behind by an earlier test file in the same Jest worker can drop a
 * structured log record into the middle of the capture. Parsing the raw
 * concatenation then fails with "unexpected non-whitespace character" on a run
 * that has nothing to do with the CLI.
 */
function lastJson(): unknown {
  const isLogRecord = (chunk: string): boolean => {
    try {
      const parsed: unknown = JSON.parse(chunk);
      return !!parsed && typeof parsed === 'object' && 'ts' in parsed && 'level' in parsed;
    } catch {
      return false;
    }
  };
  return JSON.parse(stdout.filter((chunk) => !isLogRecord(chunk)).join(''));
}

describe('cli e2e — friendly resource commands', () => {
  it('`crons list` returns the jobs as JSON, exit 0', async () => {
    const code = await runCli(['crons', 'list', ...base([])]);
    expect(code).toBe(0);
    expect(lastJson()).toEqual({ jobs: [expect.objectContaining({ id: 'job-1' }), expect.objectContaining({ id: 'job-2' })] });
  });

  it('`crons list --agent agent-1` maps the flag to a query param', async () => {
    const code = await runCli(['crons', 'list', ...base(['--agent', 'agent-1'])]);
    expect(code).toBe(0);
    expect(lastJson()).toEqual({ jobs: [expect.objectContaining({ id: 'job-1' })] });
  });

  it('`crons run <id>` fills the positional path arg', async () => {
    const code = await runCli(['crons', 'run', 'job-1', ...base([])]);
    expect(code).toBe(0);
    expect(lastJson()).toEqual({ run: expect.objectContaining({ jobId: 'job-1' }) });
  });

  it('missing a required positional arg fails without calling the server', async () => {
    const code = await runCli(['crons', 'run', ...base([])]);
    expect(code).toBe(1);
  });

  it('an unknown verb fails with exit 1', async () => {
    const code = await runCli(['crons', 'frobnicate', ...base([])]);
    expect(code).toBe(1);
  });

  it('`--json` prints compact (single-line) JSON instead of the pretty-printed default', async () => {
    const prettyCode = await runCli(['crons', 'list', ...base([])]);
    expect(prettyCode).toBe(0);
    const pretty = stdout.join('');
    expect(pretty.split('\n').length).toBeGreaterThan(2); // pretty-printed spans multiple lines

    stdout = [];
    const compactCode = await runCli(['crons', 'list', ...base(['--json'])]);
    expect(compactCode).toBe(0);
    const compact = stdout.join('');
    expect(compact.trim().split('\n')).toHaveLength(1); // one line: the minified JSON
    expect(JSON.parse(compact)).toEqual(JSON.parse(pretty)); // same data either way
  });
});

describe('cli e2e — crons create/update/delete/get/runs/status', () => {
  it('`crons create` posts a new job (cleaned up after)', async () => {
    const code = await runCli(['crons', 'create', ...base(['--agentId', 'agent-1', '--name', 'testjob', '--schedule', '0 9 * * *', '--command', 'echo hi'])]);
    expect(code).toBe(0);
    const body = lastJson() as { job: { id: string; agentId: string; name: string } };
    expect(body.job).toEqual(expect.objectContaining({ agentId: 'agent-1', name: 'testjob' }));

    stdout = [];
    const delCode = await runCli(['crons', 'delete', body.job.id, ...base([])]);
    expect(delCode).toBe(0);
    expect(lastJson()).toEqual({ ok: true });
  });

  it('`crons create` missing a required flag (--name) fails without calling the server', async () => {
    const code = await runCli(['crons', 'create', ...base(['--agentId', 'agent-1', '--schedule', '0 9 * * *', '--command', 'echo hi'])]);
    expect(code).toBe(1);
  });

  it('`crons get <id>` returns a single job', async () => {
    const code = await runCli(['crons', 'get', 'job-1', ...base([])]);
    expect(code).toBe(0);
    expect(lastJson()).toEqual({ job: expect.objectContaining({ id: 'job-1' }) });
  });

  it('`crons get <unknown>` 404s and exits non-zero', async () => {
    const code = await runCli(['crons', 'get', 'nope', ...base([])]);
    expect(code).toBe(1);
  });

  it('`crons update <id> --data <json>` updates via the JSON body escape hatch (no declared body flags for update; reverted after)', async () => {
    const code = await runCli(['crons', 'update', 'job-2', '--data', '{"enabled":false}', ...base([])]);
    expect(code).toBe(0);
    expect(lastJson()).toEqual({ job: expect.objectContaining({ id: 'job-2', enabled: false }) });

    stdout = [];
    const revertCode = await runCli(['crons', 'update', 'job-2', '--data', '{"enabled":true}', ...base([])]);
    expect(revertCode).toBe(0);
    expect(lastJson()).toEqual({ job: expect.objectContaining({ id: 'job-2', enabled: true }) });
  });

  /** `JSON.parse` accepts primitives and arrays too, and merging declared flags
   *  into one of those threw `Cannot use 'in' operator` — an internal message
   *  where the intended one was already written a few lines above. */
  it.each(['5', '"text"', 'null', '[1,2]'])('`--data %s` is rejected as not an object', async (data) => {
    const code = await runCli(['crons', 'create', '--data', data, ...base([])]);
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('Invalid --data: must be a JSON object.');
    expect(stderr.join('')).not.toMatch(/in' operator|TypeError/);
  });

  it('`crons update <unknown>` 404s and exits non-zero', async () => {
    const code = await runCli(['crons', 'update', 'nope', '--data', '{}', ...base([])]);
    expect(code).toBe(1);
  });

  it('`crons delete <unknown>` 404s and exits non-zero', async () => {
    const code = await runCli(['crons', 'delete', 'nope', ...base([])]);
    expect(code).toBe(1);
  });

  it('`crons runs <id> --limit 1` returns run history', async () => {
    const code = await runCli(['crons', 'runs', 'job-1', '--limit', '1', ...base([])]);
    expect(code).toBe(0);
    expect(lastJson()).toEqual({ runs: [{ status: 'ok' }] });
  });

  it('`crons status` reports the scheduler status', async () => {
    const code = await runCli(['crons', 'status', ...base([])]);
    expect(code).toBe(0);
    expect(lastJson()).toEqual({ running: true, jobCount: expect.any(Number) });
  });
});

describe('cli e2e — api passthrough & meta', () => {
  it('`api GET /v1/_meta/routes` returns the manifest', async () => {
    const code = await runCli(['api', 'GET', '/v1/_meta/routes', ...base([])]);
    expect(code).toBe(0);
    const body = lastJson() as { routes: Array<{ cli?: { noun: string } }> };
    expect(body.routes.some((r) => r.cli?.noun === 'crons')).toBe(true);
  });

  it('api passthrough with a bad path errors and exits non-zero', async () => {
    const code = await runCli(['api', 'GET', '/v1/does-not-exist', ...base([])]);
    expect(code).toBe(1);
  });
});

describe('cli e2e — auth', () => {
  it('a wrong key yields a non-zero exit', async () => {
    const code = await runCli(['crons', 'list', '--config', '/nonexistent-config.json', '--url', baseUrl, '--key', 'wrong-key']);
    expect(code).toBe(1);
  });
});

describe('cli e2e — help/version', () => {
  it('no command prints general help to stderr and exits 0', async () => {
    const code = await runCli([]);
    expect(code).toBe(0);
    expect(stderr.join('')).toMatch(/claude-gateway v\d+\.\d+\.\d+ — control a running gateway/);
  });

  it('`help` prints the same general help and exits 0', async () => {
    const code = await runCli(['help']);
    expect(code).toBe(0);
    expect(stderr.join('')).toMatch(/Usage: claude-gateway <command>/);
  });

  it('`version` prints the package version to stdout and exits 0', async () => {
    const code = await runCli(['version']);
    expect(code).toBe(0);
    const printed = stdout.join('').trim();
    expect(printed).toMatch(/^\d+\.\d+\.\d+/);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(printed).toBe((require('../../package.json') as { version: string }).version);
  });

  it('`--version` is accepted as an alias for `version`', async () => {
    const code = await runCli(['--version']);
    expect(code).toBe(0);
    expect(stdout.join('').trim().length).toBeGreaterThan(0);
  });

  it('`logs` was removed rather than left as a failing stub — it is now simply unknown', async () => {
    const code = await runCli(['logs', ...base([])]);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/Unknown command: logs/);
  });

  it('an unknown top-level command exits 1 and prints general help', async () => {
    const code = await runCli(['frobnicate']);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/Unknown command: frobnicate/);
  });

  it('general help documents `gateway start` as the way to start the server', async () => {
    await runCli([]);
    const help = stderr.join('');
    expect(help).toMatch(/gateway start/);
    expect(help).toMatch(/service install\|status\|uninstall/);
    expect(help).toMatch(/update \[check\]/);
  });

  it('`<noun> --help` is a help request (exit 0); a bare `<noun>` is a usage error (exit 1)', async () => {
    // Both print the same verb listing — only the exit code distinguishes
    // "you asked for help" from "you forgot the verb".
    expect(await runCli(['crons', '--help'])).toBe(0);
    expect(stderr.join('')).toMatch(/claude-gateway crons — commands:/);

    stderr = [];
    expect(await runCli(['crons'])).toBe(1);
    expect(stderr.join('')).toMatch(/claude-gateway crons — commands:/);
  });

  // Every noun, not a hand-picked few: `agents` and `channels` returned 1 for
  // `--help` because this pinned only the three that were already right.
  // `update` is absent by design: a bare `update` performs the update, so it is
  // not a verb-less usage error the way these are.
  it.each(['gateway', 'service', 'crons', 'agents', 'channels', 'claude'])(
    '`%s --help` exits 0 while its bare form exits 1',
    async (noun) => {
      expect(await runCli([noun, '--help'])).toBe(0);
      expect(await runCli([noun])).toBe(1);
    },
  );

  it('`update --help` exits 0 without performing an update', async () => {
    expect(await runCli(['update', '--help'])).toBe(0);
  });

  it('honours `-h` as a short alias, not a command name', async () => {
    expect(await runCli(['crons', '-h'])).toBe(0);
    expect(stderr.join('')).toMatch(/claude-gateway crons — commands:/);
  });
});
