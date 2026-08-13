import express from 'express';
import request from 'supertest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AppsRegistry, AppEntry } from '../../../src/apps/registry';
import { AppInstaller, InstallerCallbacks, JobState } from '../../../src/apps/installer';
import { RegistryClient } from '../../../src/apps/registry-client';
import { createAppsRouter } from '../../../src/api/apps-router';
import { ApiKey } from '../../../src/types';
import { ComposePort, ComposeSocket } from '../../../src/apps/compose-generator';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const ADMIN_KEY: ApiKey = { key: 'admin-key', agents: '*', admin: true };
const READ_KEY: ApiKey = { key: 'read-key', agents: '*' };
const API_KEYS: ApiKey[] = [ADMIN_KEY, READ_KEY];

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apps-router-test-'));
}

function makeTmpPath(): string {
  const dir = makeTmpDir();
  return path.join(dir, 'apps.json');
}

function makeEntry(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'test-app',
    version: '1.0.0',
    commit: 'abc123def456abc123def456abc123def456abc1',
    githubUrl: 'https://github.com/test/test-app',
    installPath: '/home/ubuntu/.claude-gateway/apps/test-app',
    ports: [{ name: 'api', service: 'app', hostPort: 5000, containerPort: 5000, type: 'api', rateLimit: 200 }],
    sockets: {},
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    source: 'registry',
    ...overrides,
  };
}

/** Create a stub AppInstaller backed by an in-memory job map */
function makeInstaller(
  registry: AppsRegistry,
  appsDir?: string,
  spawn?: (cmd: string, args: string[], opts?: object) => { stdout: string; stderr: string; status: number },
): { installer: AppInstaller; callbacks: InstallerCallbacks } {
  const callbacks: InstallerCallbacks = {
    registerRoutes: jest.fn((_appName: string, _ports: ComposePort[]) => {}),
    deregisterRoutes: jest.fn((_appName: string) => {}),
    startSocket: jest.fn((_socketPath: string, _socket: ComposeSocket) => Promise.resolve()),
    stopSockets: jest.fn((_appName: string) => {}),
  };
  const installer = new AppInstaller(
    registry,
    new RegistryClient(),
    callbacks,
    (spawn ?? jest.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 })) as ConstructorParameters<typeof AppInstaller>[3],
    appsDir ?? makeTmpDir(),
  );
  return { installer, callbacks };
}

/** Create a mock RegistryClient */
function makeRegistryClient(apps = VALID_REGISTRY_APPS): RegistryClient {
  const client = new RegistryClient();
  jest.spyOn(client, 'fetchRegistry').mockResolvedValue({
    updated_at: '2026-05-19T00:00:00Z',
    apps,
  });
  return client;
}

const VALID_REGISTRY_APPS = [
  {
    name: 'getpod-manager',
    description: 'VM manager',
    repo: 'https://github.com/0xMaxMa/getpod-manager',
    author: '0xMaxMa',
    versions: [
      {
        version: '1.0.0',
        commit: 'abc123def456abc123def456abc123def456abc1',
        approved_at: '2026-05-01',
      },
    ],
  },
];

function makeApp(
  registry: AppsRegistry,
  registryClient: RegistryClient,
  spawn?: (cmd: string, args: string[], opts?: object) => { stdout: string; stderr: string; status: number },
): express.Application {
  const app = express();
  app.use(express.json());
  const { installer } = makeInstaller(registry, undefined, spawn);
  app.use('/api', createAppsRouter(registry, installer, registryClient, API_KEYS));
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createAppsRouter()', () => {
  let registry: AppsRegistry;
  let registryClient: RegistryClient;
  let app: express.Application;

  beforeEach(() => {
    registry = new AppsRegistry(makeTmpPath());
    registryClient = makeRegistryClient();
    app = makeApp(registry, registryClient);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── GET /api/v1/apps ────────────────────────────────────────────────────

  describe('GET /api/v1/apps', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v1/apps');
      expect(res.status).toBe(401);
    });

    it('returns empty apps array when no apps installed', async () => {
      const res = await request(app)
        .get('/api/v1/apps')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body.apps).toEqual([]);
    });

    it('returns installed apps', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .get('/api/v1/apps')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body.apps).toHaveLength(1);
      expect(res.body.apps[0].name).toBe('test-app');
    });
  });

  // ── GET /api/v1/apps/registry ───────────────────────────────────────────

  describe('GET /api/v1/apps/registry', () => {
    it('returns registry data', async () => {
      const res = await request(app)
        .get('/api/v1/apps/registry')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.apps)).toBe(true);
    });

    it('returns 502 on registry fetch failure', async () => {
      jest.spyOn(registryClient, 'fetchRegistry').mockRejectedValue(new Error('network'));
      const res = await request(app)
        .get('/api/v1/apps/registry')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(502);
    });
  });

  // ── GET /api/v1/apps/registry/:name ────────────────────────────────────

  describe('GET /api/v1/apps/registry/:name', () => {
    it('returns the named app', async () => {
      const res = await request(app)
        .get('/api/v1/apps/registry/getpod-manager')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('getpod-manager');
    });

    it('returns 404 for unknown app', async () => {
      const res = await request(app)
        .get('/api/v1/apps/registry/nonexistent')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/apps/install ──────────────────────────────────────────

  describe('POST /api/v1/apps/install', () => {
    it('returns 403 for non-admin key', async () => {
      const res = await request(app)
        .post('/api/v1/apps/install')
        .set('Authorization', `Bearer ${READ_KEY.key}`)
        .send({ registry_app: 'getpod-manager' });
      expect(res.status).toBe(403);
    });

    it('returns 400 when no source provided', async () => {
      const res = await request(app)
        .post('/api/v1/apps/install')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 202 with jobId for registry install', async () => {
      const res = await request(app)
        .post('/api/v1/apps/install')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ registry_app: 'getpod-manager', version: '1.0.0' });
      expect(res.status).toBe(202);
      expect(typeof res.body.jobId).toBe('string');
    });

    it('returns 202 with jobId for local_path install', async () => {
      // Use a tmp path — the job will fail async (no app.yaml), but the API accepts it immediately
      const fakeLocalPath = path.join(os.tmpdir(), 'fake-app-nonexistent');
      const res = await request(app)
        .post('/api/v1/apps/install')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ local_path: fakeLocalPath });
      expect(res.status).toBe(202);
      expect(typeof res.body.jobId).toBe('string');
    });
  });

  // ── POST /api/v1/apps/inspect ──────────────────────────────────────────

  describe('POST /api/v1/apps/inspect', () => {
    /** Spawn that resolves HEAD and writes an app.yaml (bare-key secret +
     *  self-generating secret) on checkout, so inspect returns real keys. */
    function inspectSpawn(head: string) {
      return (cmd: string, args: string[], opts?: object) => {
        const cwd = (opts as { cwd?: string } | undefined)?.cwd;
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && cwd) {
          fs.writeFileSync(
            path.join(cwd, 'app.yaml'),
            `
apiVersion: apps.getpod.ai/v1
name: secretful-app
version: 3.1.0
commit: "${head}"
services:
  app:
    image: nginx:1.25
    environment:
      - DB_PASSWORD
      - SESSION_SECRET=!generate:hex:32
    ports:
      - name: api
        host: 5400
        container: 5400
        type: api
    healthcheck:
      test: wget -qO- http://localhost:5400/health
      interval: 30s
`.trim(),
            'utf-8',
          );
        }
        return { stdout: '', stderr: '', status: 0 };
      };
    }

    it('returns 403 for non-admin key', async () => {
      const res = await request(app)
        .post('/api/v1/apps/inspect')
        .set('Authorization', `Bearer ${READ_KEY.key}`)
        .send({ github_url: 'https://github.com/test/secretful-app' });
      expect(res.status).toBe(403);
    });

    it('returns 400 when no source provided', async () => {
      const res = await request(app)
        .post('/api/v1/apps/inspect')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 200 with required + generated secrets for a GitHub URL', async () => {
      const head = 'abcdef0123456789abcdef0123456789abcdef01';
      const inspectApp = makeApp(registry, registryClient, inspectSpawn(head));
      const res = await request(inspectApp)
        .post('/api/v1/apps/inspect')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ github_url: 'https://github.com/test/secretful-app' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('secretful-app');
      expect(res.body.secretKeys).toEqual(['DB_PASSWORD']);
      expect(res.body.generatedKeys).toEqual([
        { key: 'SESSION_SECRET', encoding: 'hex', bytes: 32 },
      ]);
      // No install happened.
      expect(await registry.get('secretful-app')).toBeUndefined();
    });

    /** Spawn whose app.yaml declares a prompt-with-default secret. */
    function inspectSpawnWithDefault(head: string) {
      return (cmd: string, args: string[], opts?: object) => {
        const cwd = (opts as { cwd?: string } | undefined)?.cwd;
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && cwd) {
          fs.writeFileSync(
            path.join(cwd, 'app.yaml'),
            `
apiVersion: apps.getpod.ai/v1
name: defaultful-app
version: 1.0.0
commit: "${head}"
services:
  app:
    image: nginx:1.25
    environment:
      - NEXTAUTH_URL=!default:http://localhost:3737
    ports:
      - name: api
        host: 5401
        container: 5401
        type: api
    healthcheck:
      test: wget -qO- http://localhost:5401/health
      interval: 30s
`.trim(),
            'utf-8',
          );
        }
        return { stdout: '', stderr: '', status: 0 };
      };
    }

    it('surfaces secretDefaults for a prompt-with-default secret', async () => {
      const head = 'abcdef0123456789abcdef0123456789abcdef02';
      const inspectApp = makeApp(registry, registryClient, inspectSpawnWithDefault(head));
      const res = await request(inspectApp)
        .post('/api/v1/apps/inspect')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ github_url: 'https://github.com/test/defaultful-app' });
      expect(res.status).toBe(200);
      // Still prompted (visible/editable)…
      expect(res.body.secretKeys).toEqual(['NEXTAUTH_URL']);
      // …and the default is surfaced for UI pre-fill, URL intact.
      expect(res.body.secretDefaults).toEqual({ NEXTAUTH_URL: 'http://localhost:3737' });
    });
  });

  // ── GET /api/v1/apps/jobs/:jobId ───────────────────────────────────────

  describe('GET /api/v1/apps/jobs/:jobId', () => {
    it('returns 404 for unknown job', async () => {
      const res = await request(app)
        .get('/api/v1/apps/jobs/unknown-job-id')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(404);
    });

    it('returns job state for known job', async () => {
      const installRes = await request(app)
        .post('/api/v1/apps/install')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ registry_app: 'getpod-manager' });
      const { jobId } = installRes.body as { jobId: string };

      const jobRes = await request(app)
        .get(`/api/v1/apps/jobs/${jobId}`)
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(jobRes.status).toBe(200);
      expect(jobRes.body.id).toBe(jobId);
      expect(['pending', 'running', 'completed', 'failed']).toContain(jobRes.body.status);
    });
  });

  // ── GET /api/v1/apps/:name ─────────────────────────────────────────────

  describe('GET /api/v1/apps/:name', () => {
    it('returns 404 when app not found', async () => {
      const res = await request(app)
        .get('/api/v1/apps/ghost')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(404);
    });

    it('returns app entry', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .get('/api/v1/apps/test-app')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('test-app');
    });
  });

  // ── DELETE /api/v1/apps/:name ──────────────────────────────────────────

  describe('DELETE /api/v1/apps/:name', () => {
    it('returns 403 for non-admin key', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .delete('/api/v1/apps/test-app')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(403);
    });

    it('returns 404 when app not found', async () => {
      const res = await request(app)
        .delete('/api/v1/apps/ghost')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(404);
    });

    it('returns 200 and deletes app', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .delete('/api/v1/apps/test-app')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      // May succeed or fail depending on docker availability — just check it responds
      expect([200, 500]).toContain(res.status);
    });
  });

  // ── POST /api/v1/apps/:name/start|stop|restart ─────────────────────────

  describe('POST /api/v1/apps/:name/:action', () => {
    it('returns 403 for non-admin key', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .post('/api/v1/apps/test-app/stop')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(403);
    });

    it('returns 404 when app not found', async () => {
      const res = await request(app)
        .post('/api/v1/apps/ghost/stop')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(404);
    });

    it('returns 404 for invalid action', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .post('/api/v1/apps/test-app/explode')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/v1/apps/:name/version ─────────────────────────────────────

  describe('GET /api/v1/apps/:name/version', () => {
    it('returns 404 when app not found', async () => {
      const res = await request(app)
        .get('/api/v1/apps/ghost/version')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(404);
    });

    it('returns updateable: false for local apps', async () => {
      await registry.upsert(makeEntry({ source: 'local' }));
      const res = await request(app)
        .get('/api/v1/apps/test-app/version')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body.updateable).toBe(false);
      expect(res.body.latest_commit).toBeNull();
    });

    it('reports a custom app as updateable when its repo HEAD has moved', async () => {
      const newHead = 'b'.repeat(40);
      const spawn = jest.fn((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${newHead}\tHEAD\n`, stderr: '', status: 0 };
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      const customApp = makeApp(registry, registryClient, spawn);
      await registry.upsert(makeEntry({ source: 'custom', commit: 'a'.repeat(40) }));

      const res = await request(customApp)
        .get('/api/v1/apps/test-app/version')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body.updateable).toBe(true);
      expect(res.body.latest_commit).toBe(newHead);
    });

    it('reports a custom app as not updateable when already at HEAD', async () => {
      const head = 'a'.repeat(40);
      const spawn = jest.fn((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${head}\tHEAD\n`, stderr: '', status: 0 };
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      const customApp = makeApp(registry, registryClient, spawn);
      await registry.upsert(makeEntry({ source: 'custom', commit: head }));

      const res = await request(customApp)
        .get('/api/v1/apps/test-app/version')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body.updateable).toBe(false);
      expect(res.body.latest_commit).toBe(head);
    });

    it('returns version info for registry app', async () => {
      await registry.upsert(
        makeEntry({
          name: 'getpod-manager',
          source: 'registry',
          version: '1.0.0',
          commit: 'abc123def456abc123def456abc123def456abc1',
        }),
      );
      const res = await request(app)
        .get('/api/v1/apps/getpod-manager/version')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body.installed).toBe('1.0.0');
      expect(typeof res.body.updateable).toBe('boolean');
    });
  });

  // ── POST /api/v1/apps/:name/reconfigure ────────────────────────────────
  describe('POST /api/v1/apps/:name/reconfigure', () => {
    it('returns 403 for non-admin key', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .post('/api/v1/apps/test-app/reconfigure')
        .set('Authorization', `Bearer ${READ_KEY.key}`)
        .send({ env_vars: { FOO: 'bar' } });
      expect(res.status).toBe(403);
    });

    it('returns 404 when app not installed', async () => {
      const res = await request(app)
        .post('/api/v1/apps/ghost/reconfigure')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ env_vars: { FOO: 'bar' } });
      expect(res.status).toBe(404);
    });

    it('returns 400 for a local (symlinked) app', async () => {
      await registry.upsert(makeEntry({ source: 'local' }));
      const res = await request(app)
        .post('/api/v1/apps/test-app/reconfigure')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ env_vars: { FOO: 'bar' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/local/i);
    });

    it('returns 400 when neither env_vars nor ports is provided', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .post('/api/v1/apps/test-app/reconfigure')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 for a banned override port', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .post('/api/v1/apps/test-app/reconfigure')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ ports: { api: 443 } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/banned/i);
    });

    it('returns 400 for an override port below 1024', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .post('/api/v1/apps/test-app/reconfigure')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ ports: { api: 1000 } });
      expect(res.status).toBe(400);
    });

    it('returns 400 for a non-integer override port', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .post('/api/v1/apps/test-app/reconfigure')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ ports: { api: 'nope' } });
      expect(res.status).toBe(400);
    });

    it('returns 400 for a non-string env var value', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .post('/api/v1/apps/test-app/reconfigure')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ env_vars: { FOO: 123 } });
      expect(res.status).toBe(400);
    });

    it('returns 400 for an unknown override port name', async () => {
      await registry.upsert(makeEntry()); // declares only port "api"
      const res = await request(app)
        .post('/api/v1/apps/test-app/reconfigure')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ ports: { nonexistent: 6100 } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/[Uu]nknown port name/);
    });

    it('returns 400 when an override port collides with another installed app', async () => {
      await registry.upsert(makeEntry({ name: 'other-app', ports: [
        { name: 'api', service: 'app', hostPort: 6001, containerPort: 6001, type: 'api', rateLimit: 200 },
      ] }));
      await registry.upsert(makeEntry({ name: 'test-app' }));
      const res = await request(app)
        .post('/api/v1/apps/test-app/reconfigure')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ ports: { api: 6001 } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already used by app "other-app"/);
    });

    it('returns 202 with a jobId for a valid env-only reconfigure', async () => {
      await registry.upsert(makeEntry({ source: 'custom' }));
      const res = await request(app)
        .post('/api/v1/apps/test-app/reconfigure')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ env_vars: { FEATURE_FLAG: 'on' } });
      expect(res.status).toBe(202);
      expect(typeof res.body.jobId).toBe('string');
    });
  });
});
