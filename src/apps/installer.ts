import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SpawnSyncOptionsWithStringEncoding, spawnSync } from 'node:child_process';
import { AppsRegistry, AppEntry, PortEntry } from './registry';
import { RegistryClient } from './registry-client';
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
  startSocket(socketPath: string, socket: ComposeSocket, scripts: Record<string, ScriptConfig>): void;
  stopSockets(appName: string): void;
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

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_APPS_DIR = path.join(os.homedir(), '.claude-gateway', 'apps');
const COMMIT_RE = /^[0-9a-f]{40}$/;
const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

// ─── Installer ────────────────────────────────────────────────────────────────

export class AppInstaller {
  private readonly jobs = new Map<string, JobState>();
  private readonly appsDir: string;

  constructor(
    private readonly registry: AppsRegistry,
    private readonly registryClient: RegistryClient,
    private readonly callbacks: InstallerCallbacks,
    private readonly spawn: SpawnFn = defaultSpawn,
    appsDir?: string,
    private readonly agentManager?: AgentManager,
  ) {
    this.appsDir = appsDir ?? DEFAULT_APPS_DIR;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Start an async install job. Returns jobId immediately. */
  install(options: InstallOptions): string {
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
    });

    return jobId;
  }

  getJob(jobId: string): JobState | undefined {
    return this.jobs.get(jobId);
  }

  /** Start an async update job. Returns jobId immediately. */
  update(appName: string): string {
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
    });

    return jobId;
  }

  async uninstall(appName: string): Promise<void> {
    const entry = await this.registry.get(appName);
    if (!entry) throw new Error(`App "${appName}" is not installed`);

    const appDir = entry.installPath;

    // docker compose down --rmi all
    this.run(['docker', 'compose', 'down', '--rmi', 'all'], appDir, 120_000);

    // Remove proxy routes + sockets
    this.callbacks.deregisterRoutes(appName);
    this.callbacks.stopSockets(appName);

    // Remove agent symlink + config.json entry if this was an agent app
    if (this.agentManager) {
      this.agentManager.deleteAgent(entry);
    }

    // Remove app files (but not the dir itself if it's a symlink target)
    if (fs.existsSync(appDir)) {
      fs.rmSync(appDir, { recursive: true, force: true });
    }

    await this.registry.remove(appName);
  }

  async startStopRestart(
    appName: string,
    action: 'start' | 'stop' | 'restart',
  ): Promise<void> {
    const entry = await this.registry.get(appName);
    if (!entry) throw new Error(`App "${appName}" is not installed`);

    const args = action === 'restart'
      ? ['docker', 'compose', 'restart']
      : ['docker', 'compose', action === 'start' ? 'up' : 'stop', ...(action === 'start' ? ['-d'] : [])];

    this.run(args, entry.installPath, 60_000);
    await this.registry.updateStatus(
      appName,
      action === 'stop' ? 'stopped' : 'running',
    );
  }

  // ─── Internal install pipeline ────────────────────────────────────────────

  private async runInstall(job: JobState, options: InstallOptions): Promise<void> {
    job.status = 'running';
    job.updatedAt = Date.now();

    const { localPath } = options;

    // ── Resolve app dir and commit ────────────────────────────────────────
    let appDir: string;
    let appName: string;
    let commit: string;
    let githubUrl: string;
    let source: AppEntry['source'];
    let version = options.version ?? '0.0.0';

    if (localPath) {
      // Mode B — local pre-baked path
      const resolved = path.resolve(localPath);
      if (!resolved.startsWith(this.appsDir + path.sep) && resolved !== this.appsDir) {
        throw new Error(
          `local_path must be within ${this.appsDir} — got "${localPath}"`,
        );
      }
      if (!fs.existsSync(resolved)) {
        throw new Error(`local_path does not exist: "${localPath}"`);
      }
      appDir = resolved;
      appName = path.basename(resolved);
      commit = 'local';
      githubUrl = '';
      source = 'local';
      this.log(job, `Using local path: ${appDir}`);
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
        throw new Error(
          `App "${appName}" is already installed. Use update to upgrade.`,
        );
      }

      // git clone + checkout
      this.log(job, `Cloning ${githubUrl}`);
      fs.mkdirSync(this.appsDir, { recursive: true });
      this.run(['git', 'clone', '--no-checkout', githubUrl, appDir]);
      this.run(['git', 'checkout', commit], appDir);
      this.log(job, `Checked out commit ${commit.slice(0, 8)}`);
    }

    // Validate app name from app.yaml matches
    this.log(job, 'Validating app.yaml');
    const yamlContent = fs.readFileSync(path.join(appDir, 'app.yaml'), 'utf-8');
    const appYaml = parseAppYaml(yamlContent, appDir);

    if (!APP_NAME_RE.test(appYaml.name)) {
      throw new Error(`Invalid app name in app.yaml: "${appYaml.name}"`);
    }
    // Use name from app.yaml as canonical name
    appName = appYaml.name;

    // Conflict check — app name
    const existing = await this.registry.get(appName);
    if (existing) {
      throw new Error(`App "${appName}" is already installed`);
    }

    // ── Generate docker-compose.yml ───────────────────────────────────────
    this.log(job, 'Generating docker-compose.yml');
    const composePath = path.join(appDir, 'docker-compose.yml');
    const generated = generateCompose(appYaml, appName, appDir, composePath);

    // Conflict check — agent name (if app declares an agent)
    if (generated.agentDeclaration && this.agentManager) {
      const conflict = this.agentManager.findAgentByName(generated.agentDeclaration.name);
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
      const val = envVars[key] ?? '';
      envLines.push(`${key}=${val}`);
    }
    // Also write any explicitly provided vars not already declared as secrets
    for (const [k, v] of Object.entries(envVars)) {
      if (!generated.secretKeys.includes(k)) {
        envLines.push(`${k}=${v}`);
      }
    }

    const envPath = path.join(appDir, '.env');
    fs.writeFileSync(envPath, envLines.join('\n') + '\n', { mode: 0o600 });

    // ── Create socket files ───────────────────────────────────────────────
    const SOCK_DIR = '/run/claude-gateway/apps';
    if (generated.sockets.length > 0) {
      fs.mkdirSync(SOCK_DIR, { recursive: true });
    }
    for (const sock of generated.sockets) {
      const sockPath = sock.hostSocketPath;
      // Remove stale socket file if it exists
      if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
      this.callbacks.startSocket(sockPath, sock, sock.scripts);
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
    }

    await this.registry.upsert(entry);

    // ── docker compose build ──────────────────────────────────────────────
    this.log(job, 'Building images');
    this.run(['docker', 'compose', 'build'], appDir, 600_000);

    // ── docker compose up -d ──────────────────────────────────────────────
    this.log(job, 'Starting containers');
    this.run(['docker', 'compose', 'up', '-d', '--wait'], appDir, 120_000);

    // ── Update status to running ──────────────────────────────────────────
    await this.registry.updateStatus(appName, 'running');
    this.log(job, 'Containers healthy');

    // ── Create agent workspace symlink + config.json entry ───────────────
    if (generated.agentDeclaration && this.agentManager) {
      this.agentManager.upsertAgent(entry);
      this.log(job, `Agent "${generated.agentDeclaration.name}" registered`);
    }

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
    const latest = app.versions[app.versions.length - 1];
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

    const tmpDir = path.join(os.tmpdir(), `cg-update-${appName}-${Date.now()}`);
    try {
      // ── Clone + validate new version ─────────────────────────────────────
      this.log(job, `Cloning ${app.repo}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      this.run(['git', 'clone', '--no-checkout', app.repo, tmpDir]);
      this.run(['git', 'checkout', latest.commit], tmpDir);

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
        this.run(['docker', 'compose', '-p', appName, 'up', '-d', '--wait'], tmpDir, 120_000);
      } catch (upErr) {
        // Rollback: bring old containers back up from old install path
        this.log(job, 'New containers failed — rolling back to previous version');
        try {
          this.run(['docker', 'compose', '-p', appName, 'up', '-d'], entry.installPath, 120_000);
          this.callbacks.registerRoutes(appName, entry.ports.map((p) => ({
            name: p.name,
            service: p.service,
            containerPort: p.containerPort,
            type: p.type,
            rateLimit: p.rateLimit,
          })));
          await this.registry.updateStatus(appName, 'running');
        } catch { /* ignore secondary failure */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw upErr;
      }

      // ── Swap dirs ─────────────────────────────────────────────────────────
      this.log(job, 'Swapping app directories');
      const finalDir = path.join(this.appsDir, appName);
      const oldBackupDir = `${finalDir}-old-${Date.now()}`;
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
        this.agentManager.upsertAgent(finalEntry);
        this.log(job, `Agent "${generated.agentDeclaration.name}" re-registered`);
      }

      // ── Re-register proxy routes + sockets ───────────────────────────────
      this.callbacks.registerRoutes(appName, generated.ports);
      for (const sock of generated.sockets) {
        const sockPath = sock.hostSocketPath;
        if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
        this.callbacks.startSocket(sockPath, sock, sock.scripts);
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
        const latest = app.versions[app.versions.length - 1];
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

    if (options.githubUrl && options.commit) {
      if (!COMMIT_RE.test(options.commit)) {
        throw new Error(
          `commit must be a 40-char hex string — branch names are not allowed`,
        );
      }
      const appName = options.githubUrl.split('/').pop()?.replace(/\.git$/, '') ?? 'app';
      return {
        appName,
        commit: options.commit,
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
      const errDetail = result.stderr.trim() || result.stdout.trim();
      throw new Error(
        `Command failed: ${args[0]} ${args[1]} — ${errDetail.slice(0, 500)}`,
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
