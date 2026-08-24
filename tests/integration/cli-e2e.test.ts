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
  const jobs = [
    { id: 'job-1', agentId: 'agent-1', name: 'nightly', enabled: true },
    { id: 'job-2', agentId: 'agent-2', name: 'hourly', enabled: true },
  ];
  return {
    list: (agentId?: string) => (agentId ? jobs.filter((j) => j.agentId === agentId) : jobs),
    status: () => ({ running: true, jobCount: jobs.length }),
    get: (id: string) => jobs.find((j) => j.id === id),
    run: async (id: string) => ({ id, status: 'ok', jobId: id }),
    getRuns: async (_id: string, _limit: number) => [{ status: 'ok' }],
  };
}

let server: http.Server;
let baseUrl: string;
let stdout: string[];
let writeSpy: jest.SpyInstance;

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
});

afterEach(() => writeSpy.mockRestore());

// Never let a real ~/.claude-gateway/config.json leak in — force an empty config.
const base = (extra: string[]) => ['--config', '/nonexistent-config.json', '--url', baseUrl, '--key', KEY, ...extra];

function lastJson(): unknown {
  return JSON.parse(stdout.join(''));
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
