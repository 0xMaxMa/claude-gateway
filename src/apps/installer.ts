import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SpawnSyncOptionsWithStringEncoding, spawnSync, spawn } from 'node:child_process';
import { AppsRegistry, AppEntry, PortEntry } from './registry';
import { RegistryClient, RegistryVersion } from './registry-client';
import {
  parseAppYaml,
  generateCompose,
  ComposePort,
  ComposeSocket,
} from './compose-generator';
import { AgentManager } from './agent-manager';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InstallOptions {
  /** Registry app name (Mode A — registry install) */
  registryApp?: string;
  /** Registry version (defaults to latest) */
  version?: string;
  /** GitHub URL (Mode A — custom GitHub install) */
  githubUrl?: string;
  /** 40-char hex commit (required for githubUrl) */
  commit?: string;
  /** Local path within ~/.claude-gateway/apps/ (Mode B — pre-baked) */
  localPath?: string;
  /** Pre-supplied env vars (secrets that would otherwise be prompted) */
  envVars?: Record<string, string>;
}

export interface InstallResult {
  appName: string;
  proxyUrls: Record<string, string>; // portName → /app/<name>/<port>/
  secretKeys: string[];
  agentDeclaration?: { path: string; name: string } | null;
}

export interface JobState {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  logs: string[];
  result?: InstallResult;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

export interface InstallerCallbacks {
  registerRoutes(appName: string, ports: ComposePort[]): void;
  deregisterRoutes(appName: string): void;
  startSocket(socketPath: string, socket: ComposeSocket, scripts: Record<string, ScriptConfig>, appDir: string): Promise<void>;
  stopSockets(appName: string): void;
  reinitializeAgent?(agentName: string): Promise<void>;
}

export interface ScriptConfig {
  path: string;
  timeout: string;
  args?: Array<{ name: string; type: string; pattern?: string }>;
}

type SpawnFn = (
  cmd: string,
  args: string[],
  opts?: SpawnSyncOptionsWithStringEncoding,
) => { stdout: string; stderr: string; status: number | null };

/**
 * Async (non-blocking) command runner used by the boot-time container restore.
 * Unlike {@link SpawnFn} (spawnSync — freezes the event loop for the command's
 * whole duration), this returns a Promise so a slow `compose up --wait` can run
 * in the background while the gateway keeps serving Telegram/cron/other apps.
 */
type AsyncSpawnFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; status: number | null }>;

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_APPS_DIR = path.join(os.homedir(), '.claude-gateway', 'apps');
// Per-app ceiling for the boot-time `compose up --wait` during restore. Runs in
// the background (non-blocking), so this only bounds how long a hung container
// keeps its child process alive — not the gateway's responsiveness. Shorter than
// the install path's 600s because restore images are already built (no pull/build).
const RESTORE_COMPOSE_TIMEOUT_MS = 180_000;
// Max apps brought up concurrently during boot restore. Bounds the docker/CPU
// spike when many apps are marked running, while still parallelising the common
// case. Typical installs have 1-3 apps, so this rarely binds.
const RESTORE_MAX_CONCURRENCY = 4;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
// Disallow '..' in owner/repo segments — prevents path traversal via edge-case git URL parsing.
const GITHUB_URL_RE = /^https:\/\/github\.com\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*(\.git)?$/;

// ─── Installer ────────────────────────────────────────────────────────────────

export class AppInstaller {
  private readonly jobs = new Map<string, JobState>();
  private readonly appsDir: string;
  /** Tracks app names currently being installed to prevent concurrent installs of the same name. */
  private readonly installingNames = new Set<string>();

  constructor(
    private readonly registry: AppsRegistry,
    private readonly registryClient: RegistryClient,
    private readonly callbacks: InstallerCallbacks,
    private readonly spawn: SpawnFn = defaultSpawn,
    appsDir?: string,
    private readonly agentManager?: AgentManager,
    private readonly spawnAsync: AsyncSpawnFn = defaultAsyncSpawn,
  ) {
    this.appsDir = appsDir ?? DEFAULT_APPS_DIR;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Start an async install job. Returns jobId immediately. */
  install(options: InstallOptions): string {
    this.pruneOldJobs();

    // Check synchronously before spawning async job to prevent races
    const tentativeName = options.registryApp ?? options.githubUrl ?? options.localPath ?? 'unknown';
    if (this.installingNames.has(tentativeName)) {
      throw new Error(`App "${tentativeName}" is already being installed`);
    }
    this.installingNames.add(tentativeName);

    const jobId = crypto.randomUUID();
    const job: JobState = {
      id: jobId,
      status: 'pending',
      logs: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(jobId, job);

    // Run in background — no await
    void this.runInstall(job, options).catch((err: unknown) => {
      this.failJob(job, err instanceof Error ? err.message : String(err));
    }).finally(() => {
      this.installingNames.delete(tentativeName);
    });

    return jobId;
  }

  getJob(jobId: string): JobState | undefined {
    return this.jobs.get(jobId);
  }

  /** Start an async update job. Returns jobId immediately. */
  update(appName: string): string {
    this.pruneOldJobs();

    if (this.installingNames.has(appName)) {
      throw new Error(`App "${appName}" is already being installed or updated`);
    }
    this.installingNames.add(appName);

    const jobId = crypto.randomUUID();
    const job: JobState = {
      id: jobId,
      status: 'pending',
      logs: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(jobId, job);

    void this.runUpdate(job, appName).catch((err: unknown) => {
      this.failJob(job, err instanceof Error ? err.message : String(err));
    }).finally(() => {
      this.installingNames.delete(appName);
    });

    return jobId;
  }

  async uninstall(appName: string): Promise<void> {
    const entry = await this.registry.get(appName);

    // Orphaned install: directory exists on disk but not in registry — clean up filesystem only
    if (!entry) {
      const orphanDir = path.join(this.appsDir, appName);
      if (!fs.existsSync(orphanDir)) {
        throw new Error(`App "${appName}" is not installed`);
      }
      const stat = fs.lstatSync(orphanDir);
      const resolvedDir = stat.isSymbolicLink() ? fs.realpathSync(orphanDir) : orphanDir;

      // Bring down any running containers before touching the filesystem
      const orphanCompose = path.join(resolvedDir, 'docker-compose.yml');
      if (fs.existsSync(orphanCompose)) {
        try { this.run(['docker', 'compose', '-p', appName, 'down', '--rmi', 'all'], resolvedDir, 120_000); }
        catch { /* best-effort — proceed with cleanup regardless */ }
      }

      if (stat.isSymbolicLink()) {
        fs.unlinkSync(orphanDir);
      } else {
        this.rmrf(orphanDir);
      }
      return;
    }

    const appDir = entry.installPath;

    // docker compose down --rmi all (graceful fallback if dir is already gone)
    if (fs.existsSync(appDir)) {
      try {
        this.run(['docker', 'compose', '-p', appName, 'down', '--rmi', 'all'], appDir, 120_000);
      } catch { /* best-effort — continue cleanup */ }
    } else {
      // Dir gone — stop containers by project label only (no compose file needed, no --rmi all)
      try {
        this.run(['docker', 'compose', '-p', appName, 'down'], os.tmpdir(), 120_000);
      } catch { /* best-effort */ }
    }

    // Remove proxy routes + sockets
    this.callbacks.deregisterRoutes(appName);
    this.callbacks.stopSockets(appName);

    // Remove agent symlink + config.json entry if this was an agent app
    if (this.agentManager) {
      await this.agentManager.deleteAgent(entry);
    }

    // Remove app files — symlink only for local-dev installs, full rmrf for cloned installs
    let appDirStat: fs.Stats | null = null;
    try { appDirStat = fs.lstatSync(appDir); } catch { /* already gone */ }
    if (appDirStat) {
      if (appDirStat.isSymbolicLink()) {
        fs.unlinkSync(appDir);
      } else {
        this.rmrf(appDir);
      }
    }

    await this.registry.remove(appName);
  }

  async startStopRestart(
    appName: string,
    action: 'start' | 'stop' | 'restart',
  ): Promise<void> {
    const entry = await this.registry.get(appName);
    if (!entry) throw new Error(`App "${appName}" is not installed`);

    if (action === 'stop') {
      this.run(['docker', 'compose', '-p', appName, 'stop'], entry.installPath, 60_000);
      await this.registry.updateStatus(appName, 'stopped');
    } else {
      // start / restart: stop conflicting containers and wait for healthcheck
      this.composeUp(appName, entry.installPath);
      await this.registry.updateStatus(appName, 'running');
    }
  }

  /**
   * Bring up containers for every app marked `running` in the registry.
   *
   * Compose has no host-reboot restart policy here, so after the gateway (or
   * its host) restarts, an app's proxy route is restored but its containers are
   * not running — leaving the route live while the upstream port is dead
   * (ECONNREFUSED). This re-runs `compose up -d --wait` for each running app to
   * close that gap. It is idempotent: already-healthy containers return fast.
   *
   * Runs fully async and non-blocking: each app is brought up via {@link
   * composeUpAsync} (a real child process, not spawnSync), with up to
   * {@link RESTORE_MAX_CONCURRENCY} apps in flight at once. The caller (boot)
   * does NOT await this before wiring routes, so the gateway stays responsive
   * throughout — at the cost of a brief ECONNREFUSED window per app until its
   * `--wait` completes, which self-heals within seconds.
   *
   * Best-effort and non-fatal — a failure for one app is collected and the rest
   * still proceed, so one broken app cannot block the others or gateway startup.
   * Returns the apps that failed to start (and the count attempted, for logging).
   */
  async restoreRunningApps(): Promise<{ attempted: number; failures: Array<{ app: string; error: string }> }> {
    const apps = await this.registry.list();
    const running = apps.filter((e) => e.status === 'running');
    const failures: Array<{ app: string; error: string }> = [];

    // Bounded-concurrency worker pool: workers pull from a shared cursor until
    // the list is drained, so at most RESTORE_MAX_CONCURRENCY compose-ups run at
    // once. push() is safe across workers — JS is single-threaded between awaits.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < running.length) {
        const entry = running[cursor++];
        try {
          await this.composeUpAsync(entry.name, entry.installPath);
        } catch (err) {
          failures.push({ app: entry.name, error: (err as Error).message });
        }
      }
    };
    const poolSize = Math.min(RESTORE_MAX_CONCURRENCY, running.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    return { attempted: running.length, failures };
  }

  // ─── Internal install pipeline ────────────────────────────────────────────

  private async runInstall(job: JobState, options: InstallOptions): Promise<void> {
    job.status = 'running';
    job.updatedAt = Date.now();

    const tentativeName = options.registryApp ?? options.githubUrl ?? options.localPath ?? 'unknown';
    const { localPath } = options;

    // ── Resolve app dir and commit ────────────────────────────────────────
    let appDir: string;
    let appName: string;
    let commit: string;
    let githubUrl: string;
    let source: AppEntry['source'];
    let version = options.version ?? '0.0.0';

    if (localPath) {
      // Mode B — local dev path (symlinked into appsDir)
      const resolved = path.resolve(localPath);
      if (!fs.existsSync(resolved)) {
        throw new Error(`local_path does not exist: "${resolved}"`);
      }
      // Read app.yaml from local path first to get canonical app name
      const localYamlPath = path.join(resolved, 'app.yaml');
      if (!fs.existsSync(localYamlPath)) {
        throw new Error(`app.yaml not found in "${resolved}"`);
      }
      const localYamlContent = fs.readFileSync(localYamlPath, 'utf-8');
      const localAppYaml = parseAppYaml(localYamlContent, resolved);
      appName = localAppYaml.name;
      appDir = path.join(this.appsDir, appName);
      const diskExists = fs.existsSync(appDir);
      const registryEntry = await this.registry.get(appName);

      if (diskExists) {
        if (registryEntry) {
          throw new Error(`App "${appName}" is already installed. Uninstall first.`);
        }
        // Orphaned directory (registry missing) — bring down containers first
        const stat = fs.lstatSync(appDir);
        const resolvedAppDir = stat.isSymbolicLink() ? fs.realpathSync(appDir) : appDir;
        const orphanCompose = path.join(resolvedAppDir, 'docker-compose.yml');
        if (fs.existsSync(orphanCompose)) {
          try { this.run(['docker', 'compose', '-p', appName, 'down', '--rmi', 'all'], resolvedAppDir, 120_000); }
          catch (e) { this.log(job, `Warning: orphan container cleanup failed: ${(e as Error).message}`); }
        }
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(appDir);
        } else {
          this.rmrf(appDir);
        }
        this.log(job, `Removed orphaned app directory for "${appName}"`);
      } else if (registryEntry) {
        // Orphaned registry entry: disk is gone but apps.json still has the app.
        // Clean up before creating symlink so install can proceed.
        await this.registry.remove(appName).catch(() => {});
        this.log(job, `Cleaned up orphaned registry entry for "${appName}"`);
      }

      fs.symlinkSync(resolved, appDir);
      commit = 'local';
      githubUrl = '';
      source = 'local';
      this.log(job, `Symlinked ${resolved} → ${appDir}`);
    } else {
      // Mode A — registry or GitHub
      ({ appName, commit, githubUrl, source, version } = await this.resolveSource(
        job,
        options,
        version,
      ));
      appDir = path.join(this.appsDir, appName);

      // Check for existing install
      if (fs.existsSync(appDir)) {
        const registryEntry = await this.registry.get(appName);
        if (registryEntry) {
          throw new Error(`App "${appName}" is already installed. Use update to upgrade.`);
        }
        // Orphaned directory (registry missing) — bring down containers first
        const orphanCompose = path.join(appDir, 'docker-compose.yml');
        if (fs.existsSync(orphanCompose)) {
          try { this.run(['docker', 'compose', '-p', appName, 'down', '--rmi', 'all'], appDir, 120_000); }
          catch (e) { this.log(job, `Warning: orphan container cleanup failed: ${(e as Error).message}`); }
        }
        this.rmrf(appDir);
        this.log(job, `Removed orphaned app directory for "${appName}"`);
      }

      // Shallow fetch of specific commit — avoids downloading full repo history
      this.log(job, `Cloning ${githubUrl}`);
      fs.mkdirSync(appDir, { recursive: true });
      this.run(['git', 'init'], appDir);
      this.run(['git', 'remote', 'add', 'origin', githubUrl], appDir);
      this.run(['git', 'fetch', '--depth', '1', 'origin', commit], appDir);
      this.run(['git', 'checkout', 'FETCH_HEAD'], appDir);
      this.log(job, `Checked out commit ${commit.slice(0, 8)}`);
    }

    // Track registered agent name for rollback (set after upsertAgent succeeds)
    let registeredAgentName: string | undefined;

    // From here — appDir exists. Wrap in try so any failure cleans it up.
    try {

    // Validate app name from app.yaml matches
    this.log(job, 'Validating app.yaml');
    const yamlContent = fs.readFileSync(path.join(appDir, 'app.yaml'), 'utf-8');
    const appYaml = parseAppYaml(yamlContent, appDir);

    if (!APP_NAME_RE.test(appYaml.name)) {
      throw new Error(`Invalid app name in app.yaml: "${appYaml.name}"`);
    }
    version = appYaml.version;
    // Switch lock to canonical app name (atomic: add canonical before removing tentative)
    appName = appYaml.name;
    if (this.installingNames.has(appName) && appName !== tentativeName) {
      throw new Error(`App "${appName}" is already being installed`);
    }
    this.installingNames.add(appName);
    this.installingNames.delete(tentativeName);

    // Conflict check — app name (atomic with install lock held)
    const existing = await this.registry.get(appName);
    if (existing) {
      if (fs.existsSync(appDir)) {
        throw new Error(`App "${appName}" is already installed`);
      }
      // Orphaned registry entry: disk is gone but apps.json still has the app.
      // Clean up the stale entry so install can proceed cleanly.
      await this.registry.remove(appName).catch(() => {});
      this.log(job, `Cleaned up orphaned registry entry for "${appName}"`);
    }

    // ── Generate docker-compose.yml ───────────────────────────────────────
    this.log(job, 'Generating docker-compose.yml');
    const composePath = path.join(appDir, 'docker-compose.yml');
    const generated = generateCompose(appYaml, appName, appDir, composePath);

    // Conflict check — host port uniqueness across all installed apps
    const installedApps = await this.registry.list();
    const usedHostPorts = new Map<number, string>();
    for (const app of installedApps) {
      for (const port of app.ports) {
        usedHostPorts.set(port.hostPort, app.name);
      }
    }
    for (const port of generated.ports) {
      const owner = usedHostPorts.get(port.hostPort);
      if (owner) {
        throw new Error(
          `Host port ${port.hostPort} (port "${port.name}") is already used by app "${owner}"`,
        );
      }
    }

    // Conflict check — agent name (if app declares an agent), inside install lock
    if (generated.agentDeclaration && this.agentManager) {
      const conflict = await this.agentManager.findAgentByName(generated.agentDeclaration.name);
      if (conflict) {
        throw new Error(
          `Agent name "${generated.agentDeclaration.name}" is already registered — agent name conflict`,
        );
      }
    }

    for (const w of generated.warnings) {
      this.log(job, `Warning: ${w}`);
    }

    // ── Write .env ────────────────────────────────────────────────────────
    this.log(job, 'Writing .env');
    const envVars = options.envVars ?? {};
    const envLines: string[] = [];

    // Inject BASE_PATH for web-type ports
    for (const port of generated.ports) {
      if (port.type === 'web') {
        envVars[`BASE_PATH`] = `/app/${appName}/${port.name}`;
      }
    }

    for (const key of generated.secretKeys) {
      const val = (envVars[key] ?? '').replace(/[\r\n]/g, '');
      envLines.push(`${key}=${val}`);
    }
    // Also write any explicitly provided vars not already declared as secrets
    for (const [k, v] of Object.entries(envVars)) {
      if (!generated.secretKeys.includes(k)) {
        envLines.push(`${k}=${v.replace(/[\r\n]/g, '')}`);
      }
    }

    const envPath = path.join(appDir, '.env');
    try {
      fs.writeFileSync(envPath, envLines.join('\n') + '\n', { mode: 0o600 });
    } catch (err) {
      throw new Error(`Failed to write .env: ${(err as Error).message}`);
    }

    // ── Create socket files ───────────────────────────────────────────────
    // Use homedir so sockets are on the host-mounted volume and visible to remote
    // Docker daemons (e.g. docker-builder DinD) via a shared bind mount.
    const SOCK_DIR = path.join(os.homedir(), '.claude-gateway', 'sockets');
    if (generated.sockets.length > 0) {
      fs.mkdirSync(SOCK_DIR, { recursive: true });
    }
    for (const sock of generated.sockets) {
      const sockPath = sock.hostSocketPath;
      try {
        await this.callbacks.startSocket(sockPath, sock, sock.scripts, appDir);
      } catch (err) {
        throw new Error(`Failed to start socket for service "${sock.service}": ${(err as Error).message}`);
      }
      this.log(job, `Socket ready: ${path.basename(sockPath)}`);
    }

    // ── Register in apps.json (status: building) ──────────────────────────
    this.log(job, 'Registering app');
    const socketMap: Record<string, string> = {};
    for (const s of generated.sockets) {
      socketMap[s.service] = s.hostSocketPath;
    }

    const portEntries: PortEntry[] = generated.ports.map((p) => ({
      name: p.name,
      service: p.service,
      hostPort: p.hostPort,
      containerPort: p.containerPort,
      type: p.type,
      rateLimit: p.rateLimit,
    }));

    // ── Agent path detection + service injection ─────────────────────────
    let agentPaths: AppEntry['agentPaths'];
    if (generated.agentDeclaration && this.agentManager) {
      this.log(job, 'Detecting agent binary paths');
      agentPaths = this.agentManager.detectAgentPaths();
    }

    const entry: AppEntry = {
      name: appName,
      version,
      commit,
      githubUrl,
      installPath: appDir,
      ports: portEntries,
      sockets: socketMap,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'building',
      source,
      ...(generated.agentDeclaration !== null ? { agentDeclaration: generated.agentDeclaration } : {}),
      ...(agentPaths ? { agentPaths } : {}),
    };

    // Inject agent service into docker-compose.yml before build
    if (generated.agentDeclaration && this.agentManager && agentPaths) {
      this.agentManager.injectAgentService(entry);
      this.log(job, `Agent service injected for ${generated.agentDeclaration.name}`);
      // Pre-pull the agent base image so compose up --wait doesn't time out during pull
      this.log(job, 'Pre-pulling agent base image');
      try {
        this.run(['docker', 'pull', 'debian:stable-slim'], appDir, 300_000);
      } catch {
        // non-fatal — compose up will attempt its own pull
      }
    }

    await this.registry.upsert(entry);

    // ── Create agent workspace symlink + config.json entry (before compose up) ──
    // Symlink is created early so it's visible during the container startup wait
    // and so the gateway can hot-reload the agent config while containers spin up.
    if (generated.agentDeclaration && this.agentManager) {
      await this.agentManager.upsertAgent(entry);
      registeredAgentName = generated.agentDeclaration.name;
      this.log(job, `Agent "${generated.agentDeclaration.name}" registered`);
      await this.callbacks.reinitializeAgent?.(generated.agentDeclaration.name);
    }

    try {
      // ── docker compose build ──────────────────────────────────────────────
      this.log(job, 'Building images');
      this.run(['docker', 'compose', '-p', appName, 'build'], appDir, 600_000);

      // ── docker compose up -d ──────────────────────────────────────────────
      this.log(job, 'Starting containers');
      this.composeUp(appName, appDir, job);
    } catch (err) {
      this.log(job, 'Build/start failed — rolling back');
      throw err; // outer catch handles full cleanup
    }

    // ── Update status to running ──────────────────────────────────────────
    await this.registry.updateStatus(appName, 'running');
    this.log(job, 'Containers healthy');

    // ── Register proxy routes ─────────────────────────────────────────────
    this.callbacks.registerRoutes(appName, generated.ports);

    // ── Build result ──────────────────────────────────────────────────────
    const proxyUrls: Record<string, string> = {};
    for (const p of generated.ports) {
      proxyUrls[p.name] = `/app/${appName}/${p.name}/`;
    }

    const result: InstallResult = {
      appName,
      proxyUrls,
      secretKeys: generated.secretKeys,
      agentDeclaration: generated.agentDeclaration,
    };

    job.status = 'completed';
    job.result = result;
    job.updatedAt = Date.now();
    this.log(job, `Install complete: ${JSON.stringify(proxyUrls)}`);
    this.installingNames.delete(appName);

    } catch (err) {
      // Outer rollback: clean up appDir and all registered resources
      this.installingNames.delete(appName);
      this.installingNames.delete(tentativeName);
      await this.registry.remove(appName).catch(() => {});
      if (registeredAgentName && this.agentManager) {
        await this.agentManager.deleteAgentByName(registeredAgentName).catch(() => {});
      }
      this.callbacks.stopSockets(appName);
      this.callbacks.deregisterRoutes(appName);
      try {
        this.run(['docker', 'compose', '-p', appName, 'down', '--rmi', 'all', '--volumes'], appDir, 60_000);
      } catch { /* containers may not have started yet */ }
      try {
        const stat = fs.lstatSync(appDir);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(appDir);
        } else {
          fs.rmSync(appDir, { recursive: true, force: true });
        }
      } catch { /* already gone */ }
      throw err;
    }
  }

  // ─── Update pipeline ──────────────────────────────────────────────────────

  private async runUpdate(job: JobState, appName: string): Promise<void> {
    job.status = 'running';
    job.updatedAt = Date.now();

    const entry = await this.registry.get(appName);
    if (!entry) throw new Error(`App "${appName}" is not installed`);
    if (entry.source !== 'registry') {
      throw new Error('Only registry-installed apps can be updated via this endpoint');
    }

    // Resolve latest version
    const app = await this.registryClient.findApp(appName);
    if (!app) throw new Error(`App "${appName}" not found in registry`);
    const latest = selectLatest(app.versions);
    if (!latest) throw new Error(`No versions available for "${appName}"`);

    if (latest.commit === entry.commit) {
      job.status = 'completed';
      job.result = {
        appName,
        proxyUrls: {},
        secretKeys: [],
        agentDeclaration: entry.agentDeclaration ?? null,
      };
      job.updatedAt = Date.now();
      this.log(job, `Already at latest version ${entry.version}`);
      return;
    }

    this.log(job, `Updating ${appName} from ${entry.version} → ${latest.version}`);

    const tmpDir = path.join(os.tmpdir(), `cg-update-${appName}-${crypto.randomUUID()}`);
    try {
      // ── Shallow fetch of specific commit into tmp dir ─────────────────────
      this.log(job, `Cloning ${app.repo}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      this.run(['git', 'init'], tmpDir);
      this.run(['git', 'remote', 'add', 'origin', app.repo], tmpDir);
      this.run(['git', 'fetch', '--depth', '1', 'origin', latest.commit], tmpDir);
      this.run(['git', 'checkout', 'FETCH_HEAD'], tmpDir);

      const yamlContent = fs.readFileSync(path.join(tmpDir, 'app.yaml'), 'utf-8');
      const appYaml = parseAppYaml(yamlContent, tmpDir);
      const composePath = path.join(tmpDir, 'docker-compose.yml');
      const generated = generateCompose(appYaml, appName, tmpDir, composePath);

      for (const w of generated.warnings) {
        this.log(job, `Warning: ${w}`);
      }

      // ── Copy .env from old install to preserve secrets ───────────────────
      const oldEnvPath = path.join(entry.installPath, '.env');
      if (fs.existsSync(oldEnvPath)) {
        fs.copyFileSync(oldEnvPath, path.join(tmpDir, '.env'));
      }

      // ── Detect agent paths + inject agent service if needed ───────────────
      let agentPaths = entry.agentPaths;
      if (generated.agentDeclaration && this.agentManager && !agentPaths) {
        agentPaths = this.agentManager.detectAgentPaths();
      }

      const newEntry: AppEntry = {
        ...entry,
        version: latest.version,
        commit: latest.commit,
        installPath: tmpDir,
        ...(generated.agentDeclaration !== null ? { agentDeclaration: generated.agentDeclaration } : {}),
        ...(agentPaths ? { agentPaths } : {}),
      };

      if (generated.agentDeclaration && this.agentManager && agentPaths) {
        this.agentManager.injectAgentService(newEntry);
      }

      // ── Build new images in tmp dir ───────────────────────────────────────
      this.log(job, 'Building new images');
      this.run(['docker', 'compose', '-p', appName, 'build'], tmpDir, 600_000);

      // ── Backup MEMORY.md before any disruption ────────────────────────────
      let memoryBackup: string | null = null;
      if (entry.agentDeclaration && this.agentManager) {
        memoryBackup = this.agentManager.backupMemory(entry.agentDeclaration.name);
        if (memoryBackup !== null) {
          this.log(job, 'MEMORY.md backed up');
        }
      }

      // ── Deregister old routes before taking down containers ───────────────
      this.callbacks.deregisterRoutes(appName);
      this.callbacks.stopSockets(appName);

      // ── Bring old containers down (keeps images for rollback) ─────────────
      this.log(job, 'Stopping old containers');
      this.run(['docker', 'compose', '-p', appName, 'down'], entry.installPath, 120_000);

      // ── Start new containers ──────────────────────────────────────────────
      this.log(job, 'Starting new containers');
      try {
        this.composeUp(appName, tmpDir, job);
      } catch (upErr) {
        // Rollback: bring old containers back up from old install path
        this.log(job, 'New containers failed — rolling back to previous version');
        let rollbackFailed = false;
        try {
          this.run(['docker', 'compose', '-p', appName, 'up', '-d'], entry.installPath, 120_000);
          this.callbacks.registerRoutes(appName, entry.ports.map((p) => ({
            name: p.name,
            service: p.service,
            hostPort: p.hostPort,
            containerPort: p.containerPort,
            type: p.type,
            rateLimit: p.rateLimit,
          })));
          await this.registry.updateStatus(appName, 'running');
        } catch (rollbackErr) {
          rollbackFailed = true;
          this.log(job, `ROLLBACK FAILED — app "${appName}" may be in a broken state: ${(rollbackErr as Error).message}`);
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (rollbackFailed) {
          throw new Error(`Update failed and rollback also failed — app "${appName}" may be in a broken state. Check job logs for details.`);
        }
        throw upErr;
      }

      // ── Swap dirs ─────────────────────────────────────────────────────────
      this.log(job, 'Swapping app directories');
      const finalDir = path.join(this.appsDir, appName);
      const oldBackupDir = `${finalDir}-old-${crypto.randomUUID()}`;
      fs.renameSync(finalDir, oldBackupDir);
      fs.renameSync(tmpDir, finalDir);

      // ── Restore MEMORY.md ─────────────────────────────────────────────────
      if (memoryBackup !== null && generated.agentDeclaration && this.agentManager) {
        this.agentManager.restoreMemory(generated.agentDeclaration.name, memoryBackup);
        this.log(job, 'MEMORY.md restored');
      }

      // ── Update registry ───────────────────────────────────────────────────
      const finalEntry: AppEntry = {
        ...newEntry,
        installPath: finalDir,
        updatedAt: new Date().toISOString(),
        status: 'running',
      };
      await this.registry.upsert(finalEntry);

      // ── Re-create agent symlink + config.json entry ───────────────────────
      if (generated.agentDeclaration && this.agentManager) {
        await this.agentManager.upsertAgent(finalEntry);
        this.log(job, `Agent "${generated.agentDeclaration.name}" re-registered`);
        await this.callbacks.reinitializeAgent?.(generated.agentDeclaration.name);
      }

      // ── Re-register proxy routes + sockets ───────────────────────────────
      this.callbacks.registerRoutes(appName, generated.ports);
      for (const sock of generated.sockets) {
        const sockPath = sock.hostSocketPath;
        await this.callbacks.startSocket(sockPath, sock, sock.scripts, finalDir);
      }

      // ── Clean up old backup (best-effort) ─────────────────────────────────
      try {
        this.run(['docker', 'compose', '-p', appName, 'down', '--rmi', 'all'], oldBackupDir, 120_000);
      } catch { /* non-fatal */ }
      fs.rmSync(oldBackupDir, { recursive: true, force: true });

      // ── Build result ──────────────────────────────────────────────────────
      const proxyUrls: Record<string, string> = {};
      for (const p of generated.ports) {
        proxyUrls[p.name] = `/app/${appName}/${p.name}/`;
      }

      job.status = 'completed';
      job.result = {
        appName,
        proxyUrls,
        secretKeys: generated.secretKeys,
        agentDeclaration: generated.agentDeclaration,
      };
      job.updatedAt = Date.now();
      this.log(job, `Update complete → ${latest.version}`);

    } catch (err) {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      throw err;
    }
  }

  private async resolveSource(
    job: JobState,
    options: InstallOptions,
    defaultVersion: string,
  ): Promise<{
    appName: string;
    commit: string;
    githubUrl: string;
    source: AppEntry['source'];
    version: string;
  }> {
    if (options.registryApp) {
      // Registry install
      const ver = await this.registryClient.findVersion(
        options.registryApp,
        options.version ?? '',
      );
      if (!ver && options.version) {
        // Try to find the specific version
        const app = await this.registryClient.findApp(options.registryApp);
        if (!app) throw new Error(`App "${options.registryApp}" not found in registry`);
        const v = app.versions.find((v) => v.version === options.version);
        if (!v) throw new Error(`Version "${options.version}" not found for "${options.registryApp}"`);
        return {
          appName: options.registryApp,
          commit: v.commit,
          githubUrl: app.repo,
          source: 'registry',
          version: v.version,
        };
      }
      if (!ver) {
        // No version specified — use latest
        const app = await this.registryClient.findApp(options.registryApp);
        if (!app) throw new Error(`App "${options.registryApp}" not found in registry`);
        const latest = selectLatest(app.versions);
        if (!latest) throw new Error(`No versions available for "${options.registryApp}"`);
        this.log(job, `Using latest version ${latest.version}`);
        return {
          appName: options.registryApp,
          commit: latest.commit,
          githubUrl: app.repo,
          source: 'registry',
          version: latest.version,
        };
      }
      return {
        appName: options.registryApp,
        commit: ver.ver.commit,
        githubUrl: ver.app.repo,
        source: 'registry',
        version: ver.ver.version,
      };
    }

    if (options.githubUrl) {
      if (!GITHUB_URL_RE.test(options.githubUrl)) {
        throw new Error(`githubUrl must be a valid https://github.com/<owner>/<repo> URL`);
      }
      let commit: string;
      if (options.commit) {
        if (!COMMIT_RE.test(options.commit)) {
          throw new Error(`commit must be a 40-char hex string — branch names are not allowed`);
        }
        commit = options.commit;
      } else {
        // Auto-resolve HEAD commit via git ls-remote
        this.log(job, `Resolving HEAD commit for ${options.githubUrl}`);
        const { stdout } = this.run(['git', 'ls-remote', options.githubUrl, 'HEAD'], process.cwd());
        const match = stdout.trim().match(/^([0-9a-f]{40})\s+HEAD/);
        if (!match) throw new Error(`Could not resolve HEAD commit for ${options.githubUrl}`);
        commit = match[1];
        this.log(job, `Resolved HEAD → ${commit.slice(0, 8)}`);
      }
      const appName = options.githubUrl.split('/').pop()?.replace(/\.git$/, '') ?? 'app';
      return {
        appName,
        commit,
        githubUrl: options.githubUrl,
        source: 'custom',
        version: defaultVersion,
      };
    }

    throw new Error(
      'Install requires one of: registryApp, githubUrl+commit, or localPath',
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Remove a directory recursively. Falls back to `sudo rm -rf` for root-owned files. */
  private rmrf(dirPath: string): void {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        console.warn(`[installer] EACCES removing "${dirPath}" — falling back to sudo rm -rf`);
        this.run(['sudo', 'rm', '-rf', dirPath]);
      } else {
        throw err;
      }
    }
  }

  /**
   * Stop conflicting containers then run `docker compose up -d --wait`.
   * Captures container logs into the job on failure before rethrowing.
   * job is optional — when omitted (e.g. startStopRestart) logs go to stderr.
   */
  private composeUp(appName: string, dir: string, job?: JobState): void {
    this.stopConflictingContainers(appName);
    try {
      this.run(['docker', 'compose', '-p', appName, 'up', '-d', '--wait'], dir, 600_000);
    } catch (upErr) {
      if (job) {
        try {
          const { stdout } = this.run(
            ['docker', 'compose', '-p', appName, 'logs', '--no-color', '--tail=50'],
            dir,
            10_000,
          );
          if (stdout.trim()) {
            for (const line of stdout.trim().split('\n')) {
              this.log(job, `  ${line}`);
            }
          }
        } catch { /* ignore log capture errors */ }
      }
      throw upErr;
    }
  }

  /**
   * Async, non-blocking counterpart of {@link composeUp} for the boot-time
   * restore. Uses the async spawn seam so a slow `--wait` never freezes the
   * event loop. Skips {@link stopConflictingContainers} on purpose: that guards
   * dev-time port clashes during install/update, but after a host reboot nothing
   * is running (the very reason this restore exists), so there is nothing to
   * conflict with — and keeping it out avoids extra synchronous docker calls.
   */
  private async composeUpAsync(appName: string, dir: string): Promise<void> {
    await this.runAsync(
      ['docker', 'compose', '-p', appName, 'up', '-d', '--wait'],
      dir,
      RESTORE_COMPOSE_TIMEOUT_MS,
    );
  }

  /** Async equivalent of {@link run}: throws on non-zero exit. */
  private async runAsync(args: string[], cwd?: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
    const result = await this.spawnAsync(args[0], args.slice(1), { cwd, timeoutMs });
    if (result.status !== 0) {
      const errDetail = (result.stderr.trim() || result.stdout.trim()).slice(-2000);
      throw new Error(`Command failed: ${args[0]} ${args[1]} — ${errDetail}`);
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  /** Evict terminal jobs older than 24 hours to bound memory growth. */
  private pruneOldJobs(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if ((job.status === 'completed' || job.status === 'failed') && job.updatedAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  /**
   * Stop and remove any containers whose name matches `${appName}-*` but belong
   * to a different compose project. Prevents "container name already in use" when
   * the same app was previously started from a different path/project name.
   */
  private stopConflictingContainers(appName: string): void {
    let output: string;
    try {
      const result = this.run(
        ['docker', 'ps', '-a',
          '--filter', `name=^${appName}-`,
          '--format', '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}'],
        os.tmpdir(),
        15_000,
      );
      output = result.stdout.trim();
    } catch {
      return;
    }
    if (!output) return;

    for (const line of output.split('\n')) {
      const parts = line.split('\t');
      const id = parts[0];
      const project = parts[2];
      if (!id || !project || project === appName) continue;
      try { this.run(['docker', 'stop', id], os.tmpdir(), 15_000); } catch { /* ignore */ }
      try { this.run(['docker', 'rm', id], os.tmpdir(), 15_000); } catch { /* ignore */ }
    }
  }

  private run(
    args: string[],
    cwd?: string,
    timeoutMs = 30_000,
  ): { stdout: string; stderr: string } {
    const opts: SpawnSyncOptionsWithStringEncoding = {
      encoding: 'utf-8',
      timeout: timeoutMs,
      ...(cwd ? { cwd } : {}),
    };
    const result = this.spawn(args[0], args.slice(1), opts);
    if (result.status !== 0) {
      const errDetail = (result.stderr.trim() || result.stdout.trim()).slice(-2000);
      throw new Error(
        `Command failed: ${args[0]} ${args[1]} — ${errDetail}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  private log(job: JobState, message: string): void {
    job.logs.push(`[${new Date().toISOString()}] ${message}`);
    job.updatedAt = Date.now();
  }

  private failJob(job: JobState, error: string): void {
    job.status = 'failed';
    job.error = error;
    job.updatedAt = Date.now();
    this.log(job, `FAILED: ${error}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Select the latest version from a registry versions array.
 * Sorts by approved_at (ISO string comparison is correct for ISO dates).
 * Falls back to last array element when approved_at is absent.
 */
function selectLatest(versions: RegistryVersion[]): RegistryVersion | undefined {
  if (versions.length === 0) return undefined;
  const withDate = versions.filter((v) => v.approved_at);
  if (withDate.length > 0) {
    return withDate.reduce((a, b) => (a.approved_at > b.approved_at ? a : b));
  }
  return versions[versions.length - 1];
}

// ─── Default spawn implementation ─────────────────────────────────────────────

function defaultSpawn(
  cmd: string,
  args: string[],
  opts?: SpawnSyncOptionsWithStringEncoding,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(cmd, args, {
    encoding: 'utf-8',
    ...opts,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

/**
 * Async spawn used by the boot-time restore. Buffers stdout/stderr and resolves
 * with the exit status (never rejects on a non-zero exit — the caller maps that
 * to a failure). On timeout the child is SIGKILLed and the promise rejects.
 *
 * NOTE on timeout semantics for `docker compose up --wait`: SIGKILL kills the
 * `docker compose` CLI process we spawned, NOT the containers. dockerd keeps
 * bringing them up in the background, so a timeout means "we stopped waiting on
 * the healthcheck", not "the start was cancelled" — the app may well come up
 * healthy moments later. That's acceptable for restore: we only abandon the
 * blocking wait, the container lifecycle is owned by dockerd regardless.
 */
function defaultAsyncSpawn(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    };
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          // SIGKILL the compose CLI; dockerd keeps starting the containers.
          child.kill('SIGKILL');
          fail(new Error(`Command timed out after ${opts.timeoutMs}ms: ${cmd} ${args[0] ?? ''}`));
        }, opts.timeoutMs)
      : null;
    // setEncoding uses an internal StringDecoder so multi-byte characters split
    // across chunk boundaries are decoded correctly. Stream 'error's (rare) are
    // routed to the same reject path so they never surface as uncaught.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { stdout += d; });
    child.stderr?.on('data', (d: string) => { stderr += d; });
    child.stdout?.on('error', fail);
    child.stderr?.on('error', fail);
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, status: code });
    });
  });
}
