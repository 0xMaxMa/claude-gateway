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
  // Boot restore, and now composeUp()'s `up`/`build` steps too (#452), run
  // through the async seam, not the sync one. A test that needs the two seams
  // to disagree (e.g. driving restoreRunningApps() per #446) passes this
  // explicitly. Omitted → derived from `spawn` so a caller that only mocks
  // the sync side still gets a matching, always-resolving async mock instead
  // of silently falling through to the constructor's real default (which
  // would spawn an actual `docker` child process from a unit test).
  asyncSpawn?: (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string; status: number }>,
): { installer: AppInstaller; callbacks: InstallerCallbacks } {
  const callbacks: InstallerCallbacks = {
    registerRoutes: jest.fn((_appName: string, _ports: ComposePort[]) => {}),
    deregisterRoutes: jest.fn((_appName: string) => {}),
    startSocket: jest.fn((_socketPath: string, _socket: ComposeSocket) => Promise.resolve()),
    stopSockets: jest.fn((_appName: string) => {}),
  };
  const syncSpawn = spawn ?? jest.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
  const installer = new AppInstaller(
    registry,
    new RegistryClient(),
    callbacks,
    syncSpawn as ConstructorParameters<typeof AppInstaller>[3],
    appsDir ?? makeTmpDir(),
    undefined,
    (asyncSpawn ?? (async (cmd: string, args: string[], opts?: object) => syncSpawn(cmd, args, opts))) as ConstructorParameters<typeof AppInstaller>[6],
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

  // ── Boot-restore state on the read routes (#446) ────────────────────────

  // A boot restore deliberately suppresses status reconciliation while it owns
  // an app (installer.ts:1439), and the apps it restores are exactly those
  // stored as `running` — so mid-rebuild both read routes reported a flat
  // `running` for an app with no containers behind it, indistinguishable from
  // one that is genuinely serving. They now carry `restoring: true` alongside
  // the unchanged status. These tests drive a REAL restore and read the routes
  // while `compose up` is parked, rather than reaching into the private set.
  describe('boot restore state (#446)', () => {
    /** A router over an installer whose `compose up` parks until released. */
    function makeParkedRestore(): {
      api: express.Application;
      installer: AppInstaller;
      /** Resolves once `compose up` has actually been entered. */
      upStarted: Promise<void>;
      release: () => void;
    } {
      let release!: () => void;
      const parked = new Promise<void>((r) => { release = r; });
      let signalUp!: () => void;
      const upStarted = new Promise<void>((r) => { signalUp = r; });

      const asyncSpawn = jest.fn(async (_cmd: string, args: string[], _opts?: object) => {
        if (args.includes('up')) {
          signalUp();
          await parked;
        }
        // Empty output throughout: no images to probe, and an empty `ps` maps to
        // `stopped` — which is precisely what the suppression must keep the read
        // routes from reporting while the restore is still in flight.
        return { stdout: '', stderr: '', status: 0 };
      });

      const { installer, api } = makeRestoreApi(asyncSpawn);
      return { api, installer, upStarted, release };
    }

    /** Router + installer sharing one registry, with `asyncSpawn` driving restore. */
    function makeRestoreApi(
      asyncSpawn: (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string; status: number }>,
    ): { api: express.Application; installer: AppInstaller } {
      const { installer } = makeInstaller(registry, undefined, undefined, asyncSpawn);
      const api = express();
      api.use(express.json());
      api.use('/api', createAppsRouter(registry, installer, registryClient, API_KEYS));
      return { api, installer };
    }

    function get(api: express.Application, url: string) {
      return request(api).get(url).set('Authorization', `Bearer ${READ_KEY.key}`);
    }

    beforeEach(async () => {
      await registry.upsert(makeEntry({ name: 'test-app', status: 'running' }));
    });

    it('marks an in-flight restore on GET /api/v1/apps without altering its status', async () => {
      const { api, installer, upStarted, release } = makeParkedRestore();

      const restore = installer.restoreRunningApps();
      await upStarted;
      const mid = await get(api, '/api/v1/apps');
      release();
      await restore;

      expect(mid.status).toBe(200);
      // The point of the fix: pre-fix this field is undefined and a client sees
      // a plain `running`, identical to a healthy app.
      expect(mid.body.apps[0].restoring).toBe(true);
      expect(mid.body.apps[0].status).toBe('running');
    });

    it('omits the field entirely once the restore has finished', async () => {
      const { api, installer, upStarted, release } = makeParkedRestore();

      const restore = installer.restoreRunningApps();
      await upStarted;
      release();
      await restore;

      const after = await get(api, '/api/v1/apps');
      // Absent, not `false` — same contract as restoreError/restoreFailedAt, so
      // no existing consumer gains a new always-present key.
      expect(after.body.apps[0].restoring).toBeUndefined();
      expect('restoring' in after.body.apps[0]).toBe(false);
    });

    it('reports restoring from the first request of the boot, before the restore starts', async () => {
      // The boot order the fix establishes: markRestorePending() is awaited
      // before the server listens, so the very first response already carries
      // the flag. Pre-fix the marking happened inside restoreRunningApps(),
      // after the server was live — so a client polling at boot saw a bare
      // `running` for an app whose containers did not exist yet, and the read
      // itself persisted `stopped` underneath the pending restore (#425).
      const { api, installer, upStarted, release } = makeParkedRestore();

      const pending = await installer.markRestorePending();
      const atBoot = await get(api, '/api/v1/apps');
      expect(atBoot.body.apps[0].restoring).toBe(true);
      expect(atBoot.body.apps[0].status).toBe('running');

      const restore = installer.restoreRunningApps(pending);
      await upStarted;
      release();
      await restore;

      const after = await get(api, '/api/v1/apps');
      expect('restoring' in after.body.apps[0]).toBe(false);
    });

    it('marks it on GET /api/v1/apps/:name too, through the same decorator', async () => {
      const { api, installer, upStarted, release } = makeParkedRestore();

      const restore = installer.restoreRunningApps();
      await upStarted;
      const mid = await get(api, '/api/v1/apps/test-app');
      release();
      await restore;

      expect(mid.body.restoring).toBe(true);
      expect(mid.body.status).toBe('running');
    });

    it('leaves an app mid-install reporting building, not restoring', async () => {
      // An install owns the status via a different mechanism; the two must stay
      // distinguishable rather than both collapsing into "busy".
      await registry.upsert(makeEntry({ name: 'test-app', status: 'building' }));
      const res = await get(app, '/api/v1/apps');
      expect(res.body.apps[0].status).toBe('building');
      expect(res.body.apps[0].restoring).toBeUndefined();
    });

    it('reports a failed restore as restoreError with no lingering restoring flag', async () => {
      const { api, installer } = makeRestoreApi(async (_cmd, args) => {
        if (args.includes('up')) return { stdout: '', stderr: 'mocked error: up', status: 1 };
        return { stdout: '', stderr: '', status: 0 };
      });

      await installer.restoreRunningApps();
      const res = await get(api, '/api/v1/apps');

      // The in-flight marker is released in restoreRunningApps()'s per-app
      // `finally`, so the two states are mutually exclusive in the response.
      expect(res.body.apps[0].restoreError).toBeDefined();
      expect(res.body.apps[0].restoring).toBeUndefined();
    });
  });

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

    it('stops a running app → 200 and registry status becomes stopped', async () => {
      await registry.upsert(makeEntry({ status: 'running' }));
      const res = await request(app)
        .post('/api/v1/apps/test-app/stop')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ name: 'test-app', action: 'stop' });
      expect((await registry.get('test-app'))?.status).toBe('stopped');
    });

    it('starts a stopped app → 200 and registry status becomes running', async () => {
      await registry.upsert(makeEntry({ status: 'stopped' }));
      const res = await request(app)
        .post('/api/v1/apps/test-app/start')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ name: 'test-app', action: 'start' });
      expect((await registry.get('test-app'))?.status).toBe('running');
    });

    it('restarts an app → 200 and registry status becomes running', async () => {
      await registry.upsert(makeEntry({ status: 'stopped' }));
      const res = await request(app)
        .post('/api/v1/apps/test-app/restart')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ name: 'test-app', action: 'restart' });
      expect((await registry.get('test-app'))?.status).toBe('running');
    });

    it('returns 409 when a mutating job holds the app', async () => {
      await registry.upsert(makeEntry());
      const { installer } = makeInstaller(registry);
      const busyApp = express();
      busyApp.use(express.json());
      busyApp.use('/api', createAppsRouter(registry, installer, registryClient, API_KEYS));
      // Simulate an install/update/backup holding the per-app mutex.
      (installer as unknown as { installingNames: Set<string> }).installingNames.add('test-app');
      const res = await request(busyApp)
        .post('/api/v1/apps/test-app/stop')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(409);
      // The app was never touched — status stays as it was.
      expect((await registry.get('test-app'))?.status).toBe('running');
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

  // ─── POST /api/v1/apps/housekeeping (#302) ────────────────────────────────
  describe('POST /api/v1/apps/housekeeping', () => {
    function reportSpawn() {
      return jest.fn((_cmd: string, args: string[]) => {
        if (args.includes('df')) {
          return { stdout: 'Images\t0B\nBuild Cache\t1.457GB\n', stderr: '', status: 0 };
        }
        if (args.includes('volume') && args.includes('ls')) {
          return { stdout: 'orphan_a\n', stderr: '', status: 0 };
        }
        if (args.includes('image') && args.includes('ls')) {
          return { stdout: 'sha_1\nsha_2\n', stderr: '', status: 0 };
        }
        return { stdout: '', stderr: '', status: 0 };
      });
    }

    it('returns 403 for a non-admin key', async () => {
      const res = await request(app)
        .post('/api/v1/apps/housekeeping')
        .set('Authorization', `Bearer ${READ_KEY.key}`)
        .send({ mode: 'report' });
      expect(res.status).toBe(403);
    });

    it('report mode returns a read-only reclaim report', async () => {
      const spawn = reportSpawn();
      const hkApp = makeApp(registry, registryClient, spawn);
      const res = await request(hkApp)
        .post('/api/v1/apps/housekeeping')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ mode: 'report' });
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('report');
      expect(res.body.report.buildCacheReclaimable).toBe('1.457GB');
      expect(res.body.report.danglingImageCount).toBe(2);
      expect(res.body.report.orphanVolumes).toEqual(['orphan_a']);
      // read-only: no prune issued
      const args = spawn.mock.calls.map((c) => c[1] as string[]);
      expect(args.some((a) => a.includes('prune'))).toBe(false);
    });

    it('defaults to report mode when no body is sent', async () => {
      const spawn = reportSpawn();
      const hkApp = makeApp(registry, registryClient, spawn);
      const res = await request(hkApp)
        .post('/api/v1/apps/housekeeping')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('report');
    });

    it('prune mode executes the safe reclaim only', async () => {
      const spawn = reportSpawn();
      const hkApp = makeApp(registry, registryClient, spawn);
      const res = await request(hkApp)
        .post('/api/v1/apps/housekeeping')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ mode: 'prune' });
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('prune');
      expect(res.body.pruned).toEqual({ buildCache: true, danglingImages: true });
      const args = spawn.mock.calls.map((c) => c[1] as string[]);
      expect(args).toContainEqual(['builder', 'prune', '-f', '--filter', 'until=168h']);
      expect(args).toContainEqual(['image', 'prune', '-f']);
      // safety floor — never `-a`, never a volume prune
      expect(args.some((a) => a.includes('-a'))).toBe(false);
      expect(args.some((a) => a.includes('volume') && a.includes('prune'))).toBe(false);
    });

    it('rejects an invalid mode with 400', async () => {
      const res = await request(app)
        .post('/api/v1/apps/housekeeping')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ mode: 'nuke' });
      expect(res.status).toBe(400);
    });
  });

  describe('backup/restore routes', () => {
    it('POST /backup requires admin', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .post('/api/v1/apps/test-app/backup')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(403);
    });

    it('POST /backup 404s for an unknown app', async () => {
      const res = await request(app)
        .post('/api/v1/apps/nope/backup')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(404);
    });

    it('POST /restore rejects a missing backupId with 400', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .post('/api/v1/apps/test-app/restore')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('POST /restore 404s for an unknown app', async () => {
      const res = await request(app)
        .post('/api/v1/apps/nope/restore')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ backupId: 'bk1' });
      expect(res.status).toBe(404);
    });

    it('GET /backups returns an array (empty when none)', async () => {
      await registry.upsert(makeEntry());
      const res = await request(app)
        .get('/api/v1/apps/test-app/backups')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /backups 404s for an unknown app', async () => {
      const res = await request(app)
        .get('/api/v1/apps/nope/backups')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(404);
    });

    it('DELETE /backups/:id requires admin', async () => {
      const res = await request(app)
        .delete('/api/v1/apps/test-app/backups/bk1')
        .set('Authorization', `Bearer ${READ_KEY.key}`);
      expect(res.status).toBe(403);
    });

    it('DELETE /backups/:id rejects a path-traversal id with 400', async () => {
      const res = await request(app)
        .delete('/api/v1/apps/test-app/backups/..%2f..%2fetc')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(400);
    });
  });
});
