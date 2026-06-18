import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AppInstaller, InstallerCallbacks, JobState } from '../../../src/apps/installer';
import { AppsRegistry } from '../../../src/apps/registry';
import { RegistryClient } from '../../../src/apps/registry-client';
import { ComposePort, ComposeSocket } from '../../../src/apps/compose-generator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'installer-test-'));
}

function makeCallbacks(): InstallerCallbacks & {
  registeredRoutes: Array<{ appName: string; ports: ComposePort[] }>;
  deregistered: string[];
} {
  const registeredRoutes: Array<{ appName: string; ports: ComposePort[] }> = [];
  const deregistered: string[] = [];
  return {
    registeredRoutes,
    deregistered,
    registerRoutes(appName, ports) { registeredRoutes.push({ appName, ports }); },
    deregisterRoutes(appName) { deregistered.push(appName); },
    startSocket(_socketPath: string, _socket: ComposeSocket) { return Promise.resolve(); },
    stopSockets(_appName: string) {},
  };
}

/**
 * Create a minimal valid app dir with app.yaml and optional Dockerfile.
 */
function makeAppDir(dir: string, appName: string, port = 5000): string {
  const appDir = path.join(dir, appName);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'app.yaml'),
    `
apiVersion: apps.getpod.ai/v1
name: ${appName}
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  app:
    image: nginx:1.25
    ports:
      - name: api
        host: ${port}
        container: ${port}
        type: api
    healthcheck:
      test: wget -qO- http://localhost:${port}/health
      interval: 30s
`.trim(),
    'utf-8',
  );
  return appDir;
}

/** Spawn mock that always succeeds */
const successSpawn = jest.fn(
  (_cmd: string, _args: string[], _opts?: object) => ({
    stdout: '',
    stderr: '',
    status: 0,
  }),
);

/** Spawn mock that fails on matching command */
function failingSpawn(failOn: string) {
  return jest.fn((_cmd: string, args: string[], _opts?: object) => {
    if (args.some((a) => a.includes(failOn))) {
      return { stdout: '', stderr: `mocked error: ${failOn}`, status: 1 };
    }
    return { stdout: '', stderr: '', status: 0 };
  });
}

/** Async spawn mock (used by the boot-time container restore path). */
const successAsyncSpawn = jest.fn(
  async (_cmd: string, _args: string[], _opts?: object) => ({
    stdout: '',
    stderr: '',
    status: 0,
  }),
);

/** Async spawn mock that fails on matching command */
function failingAsyncSpawn(failOn: string) {
  return jest.fn(async (_cmd: string, args: string[], _opts?: object) => {
    if (args.some((a) => a.includes(failOn))) {
      return { stdout: '', stderr: `mocked error: ${failOn}`, status: 1 };
    }
    return { stdout: '', stderr: '', status: 0 };
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AppInstaller', () => {
  let tmpDir: string;
  let appsDir: string;
  let srcDir: string;
  let registry: AppsRegistry;
  let callbacks: ReturnType<typeof makeCallbacks>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    appsDir = path.join(tmpDir, 'apps');
    srcDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(appsDir);
    fs.mkdirSync(srcDir);
    const appsJsonPath = path.join(tmpDir, 'apps.json');
    registry = new AppsRegistry(appsJsonPath);
    callbacks = makeCallbacks();
  });

  function makeInstaller(spawnFn = successSpawn, asyncSpawnFn = successAsyncSpawn) {
    return new AppInstaller(
      registry,
      new RegistryClient(),
      callbacks,
      spawnFn,
      appsDir,
      undefined, // agentManager
      asyncSpawnFn as unknown as ConstructorParameters<typeof AppInstaller>[6],
    );
  }

  // ─── install() — local path mode ─────────────────────────────────────────

  describe('install() — local path', () => {
    it('returns a job ID immediately', () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      expect(typeof jobId).toBe('string');
      expect(jobId.length).toBeGreaterThan(0);
    });

    it('job is in pending/running state immediately after call', () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      const job = installer.getJob(jobId);
      expect(job).toBeDefined();
      expect(['pending', 'running']).toContain(job!.status);
    });

    it('job completes with correct result after async install', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });

      const job = await waitForJob(installer, jobId, 5000);
      expect(job.status).toBe('completed');
      expect(job.result?.appName).toBe('my-app');
      expect(job.result?.proxyUrls).toBeDefined();
    });

    it('registers proxy routes on success', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      expect(callbacks.registeredRoutes).toHaveLength(1);
      expect(callbacks.registeredRoutes[0].appName).toBe('my-app');
    });

    it('persists entry to apps.json with status running', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      const entry = await registry.get('my-app');
      expect(entry?.status).toBe('running');
      expect(entry?.source).toBe('local');
    });

    it('persists version from app.yaml into registry entry', async () => {
      const appDir = path.join(srcDir, 'versioned-app');
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(
        path.join(appDir, 'app.yaml'),
        `
apiVersion: apps.getpod.ai/v1
name: versioned-app
version: 3.1.4
commit: "abc123def456abc123def456abc123def456abc1"
services:
  app:
    image: nginx:1.25
    ports:
      - name: api
        host: 5100
        container: 5100
        type: api
    healthcheck:
      test: wget -qO- http://localhost:5100/health
      interval: 30s
`.trim(),
        'utf-8',
      );
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      const entry = await registry.get('versioned-app');
      expect(entry?.version).toBe('3.1.4');
    });

    it('writes .env file to app dir', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({
        localPath: appDir,
        envVars: { MY_SECRET: 'hunter2' },
      });
      await waitForJob(installer, jobId, 5000);

      const envPath = path.join(appDir, '.env');
      expect(fs.existsSync(envPath)).toBe(true);
    });

    it('injects BASE_PATH into env for web-type ports', async () => {
      const appDir = path.join(srcDir, 'web-app');
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(
        path.join(appDir, 'app.yaml'),
        `
apiVersion: apps.getpod.ai/v1
name: web-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  app:
    image: node:20-alpine
    ports:
      - name: web
        host: 3000
        container: 3000
        type: web
`.trim(),
        'utf-8',
      );
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      const envContent = fs.readFileSync(path.join(appDir, '.env'), 'utf-8');
      expect(envContent).toContain('BASE_PATH=/app/web-app/web');
    });

    it('fails when local_path has no app.yaml', async () => {
      const outsidePath = path.join(tmpDir, 'evil-app');
      fs.mkdirSync(outsidePath);
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: outsidePath });
      const job = await waitForJob(installer, jobId, 5000);

      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/app\.yaml not found/);
    });

    it('fails when local_path does not exist', async () => {
      const installer = makeInstaller();
      const jobId = installer.install({
        localPath: path.join(appsDir, 'nonexistent'),
      });
      const job = await waitForJob(installer, jobId, 5000);

      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/does not exist/);
    });

    it('fails when docker compose up fails', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const spawn = failingSpawn('up');
      const installer = makeInstaller(spawn as typeof successSpawn);
      const jobId = installer.install({ localPath: appDir });
      const job = await waitForJob(installer, jobId, 5000);

      expect(job.status).toBe('failed');
      expect(job.error).toBeDefined();
    });

    it('fails when app is already installed', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      // First install
      const jobId1 = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId1, 5000);
      // Second install attempt
      const jobId2 = installer.install({ localPath: appDir });
      const job2 = await waitForJob(installer, jobId2, 5000);

      expect(job2.status).toBe('failed');
      expect(job2.error).toMatch(/already installed/);
    });
  });

  // ─── getJob() ─────────────────────────────────────────────────────────────

  describe('getJob()', () => {
    it('returns undefined for unknown job ID', () => {
      const installer = makeInstaller();
      expect(installer.getJob('unknown-id')).toBeUndefined();
    });

    it('returns the job state', () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      const job = installer.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.id).toBe(jobId);
    });
  });

  // ─── uninstall() ──────────────────────────────────────────────────────────

  describe('uninstall()', () => {
    it('throws when app is not installed', async () => {
      const installer = makeInstaller();
      await expect(installer.uninstall('ghost-app')).rejects.toThrow('not installed');
    });

    it('calls deregisterRoutes callback', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      await installer.uninstall('my-app');
      expect(callbacks.deregistered).toContain('my-app');
    });

    it('removes entry from apps.json', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      await installer.uninstall('my-app');
      expect(await registry.get('my-app')).toBeUndefined();
    });
  });

  // ─── startStopRestart() ───────────────────────────────────────────────────

  describe('startStopRestart()', () => {
    it('throws when app is not installed', async () => {
      const installer = makeInstaller();
      await expect(installer.startStopRestart('ghost', 'stop')).rejects.toThrow(
        'not installed',
      );
    });

    it('updates status to stopped on stop', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      await installer.startStopRestart('my-app', 'stop');
      const entry = await registry.get('my-app');
      expect(entry?.status).toBe('stopped');
    });

    it('updates status to running on start', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      await installer.startStopRestart('my-app', 'stop');
      await installer.startStopRestart('my-app', 'start');
      const entry = await registry.get('my-app');
      expect(entry?.status).toBe('running');
    });
  });

  // ─── restoreRunningApps() ─────────────────────────────────────────────────

  describe('restoreRunningApps()', () => {
    it('brings up containers for apps marked running (via the async spawn seam)', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      // Restore runs through the async (non-blocking) spawn, NOT the sync one.
      const calls: string[][] = [];
      const trackAsyncSpawn = jest.fn(async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer2 = makeInstaller(successSpawn, trackAsyncSpawn);

      const { attempted, failures } = await installer2.restoreRunningApps();
      expect(failures).toEqual([]);
      expect(attempted).toBe(1);
      expect(calls.some((c) => c.includes('up'))).toBe(true);
    });

    it('skips apps that are not running', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);
      await installer.startStopRestart('my-app', 'stop');

      const calls: string[][] = [];
      const trackAsyncSpawn = jest.fn(async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer2 = makeInstaller(successSpawn, trackAsyncSpawn);

      const { attempted, failures } = await installer2.restoreRunningApps();
      expect(failures).toEqual([]);
      expect(attempted).toBe(0);
      expect(calls.some((c) => c.includes('up'))).toBe(false);
    });

    it('is non-fatal: collects failures without throwing when compose up fails', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      const installer2 = makeInstaller(successSpawn, failingAsyncSpawn('up'));

      const { attempted, failures } = await installer2.restoreRunningApps();
      expect(attempted).toBe(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].app).toBe('my-app');
    });

    it('caps concurrency at RESTORE_MAX_CONCURRENCY while starting every app', async () => {
      // Install 6 running apps — more than the concurrency cap of 4.
      const names = ['app-a', 'app-b', 'app-c', 'app-d', 'app-e', 'app-f'];
      for (let i = 0; i < names.length; i++) {
        const dir = makeAppDir(srcDir, names[i], 5001 + i);
        const inst = makeInstaller();
        await waitForJob(inst, inst.install({ localPath: dir }), 5000);
      }

      // Async spawn that holds each `up` briefly so workers genuinely overlap,
      // tracking the peak number in flight at once.
      let inFlight = 0;
      let maxInFlight = 0;
      let started = 0;
      const trackAsyncSpawn = jest.fn(async (_cmd: string, args: string[]) => {
        if (args.includes('up')) {
          inFlight++;
          started++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight--;
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer2 = makeInstaller(successSpawn, trackAsyncSpawn);

      const { attempted, failures } = await installer2.restoreRunningApps();
      expect(attempted).toBe(6);
      expect(failures).toEqual([]);
      expect(started).toBe(6); // every app was started
      expect(maxInFlight).toBeLessThanOrEqual(4); // never exceeded the cap
      expect(maxInFlight).toBeGreaterThan(1); // and it actually parallelised
    });
  });

  // ─── GitHub URL install — validation ─────────────────────────────────────

  describe('install() — github URL validation', () => {
    it('fails when commit is not a 40-char hex string', async () => {
      const installer = makeInstaller();
      const jobId = installer.install({
        githubUrl: 'https://github.com/test/app',
        commit: 'main', // branch name — not allowed
      });
      const job = await waitForJob(installer, jobId, 5000);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/40-char hex/);
    });

    it('fails when neither registryApp, githubUrl, nor localPath is provided', async () => {
      const installer = makeInstaller();
      const jobId = installer.install({});
      const job = await waitForJob(installer, jobId, 5000);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/registryApp|githubUrl|localPath/);
    });

    it('persists version from app.yaml after clone', async () => {
      const commit = 'a'.repeat(40);
      const githubUrl = 'https://github.com/test/cloned-app';

      // Simulate git checkout by writing app.yaml into cwd when checkout runs
      const cloneSpawn = jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          fs.writeFileSync(
            path.join(opts.cwd, 'app.yaml'),
            `
apiVersion: apps.getpod.ai/v1
name: cloned-app
version: 2.3.4
commit: "${commit}"
services:
  app:
    image: nginx:1.25
    ports:
      - name: api
        host: 5200
        container: 5200
        type: api
    healthcheck:
      test: wget -qO- http://localhost:5200/health
      interval: 30s
`.trim(),
            'utf-8',
          );
        }
        return { stdout: '', stderr: '', status: 0 };
      });

      const installer = makeInstaller(cloneSpawn);
      const jobId = installer.install({ githubUrl, commit });
      await waitForJob(installer, jobId, 5000);

      const entry = await registry.get('cloned-app');
      expect(entry?.version).toBe('2.3.4');
    });
  });
});

// ─── Utility ──────────────────────────────────────────────────────────────────

function waitForJob(
  installer: AppInstaller,
  jobId: string,
  timeoutMs: number,
): Promise<JobState> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      const job = installer.getJob(jobId);
      if (!job) {
        clearInterval(interval);
        reject(new Error(`Job ${jobId} not found`));
        return;
      }
      if (job.status === 'completed' || job.status === 'failed') {
        clearInterval(interval);
        resolve(job);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(interval);
        reject(new Error(`Job ${jobId} timed out in status: ${job.status}`));
      }
    }, 50);
  });
}
