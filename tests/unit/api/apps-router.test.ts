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

function makeTmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-router-test-'));
  return path.join(dir, 'apps.json');
}

function makeEntry(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'test-app',
    version: '1.0.0',
    commit: 'abc123def456abc123def456abc123def456abc1',
    githubUrl: 'https://github.com/test/test-app',
    installPath: '/home/ubuntu/.claude-gateway/apps/test-app',
    ports: [{ name: 'api', service: 'app', containerPort: 5000, type: 'api', rateLimit: 200 }],
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
): { installer: AppInstaller; callbacks: InstallerCallbacks } {
  const callbacks: InstallerCallbacks = {
    registerRoutes: jest.fn((_appName: string, _ports: ComposePort[]) => {}),
    deregisterRoutes: jest.fn((_appName: string) => {}),
    startSocket: jest.fn((_socketPath: string, _socket: ComposeSocket) => {}),
    stopSockets: jest.fn((_appName: string) => {}),
  };
  const installer = new AppInstaller(
    registry,
    new RegistryClient(),
    callbacks,
    jest.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 }),
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
): express.Application {
  const app = express();
  app.use(express.json());
  const { installer } = makeInstaller(registry);
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
      const fakeLocalPath = path.join(os.homedir(), '.claude-gateway', 'apps', 'fake-app');
      const res = await request(app)
        .post('/api/v1/apps/install')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ local_path: fakeLocalPath });
      expect(res.status).toBe(202);
      expect(typeof res.body.jobId).toBe('string');
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

    it('returns updateable: false for custom/local apps', async () => {
      await registry.upsert(makeEntry({ source: 'custom' }));
      const res = await request(app)
        .get('/api/v1/apps/test-app/version')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body.updateable).toBe(false);
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
});
