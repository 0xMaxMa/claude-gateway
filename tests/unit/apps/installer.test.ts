import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AppInstaller, InstallerCallbacks, JobState, parseComposePs, mapContainerStatesToAppStatus } from '../../../src/apps/installer';
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

    // ── Self-generating secrets (issue #255) ─────────────────────────────────
    function makeGenAppDir(dir: string, appName: string, port = 5000): string {
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
    environment:
      - GEN_HEX=!generate:hex:16
      - GEN_URLSAFE=!generate:base64url:24
      - USER_KEY
    ports:
      - name: api
        host: ${port}
        container: ${port}
        type: api
`.trim(),
        'utf-8',
      );
      return appDir;
    }

    function readEnv(appDir: string): Record<string, string> {
      const content = fs.readFileSync(path.join(appDir, '.env'), 'utf-8');
      const out: Record<string, string> = {};
      for (const line of content.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
      }
      return out;
    }

    it('writes a fresh random value for a generated key', async () => {
      const appDir = makeGenAppDir(srcDir, 'gen-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      const env = readEnv(appDir);
      // hex:16 → 32 hex chars; base64url has no + / = padding
      expect(env['GEN_HEX']).toMatch(/^[0-9a-f]{32}$/);
      expect(env['GEN_URLSAFE']).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(env['GEN_URLSAFE'].length).toBeGreaterThan(0);
    });

    it('produces different values on two installs of the same app', async () => {
      const appDirA = makeGenAppDir(srcDir, 'gen-app-a', 5001);
      const appDirB = makeGenAppDir(srcDir, 'gen-app-b', 5002);
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDirA }), 5000);
      await waitForJob(installer, installer.install({ localPath: appDirB }), 5000);

      expect(readEnv(appDirA)['GEN_HEX']).not.toBe(readEnv(appDirB)['GEN_HEX']);
    });

    it('lets an explicit env_var override generation', async () => {
      const appDir = makeGenAppDir(srcDir, 'gen-app');
      const installer = makeInstaller();
      const jobId = installer.install({
        localPath: appDir,
        envVars: { GEN_HEX: 'pinned-value' },
      });
      await waitForJob(installer, jobId, 5000);

      const env = readEnv(appDir);
      expect(env['GEN_HEX']).toBe('pinned-value');
      // the un-pinned generated key is still randomized, and not double-written
      expect(env['GEN_URLSAFE']).toMatch(/^[A-Za-z0-9_-]+$/);
      const hexCount = fs
        .readFileSync(path.join(appDir, '.env'), 'utf-8')
        .split('\n')
        .filter((l) => l.startsWith('GEN_HEX=')).length;
      expect(hexCount).toBe(1);
    });

    it('never writes the generated value into the job logs', async () => {
      const appDir = makeGenAppDir(srcDir, 'gen-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      const env = readEnv(appDir);
      const logs = installer.getJob(jobId)!.logs.join('\n');
      expect(logs).toContain('Generated secrets: GEN_HEX, GEN_URLSAFE');
      expect(logs).not.toContain(env['GEN_HEX']);
      expect(logs).not.toContain(env['GEN_URLSAFE']);
    });

    it('does not report generated keys in job result secretKeys', async () => {
      const appDir = makeGenAppDir(srcDir, 'gen-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      const job = await waitForJob(installer, jobId, 5000);

      const secretKeys = (job.result as { secretKeys: string[] }).secretKeys;
      expect(secretKeys).toContain('USER_KEY');
      expect(secretKeys).not.toContain('GEN_HEX');
      expect(secretKeys).not.toContain('GEN_URLSAFE');
    });

    it('update preserves a generated value already in .env (copies verbatim)', async () => {
      // The update path (installer.ts:708-712) copies the existing .env into the
      // new install dir instead of rebuilding it, so a generated DB password
      // survives an update and never locks the app out of its own volume.
      const appDir = makeGenAppDir(srcDir, 'gen-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      const original = readEnv(appDir)['GEN_HEX'];
      // Simulate the update copy step against a fresh target dir.
      const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-update-'));
      fs.copyFileSync(path.join(appDir, '.env'), path.join(newDir, '.env'));
      expect(readEnv(newDir)['GEN_HEX']).toBe(original);
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
    }, 60000);
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

    it('auto-resolves the default branch HEAD when no commit is given', async () => {
      // The install must not require a user-supplied commit: when omitted, the
      // installer resolves HEAD via `git ls-remote` and pins that commit.
      const resolved = 'abcdef0123456789abcdef0123456789abcdef01'; // 40-hex
      const githubUrl = 'https://github.com/test/headless-app';

      let lsRemoteCalled = false;
      const resolveSpawn = jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          lsRemoteCalled = true;
          // git ls-remote <url> HEAD → "<sha>\tHEAD"
          return { stdout: `${resolved}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          fs.writeFileSync(
            path.join(opts.cwd, 'app.yaml'),
            `
apiVersion: apps.getpod.ai/v1
name: headless-app
version: 1.0.0
commit: "${resolved}"
services:
  app:
    image: nginx:1.25
    ports:
      - name: api
        host: 5300
        container: 5300
        type: api
    healthcheck:
      test: wget -qO- http://localhost:5300/health
      interval: 30s
`.trim(),
            'utf-8',
          );
        }
        return { stdout: '', stderr: '', status: 0 };
      });

      const installer = makeInstaller(resolveSpawn);
      const jobId = installer.install({ githubUrl }); // no commit
      const job = await waitForJob(installer, jobId, 5000);

      expect(job.status).toBe('completed');
      expect(lsRemoteCalled).toBe(true);
      // the resolved HEAD is pinned in the registry entry
      const entry = await registry.get('headless-app');
      expect(entry?.commit).toBe(resolved);
      // and the fetch pins the resolved commit, not a branch name
      expect(
        resolveSpawn.mock.calls.some(
          (c) => c[0] === 'git' && c[1][0] === 'fetch' && c[1].includes(resolved),
        ),
      ).toBe(true);
      // the resolved commit is surfaced in the job logs
      expect(job.logs.join('\n')).toContain(`Resolved HEAD → ${resolved.slice(0, 8)}`);
    });
  });

  // ── inspectSource() — read-only pre-install preview (issue #265) ──────────
  describe('inspectSource() — GitHub URL', () => {
    /** Spawn mock: resolves HEAD via ls-remote and writes an app.yaml whose
     *  service declares a bare-key secret + a self-generating secret. */
    function inspectSpawn(head: string) {
      return jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          fs.writeFileSync(
            path.join(opts.cwd, 'app.yaml'),
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
      - NODE_ENV=production
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
      });
    }

    function tmpInspectDirs(): string[] {
      return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cg-inspect-'));
    }

    it('returns required + generated secrets parsed from app.yaml, without installing', async () => {
      const head = 'abcdef0123456789abcdef0123456789abcdef01';
      const before = tmpInspectDirs();
      const installer = makeInstaller(inspectSpawn(head));

      const info = await installer.inspectSource({
        githubUrl: 'https://github.com/test/secretful-app',
      });

      // Real required secret (bare key) is surfaced — the whole point of the fix.
      expect(info.secretKeys).toEqual(['DB_PASSWORD']);
      // Self-generating secret is reported separately (never prompted for).
      expect(info.generatedKeys).toEqual([
        { key: 'SESSION_SECRET', encoding: 'hex', bytes: 32 },
      ]);
      // Canonical metadata comes from the fetched app.yaml, not the URL.
      expect(info.name).toBe('secretful-app');
      expect(info.version).toBe('3.1.0');
      expect(info.source).toBe('custom');
      expect(info.commit).toBe(head); // auto-resolved HEAD

      // No install side effects: nothing registered, no app dir created.
      expect(await registry.get('secretful-app')).toBeUndefined();
      expect(fs.existsSync(path.join(appsDir, 'secretful-app'))).toBe(false);
      expect(callbacks.registeredRoutes).toHaveLength(0);

      // No tmp clone dir left behind.
      expect(tmpInspectDirs()).toEqual(before);
    });

    it('propagates a resolution failure instead of silently reporting no secrets', async () => {
      const failing = jest.fn((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: '', stderr: 'not found', status: 1 };
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer = makeInstaller(failing as typeof successSpawn);
      await expect(
        installer.inspectSource({ githubUrl: 'https://github.com/test/missing' }),
      ).rejects.toThrow();
    });
  });

  // ── update() — GitHub-installed (custom) apps (issue #259) ────────────────
  describe('update() — custom (GitHub) apps', () => {
    function readEnvFile(appDir: string): Record<string, string> {
      const content = fs.readFileSync(path.join(appDir, '.env'), 'utf-8');
      const out: Record<string, string> = {};
      for (const line of content.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
      }
      return out;
    }

    // Spawn mock whose ls-remote HEAD and app.yaml (written on checkout) are
    // driven by a mutable `state`, so one installer can install at one commit
    // then update to another.
    function makeGitState(appName: string, port: number) {
      const state = { head: 'a'.repeat(40), version: '1.0.0' };
      const spawn = jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${state.head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          fs.writeFileSync(
            path.join(opts.cwd, 'app.yaml'),
            `
apiVersion: apps.getpod.ai/v1
name: ${appName}
version: ${state.version}
commit: "${state.head}"
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
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      return { state, spawn };
    }

    it('updates a GitHub-installed app to the new default-branch HEAD, preserving .env', async () => {
      const githubUrl = 'https://github.com/test/custom-app';
      const { state, spawn } = makeGitState('custom-app', 5400);
      const installer = makeInstaller(spawn);

      // Install at HEAD "aaaa…" with a secret that must survive the update
      state.head = 'a'.repeat(40);
      state.version = '1.0.0';
      await waitForJob(installer, installer.install({ githubUrl, envVars: { APP_SECRET: 'keep-me' } }), 5000);

      let entry = await registry.get('custom-app');
      expect(entry?.source).toBe('custom');
      expect(entry?.commit).toBe('a'.repeat(40));
      expect(readEnvFile(entry!.installPath)['APP_SECRET']).toBe('keep-me');

      // Default branch advances → update should follow HEAD
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update('custom-app'), 5000);
      expect(job.status).toBe('completed');

      entry = await registry.get('custom-app');
      expect(entry?.commit).toBe('b'.repeat(40));
      expect(entry?.version).toBe('2.0.0');
      // secret (and therefore volumes) preserved via .env copy-forward
      expect(readEnvFile(entry!.installPath)['APP_SECRET']).toBe('keep-me');
    });

    it('updates an app whose on-disk dir name ≠ app.yaml name (legacy install, issue #275)', async () => {
      // Legacy installs named the on-disk dir after the source repo basename,
      // so installPath basename can differ from the app name. The dir-swap must
      // key off entry.installPath (like the down/rollback steps), not the app
      // name — otherwise it throws ENOENT renaming a non-existent apps/<name>.
      const githubUrl = 'https://github.com/test/cc-monitor-appstore';
      const { state, spawn } = makeGitState('cc-monitor', 5403);
      const installer = makeInstaller(spawn);

      state.head = 'a'.repeat(40);
      state.version = '1.0.0';
      await waitForJob(installer, installer.install({ githubUrl, envVars: { APP_SECRET: 'keep-me' } }), 5000);

      // Simulate the legacy on-disk layout: rename the installed dir to the repo
      // basename and repoint the registry's installPath at it (dir name ≠ name).
      const entry = await registry.get('cc-monitor');
      const legacyDir = path.join(appsDir, 'cc-monitor-appstore');
      fs.renameSync(entry!.installPath, legacyDir);
      await registry.upsert({ ...entry!, installPath: legacyDir });
      expect(fs.existsSync(path.join(appsDir, 'cc-monitor'))).toBe(false);

      // Update must complete end-to-end (previously threw ENOENT at the swap).
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update('cc-monitor'), 5000);
      expect(job.status).toBe('completed');

      const after = await registry.get('cc-monitor');
      expect(after?.commit).toBe('b'.repeat(40));
      expect(after?.version).toBe('2.0.0');
      // Registry installPath stays at the real (legacy) directory, still on disk.
      expect(after?.installPath).toBe(legacyDir);
      expect(fs.existsSync(legacyDir)).toBe(true);
      // Secret (and therefore volumes) preserved via the .env copy-forward.
      expect(readEnvFile(after!.installPath)['APP_SECRET']).toBe('keep-me');
    });

    it('is a no-op when the custom app is already at HEAD', async () => {
      const githubUrl = 'https://github.com/test/steady-app';
      const { state, spawn } = makeGitState('steady-app', 5401);
      const installer = makeInstaller(spawn);

      state.head = 'c'.repeat(40);
      await waitForJob(installer, installer.install({ githubUrl }), 5000);

      // HEAD unchanged → update completes without rebuilding
      const job = await waitForJob(installer, installer.update('steady-app'), 5000);
      expect(job.status).toBe('completed');
      expect(job.logs.join('\n')).toContain(`Already at latest commit ${'c'.repeat(8)}`);

      const entry = await registry.get('steady-app');
      expect(entry?.commit).toBe('c'.repeat(40));
    });

    it('rejects updating a local (symlinked) app', async () => {
      const appDir = makeAppDir(srcDir, 'local-app', 5402);
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);
      expect((await registry.get('local-app'))?.source).toBe('local');

      const job = await waitForJob(installer, installer.update('local-app'), 5000);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/local path|cannot be updated/i);
    });

    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    // A cleanup failure on the post-update backup dir must not fail an
    // already-successful update (issue #261 self-review). As root the dir is
    // always removable, so the scenario can't occur.
    (isRoot ? it.skip : it)(
      'completes the update even when the old backup dir cannot be removed',
      async () => {
        const githubUrl = 'https://github.com/test/backup-app';
        const appName = 'backup-app';
        const state = { head: 'a'.repeat(40), version: '1.0.0' };
        const spawn = jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
          if (cmd === 'git' && args[0] === 'ls-remote') {
            return { stdout: `${state.head}\tHEAD\n`, stderr: '', status: 0 };
          }
          if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
            fs.writeFileSync(
              path.join(opts.cwd, 'app.yaml'),
              `
apiVersion: apps.getpod.ai/v1
name: ${appName}
version: ${state.version}
commit: "${state.head}"
services:
  app:
    image: nginx:1.25
    ports:
      - name: api
        host: 5600
        container: 5600
        type: api
    healthcheck:
      test: wget -qO- http://localhost:5600/health
      interval: 30s
`.trim(),
              'utf-8',
            );
          }
          // The sudo fallback also fails, so removal genuinely cannot complete.
          if (cmd === 'sudo') return { stdout: '', stderr: 'mock: sudo denied', status: 1 };
          return { stdout: '', stderr: '', status: 0 };
        });
        const installer = makeInstaller(spawn);

        await waitForJob(installer, installer.install({ githubUrl }), 5000);
        const appDir = path.join(appsDir, appName);
        // Make the installed dir un-removable — after the swap it becomes the
        // old backup dir the post-update cleanup tries (and fails) to delete.
        const locked = path.join(appDir, 'pgdata');
        fs.mkdirSync(locked);
        fs.writeFileSync(path.join(locked, 'PG_VERSION'), '16');
        fs.chmodSync(locked, 0o000);

        try {
          state.head = 'b'.repeat(40);
          state.version = '2.0.0';
          const job = await waitForJob(installer, installer.update(appName), 5000);

          // Update itself succeeded — the backup-cleanup failure must not flip it to failed.
          expect(job.status).toBe('completed');
          expect((await registry.get(appName))?.commit).toBe('b'.repeat(40));
          expect(job.logs.join('\n')).toMatch(/failed to remove old backup dir/i);
        } finally {
          for (const d of fs.readdirSync(appsDir)) {
            if (d.startsWith(appName)) {
              try { fs.chmodSync(path.join(appsDir, d, 'pgdata'), 0o755); } catch { /* n/a */ }
            }
          }
        }
      },
    );
  });

  // ── Rollback cleanup of root-owned / undeletable app dirs (issue #261) ─────
  describe('install rollback — undeletable (root-owned) app directory', () => {
    // Emulate the prod failure: a GitHub install clones successfully, a
    // container leaves behind a directory the gateway user cannot traverse
    // (stand-in for root-owned postgres/pgdata), then `docker compose up`
    // fails. The rollback's fs.rmSync then throws EACCES and must escalate to
    // `sudo rm -rf` instead of silently orphaning the directory.
    function makeFailingGitSpawn(appName: string, port: number, head: string) {
      return jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          fs.writeFileSync(
            path.join(opts.cwd, 'app.yaml'),
            `
apiVersion: apps.getpod.ai/v1
name: ${appName}
version: 1.0.0
commit: "${head}"
services:
  app:
    image: postgres:16-alpine
    ports:
      - name: api
        host: ${port}
        container: ${port}
        type: api
    healthcheck:
      test: pg_isready
      interval: 30s
`.trim(),
            'utf-8',
          );
          // Stand-in for a root-owned bind mount: a dir this user can't recurse.
          const locked = path.join(opts.cwd, 'pgdata');
          fs.mkdirSync(locked);
          fs.writeFileSync(path.join(locked, 'PG_VERSION'), '16');
          fs.chmodSync(locked, 0o000);
        }
        if (args.some((a) => a === 'up')) {
          return { stdout: '', stderr: 'mock: compose up failed', status: 1 };
        }
        return { stdout: '', stderr: '', status: 0 };
      });
    }

    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    // As root the scenario can't occur (root deletes anything), so skip.
    (isRoot ? it.skip : it)(
      'escalates to sudo rm -rf when rollback hits an EACCES app dir instead of swallowing it',
      async () => {
        const githubUrl = 'https://github.com/test/rollback-app';
        const appDir = path.join(appsDir, 'rollback-app');
        const locked = path.join(appDir, 'pgdata');
        const spawn = makeFailingGitSpawn('rollback-app', 5500, 'e'.repeat(40));
        const installer = makeInstaller(spawn);

        try {
          const job = await waitForJob(installer, installer.install({ githubUrl }), 5000);
          expect(job.status).toBe('failed'); // install failed at compose up

          // The rollback must escalate to `sudo rm -rf <appDir>` rather than
          // silently swallowing EACCES and orphaning the directory.
          const sawSudoRm = spawn.mock.calls.some(
            (c) => c[0] === 'sudo' && Array.isArray(c[1]) && c[1].join(' ') === `rm -rf ${appDir}`,
          );
          expect(sawSudoRm).toBe(true);
        } finally {
          // Restore perms so the leftover tmp dir can be cleaned up.
          try { fs.chmodSync(locked, 0o755); } catch { /* already gone */ }
          try { fs.rmSync(appDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      },
    );
  });

  // ── Agent-name conflict / orphan reclaim (issue #263) ──────────────────────
  describe('install — agent-name conflict vs orphan reclaim', () => {
    function makeAgentMgr(existingAgentName: string) {
      return {
        findAgentByName: jest.fn(async (n: string) => (n === existingAgentName ? n : null)),
        deleteAgentByName: jest.fn(async () => {}),
        deleteAgent: jest.fn(async () => {}),
        detectAgentPaths: jest.fn(() => ({
          claudeBin: '/usr/bin/claude',
          nodeBin: '/usr/bin/node',
          npmRoot: '/usr/lib/node_modules',
        })),
        injectAgentService: jest.fn(() => {}),
        upsertAgent: jest.fn(async () => {}),
        backupMemory: jest.fn(() => null),
        restoreMemory: jest.fn(() => {}),
      };
    }

    function makeInstallerWithAgent(
      spawn: typeof successSpawn,
      agentMgr: ReturnType<typeof makeAgentMgr>,
    ) {
      return new AppInstaller(
        registry,
        new RegistryClient(),
        callbacks,
        spawn,
        appsDir,
        agentMgr as unknown as ConstructorParameters<typeof AppInstaller>[5],
        successAsyncSpawn as unknown as ConstructorParameters<typeof AppInstaller>[6],
      );
    }

    // GitHub install of an app that declares an agent service.
    function agentGitSpawn(appName: string, agentName: string, port: number, head: string) {
      return jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          fs.writeFileSync(
            path.join(opts.cwd, 'app.yaml'),
            `
apiVersion: apps.getpod.ai/v1
name: ${appName}
version: 1.0.0
commit: "${head}"
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
  agent:
    path: ./agent
    name: ${agentName}
`.trim(),
            'utf-8',
          );
          fs.mkdirSync(path.join(opts.cwd, 'agent'), { recursive: true });
        }
        return { stdout: '', stderr: '', status: 0 };
      });
    }

    it('reclaims an orphaned agent (registered but owned by no installed app) and proceeds', async () => {
      const agentMgr = makeAgentMgr('orphan-bot'); // config says it exists…
      // …but no installed app declares it → orphan
      const spawn = agentGitSpawn('agent-app', 'orphan-bot', 5700, 'a'.repeat(40));
      const installer = makeInstallerWithAgent(spawn as unknown as typeof successSpawn, agentMgr);

      const job = await waitForJob(
        installer,
        installer.install({ githubUrl: 'https://github.com/test/agent-app' }),
        5000,
      );

      expect(agentMgr.deleteAgentByName).toHaveBeenCalledWith('orphan-bot');
      expect(job.status).toBe('completed');
    });

    it('throws a clear conflict when the agent is owned by a different installed app', async () => {
      // A different app already owns "shared-bot".
      await registry.upsert({
        name: 'other-app',
        version: '1.0.0',
        commit: 'b'.repeat(40),
        githubUrl: 'https://github.com/test/other-app',
        installPath: path.join(appsDir, 'other-app'),
        ports: [],
        sockets: {},
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'running',
        source: 'custom',
        agentDeclaration: { path: './agent', name: 'shared-bot' },
      });

      const agentMgr = makeAgentMgr('shared-bot');
      const spawn = agentGitSpawn('agent-app', 'shared-bot', 5701, 'c'.repeat(40));
      const installer = makeInstallerWithAgent(spawn as unknown as typeof successSpawn, agentMgr);

      const job = await waitForJob(
        installer,
        installer.install({ githubUrl: 'https://github.com/test/agent-app' }),
        5000,
      );

      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/already registered by app "other-app"/);
      expect(agentMgr.deleteAgentByName).not.toHaveBeenCalled();
    });
  });

  // ─── reconfigure() — env/port changes on an installed app (issue #267) ────
  describe('reconfigure()', () => {
    /**
     * Spawn mock that writes an app.yaml (one api port, a bare secret + a
     * self-generating secret) on `git checkout`, and records every invocation
     * so tests can assert docker flags. Emulates a GitHub install so the app is
     * non-local (reconfigurable) with a real on-disk appDir.
     */
    function makeRecordingSpawn(port = 5600) {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const spawn = jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        calls.push({ cmd, args });
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          fs.writeFileSync(
            path.join(opts.cwd, 'app.yaml'),
            `
apiVersion: apps.getpod.ai/v1
name: reconf-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  app:
    image: nginx:1.25
    environment:
      - DB_PASSWORD
      - SESSION_SECRET=!generate:hex:32
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
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      return { spawn, calls };
    }

    async function installReconfApp(spawn: SpawnFnLike, dbPass = 'orig-secret') {
      const installer = makeInstaller(spawn as unknown as typeof successSpawn);
      const jobId = installer.install({
        githubUrl: 'https://github.com/test/reconf-app',
        commit: 'a'.repeat(40),
        envVars: { DB_PASSWORD: dbPass },
      });
      const job = await waitForJob(installer, jobId, 5000);
      expect(job.status).toBe('completed');
      return installer;
    }

    it('merges env vars into .env, preserving unsent keys and generated secrets', async () => {
      const { spawn } = makeRecordingSpawn();
      const installer = await installReconfApp(spawn);
      const appDir = (await registry.get('reconf-app'))!.installPath;

      const before = fs.readFileSync(path.join(appDir, '.env'), 'utf-8');
      const genBefore = before.split('\n').find((l) => l.startsWith('SESSION_SECRET='));
      expect(before).toContain('DB_PASSWORD=orig-secret');
      expect(genBefore).toBeDefined();

      const job = await waitForJob(
        installer,
        installer.reconfigure('reconf-app', { envVars: { FEATURE_FLAG: 'on' } }),
        5000,
      );
      expect(job.status).toBe('completed');

      const after = fs.readFileSync(path.join(appDir, '.env'), 'utf-8');
      // Untouched key preserved, generated secret NOT rotated, new key added.
      expect(after).toContain('DB_PASSWORD=orig-secret');
      expect(after.split('\n').find((l) => l.startsWith('SESSION_SECRET='))).toBe(genBefore);
      expect(after).toContain('FEATURE_FLAG=on');
    });

    it('force-recreates the container and never removes volumes', async () => {
      const { spawn, calls } = makeRecordingSpawn();
      const installer = await installReconfApp(spawn);
      calls.length = 0; // only inspect the reconfigure phase

      const job = await waitForJob(
        installer,
        installer.reconfigure('reconf-app', { envVars: { FEATURE_FLAG: 'on' } }),
        5000,
      );
      expect(job.status).toBe('completed');

      const up = calls.find(
        (c) => c.cmd === 'docker' && c.args.includes('up') && c.args.includes('--force-recreate'),
      );
      expect(up).toBeDefined();
      // Data safety: no reconfigure command may pass -v / --volumes.
      for (const c of calls) {
        expect(c.args).not.toContain('-v');
        expect(c.args).not.toContain('--volumes');
      }
    });

    it('overrides the host port, re-registers routes, and updates the registry', async () => {
      const { spawn } = makeRecordingSpawn(5600);
      const installer = await installReconfApp(spawn);
      callbacks.deregistered.length = 0;
      callbacks.registeredRoutes.length = 0;

      const job = await waitForJob(
        installer,
        installer.reconfigure('reconf-app', { portOverrides: { api: 5650 } }),
        5000,
      );
      expect(job.status).toBe('completed');

      expect(callbacks.deregistered).toContain('reconf-app');
      const reg = callbacks.registeredRoutes.find((r) => r.appName === 'reconf-app');
      expect(reg?.ports[0].hostPort).toBe(5650);

      const entry = await registry.get('reconf-app');
      expect(entry?.ports[0].hostPort).toBe(5650);

      const compose = fs.readFileSync(path.join(entry!.installPath, 'docker-compose.yml'), 'utf-8');
      expect(compose).toContain('5650:5600');
    });

    it('fails a reconfigure whose port collides with another installed app', async () => {
      const { spawn } = makeRecordingSpawn(5600);
      const installer = await installReconfApp(spawn);
      await registry.upsert(makeEntryFor('other-app', 5700));

      const job = await waitForJob(
        installer,
        installer.reconfigure('reconf-app', { portOverrides: { api: 5700 } }),
        5000,
      );
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/already used by app "other-app"/);
    });

    it('leaves the live compose untouched when a port change throws before recreate (F2)', async () => {
      // A collision (or any pre-recreate throw) must not have already rewritten
      // the live docker-compose.yml — otherwise the file holds the new ports
      // while the old container/routes are still live (finding F2). Reconfigure
      // generates to a temp file and only swaps the live compose inside the
      // guarded section, so a collision leaves the old mapping on disk.
      const { spawn } = makeRecordingSpawn(5600);
      const installer = await installReconfApp(spawn);
      await registry.upsert(makeEntryFor('other-app', 5700));

      const appDir = (await registry.get('reconf-app'))!.installPath;
      const composePath = path.join(appDir, 'docker-compose.yml');
      expect(fs.readFileSync(composePath, 'utf-8')).toContain('5600:5600');

      const job = await waitForJob(
        installer,
        installer.reconfigure('reconf-app', { portOverrides: { api: 5700 } }),
        5000,
      );
      expect(job.status).toBe('failed');

      // The live compose still holds the ORIGINAL mapping — the failed override
      // never reached disk.
      const composeAfter = fs.readFileSync(composePath, 'utf-8');
      expect(composeAfter).toContain('5600:5600');
      expect(composeAfter).not.toContain('5700');
      // Registry unchanged too.
      const entry = await registry.get('reconf-app');
      expect(entry?.ports[0].hostPort).toBe(5600);
    });

    it('rolls back the .env and recreates on a failed env-only reconfigure (F1)', async () => {
      // An env-only reconfigure rewrites .env and force-recreates the container.
      // A bad value that fails the recreate must not leave the app down with the
      // broken .env — the rollback restores the previous .env and brings the old
      // container back, even though no port changed (finding F1).
      let forceRecreateCount = 0;
      const spawn = jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          fs.writeFileSync(
            path.join(opts.cwd, 'app.yaml'),
            `
apiVersion: apps.getpod.ai/v1
name: reconf-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  app:
    image: nginx:1.25
    environment:
      - DB_PASSWORD
    ports:
      - name: api
        host: 5600
        container: 5600
        type: api
    healthcheck:
      test: wget -qO- http://localhost:5600/health
      interval: 30s
`.trim(),
            'utf-8',
          );
        }
        // First force-recreate (the reconfigure) fails; the rollback's second
        // recreate succeeds — mirroring a bad env value crashing the container.
        if (cmd === 'docker' && args.includes('up') && args.includes('--force-recreate')) {
          forceRecreateCount += 1;
          if (forceRecreateCount === 1) {
            return { stdout: '', stderr: 'mocked: container failed healthcheck', status: 1 };
          }
        }
        return { stdout: '', stderr: '', status: 0 };
      });

      const installer = makeInstaller(spawn as unknown as typeof successSpawn);
      const installJob = await waitForJob(
        installer,
        installer.install({
          githubUrl: 'https://github.com/test/reconf-app',
          commit: 'a'.repeat(40),
          envVars: { DB_PASSWORD: 'orig-secret' },
        }),
        5000,
      );
      expect(installJob.status).toBe('completed');

      const appDir = (await registry.get('reconf-app'))!.installPath;
      const envPath = path.join(appDir, '.env');
      callbacks.deregistered.length = 0;
      callbacks.registeredRoutes.length = 0;

      const job = await waitForJob(
        installer,
        installer.reconfigure('reconf-app', { envVars: { DB_PASSWORD: 'bad-value' } }),
        5000,
      );

      // Reported failed, but rolled back — not left down with the bad .env.
      expect(job.status).toBe('failed');
      const envAfter = fs.readFileSync(envPath, 'utf-8');
      expect(envAfter).toContain('DB_PASSWORD=orig-secret');
      expect(envAfter).not.toContain('bad-value');
      // The rollback issued a second force-recreate to bring the old container back.
      expect(forceRecreateCount).toBe(2);
      // Env-only path never touches proxy routes (nothing deregistered).
      expect(callbacks.deregistered).not.toContain('reconf-app');
    });

    it('rolls back to the previous port/compose/routes when the recreate fails', async () => {
      // Install succeeds; the port-change recreate then fails on its FIRST
      // `up --force-recreate`, while the rollback's recreate (the second) is
      // allowed to succeed — mirroring a real "new port unbindable" failure.
      let forceRecreateCount = 0;
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const spawn = jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        calls.push({ cmd, args });
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          fs.writeFileSync(
            path.join(opts.cwd, 'app.yaml'),
            `
apiVersion: apps.getpod.ai/v1
name: reconf-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  app:
    image: nginx:1.25
    environment:
      - DB_PASSWORD
    ports:
      - name: api
        host: 5600
        container: 5600
        type: api
    healthcheck:
      test: wget -qO- http://localhost:5600/health
      interval: 30s
`.trim(),
            'utf-8',
          );
        }
        if (cmd === 'docker' && args.includes('up') && args.includes('--force-recreate')) {
          forceRecreateCount += 1;
          if (forceRecreateCount === 1) {
            return { stdout: '', stderr: 'mocked: host port unbindable', status: 1 };
          }
        }
        return { stdout: '', stderr: '', status: 0 };
      });

      const installer = makeInstaller(spawn as unknown as typeof successSpawn);
      const installJob = await waitForJob(
        installer,
        installer.install({
          githubUrl: 'https://github.com/test/reconf-app',
          commit: 'a'.repeat(40),
          envVars: { DB_PASSWORD: 'orig-secret' },
        }),
        5000,
      );
      expect(installJob.status).toBe('completed');

      const appDir = (await registry.get('reconf-app'))!.installPath;
      const composePath = path.join(appDir, 'docker-compose.yml');
      expect(fs.readFileSync(composePath, 'utf-8')).toContain('5600:5600');

      callbacks.deregistered.length = 0;
      callbacks.registeredRoutes.length = 0;

      const job = await waitForJob(
        installer,
        installer.reconfigure('reconf-app', { portOverrides: { api: 5650 } }),
        5000,
      );

      // Job is reported failed — but the app is left rolled back, not broken.
      expect(job.status).toBe('failed');
      // On-disk compose restored to the OLD port (the new 5650 mapping is gone).
      const composeAfter = fs.readFileSync(composePath, 'utf-8');
      expect(composeAfter).toContain('5600:5600');
      expect(composeAfter).not.toContain('5650');
      // Registry still holds the OLD port (new ports were never persisted).
      const entry = await registry.get('reconf-app');
      expect(entry?.ports[0].hostPort).toBe(5600);
      // OLD routes are re-registered after the deregister, so the app is reachable.
      expect(callbacks.deregistered).toContain('reconf-app');
      const reg = callbacks.registeredRoutes.filter((r) => r.appName === 'reconf-app');
      expect(reg.length).toBeGreaterThan(0);
      expect(reg[reg.length - 1].ports[0].hostPort).toBe(5600);
      // The rollback issued a second force-recreate to bring the old container back.
      expect(forceRecreateCount).toBe(2);
    });

    it('rejects reconfigure of a local (symlinked) app', async () => {
      const appDir = makeAppDir(srcDir, 'local-reconf');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      const job = await waitForJob(
        installer,
        installer.reconfigure('local-reconf', { envVars: { X: 'y' } }),
        5000,
      );
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/local path|reinstall/i);
    });

    it('throws synchronously (409 path) when a job is already in flight', async () => {
      const { spawn } = makeRecordingSpawn();
      const installer = await installReconfApp(spawn);
      // First reconfigure holds the install lock; the second must be rejected.
      const first = installer.reconfigure('reconf-app', { envVars: { A: '1' } });
      expect(() => installer.reconfigure('reconf-app', { envVars: { B: '2' } })).toThrow(
        /already being installed or updated/,
      );
      await waitForJob(installer, first, 5000);
    });
  });

  // ─── reconcileStatus() — sync stored status with the live Docker runtime ────

  describe('reconcileStatus()', () => {
    /**
     * An ASYNC spawn mock (reconcile uses the non-blocking spawn seam) that
     * answers `docker compose ps` with a caller-supplied payload and succeeds
     * (empty) for everything else. `psStatus` simulates the daemon being
     * unreachable (non-zero exit).
     */
    function psSpawn(psStdout: string, psStatus = 0) {
      return jest.fn(async (_cmd: string, args: string[], _opts?: object) => {
        if (args.includes('ps')) {
          return { stdout: psStdout, stderr: psStatus === 0 ? '' : 'boom', status: psStatus };
        }
        return { stdout: '', stderr: '', status: 0 };
      });
    }

    const runningPs = JSON.stringify({ State: 'running', ExitCode: 0 });
    const crashedPs = JSON.stringify({ State: 'exited', ExitCode: 137 });

    it('flips a stale running → stopped when no containers exist (the reported bug)', async () => {
      await registry.upsert({ ...makeEntryFor('ghost-app', 6001), status: 'running' });
      const installer = makeInstaller(successSpawn, psSpawn('') /* empty ps = no containers */);

      const reconciled = await installer.reconcileStatus((await registry.get('ghost-app'))!);

      expect(reconciled.status).toBe('stopped');
      // Persisted, so the next read (and boot restore) see the truth.
      expect((await registry.get('ghost-app'))?.status).toBe('stopped');
    });

    it('reports error when a container crashed (exited non-zero)', async () => {
      await registry.upsert({ ...makeEntryFor('crash-app', 6002), status: 'running' });
      const installer = makeInstaller(successSpawn, psSpawn(crashedPs));

      const reconciled = await installer.reconcileStatus((await registry.get('crash-app'))!);
      expect(reconciled.status).toBe('error');
    });

    it('keeps running when the container is genuinely running', async () => {
      await registry.upsert({ ...makeEntryFor('live-app', 6003), status: 'running' });
      const installer = makeInstaller(successSpawn, psSpawn(runningPs));

      const reconciled = await installer.reconcileStatus((await registry.get('live-app'))!);
      expect(reconciled.status).toBe('running');
    });

    it('keeps the stored status when Docker cannot be queried (non-zero exit)', async () => {
      await registry.upsert({ ...makeEntryFor('daemon-down', 6004), status: 'running' });
      const installer = makeInstaller(successSpawn, psSpawn('', 1) /* daemon unreachable */);

      const reconciled = await installer.reconcileStatus((await registry.get('daemon-down'))!);
      expect(reconciled.status).toBe('running'); // no false "stopped"
    });

    it('keeps the stored status when the ps query rejects (timeout)', async () => {
      await registry.upsert({ ...makeEntryFor('hung-app', 6008), status: 'running' });
      const rejectingSpawn = jest.fn(async (_cmd: string, args: string[]) => {
        if (args.includes('ps')) throw new Error('spawn timed out');
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer = makeInstaller(successSpawn, rejectingSpawn);

      const reconciled = await installer.reconcileStatus((await registry.get('hung-app'))!);
      expect(reconciled.status).toBe('running'); // rejection swallowed, no false flip
    });

    it('still returns the corrected status when the persist write fails', async () => {
      await registry.upsert({ ...makeEntryFor('persist-fail', 6009), status: 'running' });
      const installer = makeInstaller(successSpawn, psSpawn('') /* no containers */);
      // Simulate a registry lock/write failure on persist.
      jest.spyOn(registry, 'updateStatus').mockRejectedValueOnce(new Error('lock timeout'));

      const reconciled = await installer.reconcileStatus((await registry.get('persist-fail'))!);
      // Read is still corrected in-memory even though the write failed —
      // reconcileStatus must never reject and 500 the whole list.
      expect(reconciled.status).toBe('stopped');
    });

    it('does not reconcile an app in the building state (in-flight install)', async () => {
      await registry.upsert({ ...makeEntryFor('installing-app', 6005), status: 'building' });
      const spawn = psSpawn('');
      const installer = makeInstaller(successSpawn, spawn);

      const reconciled = await installer.reconcileStatus((await registry.get('installing-app'))!);
      expect(reconciled.status).toBe('building');
      // ps must not even be queried while building.
      const psCalls = spawn.mock.calls.filter((c) => (c[1] as string[]).includes('ps'));
      expect(psCalls).toHaveLength(0);
    });

    it('reconcileStatuses() maps a mixed list in one pass', async () => {
      await registry.upsert({ ...makeEntryFor('mixed-live', 6006), status: 'running' });
      await registry.upsert({ ...makeEntryFor('mixed-dead', 6007), status: 'running' });
      // Route ps by cwd (installPath differs per app: /tmp/<name>).
      const spawn = jest.fn(async (_cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (args.includes('ps')) {
          const stdout = opts?.cwd?.endsWith('mixed-live') ? runningPs : '';
          return { stdout, stderr: '', status: 0 };
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer = makeInstaller(successSpawn, spawn as unknown as typeof successAsyncSpawn);

      const list = await registry.list();
      const reconciled = await installer.reconcileStatuses(list);
      const byName = Object.fromEntries(reconciled.map((e) => [e.name, e.status]));
      expect(byName['mixed-live']).toBe('running');
      expect(byName['mixed-dead']).toBe('stopped');
    });
  });

  // ─── parseComposePs() / mapContainerStatesToAppStatus() — pure helpers ──────

  describe('compose ps parsing + status mapping', () => {
    it('parses newline-delimited JSON objects (current compose)', () => {
      const ndjson = [
        JSON.stringify({ State: 'running', ExitCode: 0 }),
        JSON.stringify({ State: 'exited', ExitCode: 0 }),
      ].join('\n');
      const parsed = parseComposePs(ndjson);
      expect(parsed).toEqual([
        { state: 'running', exitCode: 0 },
        { state: 'exited', exitCode: 0 },
      ]);
    });

    it('parses a single JSON array (older compose)', () => {
      const arr = JSON.stringify([
        { State: 'Running', ExitCode: 0 },
        { State: 'Dead', ExitCode: 0 },
      ]);
      const parsed = parseComposePs(arr);
      expect(parsed).toEqual([
        { state: 'running', exitCode: 0 },
        { state: 'dead', exitCode: 0 },
      ]);
    });

    it('returns [] for empty output and skips malformed lines', () => {
      expect(parseComposePs('')).toEqual([]);
      expect(parseComposePs('   \n  ')).toEqual([]);
      expect(parseComposePs('{not json}\n' + JSON.stringify({ State: 'running' }))).toEqual([
        { state: 'running', exitCode: 0 },
      ]);
    });

    it('maps aggregate states to the right app status', () => {
      expect(mapContainerStatesToAppStatus([])).toBe('stopped');
      expect(mapContainerStatesToAppStatus([{ state: 'running', exitCode: 0 }])).toBe('running');
      expect(mapContainerStatesToAppStatus([{ state: 'restarting', exitCode: 0 }])).toBe('running');
      // running wins even when a sibling has exited.
      expect(
        mapContainerStatesToAppStatus([
          { state: 'exited', exitCode: 0 },
          { state: 'running', exitCode: 0 },
        ]),
      ).toBe('running');
      expect(mapContainerStatesToAppStatus([{ state: 'exited', exitCode: 137 }])).toBe('error');
      expect(mapContainerStatesToAppStatus([{ state: 'dead', exitCode: 0 }])).toBe('error');
      expect(mapContainerStatesToAppStatus([{ state: 'exited', exitCode: 0 }])).toBe('stopped');
      expect(mapContainerStatesToAppStatus([{ state: 'created', exitCode: 0 }])).toBe('stopped');
    });
  });
});

/** Minimal AppEntry for seeding a collision peer in the registry. */
function makeEntryFor(name: string, hostPort: number): import('../../../src/apps/registry').AppEntry {
  return {
    name,
    version: '1.0.0',
    commit: 'abc123def456abc123def456abc123def456abc1',
    githubUrl: `https://github.com/test/${name}`,
    installPath: `/tmp/${name}`,
    ports: [{ name: 'api', service: 'app', hostPort, containerPort: hostPort, type: 'api', rateLimit: 200 }],
    sockets: {},
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    source: 'custom',
  };
}

/** Loosely-typed spawn used by the recording mock in reconfigure() tests. */
type SpawnFnLike = (cmd: string, args: string[], opts?: { cwd?: string }) => { stdout: string; stderr: string; status: number };

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
