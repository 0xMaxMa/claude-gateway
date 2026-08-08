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
  generateSecretValue,
  ComposePort,
  ComposeSocket,
  GeneratedKey,
  GeneratedCompose,
  AgentDeclaration,
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
  /** Host-port overrides per port name (default host comes from app.yaml) */
  portOverrides?: Record<string, number>;
}

/** Options for {@link AppInstaller.reconfigure}. */
export interface ReconfigureOptions {
  /** Env vars to merge into the existing .env (unsent keys are preserved) */
  envVars?: Record<string, string>;
  /** Host-port overrides per port name (unset = app.yaml default) */
  portOverrides?: Record<string, number>;
}

export interface InstallResult {
  appName: string;
  proxyUrls: Record<string, string>; // portName → /app/<name>/<port>/
  secretKeys: string[];
  agentDeclaration?: { path: string; name: string } | null;
}

/**
 * Read-only preview of an install source, computed by fetching and parsing the
 * app.yaml BEFORE any install. Surfaces the secrets an operator must supply
 * ({@link InspectResult.secretKeys}) and the ones the gateway auto-generates
 * ({@link InspectResult.generatedKeys}) so the pre-install summary is accurate
 * even for a GitHub-URL app that has no registry entry.
 */
export interface InspectResult {
  name: string;
  version: string;
  source: AppEntry['source'];
  commit: string;
  secretKeys: string[];
  generatedKeys: GeneratedKey[];
  ports: ComposePort[];
  agentDeclaration: AgentDeclaration | null;
  warnings: string[];
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

  /**
   * Read-only inspection of an install source — no install side effects, no
   * files left behind. Resolves the repo + commit, fetches the app.yaml
   * (shallow clone into a tmp dir for registry/GitHub sources; direct read for
   * a local path), parses it, and returns the metadata needed for an accurate
   * pre-install summary: the required secrets (`secretKeys`, must be prompted)
   * and the self-generated secrets (`generatedKeys`, auto-filled at install).
   *
   * This is what lets a GitHub-URL install surface its required secrets before
   * installing — such apps have no registry entry, so `browse_registry` cannot
   * reveal them.
   */
  async inspectSource(options: InstallOptions): Promise<InspectResult> {
    // Mode B — local path: read app.yaml directly, no clone.
    if (options.localPath) {
      const resolved = path.resolve(options.localPath);
      if (!fs.existsSync(path.join(resolved, 'app.yaml'))) {
        throw new Error(`app.yaml not found in "${resolved}"`);
      }
      return this.inspectDir(resolved, 'local', 'local');
    }

    // Mode A — registry or GitHub: resolve, then shallow-clone into a tmp dir.
    // Passing a null job keeps resolveSource silent (there is no install job).
    const resolved = await this.resolveSource(null, options, options.version ?? '0.0.0');
    const tmpDir = path.join(os.tmpdir(), `cg-inspect-${crypto.randomUUID()}`);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      this.run(['git', 'init'], tmpDir);
      this.run(['git', 'remote', 'add', 'origin', resolved.githubUrl], tmpDir);
      this.run(['git', 'fetch', '--depth', '1', 'origin', resolved.commit], tmpDir);
      this.run(['git', 'checkout', 'FETCH_HEAD'], tmpDir);
      return this.inspectDir(tmpDir, resolved.source, resolved.commit, resolved.version);
    } finally {
      try {
        this.rmrf(tmpDir);
      } catch {
        /* best-effort cleanup of a read-only tmp clone */
      }
    }
  }

  /**
   * Parse the app.yaml in `appDir` and derive the pre-install metadata without
   * mutating `appDir`. generateCompose writes the compose file to its output
   * path, so we point it at a throwaway tmp file (removed here) to keep the
   * inspection read-only even for a local source.
   */
  private inspectDir(
    appDir: string,
    source: AppEntry['source'],
    commit: string,
    fallbackVersion?: string,
  ): InspectResult {
    const appYaml = parseAppYaml(fs.readFileSync(path.join(appDir, 'app.yaml'), 'utf-8'), appDir);
    const tmpCompose = path.join(os.tmpdir(), `cg-inspect-compose-${crypto.randomUUID()}.yml`);
    try {
      const generated = generateCompose(appYaml, appYaml.name, appDir, tmpCompose);
      return {
        name: appYaml.name,
        version: appYaml.version || fallbackVersion || '0.0.0',
        source,
        commit,
        secretKeys: generated.secretKeys,
        generatedKeys: generated.generatedKeys,
        ports: generated.ports,
        agentDeclaration: generated.agentDeclaration,
        warnings: generated.warnings,
      };
    } finally {
      try {
        fs.rmSync(tmpCompose, { force: true });
      } catch {
        /* best-effort cleanup of the throwaway compose file */
      }
    }
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

  /**
   * Start an async reconfigure job — merge env vars and/or override host ports
   * on an already-installed app, then force-recreate the container. Named
   * volumes (and their data) survive because this is an `up --force-recreate`,
   * never a `down -v`. Returns jobId immediately. Throws synchronously (409)
   * if the app is mid install/update/reconfigure.
   */
  reconfigure(appName: string, options: ReconfigureOptions): string {
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

    void this.runReconfigure(job, appName, options).catch((err: unknown) => {
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
   * Reconcile one app's stored status against the live Docker runtime and
   * return the entry with a fresh status. The stored status in `apps.json` is
   * only written at install/start/stop/reconfigure time, so a container that
   * crashed, was OOM-killed, or was stopped from outside the gateway leaves the
   * registry stuck on `running`. This queries the actual container state and
   * corrects the record.
   *
   * Best-effort and fail-safe: if the runtime cannot be queried (docker
   * unreachable, compose file gone, non-zero exit) the entry is returned
   * unchanged, so a transient daemon hiccup never fabricates a false `stopped`.
   * An app in the `building` state is skipped so an in-flight install — which
   * owns the status and will set `running` on completion — is not clobbered.
   *
   * When the live status differs from the stored one it is persisted back to
   * `apps.json` before returning, so subsequent reads and the boot-time restore
   * see the truth.
   */
  async reconcileStatus(entry: AppEntry): Promise<AppEntry> {
    const live = await this.queryRuntimeStatus(entry);
    if (live === entry.status) return entry;
    try {
      await this.registry.updateStatus(entry.name, live);
    } catch {
      // Persisting failed (e.g. registry lock contention). Still return the
      // corrected status so the read is accurate — a later read retries the
      // write. Never let one app's persist failure reject the whole list.
    }
    return { ...entry, status: live, updatedAt: new Date().toISOString() };
  }

  /** Reconcile a list of entries against the Docker runtime, in parallel. See {@link reconcileStatus}. */
  async reconcileStatuses(entries: AppEntry[]): Promise<AppEntry[]> {
    return Promise.all(entries.map((e) => this.reconcileStatus(e)));
  }

  /**
   * Query the live Docker state for one app and map it to an AppEntry status.
   * Returns the stored status unchanged when the runtime cannot be determined
   * (see {@link reconcileStatus} for the fail-safe rationale).
   *
   * Uses the async (non-blocking) spawn seam, not spawnSync: this runs on the
   * read path (`GET /apps`, possibly polled), so it must not freeze the gateway
   * event loop while `docker compose ps` runs. reconcileStatuses() therefore
   * genuinely parallelises across apps.
   */
  private async queryRuntimeStatus(entry: AppEntry): Promise<AppEntry['status']> {
    // An install in flight owns the status — don't race it.
    if (entry.status === 'building') return entry.status;
    let stdout: string;
    try {
      const res = await this.spawnAsync(
        'docker',
        ['compose', '-p', entry.name, 'ps', '-a', '--format', 'json'],
        { cwd: entry.installPath, timeoutMs: 10_000 },
      );
      if (res.status !== 0) return entry.status; // can't determine — keep stored
      stdout = res.stdout ?? '';
    } catch {
      return entry.status; // docker missing / spawn failed / timed out — keep stored
    }
    return mapContainerStatesToAppStatus(parseComposePs(stdout));
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
    const generated = generateCompose(appYaml, appName, appDir, composePath, options.portOverrides);

    // Conflict check — host port uniqueness across all installed apps
    const collision = await this.findHostPortCollision(
      appName,
      generated.ports.map((p) => ({ name: p.name, hostPort: p.hostPort })),
    );
    if (collision) {
      throw new Error(collision);
    }

    // Conflict check — agent name (if app declares an agent), inside install lock
    if (generated.agentDeclaration && this.agentManager) {
      const agentName = generated.agentDeclaration.name;
      const conflict = await this.agentManager.findAgentByName(agentName);
      if (conflict) {
        // The agent is registered in config.json — but is it owned by an app that
        // is actually installed? If a different installed app declares it, that's a
        // real conflict. If no installed app owns it, it's an orphan left behind by
        // a prior install that was killed before rollback could deregister it —
        // reclaim it (preserves the agent's sessions) so the app can install.
        const apps = await this.registry.list();
        const owner = apps.find(
          (a) => a.name !== appName && a.agentDeclaration?.name === agentName,
        );
        if (owner) {
          throw new Error(
            `Agent name "${agentName}" is already registered by app "${owner.name}"`,
          );
        }
        this.log(job, `Reclaiming orphaned agent registration "${agentName}"`);
        await this.agentManager.deleteAgentByName(agentName);
      }
    }

    for (const w of generated.warnings) {
      this.log(job, `Warning: ${w}`);
    }

    // ── Write .env ────────────────────────────────────────────────────────
    this.log(job, 'Writing .env');
    const generatedNames = this.writeEnvFile(appDir, appName, generated, options.envVars ?? {});
    if (generatedNames.length > 0) {
      this.log(job, `Generated secrets: ${generatedNames.join(', ')}`);
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
          this.rmrf(appDir);
        }
      } catch (cleanupErr) {
        // Directory may already be gone — that's fine. Anything else (e.g. a
        // root-owned file the sudo fallback still couldn't remove) leaves an
        // orphan on disk, so surface it in the logs instead of swallowing.
        if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.log(job, `Warning: rollback could not fully remove "${appDir}": ${(cleanupErr as Error).message}`);
        }
      }
      throw err;
    }
  }

  // ─── Update pipeline ──────────────────────────────────────────────────────

  private async runUpdate(job: JobState, appName: string): Promise<void> {
    job.status = 'running';
    job.updatedAt = Date.now();

    const entry = await this.registry.get(appName);
    if (!entry) throw new Error(`App "${appName}" is not installed`);

    // Resolve the repo + target commit for this app's source. Registry apps
    // resolve the latest published version; GitHub-installed apps resolve the
    // default branch HEAD via git ls-remote. Local (symlinked) apps have no
    // remote to pull and are not updatable.
    const target = await this.resolveUpdateTarget(entry);

    if (target.newCommit === entry.commit) {
      job.status = 'completed';
      job.result = {
        appName,
        proxyUrls: {},
        secretKeys: [],
        agentDeclaration: entry.agentDeclaration ?? null,
      };
      job.updatedAt = Date.now();
      this.log(job, `Already at latest commit ${entry.commit.slice(0, 8)}`);
      return;
    }

    this.log(job, `Updating ${appName} ${entry.commit.slice(0, 8)} → ${target.newCommit.slice(0, 8)}`);

    const tmpDir = path.join(os.tmpdir(), `cg-update-${appName}-${crypto.randomUUID()}`);
    try {
      // ── Shallow fetch of specific commit into tmp dir ─────────────────────
      this.log(job, `Cloning ${target.repo}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      this.run(['git', 'init'], tmpDir);
      this.run(['git', 'remote', 'add', 'origin', target.repo], tmpDir);
      this.run(['git', 'fetch', '--depth', '1', 'origin', target.newCommit], tmpDir);
      this.run(['git', 'checkout', 'FETCH_HEAD'], tmpDir);

      const yamlContent = fs.readFileSync(path.join(tmpDir, 'app.yaml'), 'utf-8');
      const appYaml = parseAppYaml(yamlContent, tmpDir);
      const composePath = path.join(tmpDir, 'docker-compose.yml');
      const generated = generateCompose(appYaml, appName, tmpDir, composePath);

      // Registry apps carry the published version; GitHub installs read it
      // from the freshly-fetched app.yaml.
      const newVersion = target.registryVersion ?? appYaml.version;
      this.log(job, `New version ${newVersion}`);

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
        version: newVersion,
        commit: target.newCommit,
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
        this.safeRmrf(tmpDir, job, 'update temp dir');
        if (rollbackFailed) {
          throw new Error(`Update failed and rollback also failed — app "${appName}" may be in a broken state. Check job logs for details.`);
        }
        throw upErr;
      }

      // ── Swap dirs ─────────────────────────────────────────────────────────
      // Swap in place at the recorded install path — NOT path.join(appsDir, appName).
      // For legacy installs the on-disk dir is named after the source repo/URL
      // basename, so `installPath` basename can differ from the app name. Using
      // the app name here throws ENOENT (issue #275). `entry.installPath` is the
      // authoritative location the `down`/rollback steps above already use.
      this.log(job, 'Swapping app directories');
      const finalDir = entry.installPath;
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
      this.safeRmrf(oldBackupDir, job, 'old backup dir');

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
      this.log(job, `Update complete → ${newVersion}`);

    } catch (err) {
      if (fs.existsSync(tmpDir)) {
        this.safeRmrf(tmpDir, job, 'update temp dir');
      }
      throw err;
    }
  }

  /**
   * Report whether an installed app has a newer version/commit available,
   * without performing the update. Mirrors the resolution `runUpdate` uses:
   * registry apps compare against the latest published version, custom apps
   * against the repo default-branch HEAD, and local apps are never updatable.
   * Never throws — a registry/network failure is reported as not-updatable.
   */
  async getUpdateInfo(
    entry: AppEntry,
  ): Promise<{ latestVersion: string | null; latestCommit: string | null; updateable: boolean }> {
    if (entry.source === 'local') {
      return { latestVersion: null, latestCommit: null, updateable: false };
    }
    try {
      const target = await this.resolveUpdateTarget(entry);
      return {
        latestVersion: target.registryVersion ?? null,
        latestCommit: target.newCommit,
        updateable: target.newCommit !== entry.commit,
      };
    } catch {
      return { latestVersion: null, latestCommit: null, updateable: false };
    }
  }

  /**
   * Reconfigure an installed app: merge env vars and/or override host ports,
   * then force-recreate the container in place. No clone, no dir swap — the app
   * stays at its current commit/appDir; only its .env and (optionally) its
   * compose port mappings change. Named volumes and their data survive because
   * this is an `up --force-recreate`, never a `down -v`.
   */
  private async runReconfigure(
    job: JobState,
    appName: string,
    options: ReconfigureOptions,
  ): Promise<void> {
    job.status = 'running';
    job.updatedAt = Date.now();

    const entry = await this.registry.get(appName);
    if (!entry) throw new Error(`App "${appName}" is not installed`);
    if (entry.source === 'local') {
      throw new Error(
        `App "${appName}" is installed from a local path and cannot be reconfigured — reinstall from source instead`,
      );
    }

    const appDir = entry.installPath;
    const composePath = path.join(appDir, 'docker-compose.yml');
    const portOverrides = options.portOverrides;
    const hasPortChange =
      portOverrides !== undefined && Object.keys(portOverrides).length > 0;

    // Parse the app's on-disk app.yaml (present from the original install/update).
    const yamlPath = path.join(appDir, 'app.yaml');
    if (!fs.existsSync(yamlPath)) {
      throw new Error(`app.yaml not found for "${appName}" — cannot reconfigure`);
    }
    const appYaml = parseAppYaml(fs.readFileSync(yamlPath, 'utf-8'), appDir);

    this.log(job, 'Preparing reconfigure');

    // Snapshot the current on-disk state BEFORE any mutation so a failed
    // recreate can be rolled back. Both an env-only and a port change rewrite
    // .env and force-recreate the container; a port change additionally rewrites
    // the live compose file and swaps proxy routes. If the new container never
    // comes up the app would otherwise be left down (or, for a port change,
    // unreachable with routes gone and compose/registry mismatched).
    const envPath = path.join(appDir, '.env');
    const oldComposeContent =
      hasPortChange && fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf-8') : null;
    const oldEnvContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : null;
    const oldPorts = entry.ports;

    // Compute (and validate) the port metadata. Always generate to a TEMP file
    // first: the live compose must not change until the overrides are validated
    // (generateCompose checks them) and we are inside the guarded section below.
    // Writing the live file here would leave the new ports on disk against the
    // still-running old container if a later step (collision, agent inject)
    // throws (finding F2). An env-only reconfigure never touches the compose.
    let generated: GeneratedCompose;
    let newComposeContent: string;
    {
      const tmpCompose = path.join(os.tmpdir(), `cg-reconf-${appName}-${crypto.randomUUID()}.yml`);
      try {
        generated = generateCompose(appYaml, appName, appDir, tmpCompose, portOverrides);
        newComposeContent = fs.readFileSync(tmpCompose, 'utf-8');
      } finally {
        fs.rmSync(tmpCompose, { force: true });
      }
    }

    // Host-port collision across other installed apps (only if ports changed).
    // Runs before the live compose is touched, so a collision leaves nothing to
    // undo on disk.
    if (hasPortChange) {
      const collision = await this.findHostPortCollision(
        appName,
        generated.ports.map((p) => ({ name: p.name, hostPort: p.hostPort })),
      );
      if (collision) throw new Error(collision);
    }

    // Apply the reconfigure. Everything from here mutates live state (compose
    // file, .env, proxy routes, the running container), so it is guarded: a
    // reconfigure that fails to recreate is rolled back to the previous
    // ports/compose/.env so the app stays reachable (planning §4.1 step 10 —
    // best-effort reopen).
    try {
      // Swap in the newly-generated compose only now that we're inside the
      // guard (finding F2). Regenerating drops the injected agent service, so we
      // re-inject it. An env-only reconfigure leaves the compose untouched.
      if (hasPortChange) {
        this.log(job, 'Updating docker-compose.yml');
        fs.writeFileSync(composePath, newComposeContent);
        if (generated.agentDeclaration && this.agentManager) {
          const agentPaths = entry.agentPaths ?? this.agentManager.detectAgentPaths();
          this.agentManager.injectAgentService({ ...entry, agentPaths });
        }
      }

      // Merge the new env vars onto the existing .env: keys not supplied are
      // preserved, and existing generated-secret values are carried over rather
      // than rotated (writeEnvFile treats an already-present value as pinned).
      this.log(job, 'Writing .env');
      const mergedEnv = { ...this.readEnvFile(appDir), ...(options.envVars ?? {}) };
      this.writeEnvFile(appDir, appName, generated, mergedEnv);

      // Deregister old proxy routes before the port mapping changes (the proxy is
      // bound to the old hostPort).
      if (hasPortChange) {
        this.callbacks.deregisterRoutes(appName);
      }

      // Force-recreate so the container picks up the new .env / port mapping —
      // compose does not detect an env_file content change on its own. This is an
      // `up`, not a `down -v`, so named volumes (and their data) survive.
      this.log(job, 'Recreating container');
      this.composeUp(appName, appDir, job, { forceRecreate: true });

      await this.registry.updateStatus(appName, 'running');

      // Persist the reconfigure: always bump updatedAt so the registry reflects
      // that the app was reconfigured; refresh the port mappings + re-register
      // proxy routes only when a host port actually changed.
      const updatedEntry: AppEntry = { ...entry, updatedAt: new Date().toISOString() };
      if (hasPortChange) {
        updatedEntry.ports = generated.ports.map((p) => ({
          name: p.name,
          service: p.service,
          hostPort: p.hostPort,
          containerPort: p.containerPort,
          type: p.type,
          rateLimit: p.rateLimit,
        }));
      }
      await this.registry.upsert(updatedEntry);
      if (hasPortChange) {
        this.callbacks.registerRoutes(appName, generated.ports);
      }
    } catch (reconfErr) {
      // Roll back a failed reconfigure so the app stays reachable. Both a
      // port change and an env-only change rewrite .env and force-recreate the
      // container, so a bad value (failed healthcheck) or an unbindable port can
      // leave the app down either way (finding F1). Restore the previous .env,
      // restore the previous compose + re-register the old routes when a port
      // change had swapped them, then bring the old container back on the old
      // config. Best-effort: a failing rollback is logged, not thrown.
      this.log(job, `Reconfigure failed — rolling back "${appName}"`);
      try {
        if (oldEnvContent !== null) {
          fs.writeFileSync(envPath, oldEnvContent, { mode: 0o600 });
          fs.chmodSync(envPath, 0o600);
        }
        if (hasPortChange && oldComposeContent !== null) {
          fs.writeFileSync(composePath, oldComposeContent);
        }
        this.composeUp(appName, appDir, job, { forceRecreate: true });
        if (hasPortChange) {
          this.callbacks.registerRoutes(
            appName,
            oldPorts.map((p) => ({
              name: p.name,
              service: p.service,
              hostPort: p.hostPort,
              containerPort: p.containerPort,
              type: p.type,
              rateLimit: p.rateLimit,
            })),
          );
        }
        await this.registry.updateStatus(appName, 'running');
      } catch (rollbackErr) {
        this.log(
          job,
          `ROLLBACK FAILED — app "${appName}" may be in a broken state: ${(rollbackErr as Error).message}`,
        );
      }
      throw reconfErr;
    }

    const proxyUrls: Record<string, string> = {};
    for (const p of generated.ports) {
      proxyUrls[p.name] = `/app/${appName}/${p.name}/`;
    }

    job.status = 'completed';
    job.result = {
      appName,
      proxyUrls,
      secretKeys: generated.secretKeys,
      agentDeclaration: entry.agentDeclaration ?? null,
    };
    job.updatedAt = Date.now();
    this.log(job, `Reconfigure complete: ${JSON.stringify(proxyUrls)}`);
  }

  /**
   * Return an error message if any of the given host ports is already bound by a
   * *different* installed app, else null. Shared by install and reconfigure so
   * the cross-app collision rule stays in one place.
   */
  async findHostPortCollision(
    selfName: string,
    ports: Array<{ name: string; hostPort: number }>,
  ): Promise<string | null> {
    const installedApps = await this.registry.list();
    const usedHostPorts = new Map<number, string>();
    for (const app of installedApps) {
      if (app.name === selfName) continue;
      for (const port of app.ports) {
        usedHostPorts.set(port.hostPort, app.name);
      }
    }
    for (const p of ports) {
      const owner = usedHostPorts.get(p.hostPort);
      if (owner) {
        return `Host port ${p.hostPort} (port "${p.name}") is already used by app "${owner}"`;
      }
    }
    return null;
  }

  /**
   * Write the app's .env file (mode 0600). Emits, in order: BASE_PATH for web
   * ports, declared secretKeys, self-generating generatedKeys (a fresh random
   * value unless already present in `envVars` — operator-pinned on install, or
   * the existing value on reconfigure), then any extra vars. Returns the names
   * of freshly generated secrets (for logging — never the values). Shared by
   * runInstall and runReconfigure so the .env format cannot drift.
   */
  private writeEnvFile(
    appDir: string,
    appName: string,
    generated: Pick<GeneratedCompose, 'ports' | 'secretKeys' | 'generatedKeys'>,
    envVars: Record<string, string>,
  ): string[] {
    const merged: Record<string, string> = { ...envVars };
    // Inject BASE_PATH for web-type ports
    for (const port of generated.ports) {
      if (port.type === 'web') {
        merged['BASE_PATH'] = `/app/${appName}/${port.name}`;
      }
    }

    const envLines: string[] = [];
    for (const key of generated.secretKeys) {
      const val = (merged[key] ?? '').replace(/[\r\n]/g, '');
      envLines.push(`${key}=${val}`);
    }
    const generatedKeySet = new Set(generated.generatedKeys.map((g) => g.key));
    const generatedNames: string[] = [];
    for (const g of generated.generatedKeys) {
      const pinned = merged[g.key];
      let val: string;
      if (pinned !== undefined && pinned !== '') {
        val = pinned.replace(/[\r\n]/g, '');
      } else {
        val = generateSecretValue(g.encoding, g.bytes);
        generatedNames.push(g.key);
      }
      envLines.push(`${g.key}=${val}`);
    }
    // Any explicitly provided vars not already declared as secrets/generated.
    for (const [k, v] of Object.entries(merged)) {
      if (!generated.secretKeys.includes(k) && !generatedKeySet.has(k)) {
        envLines.push(`${k}=${v.replace(/[\r\n]/g, '')}`);
      }
    }

    const envPath = path.join(appDir, '.env');
    try {
      fs.writeFileSync(envPath, envLines.join('\n') + '\n', { mode: 0o600 });
      // writeFileSync's `mode` only applies when the file is created; on
      // reconfigure the .env already exists, so re-assert 0600 explicitly to
      // keep secrets owner-only regardless of the file's prior permissions.
      fs.chmodSync(envPath, 0o600);
    } catch (err) {
      throw new Error(`Failed to write .env: ${(err as Error).message}`);
    }
    return generatedNames;
  }

  /** Parse an app's existing .env into a key→value map (empty if absent). */
  private readEnvFile(appDir: string): Record<string, string> {
    const envPath = path.join(appDir, '.env');
    const out: Record<string, string> = {};
    if (!fs.existsSync(envPath)) return out;
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  /**
   * Resolve the repo URL and target commit to update an installed app to.
   * - `registry`: latest published version via the registry client.
   * - `custom` (GitHub URL install): the default branch HEAD via git ls-remote,
   *   so the app follows its repo without a data-destroying reinstall.
   * - `local` (symlinked dir): not updatable — there is no remote to pull.
   */
  private async resolveUpdateTarget(
    entry: AppEntry,
  ): Promise<{ repo: string; newCommit: string; registryVersion?: string }> {
    if (entry.source === 'registry') {
      const app = await this.registryClient.findApp(entry.name);
      if (!app) throw new Error(`App "${entry.name}" not found in registry`);
      const latest = selectLatest(app.versions);
      if (!latest) throw new Error(`No versions available for "${entry.name}"`);
      return { repo: app.repo, newCommit: latest.commit, registryVersion: latest.version };
    }

    if (entry.source === 'custom') {
      const url = entry.githubUrl;
      if (!url || !GITHUB_URL_RE.test(url)) {
        throw new Error(`App "${entry.name}" has no valid GitHub URL to update from`);
      }
      const { stdout } = this.run(['git', 'ls-remote', url, 'HEAD'], process.cwd());
      const match = stdout.trim().match(/^([0-9a-f]{40})\s+HEAD/);
      if (!match) throw new Error(`Could not resolve HEAD commit for ${url}`);
      return { repo: url, newCommit: match[1] };
    }

    throw new Error(
      `App "${entry.name}" is installed from a local path and cannot be updated — reinstall from source instead`,
    );
  }

  private async resolveSource(
    job: JobState | null,
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
        if (job) this.log(job, `Using latest version ${latest.version}`);
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
        if (job) this.log(job, `Resolving HEAD commit for ${options.githubUrl}`);
        const { stdout } = this.run(['git', 'ls-remote', options.githubUrl, 'HEAD'], process.cwd());
        const match = stdout.trim().match(/^([0-9a-f]{40})\s+HEAD/);
        if (!match) throw new Error(`Could not resolve HEAD commit for ${options.githubUrl}`);
        commit = match[1];
        if (job) this.log(job, `Resolved HEAD → ${commit.slice(0, 8)}`);
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
      const code = (err as NodeJS.ErrnoException).code;
      // Containers running as root leave root-owned files (e.g. postgres pgdata)
      // that the gateway user cannot delete — fs.rmSync surfaces EACCES or EPERM.
      if (code === 'EACCES' || code === 'EPERM') {
        console.warn(`[installer] ${code} removing "${dirPath}" — falling back to sudo rm -rf`);
        this.run(['sudo', 'rm', '-rf', dirPath]);
      } else {
        throw err;
      }
    }
  }

  /**
   * Best-effort directory removal for cleanup paths where a failure must not
   * abort the operation (e.g. deleting a post-update backup, or a tmp clone
   * during rollback). Logs a warning instead of throwing so a cleanup error
   * never masks a successful result or the original failure.
   */
  private safeRmrf(dirPath: string, job: JobState, label: string): void {
    try {
      this.rmrf(dirPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(job, `Warning: failed to remove ${label} "${dirPath}": ${(err as Error).message}`);
      }
    }
  }

  /**
   * Stop conflicting containers then run `docker compose up -d --wait`.
   * Captures container logs into the job on failure before rethrowing.
   * job is optional — when omitted (e.g. startStopRestart) logs go to stderr.
   */
  private composeUp(appName: string, dir: string, job?: JobState, opts?: { forceRecreate?: boolean }): void {
    this.stopConflictingContainers(appName);
    const args = ['docker', 'compose', '-p', appName, 'up', '-d', '--wait'];
    if (opts?.forceRecreate) {
      args.push('--force-recreate');
    }
    try {
      this.run(args, dir, 600_000);
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

// ─── Docker runtime reconciliation helpers ─────────────────────────────────────

/** One container's runtime facts, distilled from `docker compose ps` JSON. */
export interface ComposePsContainer {
  /** Lower-cased compose state: running | restarting | exited | dead | created | paused | … */
  state: string;
  /** Process exit code (0 when still running or absent). */
  exitCode: number;
}

/**
 * Parse `docker compose ps -a --format json` stdout into a flat container list.
 * Handles both output shapes compose has shipped: newline-delimited JSON
 * objects (v2.21+) and a single JSON array (older). Malformed lines and entries
 * without a string `State` are skipped rather than throwing — a best-effort
 * parse must never crash the read path.
 */
export function parseComposePs(stdout: string): ComposePsContainer[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const out: ComposePsContainer[] = [];
  const push = (o: unknown): void => {
    if (o && typeof o === 'object' && typeof (o as { State?: unknown }).State === 'string') {
      const rec = o as { State: string; ExitCode?: unknown };
      out.push({
        state: rec.State.toLowerCase(),
        exitCode: typeof rec.ExitCode === 'number' ? rec.ExitCode : 0,
      });
    }
  };
  // Whole-string JSON array (older compose).
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) {
        arr.forEach(push);
        return out;
      }
    } catch {
      /* fall through to line-by-line parsing */
    }
  }
  // Newline-delimited JSON objects (current compose).
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      push(JSON.parse(l));
    } catch {
      /* skip a malformed line */
    }
  }
  return out;
}

/**
 * Map an app's compose-project container states to a single AppEntry status:
 *   - no containers                                   → stopped
 *   - any running / restarting                        → running
 *   - any dead, or exited with a non-zero exit code   → error   (crash)
 *   - else (clean exit / created / paused)            → stopped
 */
export function mapContainerStatesToAppStatus(
  containers: ComposePsContainer[],
): AppEntry['status'] {
  if (containers.length === 0) return 'stopped';
  if (containers.some((c) => c.state === 'running' || c.state === 'restarting')) {
    return 'running';
  }
  if (containers.some((c) => c.state === 'dead' || (c.state === 'exited' && c.exitCode !== 0))) {
    return 'error';
  }
  return 'stopped';
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
