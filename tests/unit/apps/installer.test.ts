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
    startSocket(_socketPath: string, _socket: ComposeSocket) {},
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AppInstaller', () => {
  let tmpDir: string;
  let appsDir: string;
  let registry: AppsRegistry;
  let callbacks: ReturnType<typeof makeCallbacks>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    appsDir = path.join(tmpDir, 'apps');
    fs.mkdirSync(appsDir);
    const appsJsonPath = path.join(tmpDir, 'apps.json');
    registry = new AppsRegistry(appsJsonPath);
    callbacks = makeCallbacks();
  });

  function makeInstaller(spawnFn = successSpawn) {
    return new AppInstaller(
      registry,
      new RegistryClient(),
      callbacks,
      spawnFn,
      appsDir,
    );
  }

  // ─── install() — local path mode ─────────────────────────────────────────

  describe('install() — local path', () => {
    it('returns a job ID immediately', () => {
      const appDir = makeAppDir(appsDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      expect(typeof jobId).toBe('string');
      expect(jobId.length).toBeGreaterThan(0);
    });

    it('job is in pending/running state immediately after call', () => {
      const appDir = makeAppDir(appsDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      const job = installer.getJob(jobId);
      expect(job).toBeDefined();
      expect(['pending', 'running']).toContain(job!.status);
    });

    it('job completes with correct result after async install', async () => {
      const appDir = makeAppDir(appsDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });

      const job = await waitForJob(installer, jobId, 5000);
      expect(job.status).toBe('completed');
      expect(job.result?.appName).toBe('my-app');
      expect(job.result?.proxyUrls).toBeDefined();
    });

    it('registers proxy routes on success', async () => {
      const appDir = makeAppDir(appsDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      expect(callbacks.registeredRoutes).toHaveLength(1);
      expect(callbacks.registeredRoutes[0].appName).toBe('my-app');
    });

    it('persists entry to apps.json with status running', async () => {
      const appDir = makeAppDir(appsDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      const entry = await registry.get('my-app');
      expect(entry?.status).toBe('running');
      expect(entry?.source).toBe('local');
    });

    it('writes .env file to app dir', async () => {
      const appDir = makeAppDir(appsDir, 'my-app');
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
      const appDir = path.join(appsDir, 'web-app');
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

    it('fails when local_path is outside apps directory', async () => {
      const outsidePath = path.join(tmpDir, 'evil-app');
      fs.mkdirSync(outsidePath);
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: outsidePath });
      const job = await waitForJob(installer, jobId, 5000);

      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/must be within/);
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
      const appDir = makeAppDir(appsDir, 'my-app');
      const spawn = failingSpawn('up');
      const installer = makeInstaller(spawn as typeof successSpawn);
      const jobId = installer.install({ localPath: appDir });
      const job = await waitForJob(installer, jobId, 5000);

      expect(job.status).toBe('failed');
      expect(job.error).toBeDefined();
    });

    it('fails when app is already installed', async () => {
      const appDir = makeAppDir(appsDir, 'my-app');
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
      const appDir = makeAppDir(appsDir, 'my-app');
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
      const appDir = makeAppDir(appsDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      await installer.uninstall('my-app');
      expect(callbacks.deregistered).toContain('my-app');
    });

    it('removes entry from apps.json', async () => {
      const appDir = makeAppDir(appsDir, 'my-app');
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
      const appDir = makeAppDir(appsDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      await installer.startStopRestart('my-app', 'stop');
      const entry = await registry.get('my-app');
      expect(entry?.status).toBe('stopped');
    });

    it('updates status to running on start', async () => {
      const appDir = makeAppDir(appsDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      await installer.startStopRestart('my-app', 'stop');
      await installer.startStopRestart('my-app', 'start');
      const entry = await registry.get('my-app');
      expect(entry?.status).toBe('running');
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
