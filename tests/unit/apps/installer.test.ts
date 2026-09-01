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
 * Stand-in for the root helper container the installer falls back to when the
 * gateway user cannot rename a bind path. Root is not bound by the mode bits
 * that stopped the gateway user, so the double replays the move and restores
 * the original mode — it deliberately does **not** create the destination
 * parent, so a fix that forgot to would still fail here.
 */
function simulateRootMv(args: string[]): void {
  const base = args[args.indexOf('-v') + 1].split(':')[0];
  const toContainerPath = (p: string) => path.join(base, ...p.replace(/^\/mnt\//, '').split('/'));
  const from = toContainerPath(args[args.length - 2]);
  const to = toContainerPath(args[args.length - 1]);
  const mode = fs.statSync(from).mode & 0o777;
  fs.chmodSync(from, 0o700);
  fs.renameSync(from, to);
  fs.chmodSync(to, mode);
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

/** Stub AgentManager. `existingAgentName` is the only name it reports as taken. */
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
    backupMemory: jest.fn((): string | null => null),
    restoreMemory: jest.fn(() => {}),
  };
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

  function makeInstaller(
    spawnFn = successSpawn,
    asyncSpawnFn = successAsyncSpawn,
    restoreConfig?: { buildTimeoutMs?: number; waitTimeoutMs?: number },
  ) {
    return new AppInstaller(
      registry,
      new RegistryClient(),
      callbacks,
      spawnFn,
      appsDir,
      undefined, // agentManager
      asyncSpawnFn as unknown as ConstructorParameters<typeof AppInstaller>[6],
      undefined, // housekeepingConfig
      undefined, // appBackupConfig
      undefined, // backupsDir
      restoreConfig,
    );
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

  /**
   * Spawn mock for an app that declares a directory bind (`./data/photos`) and
   * a file bind (`./config/app.conf`). `shipTracked` decides whether the updated
   * release also carries content at those paths — the realistic case a repo
   * creates with a `.gitkeep`, seed data, or a tracked config file.
   */
    function statefulAppSpawn(opts: {
      appName: string;
      state: { head: string; version: string };
      hostPort: number;
      shipTracked?: boolean;
      failConfig?: () => boolean;
      onCheckout?: (cwd: string) => void;
      calls?: Array<{ args: string[]; cwd?: string }>;
      /** Extra `./<rel>:<target>` binds the release declares, e.g. a pgdata dir. */
      extraBinds?: Array<{ rel: string; target: string }>;
      /** Release also carries a tracked file inside each `extraBinds` path. */
      shipExtraBinds?: boolean;
      /** Return true to make `compose up --wait` fail (a crashed new release). */
      failUp?: () => boolean;
      /** Return true to make the root move-helper container fail. */
      failRootMove?: () => boolean;
      /**
       * Image ID `compose images` reports for the app's built service, so the
       * update has a pre-update build to preserve and a rollback has one to
       * put back. Absent, the app builds nothing and none of that runs.
       */
      builtImageId?: string;
    }) {
      const { appName, state, hostPort } = opts;
      return jest.fn((cmd: string, args: string[], spawnOpts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${state.head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && spawnOpts?.cwd) {
          const cwd = spawnOpts.cwd;
          fs.writeFileSync(path.join(cwd, 'app.yaml'), `
apiVersion: apps.getpod.ai/v1
name: ${appName}
version: ${state.version}
commit: "${state.head}"
services:
  app:
    image: postgres:16-alpine
    volumes:
      - ./data/photos:/photos
      - ./config/app.conf:/etc/app.conf
${(opts.extraBinds ?? []).map((b) => `      - ./${b.rel}:${b.target}`).join('\n')}
    ports:
      - name: api
        host: ${hostPort}
        container: ${hostPort}
        type: api
    healthcheck:
      test: pg_isready
      interval: 30s
`.trim(), 'utf-8');
          if (opts.shipTracked) {
            // What a real `git checkout` of the new release produces.
            fs.mkdirSync(path.join(cwd, 'data', 'photos'), { recursive: true });
            fs.writeFileSync(path.join(cwd, 'data', 'photos', '.gitkeep'), '', 'utf-8');
            fs.mkdirSync(path.join(cwd, 'config'), { recursive: true });
            fs.writeFileSync(path.join(cwd, 'config', 'app.conf'), 'release-default', 'utf-8');
          }
          if (opts.shipExtraBinds) {
            // Named per release, so a test can tell the file this checkout
            // shipped from the one the *installed* release left in the live dir.
            for (const b of opts.extraBinds ?? []) {
              const dir = path.join(cwd, ...b.rel.split('/'));
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, `release-${state.version}.marker`), '', 'utf-8');
            }
          }
          opts.onCheckout?.(cwd);
        }
        if (cmd === 'docker') {
          opts.calls?.push({ args, cwd: spawnOpts?.cwd });
          if (args[0] === 'run' && args.includes('mv')) {
            if (opts.failRootMove?.()) {
              return { stdout: '', stderr: 'docker: daemon unreachable', status: 1 };
            }
            simulateRootMv(args);
            return { stdout: '', stderr: '', status: 0 };
          }
          if (args[0] === 'compose' && args.includes('up') && args.includes('--wait')
            && opts.failUp?.()) {
            return { stdout: '', stderr: 'dependency failed to start', status: 1 };
          }
          if (args[0] === 'compose' && args.includes('images') && args.includes('--format')
            && opts.builtImageId) {
            return {
              stdout: JSON.stringify([
                { ID: opts.builtImageId, Repository: `${appName}-app`, Tag: 'latest' },
              ]),
              stderr: '', status: 0,
            };
          }
          if (args.includes('config') && args.includes('--format') && spawnOpts?.cwd) {
            if (opts.failConfig?.()) {
              return { stdout: '', stderr: 'docker daemon unreachable', status: 1 };
            }
            return {
              stdout: JSON.stringify({ services: { app: { volumes: [
                { type: 'bind', source: path.join(spawnOpts.cwd, 'data', 'photos') },
                { type: 'bind', source: path.join(spawnOpts.cwd, 'config', 'app.conf') },
                ...(opts.extraBinds ?? []).map((b) => ({
                  type: 'bind', source: path.join(spawnOpts.cwd!, ...b.rel.split('/')),
                })),
              ] } } }),
              stderr: '', status: 0,
            };
          }
        }
        return { stdout: '', stderr: '', status: 0 };
      });
    }

    /** Install the app, then seed live state into its bind paths. */
    async function installWithLiveState(
      installer: AppInstaller,
      githubUrl: string,
      appName: string,
    ) {
      await waitForJob(installer, installer.install({ githubUrl }), 5000);
      const entry = await registry.get(appName);
      const photos = path.join(entry!.installPath, 'data', 'photos');
      const conf = path.join(entry!.installPath, 'config', 'app.conf');
      fs.mkdirSync(photos, { recursive: true });
      fs.mkdirSync(path.dirname(conf), { recursive: true });
      fs.writeFileSync(path.join(photos, 'photo.jpg'), 'persisted', 'utf-8');
      fs.writeFileSync(conf, 'operator-edited', 'utf-8');
      return { entry: entry!, photos, conf };
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

    it('reinstall reuses a generated secret already present in the app dir .env', async () => {
      // A local (symlinked) reinstall can re-point at a source tree that still
      // holds a prior .env alongside persisted data (e.g. a postgres pgdata bind
      // mount). If the install rotated the generated secret it would no longer
      // match the password baked into that data and the app would fail auth.
      // The install path must reuse an already-present .env, like reconfigure.
      const appDir = makeGenAppDir(srcDir, 'gen-reinstall');
      // Seed the .env a previous install left behind in the source tree.
      fs.writeFileSync(
        path.join(appDir, '.env'),
        'GEN_HEX=pinned-from-prior-install\nGEN_URLSAFE=prior-urlsafe\n',
        'utf-8',
      );

      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      const env = readEnv(appDir);
      expect(env['GEN_HEX']).toBe('pinned-from-prior-install');
      expect(env['GEN_URLSAFE']).toBe('prior-urlsafe');
    });

    it('operator env_var still overrides a generated secret already in .env', async () => {
      // Precedence must stay operator-supplied → existing .env → generate.
      const appDir = makeGenAppDir(srcDir, 'gen-reinstall-override');
      fs.writeFileSync(
        path.join(appDir, '.env'),
        'GEN_HEX=stale-value\n',
        'utf-8',
      );

      const installer = makeInstaller();
      await waitForJob(
        installer,
        installer.install({ localPath: appDir, envVars: { GEN_HEX: 'operator-wins' } }),
        5000,
      );

      expect(readEnv(appDir)['GEN_HEX']).toBe('operator-wins');
    });

    // ── Prompt-with-default secrets (!default:) ──────────────────────────────
    function makeDefaultAppDir(dir: string, appName: string, port = 5010): string {
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
      - NEXTAUTH_URL=!default:http://localhost:3737
      - PLAIN_KEY
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

    it('writes the declared default to .env when no operator value is supplied', async () => {
      const appDir = makeDefaultAppDir(srcDir, 'default-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      const env = readEnv(appDir);
      // URL default survives intact — the `:` and `/` are not truncated.
      expect(env['NEXTAUTH_URL']).toBe('http://localhost:3737');
      // A bare key with no default still writes an empty value (unchanged).
      expect(env['PLAIN_KEY']).toBe('');
    });

    it('lets an operator-supplied value win over the default', async () => {
      const appDir = makeDefaultAppDir(srcDir, 'default-app', 5011);
      const installer = makeInstaller();
      await waitForJob(
        installer,
        installer.install({ localPath: appDir, envVars: { NEXTAUTH_URL: 'https://prod.example.com' } }),
        5000,
      );

      const env = readEnv(appDir);
      expect(env['NEXTAUTH_URL']).toBe('https://prod.example.com');
    });

    it('falls back to the default when the operator value is blank', async () => {
      const appDir = makeDefaultAppDir(srcDir, 'default-app', 5012);
      const installer = makeInstaller();
      await waitForJob(
        installer,
        installer.install({ localPath: appDir, envVars: { NEXTAUTH_URL: '' } }),
        5000,
      );

      const env = readEnv(appDir);
      expect(env['NEXTAUTH_URL']).toBe('http://localhost:3737');
    });

    it('reports a default key in job result secretKeys (still prompted)', async () => {
      const appDir = makeDefaultAppDir(srcDir, 'default-app', 5013);
      const installer = makeInstaller();
      const job = await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      const secretKeys = (job.result as { secretKeys: string[] }).secretKeys;
      expect(secretKeys).toContain('NEXTAUTH_URL');
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

    it('throws "busy" when a mutating job holds the app', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      const jobId = installer.install({ localPath: appDir });
      await waitForJob(installer, jobId, 5000);

      // Simulate an install/update/backup in flight on the same app.
      (installer as unknown as { installingNames: Set<string> }).installingNames.add('my-app');
      await expect(installer.startStopRestart('my-app', 'stop')).rejects.toThrow('busy');
      // Guard rejected before touching the app — status is unchanged.
      expect((await registry.get('my-app'))?.status).toBe('running');
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

    // ── Cold-host restore (issue #425) ────────────────────────────────────
    //
    // On a host with no image cache the restore has to BUILD before it can
    // wait. `up` alone would do that under the healthcheck-wait budget, and a
    // timeout there SIGKILLs the compose CLI — which cancels the build, so no
    // image and no container ever appear. The double below models exactly that.

    /**
     * Async-spawn double with real cold-host timeout semantics: a command whose
     * work exceeds its OWN budget is killed (rejects, as defaultAsyncSpawn
     * does), and a killed build leaves nothing behind. `buildMs` is how long
     * this host needs to build the app's image from source; `imagePresent`
     * models a warm host that already has the image.
     */
    function coldHostAsyncSpawn(buildMs: number, imagePresent = false) {
      const seen: Array<{ args: string[]; timeoutMs?: number }> = [];
      let imageBuilt = imagePresent;
      const fn = jest.fn(async (_cmd: string, args: string[], opts?: object) => {
        const budget = (opts as { timeoutMs?: number } | undefined)?.timeoutMs;
        seen.push({ args, timeoutMs: budget });
        const ceiling = budget ?? Number.POSITIVE_INFINITY;
        const build = (): void => {
          // The CLI owns the build session: killing it cancels the build.
          if (buildMs > ceiling) throw new Error(`Command timed out after ${ceiling}ms: docker compose`);
          imageBuilt = true;
        };
        // Image probe: which images the project needs, and whether they exist.
        if (args.includes('config')) return { stdout: 'my-app-web\n', stderr: '', status: 0 };
        if (args.includes('inspect')) return { stdout: '', stderr: '', status: imageBuilt ? 0 : 1 };
        if (args.includes('build')) build();
        // `up` builds a missing image itself — under ITS budget, which is the
        // whole bug when no separate build step ran first.
        else if (args.includes('up') && !imageBuilt) build();
        return { stdout: '', stderr: '', status: 0 };
      });
      return Object.assign(fn, { seen });
    }

    it('builds under its own budget before waiting, so a cold rebuild is not killed by the wait timeout', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      // 400s of build — far past the 180s healthcheck-wait budget, well inside
      // the 30-minute build budget.
      const asyncSpawn = coldHostAsyncSpawn(400_000);
      const installer2 = makeInstaller(successSpawn, asyncSpawn);

      const { attempted, failures } = await installer2.restoreRunningApps();
      expect(attempted).toBe(1);
      expect(failures).toEqual([]); // pre-fix: killed mid-build, restore fails

      const compose = asyncSpawn.seen.filter((c) => c.args.includes('build') || c.args.includes('up'));
      expect(compose.map((c) => (c.args.includes('build') ? 'build' : 'up'))).toEqual(['build', 'up']);
      expect(compose[0].timeoutMs).toBe(1_800_000);
      expect(compose[1].timeoutMs).toBe(180_000);
    });

    it('skips the build entirely when the app image is already on the host', async () => {
      // Anti-over-correction: `up` builds only what is missing, but `build`
      // re-runs every time it is called. Issuing it unconditionally would
      // re-execute every Dockerfile on every boot — and appHousekeeping prunes
      // build cache after a week, so that rebuild would be from scratch.
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      // A build this host cannot afford: 400s against the 180s wait budget. It
      // never runs, because the image is already there.
      const warm = coldHostAsyncSpawn(400_000, true);
      const installer2 = makeInstaller(successSpawn, warm);

      const { failures } = await installer2.restoreRunningApps();
      expect(failures).toEqual([]);
      expect(warm.seen.some((c) => c.args.includes('build'))).toBe(false);
      expect(warm.seen.filter((c) => c.args.includes('up'))).toHaveLength(1);
    });

    it('still bounds the build: one that outlasts its own budget fails the restore', async () => {
      // Anti-over-correction: the fix must not remove the ceiling, only resize it.
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      const installer2 = makeInstaller(successSpawn, coldHostAsyncSpawn(2_000_000));

      const { failures } = await installer2.restoreRunningApps();
      expect(failures).toHaveLength(1);
      expect(failures[0].app).toBe('my-app');
    });

    it('takes both budgets from config, ignoring values that would remove the ceiling', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      const configured = coldHostAsyncSpawn(1_000);
      await makeInstaller(successSpawn, configured, {
        buildTimeoutMs: 900_000,
        waitTimeoutMs: 60_000,
      }).restoreRunningApps();
      const withConfig = configured.seen.filter((c) => c.args.includes('build') || c.args.includes('up'));
      expect(withConfig[0].timeoutMs).toBe(900_000);
      expect(withConfig[1].timeoutMs).toBe(60_000);

      // Config is untrusted: 0/negative/NaN all mean "no timeout" to setTimeout,
      // so they must fall back to the defaults rather than unbound the command.
      const bogus = coldHostAsyncSpawn(1_000);
      await makeInstaller(successSpawn, bogus, {
        buildTimeoutMs: 0,
        waitTimeoutMs: -1,
      }).restoreRunningApps();
      const withBogus = bogus.seen.filter((c) => c.args.includes('build') || c.args.includes('up'));
      expect(withBogus[0].timeoutMs).toBe(1_800_000);
      expect(withBogus[1].timeoutMs).toBe(180_000);
    });

    it('does not let a status read latch the app to stopped while its restore is in flight', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      // A GET /apps landing mid-restore: `compose ps` reports no containers
      // (they do not exist yet), which maps to `stopped` and would be persisted
      // — permanently excluding the app from every future boot restore.
      let midRestore: import('../../../src/apps/registry').AppEntry | undefined;
      let installer2!: AppInstaller;
      const asyncSpawn = jest.fn(async (_cmd: string, args: string[], _opts?: object) => {
        if (args.includes('up')) {
          midRestore = await installer2.reconcileStatus((await registry.get('my-app'))!);
        }
        return { stdout: '', stderr: '', status: 0 }; // empty ps = no containers
      });
      installer2 = makeInstaller(successSpawn, asyncSpawn);

      await installer2.restoreRunningApps();

      expect(midRestore?.status).toBe('running'); // pre-fix: 'stopped'
      expect((await registry.get('my-app'))?.status).toBe('running');
    });

    it('records a failed restore and keeps the app eligible for the next boot', async () => {
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      const installer2 = makeInstaller(successSpawn, failingAsyncSpawn('up'));
      await installer2.restoreRunningApps();

      // Observable through the API, not just the boot log.
      const failure = installer2.getRestoreFailure('my-app');
      expect(failure?.error).toMatch(/mocked error: up/);
      expect(failure?.at).toEqual(expect.any(String));

      // Reported honestly as `error` (not a deliberate `stopped`)…
      const reconciled = await installer2.reconcileStatus((await registry.get('my-app'))!);
      expect(reconciled.status).toBe('error');
      // …while the stored `running` intent survives, so the next pass retries it.
      expect((await registry.get('my-app'))?.status).toBe('running');
      expect((await installer2.restoreRunningApps()).attempted).toBe(1);
    });

    it('clears the restore failure once the app is observed running', async () => {
      // Anti-over-correction: the marker must not pin an app to `error` forever.
      const appDir = makeAppDir(srcDir, 'my-app');
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      // dockerd got there in the end (or an operator started it): `ps` flips
      // from "no containers" to a live one.
      let containersLive = false;
      const spawnDouble = jest.fn(async (_cmd: string, args: string[], _opts?: object) => {
        if (args.includes('ps')) {
          return {
            stdout: containersLive ? JSON.stringify({ State: 'running', ExitCode: 0 }) : '',
            stderr: '',
            status: 0,
          };
        }
        if (args.includes('up')) return { stdout: '', stderr: 'mocked error: up', status: 1 };
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer2 = makeInstaller(successSpawn, spawnDouble);

      await installer2.restoreRunningApps();
      expect(installer2.getRestoreFailure('my-app')).toBeDefined();

      containersLive = true;
      expect((await installer2.reconcileStatus((await registry.get('my-app'))!)).status).toBe('running');
      expect(installer2.getRestoreFailure('my-app')).toBeUndefined();
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

    it('merges live bind data into a release that ships tracked content at the same paths', async () => {
      // REVIEW #1 — the fix threw `Updated app already contains bind-mount path`
      // whenever the new checkout carried the bind path, making every update of
      // such an app fail-and-roll-back forever.
      const appName = 'merge-app';
      const state = { head: 'a'.repeat(40), version: '1.0.0' };
      const spawn = statefulAppSpawn({ appName, state, hostPort: 5420, shipTracked: true });
      const installer = makeInstaller(spawn as typeof successSpawn);
      const { photos, conf } = await installWithLiveState(
        installer, 'https://github.com/test/merge-app', appName,
      );

      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update(appName), 5000);

      expect(job.status).toBe('completed');
      // Live data survives the collision …
      expect(fs.readFileSync(path.join(photos, 'photo.jpg'), 'utf-8')).toBe('persisted');
      // … and the release's own file inside that directory still lands.
      expect(fs.existsSync(path.join(photos, '.gitkeep'))).toBe(true);
      // A non-directory collision keeps the live copy, and says so.
      expect(fs.readFileSync(conf, 'utf-8')).toBe('operator-edited');
      expect(job.logs.join('\n')).toContain('preserved existing bind-mount data at "config/app.conf"');
    });

    it('leaves routes and containers untouched when bind discovery fails closed', async () => {
      // REVIEW #2 — discovery ran after deregisterRoutes()/stopSockets(), so a
      // docker failure left the app running but unreachable with no path back.
      const appName = 'discovery-fail-app';
      const state = { head: 'a'.repeat(40), version: '1.0.0' };
      const calls: Array<{ args: string[]; cwd?: string }> = [];
      let failConfig = false;
      const spawn = statefulAppSpawn({
        appName, state, hostPort: 5421, calls, failConfig: () => failConfig,
      });
      const installer = makeInstaller(spawn as typeof successSpawn);
      await installWithLiveState(installer, 'https://github.com/test/discovery-fail-app', appName);

      callbacks.deregistered.length = 0;
      calls.length = 0;
      failConfig = true;
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update(appName), 5000);

      expect(job.status).toBe('failed');
      expect(job.logs.join('\n')).toContain('Cannot safely discover bind mounts');
      // The app was never disturbed: routes still registered, stack still up.
      expect(callbacks.deregistered).not.toContain(appName);
      expect(calls.some((c) => c.args.includes('down'))).toBe(false);
    });

    it('still treats bind discovery as best-effort for backups', async () => {
      // REVIEW #4 — one helper now serves both callers. Backup must stay
      // best-effort ([] on failure) while update fails closed (test above).
      const appName = 'backup-besteffort-app';
      const state = { head: 'a'.repeat(40), version: '1.0.0' };
      let failConfig = false;
      const spawn = statefulAppSpawn({
        appName, state, hostPort: 5422, failConfig: () => failConfig,
      });
      const installer = makeInstaller(spawn as typeof successSpawn);
      const { entry } = await installWithLiveState(
        installer, 'https://github.com/test/backup-besteffort-app', appName,
      );

      failConfig = true;
      const job = await waitForJob(installer, installer.backup(appName), 5000);
      expect(job.status).toBe('completed'); // best-effort: never fails the backup
      expect(job.logs.join('\n')).toContain('0 bind mount(s)');

      // Sanity: with docker healthy the same helper finds both binds.
      failConfig = false;
      const ok = await waitForJob(installer, installer.backup(appName), 5000);
      expect(ok.logs.join('\n')).toContain('2 bind mount(s)');
      expect(ok.logs.join('\n')).toContain('Archiving bind mount "data/photos"');
      expect(entry.installPath).toBeTruthy();
    });

    it('refuses a bind path that traverses a symlink, before creating anything through it', async () => {
      // REVIEW #3 — the guard ran *after* `mkdir -p`, so any directory level
      // below the symlink had already been materialised outside the app dir.
      const appName = 'symlink-app';
      const state = { head: 'a'.repeat(40), version: '1.0.0' };
      const escapeTarget = path.join(tmpDir, 'escape-target');
      fs.mkdirSync(escapeTarget, { recursive: true });
      // `data/media/photos` has a level below `data`, which the release turns
      // into a symlink — `mkdir -p .../data/media` would create it in the target.
      const spawn = jest.fn((cmd: string, args: string[], spawnOpts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${state.head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && spawnOpts?.cwd) {
          fs.writeFileSync(path.join(spawnOpts.cwd, 'app.yaml'), `
apiVersion: apps.getpod.ai/v1
name: ${appName}
version: ${state.version}
commit: "${state.head}"
services:
  app:
    image: postgres:16-alpine
    volumes:
      - ./data/media/photos:/photos
    ports:
      - name: api
        host: 5423
        container: 5423
        type: api
    healthcheck:
      test: pg_isready
      interval: 30s
`.trim(), 'utf-8');
          // Only the *updated* release ships `data` as a symlink out of the app dir.
          if (state.head === 'b'.repeat(40)) {
            fs.symlinkSync(escapeTarget, path.join(spawnOpts.cwd, 'data'));
          }
        }
        if (cmd === 'docker' && args.includes('config') && args.includes('--format') && spawnOpts?.cwd) {
          return {
            stdout: JSON.stringify({ services: { app: { volumes: [
              { type: 'bind', source: path.join(spawnOpts.cwd, 'data', 'media', 'photos') },
            ] } } }),
            stderr: '', status: 0,
          };
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer = makeInstaller(spawn as typeof successSpawn);
      await waitForJob(installer, installer.install({ githubUrl: 'https://github.com/test/symlink-app' }), 5000);
      const entry = (await registry.get(appName))!;
      const photos = path.join(entry.installPath, 'data', 'media', 'photos');
      fs.mkdirSync(photos, { recursive: true });
      fs.writeFileSync(path.join(photos, 'photo.jpg'), 'persisted', 'utf-8');

      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update(appName), 5000);

      expect(job.status).toBe('failed');
      expect(job.logs.join('\n')).toContain('must not be a symlink');
      // Nothing was created through the symlink …
      expect(fs.readdirSync(escapeTarget)).toEqual([]);
      // … and the rollback put the live state back.
      expect(fs.readFileSync(path.join(photos, 'photo.jpg'), 'utf-8')).toBe('persisted');
    });

    it('fails closed when a symlinked app dir hides its own bind sources', async () => {
      // REVIEW #6 — the fallback compared the compose text against the literal
      // app dir only, so a compose anchored to the realpath read as "no bind
      // mounts" and the update proceeded, stranding live state.
      const appName = 'symlinked-dir-app';
      const state = { head: 'a'.repeat(40), version: '1.0.0' };
      let failConfig = false;
      const spawn = statefulAppSpawn({
        appName, state, hostPort: 5424, failConfig: () => failConfig,
      });
      const installer = makeInstaller(spawn as typeof successSpawn);
      const { entry } = await installWithLiveState(
        installer, 'https://github.com/test/symlinked-dir-app', appName,
      );

      // Turn the install path into a symlink whose compose references only the
      // realpath — exactly the shape a local-dev install leaves behind.
      const realDir = path.join(tmpDir, 'symlinked-dir-app-real');
      fs.renameSync(entry.installPath, realDir);
      fs.symlinkSync(realDir, entry.installPath);
      fs.writeFileSync(
        path.join(entry.installPath, 'docker-compose.yml'),
        `services:\n  app:\n    volumes:\n      - ${path.join(realDir, 'data', 'photos')}:/photos\n`,
        'utf-8',
      );

      failConfig = true;
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update(appName), 5000);

      expect(job.status).toBe('failed');
      expect(job.logs.join('\n')).toContain('Cannot safely discover bind mounts');
    });

    it('sweeps stale update scratch dirs at boot, sparing real app dirs', async () => {
      // REVIEW #7 — staging moved beside the install path, so /tmp cleanup no
      // longer collects a checkout left by a crash mid-update.
      const uuid = '11111111-2222-4333-8444-555555555555';
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: makeAppDir(srcDir, 'keep-app') }), 5000);
      const live = (await registry.get('keep-app'))!.installPath;

      const stale = [path.join(appsDir, `.cg-update-keep-app-${uuid}`)];
      const decoys = [
        path.join(appsDir, 'my-old-app'),
        path.join(appsDir, 'cg-update-not-a-uuid'),
      ];
      for (const d of [...stale, ...decoys]) fs.mkdirSync(d, { recursive: true });

      const swept = await installer.sweepStaleUpdateDirs();

      expect(swept.sort()).toEqual([...stale].sort());
      for (const d of stale) expect(fs.existsSync(d)).toBe(false);
      for (const d of decoys) expect(fs.existsSync(d)).toBe(true);
      expect(fs.existsSync(live)).toBe(true);
    });

    it('never sweeps a release snapshot — it can hold the only copy of a bind mount', async () => {
      // The boot sweep deletes with rmrf, which falls back to `sudo rm -rf`.
      // A -failed- dir is kept on purpose when a rollback could not move a bind
      // path back; an -old- dir left by a crash mid-swap still holds the paths
      // that had not moved yet. Sweeping either root-deletes a live database.
      const uuid = '11111111-2222-4333-8444-555555555555';
      const installer = makeInstaller();
      await waitForJob(installer, installer.install({ localPath: makeAppDir(srcDir, 'keep-app') }), 5000);

      const snapshots = [
        path.join(appsDir, `keep-app-old-${uuid}`),
        path.join(appsDir, `keep-app-failed-${uuid}`),
      ];
      for (const d of snapshots) {
        fs.mkdirSync(path.join(d, 'postgres', 'pgdata'), { recursive: true });
        fs.writeFileSync(path.join(d, 'postgres', 'pgdata', 'PG_VERSION'), '16');
      }
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const swept = await installer.sweepStaleUpdateDirs();

      try {
        expect(swept).toEqual([]);
        for (const d of snapshots) {
          expect(fs.existsSync(path.join(d, 'postgres', 'pgdata', 'PG_VERSION'))).toBe(true);
          // Kept silently is how a leak goes unnoticed — it has to be reported.
          expect(warn.mock.calls.some((c) => String(c[0]).includes(d))).toBe(true);
        }
      } finally {
        warn.mockRestore();
      }
    });

    it('keeps relative bind mounts at the permanent path across an update (issue #396)', async () => {
      const githubUrl = 'https://github.com/test/stateful-app';
      const appName = 'stateful-app';
      const state = { head: 'a'.repeat(40), version: '1.0.0' };
      const dockerCalls: Array<{ args: string[]; cwd?: string }> = [];
      const spawn = jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${state.head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          fs.writeFileSync(path.join(opts.cwd, 'app.yaml'), `
apiVersion: apps.getpod.ai/v1
name: ${appName}
version: ${state.version}
commit: "${state.head}"
services:
  app:
    image: postgres:16-alpine
    volumes:
      - ./data/photos:/photos
      - ./postgres/pgdata:/var/lib/postgresql/data
    ports:
      - name: api
        host: 5410
        container: 5410
        type: api
    healthcheck:
      test: pg_isready
      interval: 30s
`.trim(), 'utf-8');
        }
        if (cmd === 'docker') {
          dockerCalls.push({ args, cwd: opts?.cwd });
          if (args.includes('config') && args.includes('--format') && opts?.cwd) {
            return {
              stdout: JSON.stringify({ services: { app: { volumes: [
                { type: 'bind', source: path.join(opts.cwd, 'data', 'photos') },
                { type: 'bind', source: path.join(opts.cwd, 'postgres', 'pgdata') },
              ] } } }),
              stderr: '', status: 0,
            };
          }
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer = makeInstaller(spawn);

      await waitForJob(installer, installer.install({ githubUrl }), 5000);
      const before = await registry.get(appName);
      const pgdata = path.join(before!.installPath, 'postgres', 'pgdata');
      const photos = path.join(before!.installPath, 'data', 'photos');
      fs.mkdirSync(pgdata, { recursive: true });
      fs.mkdirSync(photos, { recursive: true });
      fs.writeFileSync(path.join(pgdata, 'PG_VERSION'), '16');
      fs.writeFileSync(path.join(photos, 'photo.jpg'), 'persisted');

      dockerCalls.length = 0;
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update(appName), 5000);
      expect(job.status).toBe('completed');

      const after = await registry.get(appName);
      expect(after?.installPath).toBe(before?.installPath);
      expect(fs.readFileSync(path.join(pgdata, 'PG_VERSION'), 'utf-8')).toBe('16');
      expect(fs.readFileSync(path.join(photos, 'photo.jpg'), 'utf-8')).toBe('persisted');
      const compose = fs.readFileSync(path.join(after!.installPath, 'docker-compose.yml'), 'utf-8');
      expect(compose).toContain(pgdata);
      expect(compose).toContain(photos);
      expect(compose).not.toContain('cg-update-');
      const updateUp = dockerCalls.find((call) => call.args.includes('up') && call.args.includes('--wait'));
      expect(updateUp?.cwd).toBe(after?.installPath);
    });

    it('rolls back preserved bind mounts when the updated stack cannot start (issue #396)', async () => {
      const githubUrl = 'https://github.com/test/rollback-stateful-app';
      const appName = 'rollback-stateful-app';
      const state = { head: 'a'.repeat(40), version: '1.0.0', failNewUp: false, upCalls: 0 };
      const spawn = jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${state.head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          fs.writeFileSync(path.join(opts.cwd, 'app.yaml'), `
apiVersion: apps.getpod.ai/v1
name: ${appName}
version: ${state.version}
commit: "${state.head}"
services:
  app:
    image: postgres:16-alpine
    volumes:
      - ./postgres/pgdata:/var/lib/postgresql/data
    ports:
      - name: api
        host: 5411
        container: 5411
        type: api
    healthcheck:
      test: pg_isready
      interval: 30s
`.trim(), 'utf-8');
        }
        if (cmd === 'docker' && args.includes('config') && args.includes('--format') && opts?.cwd) {
          return { stdout: JSON.stringify({ services: { app: { volumes: [
            { type: 'bind', source: path.join(opts.cwd, 'postgres', 'pgdata') },
          ] } } }), stderr: '', status: 0 };
        }
        if (cmd === 'docker' && args.includes('up')) {
          state.upCalls += 1;
          if (state.failNewUp && state.upCalls === 1) {
            return { stdout: '', stderr: 'new stack failed', status: 1 };
          }
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer = makeInstaller(spawn);
      await waitForJob(installer, installer.install({ githubUrl }), 5000);
      const before = await registry.get(appName);
      const marker = path.join(before!.installPath, 'postgres', 'pgdata', 'PG_VERSION');
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, '16');

      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      state.failNewUp = true;
      state.upCalls = 0;
      const job = await waitForJob(installer, installer.update(appName), 5000);
      expect(job.status).toBe('failed');
      const after = await registry.get(appName);
      expect(after?.commit).toBe('a'.repeat(40));
      expect(fs.readFileSync(marker, 'utf-8')).toBe('16');
    });

    /**
     * A `build:` service's new image reuses the tag of the one in production,
     * so a failed update leaves that tag on the broken release. Rolling the
     * source back is not enough — the image has to come back too.
     */
    function rollbackImageSpawn(opts: {
      appName: string;
      state: { head: string; version: string; upCalls: number; failNewUp: boolean };
      calls: Array<{ args: string[] }>;
      oldImageId: string;
      tagFails?: boolean;
      ndjson?: boolean;
    }) {
      const { appName, state, calls, oldImageId } = opts;
      return jest.fn((cmd: string, args: string[], spawnOpts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${state.head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && spawnOpts?.cwd) {
          fs.writeFileSync(path.join(spawnOpts.cwd, 'app.yaml'), `
apiVersion: apps.getpod.ai/v1
name: ${appName}
version: ${state.version}
commit: "${state.head}"
services:
  app:
    build: .
    volumes:
      - ./data/photos:/photos
    ports:
      - name: api
        host: 5412
        container: 5412
        type: api
    healthcheck:
      test: exit 0
      interval: 30s
`.trim(), 'utf-8');
        }
        if (cmd !== 'docker') return { stdout: '', stderr: '', status: 0 };
        calls.push({ args });
        if (args.includes('config') && args.includes('--format') && spawnOpts?.cwd) {
          return { stdout: JSON.stringify({ services: { app: { volumes: [
            { type: 'bind', source: path.join(spawnOpts.cwd, 'data', 'photos') },
          ] } } }), stderr: '', status: 0 };
        }
        if (args.includes('images') && args.includes('json')) {
          const row = { ID: oldImageId, Repository: `${appName}-app`, Tag: 'latest' };
          return {
            // Compose has shipped both dialects: a single array, and one object
            // per line.
            stdout: opts.ndjson ? `${JSON.stringify(row)}\n` : JSON.stringify([row]),
            stderr: '', status: 0,
          };
        }
        // `docker image tag <src> <dst>`: preserving the pre-update build, then
        // (on rollback) putting it back. `tagFails` simulates an image the
        // containerd store already dropped.
        if (args[0] === 'image' && args[1] === 'tag') {
          return opts.tagFails
            ? { stdout: '', stderr: 'No such image', status: 1 }
            : { stdout: '', stderr: '', status: 0 };
        }
        if (args.includes('up')) {
          state.upCalls += 1;
          if (state.failNewUp && state.upCalls === 1) {
            return { stdout: '', stderr: 'new stack failed', status: 1 };
          }
        }
        return { stdout: '', stderr: '', status: 0 };
      });
    }

    it('rolls the image back with the source when the updated stack cannot start', async () => {
      const githubUrl = 'https://github.com/test/rollback-image-app';
      const appName = 'rollback-image-app';
      const oldImageId = 'previousgoodrelease0000';
      const state = { head: 'a'.repeat(40), version: '1.0.0', upCalls: 0, failNewUp: false };
      const calls: Array<{ args: string[] }> = [];
      const installer = makeInstaller(
        rollbackImageSpawn({ appName, state, calls, oldImageId }),
      );
      await waitForJob(installer, installer.install({ githubUrl }), 5000);

      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      state.failNewUp = true;
      state.upCalls = 0;
      calls.length = 0;
      const job = await waitForJob(installer, installer.update(appName), 5000);
      expect(job.status).toBe('failed');

      const backupRef = `${appName}-app:cg-rollback-${oldImageId.slice(0, 12)}`;
      const tagIdx = calls.findIndex(
        (c) => c.args[0] === 'image' && c.args[1] === 'tag'
          && c.args[2] === backupRef && c.args[3] === `${appName}-app:latest`,
      );
      expect(tagIdx).toBeGreaterThanOrEqual(0);
      // The rollback `up` must follow the retag, and must not need a rebuild.
      const rollbackUpIdx = calls.findIndex(
        (c, i) => i > tagIdx && c.args.includes('up') && !c.args.includes('--wait'),
      );
      expect(rollbackUpIdx).toBeGreaterThan(tagIdx);
      expect(calls[rollbackUpIdx].args).not.toContain('--build');
      expect(job.logs.some((l) => l.includes('Restored image'))).toBe(true);
    });

    it('drops its rollback tag once the updated stack is up', async () => {
      const githubUrl = 'https://github.com/test/rollback-cleanup-app';
      const appName = 'rollback-cleanup-app';
      const oldImageId = 'previousgoodrelease0000';
      const state = { head: 'a'.repeat(40), version: '1.0.0', upCalls: 0, failNewUp: false };
      const calls: Array<{ args: string[] }> = [];
      const installer = makeInstaller(
        rollbackImageSpawn({ appName, state, calls, oldImageId }),
      );
      await waitForJob(installer, installer.install({ githubUrl }), 5000);

      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      calls.length = 0;
      const job = await waitForJob(installer, installer.update(appName), 5000);
      expect(job.status).toBe('completed');

      const backupRef = `${appName}-app:cg-rollback-${oldImageId.slice(0, 12)}`;
      // Left behind, the extra reference would make the post-update reclaim's
      // `docker image rm <id>` refuse.
      expect(calls.some(
        (c) => c.args[0] === 'image' && c.args[1] === 'rm' && c.args[2] === backupRef,
      )).toBe(true);
    });

    it('reads a line-delimited `compose images` dialect as well as an array', async () => {
      const githubUrl = 'https://github.com/test/rollback-ndjson-app';
      const appName = 'rollback-ndjson-app';
      const oldImageId = 'previousgoodrelease0000';
      const state = { head: 'a'.repeat(40), version: '1.0.0', upCalls: 0, failNewUp: false };
      const calls: Array<{ args: string[] }> = [];
      const installer = makeInstaller(
        rollbackImageSpawn({ appName, state, calls, oldImageId, ndjson: true }),
      );
      await waitForJob(installer, installer.install({ githubUrl }), 5000);

      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      state.failNewUp = true;
      state.upCalls = 0;
      calls.length = 0;
      await waitForJob(installer, installer.update(appName), 5000);

      const backupRef = `${appName}-app:cg-rollback-${oldImageId.slice(0, 12)}`;
      expect(calls.some(
        (c) => c.args[0] === 'image' && c.args[1] === 'tag'
          && c.args[2] === backupRef && c.args[3] === `${appName}-app:latest`,
      )).toBe(true);
    });

    it('rebuilds from the rolled-back source when the previous image is gone', async () => {
      const githubUrl = 'https://github.com/test/rollback-rebuild-app';
      const appName = 'rollback-rebuild-app';
      const state = { head: 'a'.repeat(40), version: '1.0.0', upCalls: 0, failNewUp: false };
      const calls: Array<{ args: string[] }> = [];
      const installer = makeInstaller(
        rollbackImageSpawn({
          appName, state, calls, oldImageId: 'prunedawayimage0000', tagFails: true,
        }),
      );
      await waitForJob(installer, installer.install({ githubUrl }), 5000);

      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      state.failNewUp = true;
      state.upCalls = 0;
      calls.length = 0;
      const job = await waitForJob(installer, installer.update(appName), 5000);
      expect(job.status).toBe('failed');

      const rollbackUp = calls.find(
        (c) => c.args.includes('up') && !c.args.includes('--wait'),
      );
      expect(rollbackUp?.args).toContain('--build');
      expect(job.logs.some((l) => l.includes('could not preserve image'))).toBe(true);
      expect(job.logs.some((l) => l.includes('was not preserved'))).toBe(true);
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

    it('reclaims the old image without a compose-down that tears down the new container (issue #283)', async () => {
      // The cleanup after a successful update must NOT run
      // `compose -p <app> down --rmi all` on the backup dir: `down` selects by
      // the project label, which the freshly-started new stack now shares, so it
      // would remove the *new* container (leaving status 'running' with nothing
      // up). It must instead reclaim only the *old* image via `docker image rm`.
      const githubUrl = 'https://github.com/test/img-app';
      const appName = 'img-app';
      const port = 5405;
      const state = { head: 'a'.repeat(40), version: '1.0.0' };
      const dockerCalls: Array<{ args: string[]; cwd?: string }> = [];

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
          return { stdout: '', stderr: '', status: 0 };
        }
        if (cmd === 'docker') {
          dockerCalls.push({ args, cwd: opts?.cwd });
          // Image inspection runs before/after the directory swap. Distinguish
          // the update's new-stack query by order, not a staging cwd: the fixed
          // stack is intentionally started from the permanent app directory.
          if (args.includes('images') && args.includes('--quiet')) {
            const imagesCalls = dockerCalls.filter((c) => c.args.includes('images') && c.args.includes('--quiet'));
            return { stdout: `${imagesCalls.length >= 2 ? 'sha-new' : 'sha-old'}\n`, stderr: '', status: 0 };
          }
        }
        return { stdout: '', stderr: '', status: 0 };
      });

      const installer = makeInstaller(spawn);
      state.head = 'a'.repeat(40);
      state.version = '1.0.0';
      await waitForJob(installer, installer.install({ githubUrl }), 5000);

      dockerCalls.length = 0; // only inspect update-phase docker calls
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update(appName), 5000);
      expect(job.status).toBe('completed');

      // (a) No compose-down against the post-swap backup dir — the bug that tore
      // down the freshly-started new container.
      const downOnBackup = dockerCalls.filter(
        (c) => c.args.includes('compose') && c.args.includes('down') && (c.cwd ?? '').includes('-old-'),
      );
      expect(downOnBackup).toHaveLength(0);
      // …and no `--rmi`-bearing compose-down anywhere in the update.
      expect(dockerCalls.some((c) => c.args.includes('down') && c.args.includes('--rmi'))).toBe(false);

      // (b) The old image IS reclaimed, and the new stack's image is left alone.
      const imageRmTargets = dockerCalls
        .filter((c) => c.args[0] === 'image' && c.args[1] === 'rm')
        .map((c) => c.args[2]);
      expect(imageRmTargets).toContain('sha-old');
      expect(imageRmTargets).not.toContain('sha-new');
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
  describe('update() — container-owned bind mounts (#406)', () => {
    // rename(2) on a directory needs write permission on the directory itself
    // (the kernel updates its `..` entry), so a data dir the app's container
    // created — postgres leaves pgdata 0700 under its own uid — cannot be moved
    // by the gateway user. Mode 0500 reproduces exactly that for the test user;
    // running as root would bypass the mode bits and prove nothing.
    const runningAsRoot = process.getuid?.() === 0;
    const itAsUser = runningAsRoot ? it.skip : it;
    const PG_BIND = { rel: 'postgres/pgdata', target: '/var/lib/postgresql/data' };
    const locked: string[] = [];

    afterEach(() => {
      // Leave nothing in the OS temp dir that the test user cannot clean up.
      for (const dir of locked.splice(0)) {
        try { fs.chmodSync(dir, 0o700); } catch { /* already gone */ }
      }
    });

    /** Seed the live data dir exactly as postgres initdb leaves it. */
    function seedLockedBind(installPath: string): string {
      const pgdata = path.join(installPath, ...PG_BIND.rel.split('/'));
      fs.mkdirSync(pgdata, { recursive: true });
      fs.writeFileSync(path.join(pgdata, 'PG_VERSION'), '16', 'utf-8');
      fs.chmodSync(pgdata, 0o500);
      locked.push(pgdata);
      return pgdata;
    }

    function setup(appName: string, hostPort: number, extra: {
      failUp?: () => boolean;
      failRootMove?: () => boolean;
      shipExtraBinds?: boolean;
      builtImageId?: string;
    } = {}) {
      const state = { head: 'a'.repeat(40), version: '1.0.0' };
      const calls: Array<{ args: string[]; cwd?: string }> = [];
      const spawn = statefulAppSpawn({
        appName, state, hostPort, calls, extraBinds: [PG_BIND], ...extra,
      });
      return { state, calls, spawn };
    }

    itAsUser('completes the update and keeps the live data, moving it with a root helper', async () => {
      const appName = 'pg-app';
      const { state, calls, spawn } = setup(appName, 5430);
      const installer = makeInstaller(spawn as typeof successSpawn);
      const { entry } = await installWithLiveState(
        installer, 'https://github.com/test/pg-app', appName,
      );
      seedLockedBind(entry.installPath);

      calls.length = 0;
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update(appName), 5000);

      expect(job.status).toBe('completed');
      const updated = await registry.get(appName);
      expect(updated?.version).toBe('2.0.0');
      // The database directory came across intact.
      const moved = path.join(updated!.installPath, ...PG_BIND.rel.split('/'));
      expect(fs.readFileSync(path.join(moved, 'PG_VERSION'), 'utf-8')).toBe('16');
      // …and the escalation was announced, not silent.
      expect(job.logs.join('\n')).toContain('moving it with a root helper container');
    });

    itAsUser('mounts one common ancestor so the helper does a rename, not a copy', async () => {
      // Mounting each parent separately puts the paths on two mount points,
      // where rename(2) fails EXDEV and busybox `mv` degrades to copy+unlink —
      // duplicating a database directory on disk and losing the swap's atomicity.
      const appName = 'pg-mount-app';
      const { state, calls, spawn } = setup(appName, 5431);
      const installer = makeInstaller(spawn as typeof successSpawn);
      const { entry } = await installWithLiveState(
        installer, 'https://github.com/test/pg-mount-app', appName,
      );
      seedLockedBind(entry.installPath);

      calls.length = 0;
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      await waitForJob(installer, installer.update(appName), 5000);

      const mvCalls = calls.filter((c) => c.args[0] === 'run' && c.args.includes('mv'));
      expect(mvCalls).toHaveLength(1);
      const mounts = mvCalls[0].args.filter((a, i) => mvCalls[0].args[i - 1] === '-v');
      expect(mounts).toHaveLength(1);
      const [source, target] = mounts[0].split(':');
      const [from, to] = mvCalls[0].args.slice(-2);
      // Both endpoints resolve inside that one mount — which is what keeps the
      // move a rename. The destination is the live app dir's pgdata; the source
      // is the same path under the swapped-aside previous dir.
      expect(from.startsWith(`${target}/`)).toBe(true);
      expect(to.startsWith(`${target}/`)).toBe(true);
      expect(path.join(source, ...to.slice(target.length + 1).split('/')))
        .toBe(path.join(entry.installPath, ...PG_BIND.rel.split('/')));
      const hostFrom = path.join(source, ...from.slice(target.length + 1).split('/'));
      expect(path.relative(source, hostFrom).split(path.sep)[0]).toContain('-old-');
    });

    itAsUser('does not reach for the helper when the gateway user can rename the path', async () => {
      const appName = 'plain-app';
      const { state, calls, spawn } = setup(appName, 5432);
      const installer = makeInstaller(spawn as typeof successSpawn);
      await installWithLiveState(installer, 'https://github.com/test/plain-app', appName);

      calls.length = 0;
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update(appName), 5000);

      expect(job.status).toBe('completed');
      expect(calls.filter((c) => c.args[0] === 'run' && c.args.includes('mv'))).toHaveLength(0);
    });

    itAsUser('preserves a live data dir it cannot even list when the release ships that path', async () => {
      // A container-owned dir is unreadable as well as unrenamable to the
      // gateway user (postgres leaves pgdata 0700 under its own uid, so the
      // gateway user gets ---). Merging the release's own file into it entry by
      // entry is then impossible; the live data must still win.
      const appName = 'pg-merge-app';
      const { state, spawn } = setup(appName, 5435, { shipExtraBinds: true });
      const installer = makeInstaller(spawn as typeof successSpawn);
      const { entry } = await installWithLiveState(
        installer, 'https://github.com/test/pg-merge-app', appName,
      );
      const pgdata = seedLockedBind(entry.installPath);
      fs.chmodSync(pgdata, 0o000);

      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update(appName), 5000);

      expect(job.status).toBe('completed');
      const moved = path.join((await registry.get(appName))!.installPath, ...PG_BIND.rel.split('/'));
      locked.push(moved);
      fs.chmodSync(moved, 0o700);
      expect(fs.readFileSync(path.join(moved, 'PG_VERSION'), 'utf-8')).toBe('16');
      // The live directory came across whole: it still holds what the installed
      // release left in it, and the *new* release's file inside that path is
      // the thing that gives way.
      expect(fs.existsSync(path.join(moved, 'release-1.0.0.marker'))).toBe(true);
      expect(fs.existsSync(path.join(moved, 'release-2.0.0.marker'))).toBe(false);
      expect(job.logs.join('\n')).toContain(`preserved existing bind-mount data at "${PG_BIND.rel}"`);
    });

    itAsUser('reports a swap failure as a swap failure, not as a container failure', async () => {
      const appName = 'swap-fail-app';
      let helperDown = false;
      const { state, spawn } = setup(appName, 5433, { failRootMove: () => helperDown });
      const installer = makeInstaller(spawn as typeof successSpawn);
      const { entry } = await installWithLiveState(
        installer, 'https://github.com/test/swap-fail-app', appName,
      );
      seedLockedBind(entry.installPath);

      helperDown = true;
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update(appName), 5000);

      expect(job.status).toBe('failed');
      const logs = job.logs.join('\n');
      expect(logs).toContain('Update failed during the directory swap');
      expect(logs).not.toContain('New containers failed');
      // The move never happened, so the previous app dir is whole and the
      // rollback cleaned up after itself.
      const restored = (await registry.get(appName))!.installPath;
      expect(fs.existsSync(path.join(restored, ...PG_BIND.rel.split('/'), 'PG_VERSION'))).toBe(true);
      expect(fs.readdirSync(appsDir).filter((d) => d.includes('-failed-'))).toHaveLength(0);
    });

    itAsUser('keeps the failed dir and refuses to restart when live data cannot be moved back', async () => {
      // The move fix is what puts a container-owned directory on the restore
      // path for the first time. If restore then fails, the old code warned,
      // deleted the only copy with safeRmrf, and reported a clean rollback.
      const appName = 'rollback-loss-app';
      let updating = false;
      // The move out succeeds; the helper is unavailable by the time the
      // rollback needs it to move the data back.
      let helperCalls = 0;
      const { state, calls, spawn } = setup(appName, 5434, {
        failUp: () => updating,
        failRootMove: () => updating && ++helperCalls > 1,
      });
      const installer = makeInstaller(spawn as typeof successSpawn);
      const { entry } = await installWithLiveState(
        installer, 'https://github.com/test/rollback-loss-app', appName,
      );
      seedLockedBind(entry.installPath);

      calls.length = 0;
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      updating = true;
      const job = await waitForJob(installer, installer.update(appName), 5000);

      expect(job.status).toBe('failed');
      const logs = job.logs.join('\n');
      expect(logs).toContain('ROLLBACK FAILED');
      expect(logs).toContain(PG_BIND.rel);

      // The only copy of the data is still on disk, in the kept -failed- dir.
      const failedDirs = fs.readdirSync(appsDir).filter((d) => d.includes('-failed-'));
      expect(failedDirs).toHaveLength(1);
      const kept = path.join(appsDir, failedDirs[0], ...PG_BIND.rel.split('/'));
      locked.push(kept);
      expect(fs.readFileSync(path.join(kept, 'PG_VERSION'), 'utf-8')).toBe('16');

      // And the app was not restarted on the half-restored directory …
      const rollbackUps = calls.filter((c) => c.args[0] === 'compose'
        && c.args.includes('up') && !c.args.includes('--wait'));
      expect(rollbackUps).toHaveLength(0);
      // … so it must not still be advertised as running.
      expect((await registry.get(appName))?.status).toBe('error');
    });

    itAsUser('leaves the image tags on the previous release when it keeps the failed dir', async () => {
      // The recovery the job log prints is "move those paths back, then start
      // the app". Doing that has to bring up the release the restored source
      // actually is: `<app>-<service>:latest` still naming the failed release's
      // build is the crash-loop preserveRunningImages exists to prevent — and
      // with a database, a migration that does not go backwards.
      const appName = 'rollback-image-app';
      const imageId = 'sha256:abcdef0123456789';
      let updating = false;
      let helperCalls = 0;
      const { state, calls, spawn } = setup(appName, 5436, {
        failUp: () => updating,
        failRootMove: () => updating && ++helperCalls > 1,
        builtImageId: imageId,
      });
      const installer = makeInstaller(spawn as typeof successSpawn);
      const { entry } = await installWithLiveState(
        installer, 'https://github.com/test/rollback-image-app', appName,
      );
      seedLockedBind(entry.installPath);

      calls.length = 0;
      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      updating = true;
      const job = await waitForJob(installer, installer.update(appName), 5000);

      expect(job.status).toBe('failed');
      const kept = fs.readdirSync(appsDir).filter((d) => d.includes('-failed-'));
      expect(kept).toHaveLength(1);
      locked.push(path.join(appsDir, kept[0], ...PG_BIND.rel.split('/')));

      const ref = `${appName}-app:latest`;
      const backupRef = `${appName}-app:cg-rollback-${imageId.replace(/^sha256:/, '').slice(0, 12)}`;
      const tagged = calls.filter((c) => c.args[0] === 'image' && c.args[1] === 'tag');
      expect(tagged.map((c) => c.args.slice(2))).toContainEqual([backupRef, ref]);
      // And the private rollback tag must survive: it is the last reference
      // keeping the pre-update image alive for the manual recovery.
      expect(calls.filter((c) => c.args[0] === 'image' && c.args[1] === 'rm'
        && c.args[2] === backupRef)).toHaveLength(0);
      expect(job.logs.join('\n')).toContain('kept for manual recovery');
    });

    itAsUser('names the release files a preserved live directory displaces', async () => {
      // The live copy winning is correct, but the release's own file inside
      // that path (an init.sql, an entrypoint script) is deleted on every
      // update. A warning that does not say which file makes that invisible.
      const appName = 'pg-discard-app';
      const { state, spawn } = setup(appName, 5437, { shipExtraBinds: true });
      const installer = makeInstaller(spawn as typeof successSpawn);
      const { entry } = await installWithLiveState(
        installer, 'https://github.com/test/pg-discard-app', appName,
      );
      const pgdata = seedLockedBind(entry.installPath);
      fs.chmodSync(pgdata, 0o000);

      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      const job = await waitForJob(installer, installer.update(appName), 5000);

      expect(job.status).toBe('completed');
      const moved = path.join((await registry.get(appName))!.installPath, ...PG_BIND.rel.split('/'));
      locked.push(moved);
      expect(job.logs.join('\n')).toContain('"release-2.0.0.marker"');
    });
  });

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

  // ── App-agent lifecycle across an update ───────────────────────────────────
  describe('update() — app-agent lifecycle', () => {
    /** GitHub app whose agent declaration can change (or vanish) per release. */
    function agentUpdateSpawn(
      appName: string,
      port: number,
      state: { head: string; version: string; agentName: string | null },
    ) {
      return jest.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          return { stdout: `${state.head}\tHEAD\n`, stderr: '', status: 0 };
        }
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          const agentBlock = state.agentName === null
            ? ''
            : `\n  agent:\n    path: ./agent\n    name: ${state.agentName}`;
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
`.trim() + agentBlock,
            'utf-8',
          );
          if (state.agentName !== null) {
            fs.mkdirSync(path.join(opts.cwd, 'agent'), { recursive: true });
          }
        }
        return { stdout: '', stderr: '', status: 0 };
      });
    }

    async function installThenUpdate(opts: {
      appName: string;
      port: number;
      firstAgent: string | null;
      secondAgent: string | null;
    }) {
      const state = { head: 'a'.repeat(40), version: '1.0.0', agentName: opts.firstAgent };
      const agentMgr = makeAgentMgr('unrelated-bot'); // nothing conflicts
      const spawn = agentUpdateSpawn(opts.appName, opts.port, state);
      const installer = makeInstallerWithAgent(spawn as unknown as typeof successSpawn, agentMgr);

      const install = await waitForJob(
        installer,
        installer.install({ githubUrl: `https://github.com/test/${opts.appName}` }),
        5000,
      );
      expect(install.status).toBe('completed');
      agentMgr.deleteAgentByName.mockClear();
      agentMgr.upsertAgent.mockClear();

      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      state.agentName = opts.secondAgent;
      const update = await waitForJob(installer, installer.update(opts.appName), 5000);
      return { agentMgr, update };
    }

    it('deregisters the old agent when a release renames it', async () => {
      // REVIEW #A — upsertAgent() keys off the new name, so without an explicit
      // deregistration the old workspace symlink and config entry are orphaned.
      const { agentMgr, update } = await installThenUpdate({
        appName: 'rename-agent-app', port: 5730,
        firstAgent: 'old-bot', secondAgent: 'new-bot',
      });

      expect(update.status).toBe('completed');
      expect(agentMgr.deleteAgentByName).toHaveBeenCalledWith('old-bot');
      expect(agentMgr.upsertAgent).toHaveBeenCalledTimes(1);
      expect(agentMgr.upsertAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agentDeclaration: { path: './agent', name: 'new-bot' } }),
      );
      expect(update.logs.join('\n')).toContain('renamed to "new-bot"');
    });

    it('removes the registration when a release drops its agent', async () => {
      // REVIEW #B — this branch shipped untested; every other update test passes
      // agentManager: undefined, so it never ran.
      const { agentMgr, update } = await installThenUpdate({
        appName: 'drop-agent-app', port: 5731,
        firstAgent: 'old-bot', secondAgent: null,
      });

      expect(update.status).toBe('completed');
      expect(agentMgr.deleteAgentByName).toHaveBeenCalledWith('old-bot');
      expect(agentMgr.upsertAgent).not.toHaveBeenCalled();
      expect(update.logs.join('\n')).toContain('Agent "old-bot" removed');
      expect((await registry.get('drop-agent-app'))?.agentDeclaration ?? null).toBeNull();
    });

    it('never deregisters when the agent name is unchanged', async () => {
      // Guard against over-deleting: the ordinary update must not touch the
      // registration it is about to re-upsert.
      const { agentMgr, update } = await installThenUpdate({
        appName: 'same-agent-app', port: 5732,
        firstAgent: 'same-bot', secondAgent: 'same-bot',
      });

      expect(update.status).toBe('completed');
      expect(agentMgr.deleteAgentByName).not.toHaveBeenCalled();
      expect(agentMgr.upsertAgent).toHaveBeenCalledTimes(1);
    });

    it('restores MEMORY.md under the new name, after the rename is registered', async () => {
      // restoreMemory() resolves the workspace through config.json, so writing
      // it before upsertAgent silently dropped the memory on a rename.
      const state = { head: 'a'.repeat(40), version: '1.0.0', agentName: 'old-bot' as string | null };
      const agentMgr = makeAgentMgr('unrelated-bot');
      agentMgr.backupMemory.mockReturnValue('remembered');
      const spawn = agentUpdateSpawn('memory-agent-app', 5733, state);
      const installer = makeInstallerWithAgent(spawn as unknown as typeof successSpawn, agentMgr);

      await waitForJob(
        installer,
        installer.install({ githubUrl: 'https://github.com/test/memory-agent-app' }),
        5000,
      );
      // The install already called upsertAgent — compare ordering within the
      // update alone, not against that first registration.
      agentMgr.upsertAgent.mockClear();
      agentMgr.restoreMemory.mockClear();

      state.head = 'b'.repeat(40);
      state.version = '2.0.0';
      state.agentName = 'new-bot';
      const update = await waitForJob(installer, installer.update('memory-agent-app'), 5000);

      expect(update.status).toBe('completed');
      expect(agentMgr.restoreMemory).toHaveBeenCalledWith('new-bot', 'remembered');
      expect(agentMgr.restoreMemory.mock.invocationCallOrder[0])
        .toBeGreaterThan(agentMgr.upsertAgent.mock.invocationCallOrder[0]);
    });
  });

  // ── Agent-name conflict / orphan reclaim (issue #263) ──────────────────────
  describe('install — agent-name conflict vs orphan reclaim', () => {
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
    // A genuine crash under `restart: no`: a non-signal, non-zero exit. (137/143
    // are stop-signal kills and map to `stopped`, not `error` — see #316.)
    const crashedPs = JSON.stringify({ State: 'exited', ExitCode: 1 });

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
      // A real crash under `restart: no` (non-signal, non-zero exit) is error.
      expect(mapContainerStatesToAppStatus([{ state: 'exited', exitCode: 1 }])).toBe('error');
      expect(mapContainerStatesToAppStatus([{ state: 'dead', exitCode: 0 }])).toBe('error');
      expect(mapContainerStatesToAppStatus([{ state: 'exited', exitCode: 0 }])).toBe('stopped');
      expect(mapContainerStatesToAppStatus([{ state: 'created', exitCode: 0 }])).toBe('stopped');
    });

    // ─── #316: an explicit Stop that force-kills a container must read `stopped` ──
    it('treats a signal-killed (137/143) exited container as stopped, not error', () => {
      // `docker compose stop` SIGKILLs (137) / SIGTERMs (143) a container that
      // doesn't self-terminate in the grace period — the normal result of a stop,
      // not a crash. Previously these mapped the app to `error` (bug #316).
      expect(mapContainerStatesToAppStatus([{ state: 'exited', exitCode: 137 }])).toBe('stopped');
      expect(mapContainerStatesToAppStatus([{ state: 'exited', exitCode: 143 }])).toBe('stopped');
      // The exact repro: app+db exit cleanly, the stubborn agent is SIGKILLed.
      expect(
        mapContainerStatesToAppStatus([
          { state: 'exited', exitCode: 0 },
          { state: 'exited', exitCode: 0 },
          { state: 'exited', exitCode: 137 },
        ]),
      ).toBe('stopped');
      // A genuine crash sitting alongside a signal-kill still surfaces as error.
      expect(
        mapContainerStatesToAppStatus([
          { state: 'exited', exitCode: 137 },
          { state: 'exited', exitCode: 1 },
        ]),
      ).toBe('error');
    });

    // ─── #312: crash-loop must not read as `running` ──────────────────────────
    it('parses the restarting exit code out of the Status string', () => {
      // Docker leaves ExitCode=0 while restarting; the real code is only in Status.
      const ndjson = [
        JSON.stringify({ State: 'restarting', ExitCode: 0, Status: 'Restarting (1) 3 seconds ago' }),
        JSON.stringify({
          State: 'restarting',
          ExitCode: 0,
          Status: 'Restarting (0) Less than a second ago',
        }),
        JSON.stringify({ State: 'running', ExitCode: 0, Status: 'Up 2 minutes' }),
      ].join('\n');
      expect(parseComposePs(ndjson)).toEqual([
        { state: 'restarting', exitCode: 0, restartExitCode: 1 },
        { state: 'restarting', exitCode: 0, restartExitCode: 0 },
        { state: 'running', exitCode: 0 },
      ]);
    });

    it('reports a crash-looping (restarting after non-zero exit) container as error', () => {
      // The regression: a single container endlessly restarting on exit 1.
      expect(
        mapContainerStatesToAppStatus([
          { state: 'restarting', exitCode: 0, restartExitCode: 1 },
        ]),
      ).toBe('error');
      // The issue's live scenario: db + app both crash-looping.
      expect(
        mapContainerStatesToAppStatus([
          { state: 'restarting', exitCode: 0, restartExitCode: 1 },
          { state: 'restarting', exitCode: 0, restartExitCode: 1 },
        ]),
      ).toBe('error');
      // A crash-looping dependency wins over a healthy sibling — surface the fault.
      expect(
        mapContainerStatesToAppStatus([
          { state: 'running', exitCode: 0 },
          { state: 'restarting', exitCode: 0, restartExitCode: 1 },
        ]),
      ).toBe('error');
    });

    it('keeps a clean/transient restart reported as running (no false error)', () => {
      // Clean exit (0) being restarted by `restart: always` — still healthy.
      expect(
        mapContainerStatesToAppStatus([
          { state: 'restarting', exitCode: 0, restartExitCode: 0 },
        ]),
      ).toBe('running');
      // Restarting with no parseable code (first instant) falls back to running.
      expect(mapContainerStatesToAppStatus([{ state: 'restarting', exitCode: 0 }])).toBe('running');
    });
  });

  // ─── Docker housekeeping (#302) ─────────────────────────────────────────────
  describe('Docker housekeeping (#302)', () => {
    /** A spawn mock that records every call and always succeeds. */
    function recordingSpawn() {
      return jest.fn((_cmd: string, _args: string[], _opts?: object) => ({
        stdout: '',
        stderr: '',
        status: 0,
      }));
    }

    /** All docker arg-arrays recorded by a spawn mock. */
    function dockerArgs(spy: ReturnType<typeof recordingSpawn>): string[][] {
      return spy.mock.calls
        .filter((c) => c[0] === 'docker')
        .map((c) => c[1] as string[]);
    }

    function makeHkInstaller(
      spawnFn: ReturnType<typeof recordingSpawn>,
      hk?: ConstructorParameters<typeof AppInstaller>[7],
    ) {
      return new AppInstaller(
        registry,
        new RegistryClient(),
        callbacks,
        spawnFn,
        appsDir,
        undefined,
        successAsyncSpawn as unknown as ConstructorParameters<typeof AppInstaller>[6],
        hk,
      );
    }

    // Regression (proven-red): the current code issues NO prune after a build.
    it('prunes build cache + dangling images after a successful install (default config)', async () => {
      const appDir = makeAppDir(srcDir, 'hk-app');
      const spawn = recordingSpawn();
      const installer = makeHkInstaller(spawn);
      const job = await waitForJob(installer, installer.install({ localPath: appDir }), 5000);
      expect(job.status).toBe('completed');

      const args = dockerArgs(spawn);
      // build-cache prune, time-filtered to the default 168h window
      expect(args).toContainEqual(['builder', 'prune', '-f', '--filter', 'until=168h']);
      // dangling-image prune — the SAFE subset, never `-a`
      expect(args).toContainEqual(['image', 'prune', '-f']);
    });

    // Safety floor — the destructive flags must appear NOWHERE.
    it('never issues -a prune, system prune, or any volume prune', async () => {
      const appDir = makeAppDir(srcDir, 'hk-safe');
      const spawn = recordingSpawn();
      const installer = makeHkInstaller(spawn);
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      const args = dockerArgs(spawn);
      const has = (pred: (a: string[]) => boolean) => args.some(pred);
      // no `prune -a` anywhere (builder or image)
      expect(has((a) => a.includes('prune') && a.includes('-a'))).toBe(false);
      // no `docker system prune`
      expect(has((a) => a.includes('system') && a.includes('prune'))).toBe(false);
      // no automatic `docker volume prune`
      expect(has((a) => a.includes('volume') && a.includes('prune'))).toBe(false);
    });

    it('honors the configured build-cache window', async () => {
      const appDir = makeAppDir(srcDir, 'hk-window');
      const spawn = recordingSpawn();
      const installer = makeHkInstaller(spawn, { buildCacheMaxAgeHours: 24 });
      await waitForJob(installer, installer.install({ localPath: appDir }), 5000);

      const args = dockerArgs(spawn);
      expect(args).toContainEqual(['builder', 'prune', '-f', '--filter', 'until=24h']);
    });

    it('issues zero prune calls when the feature is fully disabled', async () => {
      const appDir = makeAppDir(srcDir, 'hk-off');
      const spawn = recordingSpawn();
      const installer = makeHkInstaller(spawn, {
        buildCachePrune: false,
        danglingImagePrune: false,
      });
      const job = await waitForJob(installer, installer.install({ localPath: appDir }), 5000);
      expect(job.status).toBe('completed');

      const args = dockerArgs(spawn);
      expect(args.some((a) => a.includes('prune'))).toBe(false);
    });

    it('is best-effort: a prune failure never fails the install', async () => {
      const appDir = makeAppDir(srcDir, 'hk-besteffort');
      // Fail specifically on any `prune` command; everything else succeeds.
      const spawn = jest.fn((_cmd: string, args: string[], _opts?: object) => {
        if (args.includes('prune')) {
          return { stdout: '', stderr: 'mocked prune failure', status: 1 };
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer = makeHkInstaller(spawn as unknown as ReturnType<typeof recordingSpawn>);
      const job = await waitForJob(installer, installer.install({ localPath: appDir }), 5000);
      expect(job.status).toBe('completed');
      // the prune WAS attempted (proving the best-effort path executed)
      expect(dockerArgs(spawn as unknown as ReturnType<typeof recordingSpawn>)
        .some((a) => a.includes('prune'))).toBe(true);
    });

    it('housekeepingReport() returns a read-only report and issues no prune', () => {
      const spawn = jest.fn((_cmd: string, args: string[], _opts?: object) => {
        if (args.includes('df')) {
          return { stdout: 'Images\t0B\nBuild Cache\t1.457GB\nLocal Volumes\t170MB\n', stderr: '', status: 0 };
        }
        if (args.includes('volume') && args.includes('ls')) {
          return { stdout: 'orphan_a\norphan_b\n', stderr: '', status: 0 };
        }
        if (args.includes('image') && args.includes('ls')) {
          return { stdout: 'sha_1\nsha_2\nsha_3\n', stderr: '', status: 0 };
        }
        return { stdout: '', stderr: '', status: 0 };
      });
      const installer = makeHkInstaller(spawn as unknown as ReturnType<typeof recordingSpawn>);

      const report = installer.housekeepingReport();
      expect(report.buildCacheReclaimable).toBe('1.457GB');
      expect(report.danglingImageCount).toBe(3);
      expect(report.orphanVolumes).toEqual(['orphan_a', 'orphan_b']);

      // report is read-only — no prune of any kind
      const args = dockerArgs(spawn as unknown as ReturnType<typeof recordingSpawn>);
      expect(args.some((a) => a.includes('prune'))).toBe(false);
    });

    it('housekeepingPrune() runs the safe reclaim only (build cache + dangling)', () => {
      const spawn = recordingSpawn();
      const installer = makeHkInstaller(spawn);

      const result = installer.housekeepingPrune();
      expect(result.mode).toBe('prune');
      expect(result.pruned).toEqual({ buildCache: true, danglingImages: true });

      const args = dockerArgs(spawn);
      expect(args).toContainEqual(['builder', 'prune', '-f', '--filter', 'until=168h']);
      expect(args).toContainEqual(['image', 'prune', '-f']);
      // safety floor holds for the manual path too
      expect(args.some((a) => a.includes('prune') && a.includes('-a'))).toBe(false);
      expect(args.some((a) => a.includes('system') && a.includes('prune'))).toBe(false);
      expect(args.some((a) => a.includes('volume') && a.includes('prune'))).toBe(false);
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
