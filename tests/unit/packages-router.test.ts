/**
 * Unit tests for packages-router (Planning-54: Package Update API)
 *
 * T1:  GET /api/v1/packages — returns version info for both packages
 * T2:  GET /api/v1/packages — 401 when no API key
 * T3:  GET /api/v1/packages — 403 when non-admin key
 * T4:  GET /api/v1/packages — admin key allowed
 * T5:  GET /api/v1/packages — serves cached response on second call
 * T6:  GET /api/v1/packages — 503 when registry fetch throws
 * T7:  POST /api/v1/packages/claude-gateway/update — 404 for unknown name
 * T8:  POST /api/v1/packages/unknown/update — 404
 * T9:  POST /api/v1/packages/claude-gateway/update — already on latest → updated: false
 * T10: POST /api/v1/packages/claude-gateway/update — success, plain process warning
 * T11: POST /api/v1/packages/claude-gateway/update — success, systemd warning
 * T12: POST /api/v1/packages/claude-gateway/update — npm install fails → 500
 * T13: POST /api/v1/packages/claude-gateway/update — registry unavailable → 503
 * T14: POST /api/v1/packages/claude-code/update — success, warning: null
 * T15: POST /api/v1/packages/claude-gateway/update — 403 when non-admin key
 */

import express from 'express';
import request from 'supertest';
import { ApiKey } from '../../src/types';

// Must mock child_process before importing the module under test
jest.mock('child_process', () => ({ execSync: jest.fn() }));

import { execSync } from 'child_process';
import { createPackagesRouter, _resetCache } from '../../src/api/packages';

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

const ADMIN_KEY = 'admin-secret';
const USER_KEY = 'user-secret';

const apiKeys: ApiKey[] = [
  { key: ADMIN_KEY, description: 'admin', agents: '*', admin: true },
  { key: USER_KEY, description: 'user', agents: ['agent-1'] },
];

function makeApp(withAuth = true) {
  const app = express();
  app.use(express.json());
  app.use('/api', createPackagesRouter(withAuth ? apiKeys : undefined));
  return app;
}

// Keep track of the exit spy
let exitSpy: jest.SpyInstance;

beforeEach(() => {
  _resetCache();
  jest.clearAllMocks();
  // Prevent process.exit from actually exiting during tests
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  // Suppress timer-based exit: fast-forward timers
  jest.useFakeTimers();
});

afterEach(() => {
  exitSpy.mockRestore();
  jest.useRealTimers();
});

// Default mock: npm list returns version, fetch returns latest
function mockNpmList(pkg: string, version: string) {
  mockExecSync.mockImplementation((cmd: unknown) => {
    const cmdStr = cmd as string;
    if (cmdStr.includes(pkg)) {
      return JSON.stringify({ dependencies: { [pkg]: { version } } });
    }
    return '{}';
  });
}

function mockFetch(latestVersions: Record<string, string>) {
  global.fetch = jest.fn().mockImplementation((url: string) => {
    for (const [pkg, version] of Object.entries(latestVersions)) {
      const encoded = pkg.replace('/', '%2F');
      if (url.includes(encoded)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version }),
        });
      }
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as typeof fetch;
}

// ─── T1-T6: GET /api/v1/packages ────────────────────────────────────────────

describe('T1-T6: GET /api/v1/packages', () => {
  it('T1: returns version info for both packages', async () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      const cmdStr = cmd as string;
      if (cmdStr.includes('@0xmaxma/claude-gateway')) {
        return JSON.stringify({ dependencies: { '@0xmaxma/claude-gateway': { version: '1.2.0' } } });
      }
      if (cmdStr.includes('@anthropic-ai/claude-code')) {
        return JSON.stringify({ dependencies: { '@anthropic-ai/claude-code': { version: '1.0.5' } } });
      }
      return '{}';
    });
    mockFetch({ '@0xmaxma/claude-gateway': '1.3.1', '@anthropic-ai/claude-code': '1.1.0' });

    const res = await request(makeApp())
      .get('/api/v1/packages')
      .set('X-Api-Key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.packages).toHaveLength(2);

    const gw = res.body.packages.find((p: { package: string }) => p.package === '@0xmaxma/claude-gateway');
    expect(gw).toMatchObject({ current: '1.2.0', latest: '1.3.1', hasUpdate: true });

    const cc = res.body.packages.find((p: { package: string }) => p.package === '@anthropic-ai/claude-code');
    expect(cc).toMatchObject({ current: '1.0.5', latest: '1.1.0', hasUpdate: true });
  });

  it('T2: 401 when no API key', async () => {
    const res = await request(makeApp()).get('/api/v1/packages');
    expect(res.status).toBe(401);
  });

  it('T3: 403 when non-admin key', async () => {
    const res = await request(makeApp())
      .get('/api/v1/packages')
      .set('X-Api-Key', USER_KEY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('admin API key required');
  });

  it('T4: admin key is allowed', async () => {
    mockExecSync.mockReturnValue('{}');
    mockFetch({ '@0xmaxma/claude-gateway': '1.0.0', '@anthropic-ai/claude-code': '1.0.0' });

    const res = await request(makeApp())
      .get('/api/v1/packages')
      .set('X-Api-Key', ADMIN_KEY);
    expect(res.status).toBe(200);
  });

  it('T5: serves cached response on second call without re-fetching', async () => {
    mockExecSync.mockReturnValue(JSON.stringify({ dependencies: { '@0xmaxma/claude-gateway': { version: '1.0.0' }, '@anthropic-ai/claude-code': { version: '1.0.0' } } }));
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '1.0.0' }),
    });
    global.fetch = fetchMock as typeof fetch;

    const app = makeApp();
    await request(app).get('/api/v1/packages').set('X-Api-Key', ADMIN_KEY);
    await request(app).get('/api/v1/packages').set('X-Api-Key', ADMIN_KEY);

    // fetch called for 2 packages on first request; second request uses cache
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('T6: 503 when registry fetch throws', async () => {
    mockExecSync.mockReturnValue(JSON.stringify({ dependencies: { '@0xmaxma/claude-gateway': { version: '1.0.0' } } }));
    global.fetch = jest.fn().mockRejectedValue(new Error('network error')) as typeof fetch;

    const res = await request(makeApp())
      .get('/api/v1/packages')
      .set('X-Api-Key', ADMIN_KEY);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('registry unavailable');
  });
});

// ─── T7-T15: POST /api/v1/packages/:name/update ─────────────────────────────

describe('T7-T15: POST /api/v1/packages/:name/update', () => {
  it('T7: 404 for unrecognised name', async () => {
    const res = await request(makeApp())
      .post('/api/v1/packages/unknown-pkg/update')
      .set('X-Api-Key', ADMIN_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown package: unknown-pkg');
  });

  it('T8: 404 for completely unknown name "foo"', async () => {
    const res = await request(makeApp())
      .post('/api/v1/packages/foo/update')
      .set('X-Api-Key', ADMIN_KEY);
    expect(res.status).toBe(404);
  });

  it('T9: already on latest — updated: false, no restart', async () => {
    mockNpmList('@0xmaxma/claude-gateway', '1.3.1');
    mockFetch({ '@0xmaxma/claude-gateway': '1.3.1' });

    const res = await request(makeApp())
      .post('/api/v1/packages/claude-gateway/update')
      .set('X-Api-Key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      package: '@0xmaxma/claude-gateway',
      from: '1.3.1',
      to: '1.3.1',
      updated: false,
      warning: null,
    });
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('npm install -g'),
      expect.anything(),
    );
  });

  it('T10: claude-gateway updated — plain process warning', async () => {
    // Remove systemd/pm2 env vars to simulate plain process
    const savedInvocationId = process.env.INVOCATION_ID;
    const savedPm2Home = process.env.PM2_HOME;
    const savedPmId = process.env.pm_id;
    delete process.env.INVOCATION_ID;
    delete process.env.PM2_HOME;
    delete process.env.pm_id;

    let callCount = 0;
    mockExecSync.mockImplementation((cmd: unknown) => {
      const cmdStr = cmd as string;
      if (cmdStr.includes('npm list')) {
        callCount++;
        // First call: current; second call (after install): to
        const version = callCount === 1 ? '1.2.0' : '1.3.1';
        return JSON.stringify({ dependencies: { '@0xmaxma/claude-gateway': { version } } });
      }
      // npm install — no output
      return '';
    });
    mockFetch({ '@0xmaxma/claude-gateway': '1.3.1' });

    const res = await request(makeApp())
      .post('/api/v1/packages/claude-gateway/update')
      .set('X-Api-Key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      package: '@0xmaxma/claude-gateway',
      from: '1.2.0',
      to: '1.3.1',
      updated: true,
      warning: 'process will stop — restart manually',
    });

    // Restore
    if (savedInvocationId !== undefined) process.env.INVOCATION_ID = savedInvocationId;
    if (savedPm2Home !== undefined) process.env.PM2_HOME = savedPm2Home;
    if (savedPmId !== undefined) process.env.pm_id = savedPmId;

    // process.exit(0) should be scheduled
    jest.runAllTimers();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('T11: claude-gateway updated — systemd managed warning', async () => {
    const savedInvocationId = process.env.INVOCATION_ID;
    process.env.INVOCATION_ID = 'abc123';

    let callCount = 0;
    mockExecSync.mockImplementation((cmd: unknown) => {
      const cmdStr = cmd as string;
      if (cmdStr.includes('npm list')) {
        callCount++;
        const version = callCount === 1 ? '1.2.0' : '1.3.1';
        return JSON.stringify({ dependencies: { '@0xmaxma/claude-gateway': { version } } });
      }
      return '';
    });
    mockFetch({ '@0xmaxma/claude-gateway': '1.3.1' });

    const res = await request(makeApp())
      .post('/api/v1/packages/claude-gateway/update')
      .set('X-Api-Key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.warning).toBe('service will restart');

    if (savedInvocationId !== undefined) process.env.INVOCATION_ID = savedInvocationId;
    else delete process.env.INVOCATION_ID;
  });

  it('T12: npm install fails → 500 with stderr', async () => {
    mockNpmList('@0xmaxma/claude-gateway', '1.2.0');
    mockFetch({ '@0xmaxma/claude-gateway': '1.3.1' });

    const installError = Object.assign(new Error('npm ERR!'), {
      stderr: Buffer.from('npm ERR! 404 Not Found'),
    });
    mockExecSync.mockImplementation((cmd: unknown) => {
      const cmdStr = cmd as string;
      if (cmdStr.includes('npm list')) {
        return JSON.stringify({ dependencies: { '@0xmaxma/claude-gateway': { version: '1.2.0' } } });
      }
      throw installError;
    });

    const res = await request(makeApp())
      .post('/api/v1/packages/claude-gateway/update')
      .set('X-Api-Key', ADMIN_KEY);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('npm ERR!');
  });

  it('T13: registry unavailable during update → 503', async () => {
    mockNpmList('@0xmaxma/claude-gateway', '1.2.0');
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch;

    const res = await request(makeApp())
      .post('/api/v1/packages/claude-gateway/update')
      .set('X-Api-Key', ADMIN_KEY);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('registry unavailable');
  });

  it('T14: claude-code updated — warning is null, no process exit', async () => {
    let callCount = 0;
    mockExecSync.mockImplementation((cmd: unknown) => {
      const cmdStr = cmd as string;
      if (cmdStr.includes('npm list')) {
        callCount++;
        const version = callCount === 1 ? '1.0.5' : '1.1.0';
        return JSON.stringify({ dependencies: { '@anthropic-ai/claude-code': { version } } });
      }
      return '';
    });
    mockFetch({ '@anthropic-ai/claude-code': '1.1.0' });

    const res = await request(makeApp())
      .post('/api/v1/packages/claude-code/update')
      .set('X-Api-Key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      package: '@anthropic-ai/claude-code',
      from: '1.0.5',
      to: '1.1.0',
      updated: true,
      warning: null,
    });

    jest.runAllTimers();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('T15: 403 when non-admin key attempts update', async () => {
    const res = await request(makeApp())
      .post('/api/v1/packages/claude-gateway/update')
      .set('X-Api-Key', USER_KEY);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('admin API key required');
  });
});
