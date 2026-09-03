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
import { msUntilNextHour } from '../history/cleanup';
import { msOr } from '../utils/config-num';

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

/** Per-app backup policy (mirrors `gateway.appBackup` in the gateway config). */
export interface AppBackupConfig {
  /** Keep the N most recent backups per app; older are pruned. Default 3. 0 = unbounded. */
  retention?: number;
  /** Prune backups older than N days. Default 30. 0 = disabled. */
  maxAgeDays?: number;
  /** Hour (0-23, in cleanupTimezone) the daily backup prune runs. Default 0. */
  cleanupHour?: number;
  /** IANA timezone for cleanupHour. Default "UTC". */
  cleanupTimezone?: string;
  /** Auto-snapshot before uninstall. Default true. */
  autoBackupBeforeUninstall?: boolean;
  /** Auto-snapshot before update. Default true. */
  autoBackupBeforeUpdate?: boolean;
}

/**
 * On-disk manifest stored inside every backup archive. `volumes` are the
 * compose-level (logical) volume names; the actual Docker volume for each is
 * `<appName>_<logical>`.
 */
export interface BackupMetadata {
  id: string;
  appName: string;
  appVersion: string;
  createdAt: string; // ISO 8601
  volumes: string[];
  /**
   * App-dir-relative bind-mount source directories captured in this backup
   * (e.g. `data/photos`, `postgres/pgdata`). Optional for backward
   * compatibility with backups taken before bind-mount capture existed.
   */
  bindMounts?: string[];
  sizeBytes: number;
}

/** Summary of one backup, as surfaced by `listBackups` / `GET …/backups`. */
export interface BackupInfo {
  id: string;
  createdAt: string;
  sizeBytes: number;
  appVersion: string;
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
  /**
   * Default values for prompted secrets declared with `KEY=!default:<value>`.
   * Surfaced so install UIs can pre-fill the editable field; keyed by env var
   * name, only keys with a declared default appear. See
   * {@link GeneratedCompose.secretDefaults}.
   */
  secretDefaults: Record<string, string>;
  ports: ComposePort[];
  agentDeclaration: AgentDeclaration | null;
  warnings: string[];
}

export interface JobState {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  logs: string[];
  result?: InstallResult;
  /** Populated by backup/restore jobs with the affected backup's summary. */
  backup?: BackupInfo;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

/**
 * Docker housekeeping toggles (issue #302). Mirrors
 * `GatewayConfig['gateway']['appHousekeeping']`; all fields optional so an
 * absent config resolves to the conservative defaults in
 * {@link AppInstaller.resolveHousekeeping}.
 */
export interface AppHousekeepingConfig {
  buildCachePrune?: boolean;
  buildCacheMaxAgeHours?: number;
  danglingImagePrune?: boolean;
}

/**
 * Boot-restore budgets (issue #425). Mirrors `GatewayConfig['gateway']['appRestore']`;
 * all fields optional so an absent config resolves to {@link RESTORE_BUILD_TIMEOUT_MS}
 * / {@link RESTORE_COMPOSE_TIMEOUT_MS}. Split because the two phases have very
 * different shapes: the healthcheck wait should stay short, while a cold build
 * legitimately takes minutes and is *cancelled* if its budget expires.
 */
export interface AppRestoreConfig {
  /** Ceiling for the restore's `docker compose build`. Default 1_800_000 (30 min). */
  buildTimeoutMs?: number;
  /** Ceiling for the restore's `docker compose up -d --wait`. Default 180_000 (3 min). */
  waitTimeoutMs?: number;
}

/** Why an app's boot-time restore failed, and when. See {@link AppInstaller.getRestoreFailure}. */
export interface RestoreFailure {
  /** The underlying error message (compose output tail, or the timeout). */
  error: string;
  /** ISO timestamp of the failure. */
  at: string;
}

/** Read-only reclaim report (issue #302). Volumes are reported, never deleted. */
export interface HousekeepingReport {
  /** Human-readable reclaimable build cache from `docker system df` (e.g. "1.457GB"); '' if unknown. */
  buildCacheReclaimable: string;
  /** Count of dangling `<none>` images with no container. */
  danglingImageCount: number;
  /** Orphaned volume names (LINKS=0). Report-only — NEVER auto-deleted. */
  orphanVolumes: string[];
}

/** Result of a manual housekeeping call. */
export interface HousekeepingResult {
  mode: 'report' | 'prune';
  /** Which safe reclaims actually ran (prune mode only). */
  pruned: { buildCache: boolean; danglingImages: boolean };
  report: HousekeepingReport;
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
// Backups live under `<appsDir>/.backups/<app>/`. A dot-prefixed dir here is
// never mistaken for an installed app (the registry is driven by `apps.json`,
// not by enumerating the apps directory), and — being a sibling of each app's
// own dir rather than inside it — the archive survives that app's uninstall,
// which removes only `<appsDir>/<app>/`.
const APP_BACKUPS_DIRNAME = '.backups';
// Default per-app backup ceiling when config omits it. The N most recent are
// kept; older archives are pruned after each successful backup and by the daily
// scheduler.
const DEFAULT_BACKUP_RETENTION = 3;
// Default age ceiling (days) when config omits it. Backups older than this are
// pruned regardless of count. 0 disables age pruning.
const DEFAULT_BACKUP_MAX_AGE_DAYS = 30;
// Wall-clock ceiling for a single helper-container tar (backup or restore) of
// one volume. A few hundred MB tars in seconds; this only bounds a pathological
// hang so a stuck helper never wedges a backup job forever.
const VOLUME_TAR_TIMEOUT_MS = 300_000;
// OCI image used for the throwaway tar helper. Small, ubiquitous, already a
// transitive dependency of most stacks, so it is almost always cache-warm.
const BACKUP_HELPER_IMAGE = 'alpine';
// Ceiling for the root helper that moves a bind path the gateway user cannot
// rename itself. The move is a single rename(2) — instant — so this only bounds
// a stuck container (or a cold pull of the helper image) during an update swap.
const BIND_MOVE_TIMEOUT_MS = 120_000;
// Per-app ceiling for the boot-time `compose up --wait` during restore. Runs in
// the background (non-blocking), so this only bounds how long a hung container
// keeps its child process alive — not the gateway's responsiveness. Deliberately
// short: it bounds the *healthcheck wait* only. The build that may precede it on
// a cold host gets its own, far larger budget below — sizing this one to cover a
// from-source build would also make every hung container hold on for that long.
const RESTORE_COMPOSE_TIMEOUT_MS = 180_000;
// Per-app ceiling for the boot-time `compose build` that precedes the wait.
// Applies when the host has no image cache for the app (data dir restored onto a
// fresh machine, migrated host, pruned Docker state), where the restore has to
// cover base-image pulls, a dependency install and an application build — for up
// to RESTORE_MAX_CONCURRENCY apps competing for the same CPU. A timeout here
// SIGKILLs the CLI, which *cancels* the build (see {@link defaultAsyncSpawn}),
// so this must be generous: an expired budget means the app is never built.
const RESTORE_BUILD_TIMEOUT_MS = 1_800_000;
// Ceiling for the read-only probe that decides whether a build is needed at all.
// Two local daemon queries, no network and no work — generous on purpose so a
// momentarily busy dockerd does not make the restore skip a build it needs.
const IMAGE_PROBE_TIMEOUT_MS = 30_000;
// Max apps brought up concurrently during boot restore. Bounds the docker/CPU
// spike when many apps are marked running, while still parallelising the common
// case. Typical installs have 1-3 apps, so this rarely binds.
const RESTORE_MAX_CONCURRENCY = 4;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Validate an IANA timezone from config before it reaches `Intl.DateTimeFormat`.
 * An invalid string would otherwise throw a RangeError inside the daily-cleanup
 * scheduler at boot — config is untrusted input, so a typo must degrade to UTC,
 * never crash the gateway.
 */
function isValidTimezone(tz: string | undefined): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
// Disallow '..' in owner/repo segments — prevents path traversal via edge-case git URL parsing.
const GITHUB_URL_RE = /^https:\/\/github\.com\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*(\.git)?$/;

// ─── Installer ────────────────────────────────────────────────────────────────

const UUID_RE_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * The staging checkout `runUpdate` creates beside an app's install path,
 * `.cg-update-<app>-<uuid>`. It holds a fresh clone and nothing else, so a
 * crash leftover is pure garbage and safe to reclaim. The UUID means the
 * pattern cannot match an app directory named by a user.
 */
const STALE_UPDATE_DIR_RE = new RegExp(`^\\.cg-update-.+-${UUID_RE_SRC}$`);

/**
 * The release snapshots `runUpdate` renames an install path to during the swap:
 * `<appDir>-old-<uuid>` (previous release) and `<appDir>-failed-<uuid>` (the
 * release that failed). Deliberately **not** swept.
 *
 * Both can hold the only copy of live bind-mount data. `-failed-` is kept on
 * purpose when a rollback cannot move a bind path back, and a crash between the
 * swap's two renames leaves an `-old-` still holding the paths that had not
 * moved yet. Sweeping them would delete a database — through {@link rmrf}'s
 * `sudo rm -rf` fallback, which exists precisely to defeat the container
 * ownership that made the data unmovable in the first place. They are reported
 * at boot instead, so a leak is visible rather than silent.
 */
const RELEASE_SNAPSHOT_DIR_RE = new RegExp(`-(?:old|failed)-${UUID_RE_SRC}$`);

/**
 * A filesystem call that failed because the gateway user lacks the rights, not
 * because the path is wrong. Containers running as their image's uid leave
 * files and directories the gateway user can neither delete nor rename, and
 * those are the two codes the kernel reports for it.
 */
export function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * Deepest directory containing both paths, never either path itself.
 *
 * Used to pick a **single** mount for the root helper that moves a bind path:
 * mounting each parent separately would put the two paths on different mount
 * points, where `rename(2)` fails EXDEV and `mv` degrades to a copy.
 *
 * The comparison stops one component short of the shorter path, so the result
 * is always a strict ancestor of both — for siblings (what the callers here
 * pass) that is exact. When one path contains the other it is the *shallower*
 * path's parent, i.e. broader than strictly needed; never narrower, which would
 * put a path outside the mount.
 */
export function commonAncestorDir(a: string, b: string): string {
  const left = path.resolve(a).split(path.sep);
  const right = path.resolve(b).split(path.sep);
  const shared: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length) - 1; i++) {
    if (left[i] !== right[i]) break;
    shared.push(left[i]);
  }
  return shared.join(path.sep) || path.sep;
}

/**
 * Rows from a `docker compose … --format json` call. Compose has emitted both a
 * single JSON array and one object per line across its 2.x line, so accept
 * either rather than silently reading a newer/older daemon as "nothing here".
 */
function parseJsonRows(stdout: string): unknown[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { /* not a single document — try line-delimited below */ }
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch { /* skip a line that is not JSON */ }
  }
  return rows;
}

/** Private tag the update holds on an image so a rollback can put it back. */
const ROLLBACK_TAG_PREFIX = 'cg-rollback-';

/**
 * An image reference and the private tag pinning its pre-update build. An empty
 * `backupRef` records a reference that could *not* be pinned — the rollback
 * treats it as unrestorable and rebuilds instead.
 */
interface PreservedImage {
  ref: string;
  backupRef: string;
}

export class AppInstaller {
  private readonly jobs = new Map<string, JobState>();
  private readonly appsDir: string;
  private readonly backupsDir: string;
  private readonly appBackupConfig: Required<AppBackupConfig>;
  /** Tracks app names currently being installed to prevent concurrent installs of the same name. */
  private readonly installingNames = new Set<string>();
  /**
   * App names whose boot-time restore is in flight. Mirrors {@link installingNames}
   * for {@link restoreRunningApps}: while a restore owns an app, its containers do
   * not exist yet, so status reads must not reconcile it (issue #425).
   */
  private readonly restoringNames = new Set<string>();
  /**
   * App name → why this boot's restore of it failed. In-memory on purpose: it
   * describes the *current* process's restore attempt, so a gateway restart
   * (which retries the restore) correctly starts from a clean slate.
   */
  private readonly restoreFailures = new Map<string, RestoreFailure>();
  private readonly restoreConfig: Required<AppRestoreConfig>;

  constructor(
    private readonly registry: AppsRegistry,
    private readonly registryClient: RegistryClient,
    private readonly callbacks: InstallerCallbacks,
    private readonly spawn: SpawnFn = defaultSpawn,
    appsDir?: string,
    private readonly agentManager?: AgentManager,
    private readonly spawnAsync: AsyncSpawnFn = defaultAsyncSpawn,
    private readonly housekeepingConfig: AppHousekeepingConfig = {},
    appBackupConfig?: AppBackupConfig,
    backupsDir?: string,
    appRestoreConfig?: AppRestoreConfig,
  ) {
    this.appsDir = appsDir ?? DEFAULT_APPS_DIR;
    this.backupsDir = backupsDir ?? path.join(this.appsDir, APP_BACKUPS_DIRNAME);
    this.restoreConfig = {
      buildTimeoutMs: msOr(appRestoreConfig?.buildTimeoutMs, RESTORE_BUILD_TIMEOUT_MS),
      waitTimeoutMs: msOr(appRestoreConfig?.waitTimeoutMs, RESTORE_COMPOSE_TIMEOUT_MS),
    };
    this.appBackupConfig = {
      retention:
        appBackupConfig?.retention !== undefined && appBackupConfig.retention >= 0
          ? Math.floor(appBackupConfig.retention)
          : DEFAULT_BACKUP_RETENTION,
      maxAgeDays:
        appBackupConfig?.maxAgeDays !== undefined && appBackupConfig.maxAgeDays >= 0
          ? Math.floor(appBackupConfig.maxAgeDays)
          : DEFAULT_BACKUP_MAX_AGE_DAYS,
      cleanupHour:
        appBackupConfig?.cleanupHour !== undefined &&
        Number.isInteger(appBackupConfig.cleanupHour) &&
        appBackupConfig.cleanupHour >= 0 &&
        appBackupConfig.cleanupHour <= 23
          ? appBackupConfig.cleanupHour
          : 0,
      cleanupTimezone: isValidTimezone(appBackupConfig?.cleanupTimezone) ? appBackupConfig!.cleanupTimezone! : 'UTC',
      autoBackupBeforeUninstall: appBackupConfig?.autoBackupBeforeUninstall ?? true,
      autoBackupBeforeUpdate: appBackupConfig?.autoBackupBeforeUpdate ?? true,
    };
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
        secretDefaults: generated.secretDefaults,
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

    // Safety hook: snapshot the app's data before tearing it down, so an
    // accidental or regretted uninstall has a restore point. Best-effort — a
    // backup failure must never block the uninstall the operator asked for.
    if (this.appBackupConfig.autoBackupBeforeUninstall && fs.existsSync(appDir)) {
      try {
        await this.performBackup(entry);
      } catch (err) {
        console.warn(
          `[apps] auto-backup before uninstall of "${appName}" failed (continuing): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

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
    // The app is gone — drop its restore marker so a later install of the same
    // name does not inherit a failure that belonged to the previous one.
    this.restoreFailures.delete(appName);
  }

  // ─── Backup / Restore ───────────────────────────────────────────────────────

  /**
   * Start an async backup job. Returns jobId immediately; poll {@link getJob}.
   * A backup is a permission-safe snapshot of the app's Docker named volumes +
   * config (`.env`/`app.yaml`/compose) into a single archive under
   * `<backupsDir>/<app>/`. The app is stopped for the snapshot and restarted
   * afterwards (see {@link performBackup}).
   */
  backup(appName: string): string {
    this.pruneOldJobs();
    if (this.installingNames.has(appName)) {
      throw new Error(`App "${appName}" is busy (install/update/backup in progress)`);
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

    void this.runBackup(job, appName)
      .catch((err: unknown) => this.failJob(job, err instanceof Error ? err.message : String(err)))
      .finally(() => this.installingNames.delete(appName));

    return jobId;
  }

  /**
   * Start an async restore job. Returns jobId immediately; poll {@link getJob}.
   * Restores the app's volumes + config from a prior backup, then starts it.
   */
  restore(appName: string, backupId: string): string {
    this.pruneOldJobs();
    if (this.installingNames.has(appName)) {
      throw new Error(`App "${appName}" is busy (install/update/backup in progress)`);
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

    void this.runRestore(job, appName, backupId)
      .catch((err: unknown) => this.failJob(job, err instanceof Error ? err.message : String(err)))
      .finally(() => this.installingNames.delete(appName));

    return jobId;
  }

  /** List an app's backups, newest first. Reads the sidecar manifests. */
  listBackups(appName: string): BackupInfo[] {
    const dir = this.appBackupDir(appName);
    if (!fs.existsSync(dir)) return [];
    const infos: BackupInfo[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(dir, file), 'utf-8'),
        ) as BackupMetadata;
        // Only surface a backup whose archive is actually present.
        if (!fs.existsSync(path.join(dir, `${meta.id}.tar.gz`))) continue;
        infos.push({
          id: meta.id,
          createdAt: meta.createdAt,
          sizeBytes: meta.sizeBytes,
          appVersion: meta.appVersion,
        });
      } catch {
        /* skip malformed manifest */
      }
    }
    return infos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Delete one backup (archive + sidecar). Idempotent. */
  deleteBackup(appName: string, backupId: string): void {
    if (!/^[\w.-]+$/.test(backupId)) throw new Error(`Invalid backup id "${backupId}"`);
    const dir = this.appBackupDir(appName);
    for (const ext of ['.tar.gz', '.json']) {
      const p = path.join(dir, `${backupId}${ext}`);
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  private async runBackup(job: JobState, appName: string): Promise<void> {
    job.status = 'running';
    const entry = await this.registry.get(appName);
    if (!entry) throw new Error(`App "${appName}" is not installed`);
    const info = await this.performBackup(entry, (m) => this.log(job, m));
    job.backup = info;
    job.status = 'completed';
    job.updatedAt = Date.now();
  }

  private async runRestore(job: JobState, appName: string, backupId: string): Promise<void> {
    job.status = 'running';
    const entry = await this.registry.get(appName);
    if (!entry) throw new Error(`App "${appName}" is not installed`);
    const info = await this.performRestore(entry, backupId, (m) => this.log(job, m));
    job.backup = info;
    job.status = 'completed';
    job.updatedAt = Date.now();
  }

  /**
   * Core backup routine (shared by the job path and the auto-backup hooks).
   *
   * Consistency: a running app is stopped for the snapshot so no writes land
   * mid-tar, then ALWAYS restarted in a `finally` — a backup that throws never
   * leaves the app stuck stopped.
   *
   * Permission safety: each named volume is tarred inside a throwaway root
   * container (`docker run … tar czf`), so uid/gid/mode are preserved in the
   * archive and no host `cp`/`chown`/sudo ever touches the volume data.
   */
  private async performBackup(
    entry: AppEntry,
    logSink?: (m: string) => void,
  ): Promise<BackupInfo> {
    const log = (m: string): void => logSink?.(m);
    const appName = entry.name;
    const appDir = entry.installPath;
    if (!fs.existsSync(appDir)) {
      throw new Error(`App "${appName}" directory is gone — cannot back up`);
    }

    const volumes = this.discoverVolumes(appName, appDir);
    const bindMounts = this.discoverBindMounts(appName, appDir);
    const wasRunning = (await this.queryRuntimeStatus(entry)) === 'running';
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), `bkp-${appName}-`));

    try {
      if (wasRunning) {
        log(`Stopping "${appName}" for a consistent snapshot`);
        this.run(['docker', 'compose', '-p', appName, 'stop'], appDir, 120_000);
      }

      const volDir = path.join(staging, 'volumes');
      fs.mkdirSync(volDir, { recursive: true });
      for (const vol of volumes) {
        log(`Archiving volume "${vol}"`);
        this.run(
          [
            'docker', 'run', '--rm',
            '-v', `${appName}_${vol}:/data:ro`,
            '-v', `${volDir}:/backup`,
            BACKUP_HELPER_IMAGE,
            'tar', 'czf', `/backup/${vol}.tar.gz`, '-C', '/data', '.',
          ],
          undefined,
          VOLUME_TAR_TIMEOUT_MS,
        );
      }

      // Bind-mount data dirs under the app dir (not Docker named volumes).
      // Archive each with the same root-helper tar so ownership (e.g. the
      // postgres uid) survives without host-side cp/sudo. Indexed filenames
      // avoid collisions between paths that flatten to the same name.
      const bindDir = path.join(staging, 'binds');
      fs.mkdirSync(bindDir, { recursive: true });
      const capturedBinds: string[] = [];
      for (const rel of bindMounts) {
        const abs = path.join(appDir, rel);
        if (!fs.existsSync(abs)) {
          log(`Bind mount "${rel}" missing on disk — skipping`);
          continue;
        }
        log(`Archiving bind mount "${rel}"`);
        this.run(
          [
            'docker', 'run', '--rm',
            '-v', `${abs}:/data:ro`,
            '-v', `${bindDir}:/backup`,
            BACKUP_HELPER_IMAGE,
            'tar', 'czf', `/backup/bind-${capturedBinds.length}.tar.gz`, '-C', '/data', '.',
          ],
          undefined,
          VOLUME_TAR_TIMEOUT_MS,
        );
        capturedBinds.push(rel);
      }

      // Config (owned by the gateway user, copied on the host).
      const cfgDir = path.join(staging, 'config');
      fs.mkdirSync(cfgDir, { recursive: true });
      for (const f of ['.env', 'app.yaml', 'docker-compose.yml']) {
        this.copyIfExists(path.join(appDir, f), path.join(cfgDir, f));
      }

      const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
        .randomUUID()
        .slice(0, 8)}`;
      const meta: BackupMetadata = {
        id,
        appName,
        appVersion: entry.version,
        createdAt: new Date().toISOString(),
        volumes,
        bindMounts: capturedBinds,
        sizeBytes: 0,
      };
      fs.writeFileSync(path.join(staging, 'metadata.json'), JSON.stringify(meta, null, 2));

      const outDir = this.appBackupDir(appName);
      fs.mkdirSync(outDir, { recursive: true });
      const archivePath = path.join(outDir, `${id}.tar.gz`);
      // The gateway host tars the staging tree. Volume tarballs written by the
      // root helper are world-readable (0644), so this read succeeds without sudo.
      this.run(['tar', 'czf', archivePath, '-C', staging, '.'], undefined, VOLUME_TAR_TIMEOUT_MS);

      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(archivePath).size;
      } catch {
        /* archive stat failed — leave size 0 */
      }
      meta.sizeBytes = sizeBytes;
      fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(meta, null, 2));

      this.pruneBackups(appName);
      log(
        `Backup "${id}" complete (${sizeBytes} bytes, ${volumes.length} volume(s), ` +
          `${capturedBinds.length} bind mount(s))`,
      );
      return { id, createdAt: meta.createdAt, sizeBytes, appVersion: meta.appVersion };
    } finally {
      try {
        this.rmrf(staging);
      } catch {
        /* best-effort staging cleanup */
      }
      if (wasRunning) {
        try {
          log(`Restarting "${appName}"`);
          this.composeUp(appName, appDir);
        } catch (restartErr) {
          log(
            `WARNING: failed to restart "${appName}" after backup: ${
              restartErr instanceof Error ? restartErr.message : String(restartErr)
            }`,
          );
        }
      }
    }
  }

  /**
   * Core restore routine. Extracts the archive, wipes+repopulates each volume
   * via the root helper (preserving inner ownership), restores `.env`, and
   * starts the app on the restored data. Restoring across a differing
   * appVersion is allowed but warns (possible schema/migration mismatch).
   */
  private async performRestore(
    entry: AppEntry,
    backupId: string,
    logSink?: (m: string) => void,
  ): Promise<BackupInfo> {
    const log = (m: string): void => logSink?.(m);
    if (!/^[\w.-]+$/.test(backupId)) throw new Error(`Invalid backup id "${backupId}"`);
    const appName = entry.name;
    const appDir = entry.installPath;
    const archivePath = path.join(this.appBackupDir(appName), `${backupId}.tar.gz`);
    if (!fs.existsSync(archivePath)) {
      throw new Error(`Backup "${backupId}" not found for app "${appName}"`);
    }

    const staging = fs.mkdtempSync(path.join(os.tmpdir(), `rst-${appName}-`));
    try {
      this.run(['tar', 'xzf', archivePath, '-C', staging], undefined, VOLUME_TAR_TIMEOUT_MS);
      const meta = JSON.parse(
        fs.readFileSync(path.join(staging, 'metadata.json'), 'utf-8'),
      ) as BackupMetadata;

      if (meta.appVersion !== entry.version) {
        log(
          `WARNING: restoring backup from version "${meta.appVersion}" onto installed "${entry.version}" — possible schema/migration mismatch`,
        );
      }

      log(`Stopping "${appName}" before restore`);
      try {
        this.run(['docker', 'compose', '-p', appName, 'stop'], appDir, 120_000);
      } catch {
        /* may already be stopped */
      }

      const volDir = path.join(staging, 'volumes');
      for (const vol of meta.volumes) {
        const tarball = path.join(volDir, `${vol}.tar.gz`);
        if (!fs.existsSync(tarball)) {
          log(`WARNING: volume "${vol}" missing from backup — skipping`);
          continue;
        }
        log(`Restoring volume "${vol}"`);
        this.run(
          [
            'docker', 'run', '--rm',
            '-v', `${appName}_${vol}:/data`,
            '-v', `${volDir}:/backup`,
            BACKUP_HELPER_IMAGE,
            'sh', '-c',
            // Wipe the live volume, then untar the snapshot (uid/gid preserved).
            `rm -rf /data/* /data/..?* 2>/dev/null; tar xzf /backup/${vol}.tar.gz -C /data`,
          ],
          undefined,
          VOLUME_TAR_TIMEOUT_MS,
        );
      }

      // Restore bind-mount data dirs under the app dir. Indexed filenames match
      // performBackup's capture order. Each restored path is re-checked to stay
      // under the app dir (defense-in-depth against a tampered metadata path).
      const bindDir = path.join(staging, 'binds');
      const bindMounts = meta.bindMounts ?? [];
      bindMounts.forEach((rel, i) => {
        const abs = path.resolve(appDir, rel);
        const base = appDir.endsWith(path.sep) ? appDir : appDir + path.sep;
        if (abs !== appDir && !abs.startsWith(base)) {
          log(`WARNING: bind mount "${rel}" escapes the app dir — skipping`);
          return;
        }
        const tarball = path.join(bindDir, `bind-${i}.tar.gz`);
        if (!fs.existsSync(tarball)) {
          log(`WARNING: bind mount "${rel}" missing from backup — skipping`);
          return;
        }
        log(`Restoring bind mount "${rel}"`);
        this.run(
          [
            'docker', 'run', '--rm',
            '-v', `${abs}:/data`,
            '-v', `${bindDir}:/backup`,
            BACKUP_HELPER_IMAGE,
            'sh', '-c',
            // Wipe the live bind dir, then untar the snapshot (uid/gid preserved).
            `rm -rf /data/* /data/..?* 2>/dev/null; tar xzf /backup/bind-${i}.tar.gz -C /data`,
          ],
          undefined,
          VOLUME_TAR_TIMEOUT_MS,
        );
      });

      // Restore config that carries generated secrets, so the app boots with the
      // same credentials the volume data was created under.
      this.copyIfExists(path.join(staging, 'config', '.env'), path.join(appDir, '.env'));

      log(`Starting "${appName}" on restored data`);
      this.composeUp(appName, appDir);
      await this.registry.updateStatus(appName, 'running').catch(() => {});

      log(`Restore of "${backupId}" complete`);
      return {
        id: meta.id,
        createdAt: meta.createdAt,
        sizeBytes: meta.sizeBytes,
        appVersion: meta.appVersion,
      };
    } finally {
      try {
        this.rmrf(staging);
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * List an app's compose-level named volumes (the top-level `volumes:` keys).
   * Returns [] when the app declares none or the query fails — a config-only
   * backup is still useful (it captures `.env`).
   */
  private discoverVolumes(appName: string, appDir: string): string[] {
    try {
      const { stdout } = this.run(
        ['docker', 'compose', '-p', appName, 'config', '--volumes'],
        appDir,
        30_000,
      );
      return stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Discover bind-mount source directories that live **under the app dir**
   * (e.g. `./data/photos` → `data/photos`). These hold app-owned data that is
   * not a Docker named volume, so {@link discoverVolumes} never reports them —
   * yet they are deleted on uninstall and must be captured in a backup.
   *
   * Returns app-dir-relative POSIX paths, deduped and sorted. Bind mounts whose
   * source resolves outside the app dir (shared host resources such as a
   * read-only `~/.claude/projects`) are intentionally excluded. Best-effort:
   * returns `[]` on any failure, mirroring {@link discoverVolumes}.
   */
  /**
   * The paths a generated compose file may have resolved this app dir to.
   * Local-dev installs symlink the app dir into appsDir, and the generated
   * compose resolves bind sources against the symlink's *realpath*, so both the
   * symlink path and its target must be treated as the app root.
   */
  private bindMountBases(appDir: string): string[] {
    const bases = [appDir];
    try {
      const real = fs.realpathSync(appDir);
      if (real !== appDir) bases.push(real);
    } catch {
      /* app dir unreadable — fall back to the literal path */
    }
    return bases;
  }

  private discoverBindMounts(
    appName: string,
    appDir: string,
    onError: 'empty' | 'throw' = 'empty',
  ): string[] {
    const bases = this.bindMountBases(appDir);
    try {
      const { stdout } = this.run(
        ['docker', 'compose', '-p', appName, 'config', '--format', 'json'],
        appDir,
        30_000,
      );
      const parsed = JSON.parse(stdout) as {
        services?: Record<string, { volumes?: Array<{ type?: string; source?: string }> }>;
      };
      const rels = new Set<string>();
      for (const svc of Object.values(parsed.services ?? {})) {
        for (const vol of svc.volumes ?? []) {
          if (vol.type !== 'bind' || typeof vol.source !== 'string') continue;
          const abs = path.resolve(appDir, vol.source);
          const matched = bases.find((b) => abs === b || abs.startsWith(b + path.sep));
          if (!matched) continue; // outside the app dir
          const rel = path.relative(matched, abs);
          if (rel.length > 0) rels.add(rel.split(path.sep).join('/'));
        }
      }
      return Array.from(rels).sort();
    } catch (err) {
      if (onError === 'empty') return [];
      // Fail closed: the caller is about to move this app's directory, so an
      // unknown bind set would silently strand live state. Only an app whose
      // stored compose anchors nothing to the app dir (under either base) is
      // safe to treat as bind-free.
      const composePath = path.join(appDir, 'docker-compose.yml');
      const compose = fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf-8') : '';
      if (!bases.some((b) => compose.includes(b))) return [];
      throw new Error(`Cannot safely discover bind mounts for update: ${(err as Error).message}`);
    }
  }

  /**
   * Prune an app's backups by the union policy (issue #310): a backup is
   * deleted when it is beyond the retention count **OR** older than
   * `maxAgeDays` — whichever matches. `retention === 0` disables the count cap;
   * `maxAgeDays === 0` disables the age cap. Runs after each successful backup
   * and from the daily scheduler.
   */
  private pruneBackups(appName: string, now = Date.now()): void {
    const { retention, maxAgeDays } = this.appBackupConfig;
    if (retention <= 0 && maxAgeDays <= 0) return; // both caps disabled
    const all = this.listBackups(appName); // newest first
    const doomed = new Set<string>();
    // Count cap: everything past the N newest.
    if (retention > 0) {
      for (const stale of all.slice(retention)) doomed.add(stale.id);
    }
    // Age cap: anything older than the cutoff (union — dedupe via the set).
    if (maxAgeDays > 0) {
      const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
      for (const b of all) {
        const created = Date.parse(b.createdAt);
        if (!Number.isNaN(created) && created < cutoff) doomed.add(b.id);
      }
    }
    for (const id of doomed) this.deleteBackup(appName, id);
  }

  /**
   * Prune **every** app's backups by the union policy. Enumerates the backup
   * subdirs under `.backups/` (skipping anything that is not a valid app name),
   * so it also reaches apps that are no longer being backed up. Best-effort:
   * a failure on one app never aborts the sweep.
   */
  cleanupAllBackups(now = Date.now()): void {
    const { retention, maxAgeDays } = this.appBackupConfig;
    if (retention <= 0 && maxAgeDays <= 0) return; // both caps disabled
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.backupsDir, { withFileTypes: true });
    } catch {
      return; // no backups dir yet — nothing to prune
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!APP_NAME_RE.test(entry.name)) continue; // skip stray dirs
      try {
        this.pruneBackups(entry.name, now);
      } catch {
        /* best-effort — one bad app must not abort the sweep */
      }
    }
  }

  /**
   * Start the daily backup-cleanup scheduler (issue #310). Fires once per day at
   * `cleanupHour` in `cleanupTimezone`, pruning all apps by the union policy.
   * Returns a cancel function. No-op (returns a noop canceller) when both caps
   * are disabled. The timer is `unref`'d so it never holds the event loop open.
   */
  /**
   * Reclaim the `.cg-update-*` staging checkout a crashed or killed update left
   * behind. Staging moved next to the install path so the swap is a
   * same-filesystem rename, which also means `/tmp` cleanup no longer collects
   * it — without this sweep a mid-update crash leaks a full app checkout
   * forever.
   *
   * Release snapshots (`-old-`/`-failed-`) are **reported, never removed**: see
   * {@link RELEASE_SNAPSHOT_DIR_RE}. They can hold the only copy of a live bind
   * mount, and this sweep deletes with root.
   *
   * **Boot only.** An update in flight owns directories matching these names,
   * so this must run before any update can start. Never throws; a directory it
   * cannot remove is reported and skipped.
   */
  async sweepStaleUpdateDirs(): Promise<string[]> {
    const swept: string[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(this.appsDir);
    } catch {
      return swept; // no apps dir yet
    }
    // An installPath is authoritative — never remove a directory an app still
    // points at, however its name happens to look.
    let live: Set<string>;
    try {
      live = new Set((await this.registry.list()).map((a) => a.installPath));
    } catch {
      return swept; // registry unreadable — do not guess
    }
    for (const name of names) {
      const full = path.join(this.appsDir, name);
      if (live.has(full)) continue;
      if (RELEASE_SNAPSHOT_DIR_RE.test(name)) {
        console.warn(
          `[installer] keeping app release snapshot "${full}" — it may hold the only copy of a `
          + 'bind mount an update could not move back. Recover or delete it by hand.',
        );
        continue;
      }
      if (!STALE_UPDATE_DIR_RE.test(name)) continue;
      try {
        this.rmrf(full);
        swept.push(full);
      } catch (err) {
        console.warn(`[installer] failed to sweep stale update dir "${full}": ${(err as Error).message}`);
      }
    }
    return swept;
  }

  startBackupCleanup(): () => void {
    const { retention, maxAgeDays, cleanupHour, cleanupTimezone } = this.appBackupConfig;
    if (retention <= 0 && maxAgeDays <= 0) return () => {};
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = msUntilNextHour(cleanupHour, cleanupTimezone);
      timer = setTimeout(() => {
        try {
          this.cleanupAllBackups();
        } catch {
          /* best-effort */
        }
        schedule(); // reschedule for the next day
      }, delay);
      if (typeof (timer as NodeJS.Timeout).unref === 'function') {
        (timer as NodeJS.Timeout).unref();
      }
    };
    schedule();
    return () => clearTimeout(timer);
  }

  private appBackupDir(appName: string): string {
    // Never trust the name reaching the filesystem: an unvalidated value (e.g.
    // a `%2F`-smuggled `../../x` from a route param) would let path.join escape
    // the backups tree. Every backup op funnels through here, so this one guard
    // covers backup/restore/list/delete.
    if (!APP_NAME_RE.test(appName)) throw new Error(`Invalid app name "${appName}"`);
    return path.join(this.backupsDir, appName);
  }

  private copyIfExists(src: string, dest: string): void {
    try {
      if (fs.existsSync(src)) fs.copyFileSync(src, dest);
    } catch {
      /* best-effort — a missing/unreadable optional file is not fatal */
    }
  }

  async startStopRestart(
    appName: string,
    action: 'start' | 'stop' | 'restart',
  ): Promise<void> {
    const entry = await this.registry.get(appName);
    if (!entry) throw new Error(`App "${appName}" is not installed`);

    // Refuse while a mutating job (install/update/reconfigure/backup/restore)
    // holds this app, and claim the same per-app mutex for the duration so those
    // jobs cannot start mid-operation — otherwise `docker compose stop`/`up`
    // here races the containers an install is bringing up. Mirrors the guard in
    // backup()/restore(); the HTTP layer maps this "busy" message to 409.
    if (this.installingNames.has(appName)) {
      throw new Error(`App "${appName}" is busy (install/update/backup in progress)`);
    }
    this.installingNames.add(appName);
    try {
      if (action === 'stop') {
        this.run(['docker', 'compose', '-p', appName, 'stop'], entry.installPath, 60_000);
        await this.registry.updateStatus(appName, 'stopped');
      } else {
        // start / restart: stop conflicting containers and wait for healthcheck
        this.composeUp(appName, entry.installPath);
        await this.registry.updateStatus(appName, 'running');
      }
      // An explicit operator action supersedes this boot's restore attempt: a
      // stop is a deliberate `stopped`, a start replaced the failed one. Only
      // cleared on success — if the action threw, the app is still in the state
      // the failed restore left it in and stays eligible for the next retry.
      this.restoreFailures.delete(appName);
    } finally {
      this.installingNames.delete(appName);
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
   * see the truth. The one exception is an app whose boot restore failed: see
   * {@link restoreRunningApps} for why that must not be written down.
   */
  async reconcileStatus(entry: AppEntry): Promise<AppEntry> {
    const live = await this.queryRuntimeStatus(entry);
    // Up and serving — whatever went wrong at boot has since been resolved
    // (dockerd finished, an operator started it), so drop the stale marker.
    if (live === 'running') this.restoreFailures.delete(entry.name);
    if (live === entry.status) return entry;
    // A failed boot restore must NOT rewrite `running` → `stopped`.
    // restoreRunningApps() only considers entries stored as `running`, so
    // persisting `stopped` here is exactly what excludes the app from every
    // future boot restore — one slow cold build would latch it off for good
    // (issue #425). Report `error` instead: honest (it is not serving), and
    // distinguishable from a deliberate stop — GET /api/v1/apps pairs it with
    // the reason from {@link getRestoreFailure} — while the stored `running`
    // intent survives for the next boot to retry.
    if (live === 'stopped' && entry.status === 'running' && this.restoreFailures.has(entry.name)) {
      // Matches the persisted path below: a corrected status carries a fresh
      // timestamp whether or not the write happened.
      return { ...entry, status: 'error', updatedAt: new Date().toISOString() };
    }
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
    // So does a boot-time restore: its `compose build`/`up` has not created the
    // containers yet, so a read landing mid-restore sees an empty list, maps it
    // to `stopped`, and reconcileStatus() persists that underneath the restore.
    // On a cold host the window is minutes, not seconds (issue #425).
    if (this.restoringNames.has(entry.name)) return entry.status;
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
   *
   * Each app is marked in-flight for the duration ({@link restoringNames}) so a
   * concurrent status read cannot persist `stopped` underneath it, and a failure
   * is recorded ({@link getRestoreFailure}) so it is visible through the apps API
   * rather than only in the log, and so reconcileStatus() keeps the app eligible
   * for the next boot's restore instead of latching it off (issue #425).
   *
   * @param pending the batch from a prior {@link markRestorePending} call. Boot
   *   passes one so the marking is already done before the HTTP server starts
   *   listening; omitting it marks the batch here, which is correct for any
   *   caller that is not racing live status reads.
   */
  async restoreRunningApps(
    pending?: AppEntry[],
  ): Promise<{ attempted: number; failures: Array<{ app: string; error: string }> }> {
    const running = pending ?? (await this.markRestorePending());
    const failures: Array<{ app: string; error: string }> = [];

    // Mark the WHOLE batch in flight before any worker starts, not per worker.
    // The pool runs at most RESTORE_MAX_CONCURRENCY at a time, so marking inside
    // the worker would leave every queued app unprotected for as long as the
    // apps ahead of it take — minutes on a cold host. A status read landing in
    // that window persists `running` → `stopped`, and once that is stored the
    // no-latch guard in reconcileStatus() no longer applies (it requires the
    // stored status to still be `running`), so a later failure would latch the
    // app off for good — the exact outcome this path exists to prevent (#425).
    // Re-marking a `pending` batch is a no-op (Set.add is idempotent) and keeps
    // the invariant owned here rather than by the caller.
    for (const entry of running) this.restoringNames.add(entry.name);

    // Bounded-concurrency worker pool: workers pull from a shared cursor until
    // the list is drained, so at most RESTORE_MAX_CONCURRENCY compose-ups run at
    // once. push() is safe across workers — JS is single-threaded between awaits.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < running.length) {
        const entry = running[cursor++];
        try {
          await this.composeUpAsync(entry.name, entry.installPath);
          this.restoreFailures.delete(entry.name);
        } catch (err) {
          const error = (err as Error).message;
          failures.push({ app: entry.name, error });
          this.restoreFailures.set(entry.name, { error, at: new Date().toISOString() });
        } finally {
          // Released per app, not per batch, so an app that is already up stops
          // being shielded the moment its own restore ends.
          this.restoringNames.delete(entry.name);
        }
      }
    };
    const poolSize = Math.min(RESTORE_MAX_CONCURRENCY, running.length);
    try {
      await Promise.all(Array.from({ length: poolSize }, () => worker()));
    } finally {
      // Safety net for anything the per-app finally could not reach: a leaked
      // marker would freeze that app's status reporting for the whole process.
      for (const entry of running) this.restoringNames.delete(entry.name);
    }

    return { attempted: running.length, failures };
  }

  /**
   * Phase 1 of the boot restore: read the registry and mark every app stored as
   * `running` in flight, returning that batch for {@link restoreRunningApps}.
   *
   * Exists because the marking is what makes the suppression in {@link
   * queryRuntimeStatus} apply, and it cannot be done synchronously — the
   * registry read is async. Doing it inside restoreRunningApps() left a window
   * between the HTTP server accepting requests and the marks landing: a
   * `GET /api/v1/apps` in that window queries Docker, finds no containers (the
   * host reboot took them down), and persists `running` → `stopped`. If that
   * write lands before the registry read here, the app is filtered out of the
   * batch and never restored at all — the #425 latch-off, reached through the
   * very code that exists to prevent it. Boot therefore awaits this BEFORE
   * `router.start()`, then fires the restore itself in the background.
   *
   * Callers that are not racing live reads can skip it: restoreRunningApps()
   * calls this itself when no batch is supplied.
   */
  async markRestorePending(): Promise<AppEntry[]> {
    const apps = await this.registry.list();
    const running = apps.filter((e) => e.status === 'running');
    for (const entry of running) this.restoringNames.add(entry.name);
    return running;
  }

  /**
   * Why this boot's restore of `appName` failed, or `undefined` when the last
   * restore succeeded (or never ran). Lets `GET /api/v1/apps` tell an app the
   * gateway tried and failed to start apart from one an operator stopped —
   * previously the difference existed only in the boot log.
   */
  getRestoreFailure(appName: string): RestoreFailure | undefined {
    return this.restoreFailures.get(appName);
  }

  /**
   * Whether this process's boot restore is currently bringing `appName` up.
   *
   * Reads {@link restoringNames} — the same set {@link queryRuntimeStatus}
   * consults at :1439 — rather than tracking a second copy, so the flag cannot
   * disagree with the suppression it describes. That suppression is why the
   * accessor is needed at all: while a restore holds an app, its stored status
   * is returned unreconciled, and the set restored is exactly the apps stored
   * as `running` ({@link restoreRunningApps}), so a rebuild that takes minutes
   * on a cold host reports a flat `running` with no containers behind it. The
   * apps API pairs this with that status so a client can tell rebuilding from
   * serving (issue #446); the failed case is {@link getRestoreFailure}.
   *
   * In-memory and process-local: never persisted to `apps.json`.
   */
  isRestoring(appName: string): boolean {
    return this.restoringNames.has(appName);
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
    // Carry over an existing .env before writing, but ONLY for a local
    // (symlinked) install. A local install can re-point at a source tree that
    // still holds a prior .env alongside persisted data (e.g. a postgres pgdata
    // bind mount). writeEnvFile treats an already-present generated secret as
    // pinned, so reusing the existing .env keeps DB_PASSWORD/etc. stable and
    // lets the app reconnect to that data instead of failing auth (mirrors the
    // reconfigure path). This is deliberately scoped to `source === 'local'`:
    // a registry/GitHub install checks out into appDir, and a repo that
    // committed a `.env` would otherwise get its secrets pinned to committed
    // values — so for those sources we ignore any checked-out .env and generate
    // fresh, unchanged from before. Operator-supplied envVars still win.
    this.log(job, 'Writing .env');
    const existingEnv = source === 'local' ? this.readEnvFile(appDir) : {};
    const mergedEnv = { ...existingEnv, ...(options.envVars ?? {}) };
    const generatedNames = this.writeEnvFile(appDir, appName, generated, mergedEnv);
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

    // ── Housekeeping: reclaim leaked build cache + dangling images ────────
    // Best-effort, config-gated, after the new stack is up (issue #302).
    this.pruneAfterBuild(job);

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

    // Safety hook: snapshot before the update so a bad new image can be rolled
    // back. Best-effort — a backup failure must not block the update.
    if (this.appBackupConfig.autoBackupBeforeUpdate) {
      try {
        const info = await this.performBackup(entry, (m) => this.log(job, m));
        this.log(job, `Pre-update backup "${info.id}" created`);
      } catch (err) {
        this.log(
          job,
          `WARNING: pre-update backup failed (continuing): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Stage beside the durable install path so the directory swap and bind-data
    // moves are same-filesystem renames, not cross-device copies/failures.
    const tmpDir = path.join(
      path.dirname(entry.installPath),
      `.cg-update-${appName}-${crypto.randomUUID()}`,
    );
    // Rollback tags held on the images this update is about to build over.
    // Declared out here so every exit path can drop them again.
    let preservedImages: PreservedImage[] = [];
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
        agentDeclaration: generated.agentDeclaration,
        ...(agentPaths ? { agentPaths } : {}),
      };

      if (generated.agentDeclaration && this.agentManager && agentPaths) {
        this.agentManager.injectAgentService(newEntry);
      }

      // Pin the images the app is running before the build takes their tags
      // over. A `build:` service's new image reuses the old tag
      // (`<project>-<service>`), so once the build succeeds that tag names the
      // new release: rolling only the source back would bring the app up on the
      // failed release's image and crash-loop on a "successful" rollback. This
      // has to happen before the build — afterwards the old image has no
      // reference left to grab it by.
      preservedImages = this.preserveRunningImages(appName, entry.installPath, job);

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

      // Discover the app-owned bind paths while the old compose file still points
      // at the durable install directory. They must move with the release swap so
      // cleanup cannot delete live state. This query fails closed, so it runs
      // *before* routes and sockets come down — a throw here would otherwise
      // leave the app running but unreachable, with no path back.
      const oldBindMounts = this.discoverBindMounts(appName, entry.installPath, 'throw');

      // ── Deregister old routes before taking down containers ───────────────
      this.callbacks.deregisterRoutes(appName);
      this.callbacks.stopSockets(appName);

      // Capture the current (old) image IDs while the old compose file is still
      // the live one, so the reclaim below targets exactly this app's images.
      const oldImageIds = this.captureComposeImageIds(appName, entry.installPath);
      const oldImageRefs = this.captureComposeImageRefs(appName, entry.installPath);

      // ── Swap dirs before starting the new containers ───────────────────────
      // The new compose file's bind sources are anchored to finalDir. Starting
      // before this swap would bind the old directory inode then delete it.
      this.log(job, 'Stopping old containers');
      this.run(['docker', 'compose', '-p', appName, 'down'], entry.installPath, 120_000);
      this.log(job, 'Swapping app directories');
      const finalDir = entry.installPath;
      const oldBackupDir = `${finalDir}-old-${crypto.randomUUID()}`;
      let swapped = false;
      let reachedContainerStart = false;
      let failedDir: string | null = null;
      const movedBindMounts: string[] = [];
      try {
        fs.renameSync(finalDir, oldBackupDir);
        fs.renameSync(tmpDir, finalDir);
        swapped = true;
        this.moveBindMounts(oldBackupDir, finalDir, oldBindMounts, job, movedBindMounts);

        // The source checkout is now permanent. Rewrite the compose file with
        // finalDir as its base so every bind source and build context resolves
        // to the durable path — this call is kept for that side effect; its
        // return value necessarily matches `generated` (same app.yaml). The
        // rewrite drops the injected agent service, so re-inject it after.
        const finalComposePath = path.join(finalDir, 'docker-compose.yml');
        const finalYaml = parseAppYaml(fs.readFileSync(path.join(finalDir, 'app.yaml'), 'utf-8'), finalDir);
        generateCompose(finalYaml, appName, finalDir, finalComposePath);
        if (generated.agentDeclaration && this.agentManager && agentPaths) {
          this.agentManager.injectAgentService({ ...newEntry, installPath: finalDir });
        }

        // ── Start new containers ────────────────────────────────────────────
        this.log(job, 'Starting new containers');
        reachedContainerStart = true;
        this.composeUp(appName, finalDir, job);
      } catch (upErr) {
        // The catch spans the whole swap, so a failure here is not necessarily a
        // container failure — saying it is sends diagnosis to the wrong
        // subsystem (a bind-mount move that threw looked exactly like a crashed
        // container in the job log).
        this.log(job, reachedContainerStart
          ? 'New containers failed — rolling back to previous version'
          : `Update failed during the directory swap — rolling back to previous version: ${(upErr as Error).message}`);
        let rollbackFailed = false;
        failedDir = `${finalDir}-failed-${crypto.randomUUID()}`;
        try {
          let unrestored: string[] = [];
          if (swapped) {
            fs.renameSync(finalDir, failedDir);
            fs.renameSync(oldBackupDir, finalDir);
            unrestored = this.restoreBindMounts(failedDir, finalDir, movedBindMounts, job);
          } else if (fs.existsSync(oldBackupDir)) {
            fs.renameSync(oldBackupDir, finalDir);
          }
          // Point every tag back at the image the app was actually running
          // before this update built over it, so the restored source and the
          // restored image are the same release. Falls back to rebuilding from
          // the restored source when an old image is no longer on disk.
          //
          // This has to happen even when the bind restore below refuses to
          // start the app: the source is already back on the previous release,
          // so `<app>-<service>:latest` must name that release's build before
          // *anything* starts it. Leaving it on the failed release's build
          // means an operator who finishes the recovery by hand brings old
          // source up on a new image — the crash-loop `preserveRunningImages`
          // exists to prevent.
          const rebuild = !this.restorePreservedImages(preservedImages, finalDir, job);
          if (unrestored.length > 0) {
            // Throwing here is deliberate: it skips both the container start
            // below and the safeRmrf of failedDir, so the only copy of that
            // data stays on disk. Starting the app on a half-restored
            // directory is worse than not starting it — postgres on an empty
            // pgdata initialises a fresh cluster and then looks healthy.
            throw new Error(
              `live bind-mount data for ${unrestored.map((r) => `"${r}"`).join(', ')} could not be moved back `
              + `— it is still in "${failedDir}", which has been kept. Move those paths back into `
              + `"${finalDir}" before starting the app.`,
            );
          }
          const upArgs = ['docker', 'compose', '-p', appName, 'up', '-d'];
          if (rebuild) upArgs.push('--build');
          this.run(upArgs, finalDir, rebuild ? 600_000 : 120_000);
          this.callbacks.registerRoutes(appName, entry.ports.map((p) => ({
            name: p.name,
            service: p.service,
            hostPort: p.hostPort,
            containerPort: p.containerPort,
            type: p.type,
            rateLimit: p.rateLimit,
          })));
          await this.registry.updateStatus(appName, 'running');
          if (failedDir !== null) this.safeRmrf(failedDir, job, 'failed update dir');
        } catch (rollbackErr) {
          rollbackFailed = true;
          this.log(job, `ROLLBACK FAILED — app "${appName}" may be in a broken state: ${(rollbackErr as Error).message}`);
        }
        if (rollbackFailed) {
          // Keep the private `cg-rollback-*` tags: they are the only remaining
          // reference to the pre-update build, and the outer catch drops them.
          // Clearing the list here is what stops that — an incomplete rollback
          // is finished by hand, and that recovery needs the old image to still
          // exist. Untagged, containerd is free to reclaim it.
          if (preservedImages.some((i) => i.backupRef)) {
            this.log(job, `Pre-update images kept for manual recovery: ${
              preservedImages.filter((i) => i.backupRef).map((i) => `"${i.backupRef}" (for "${i.ref}")`).join(', ')
            }`);
          }
          preservedImages = [];
          // The success path above sets 'running'. Leaving the registry on the
          // pre-update 'running' here would report a healthy app that is not
          // running at all — and this branch now includes the case where the
          // app was deliberately not restarted.
          await this.registry.updateStatus(appName, 'error').catch(() => {});
          throw new Error(`Update failed and rollback also failed — app "${appName}" may be in a broken state. Check job logs for details.`);
        }
        throw upErr;
      }

      // The new stack is up: the previous images are no longer a rollback
      // target. Untag them before the reclaim below, which removes by image ID
      // and would be refused while a second reference exists.
      this.dropPreservedImageTags(preservedImages);
      preservedImages = [];

      // Capture the new stack's image IDs from its permanent compose file so
      // cleanup below never removes an image the new containers depend on.
      const newImageIds = this.captureComposeImageIds(appName, finalDir);
      const newImageRefs = this.captureComposeImageRefs(appName, finalDir);

      // ── Update registry ───────────────────────────────────────────────────
      const finalEntry: AppEntry = {
        ...newEntry,
        installPath: finalDir,
        updatedAt: new Date().toISOString(),
        status: 'running',
      };
      await this.registry.upsert(finalEntry);

      // ── Re-create, rename, or remove the app-agent registration ───────────
      // `upsertAgent` keys off the *new* agent name, so a release that drops or
      // renames its agent would otherwise strand the previous workspace symlink
      // and config.json entry. Both transitions are the same deregistration.
      const oldAgentName = entry.agentDeclaration?.name ?? null;
      const newAgentName = generated.agentDeclaration?.name ?? null;
      if (this.agentManager && oldAgentName !== null && oldAgentName !== newAgentName) {
        await this.agentManager.deleteAgentByName(oldAgentName);
        this.log(
          job,
          newAgentName === null
            ? `Agent "${oldAgentName}" removed`
            : `Agent "${oldAgentName}" deregistered (renamed to "${newAgentName}")`,
        );
      }
      if (generated.agentDeclaration && this.agentManager) {
        await this.agentManager.upsertAgent(finalEntry);
        this.log(job, `Agent "${generated.agentDeclaration.name}" re-registered`);
        // MEMORY.md must be written *after* registration: restoreMemory resolves
        // the workspace through config.json, so on a rename the new name is not
        // resolvable until upsertAgent has written its entry.
        if (memoryBackup !== null) {
          this.agentManager.restoreMemory(generated.agentDeclaration.name, memoryBackup);
          this.log(job, 'MEMORY.md restored');
        }
        await this.callbacks.reinitializeAgent?.(generated.agentDeclaration.name);
      }

      // ── Re-register proxy routes + sockets ───────────────────────────────
      this.callbacks.registerRoutes(appName, generated.ports);
      for (const sock of generated.sockets) {
        const sockPath = sock.hostSocketPath;
        await this.callbacks.startSocket(sockPath, sock, sock.scripts, finalDir);
      }

      // ── Reclaim old images (best-effort) ──────────────────────────────────
      // Do NOT `compose -p <app> down` the backup dir here: `down` selects
      // resources by the project label, and the freshly-started new stack now
      // shares `project=<app>`, so it would stop & remove the *new* container
      // (issue #283). The old containers were already removed by the "Stopping
      // old containers" step, so only the old images remain to reclaim. Remove
      // each old image that the new stack does not still depend on.
      const newImageSet = new Set(newImageIds);
      for (const imageId of oldImageIds) {
        if (newImageSet.has(imageId)) continue; // shared with new stack — keep
        try {
          this.run(['docker', 'image', 'rm', imageId], os.tmpdir(), 60_000);
        } catch { /* still in use or already gone — non-fatal */ }
      }
      // Reclaim a superseded *pulled* tag the image-ID reclaim above can't
      // (a pulled image with >1 repo tag isn't removable by ID) — only this
      // app's own prior refs the new stack no longer uses (issue #302).
      this.reclaimSupersededTags(job, oldImageRefs, newImageRefs);
      this.safeRmrf(oldBackupDir, job, 'old backup dir');

      // ── Housekeeping: reclaim leaked build cache + dangling images ────────
      // Best-effort, config-gated, after the image reclaim (issue #302).
      this.pruneAfterBuild(job);

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
      this.dropPreservedImageTags(preservedImages);
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
    generated: Pick<
      GeneratedCompose,
      'ports' | 'secretKeys' | 'generatedKeys' | 'secretDefaults'
    >,
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
    const secretDefaults = generated.secretDefaults ?? {};
    for (const key of generated.secretKeys) {
      // Precedence: operator-supplied value → declared default → empty. An
      // empty operator value (UI always sends the field, possibly blank) falls
      // through to the default, matching how generated keys treat '' as unset.
      const provided = merged[key];
      const raw =
        provided !== undefined && provided !== ''
          ? provided
          : secretDefaults[key] ?? '';
      envLines.push(`${key}=${raw.replace(/[\r\n]/g, '')}`);
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
      if (isPermissionError(err)) {
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
   * Create `targetDir` under `baseDir`, refusing to traverse or create through a
   * symlink. The check runs **before** each segment is created — a `mkdir -p`
   * that ran first would already have materialised directories on the far side
   * of a symlink, leaving the guard with nothing left to prevent.
   *
   * Scope: this guards the **destination** side — the freshly checked-out
   * release, which is the side an app repo controls. A bind path that was
   * already a symlink in the *previous* app dir is carried across as-is; that
   * preserves an escape the operator set up themselves rather than creating
   * one, and is the behaviour every release before this one had.
   */
  private ensureDirWithinNoSymlink(baseDir: string, targetDir: string): void {
    const relative = path.relative(baseDir, targetDir);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
      throw new Error(`Bind-mount path escapes the app directory: "${targetDir}"`);
    }
    let current = baseDir;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat: fs.Stats | null;
      try {
        stat = fs.lstatSync(current);
      } catch {
        stat = null;
      }
      if (stat === null) {
        fs.mkdirSync(current);
        continue;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Updated app bind-mount source must not be a symlink: "${current}"`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Updated app bind-mount path is not a directory: "${current}"`);
      }
    }
  }

  /** Reject a discovered bind path that does not stay inside both app roots. */
  private isSafeBindRel(fromDir: string, toDir: string, rel: string): boolean {
    if (rel.length === 0 || path.isAbsolute(rel)) return false;
    const fromBase = fromDir.endsWith(path.sep) ? fromDir : fromDir + path.sep;
    const toBase = toDir.endsWith(path.sep) ? toDir : toDir + path.sep;
    return path.resolve(fromDir, rel).startsWith(fromBase)
      && path.resolve(toDir, rel).startsWith(toBase);
  }

  /**
   * Move app-owned relative bind data across an update directory swap.
   * Renaming preserves the database's ownership and inode, unlike copying.
   *
   * A release legitimately ships content at a bind path (a `.gitkeep`, seed
   * files, a tracked `init.sql`), so a collision is normal, not an error. Live
   * state always wins — it is the data the issue exists to protect — but a
   * directory collision is **merged** entry by entry so release-provided files
   * the previous version never had still land. Every rename performed is
   * recorded, app-relative and in order, so a rollback can replay it backwards.
   */
  private moveBindMounts(
    fromDir: string,
    toDir: string,
    rels: string[],
    job: JobState,
    moved?: string[],
  ): void {
    for (const rel of rels) {
      if (!this.isSafeBindRel(fromDir, toDir, rel)) {
        this.log(job, `Warning: skipping bind-mount path outside the app directory: "${rel}"`);
        continue;
      }
      if (!fs.existsSync(path.resolve(fromDir, rel))) continue; // never created
      this.moveBindEntry(fromDir, toDir, rel, job, moved);
    }
  }

  private moveBindEntry(
    fromDir: string,
    toDir: string,
    rel: string,
    job: JobState,
    moved?: string[],
  ): void {
    const source = path.resolve(fromDir, rel);
    const destination = path.resolve(toDir, rel);
    this.ensureDirWithinNoSymlink(toDir, path.dirname(destination));

    let destStat: fs.Stats | null;
    try {
      destStat = fs.lstatSync(destination);
    } catch {
      destStat = null;
    }
    if (destStat === null) {
      this.moveBindPath(source, destination, rel, job);
      moved?.push(rel);
      return;
    }
    if (destStat.isDirectory() && fs.lstatSync(source).isDirectory()) {
      // Merge: recurse so a release-only file inside the directory survives.
      //
      // Entry-by-entry on purpose. Swapping the trees (move the live dir over
      // wholesale, then re-apply the release's own files on top) would be one
      // rename instead of one per live file, but `moved` would no longer be an
      // exact inverse: a rollback would carry those re-applied release files
      // into the restored previous app dir. Exact rollback beats the renames,
      // which are same-filesystem and only walk a directory the release also
      // ships content in.
      let entries: string[] | null;
      try {
        entries = fs.readdirSync(source);
      } catch (err) {
        // The live directory is one the app's container owns and the gateway
        // user cannot even list (postgres leaves pgdata 0700). There is no way
        // to merge into it entry by entry, so preserve it wholesale — the same
        // trade the non-directory collision below already makes.
        if (!isPermissionError(err)) throw err;
        entries = null;
      }
      if (entries !== null) {
        // Each child that needs the root helper costs its own container. That
        // is bounded by the live directory's own entry count, and only reached
        // when a release ships tracked content *inside* a path whose children
        // the gateway user cannot rename — rare enough not to trade the exact
        // rollback above for one wholesale move.
        for (const name of entries) {
          this.moveBindEntry(fromDir, toDir, `${rel}/${name}`, job, moved);
        }
        return;
      }
    }
    this.log(
      job,
      `Warning: preserved existing bind-mount data at "${rel}" — the updated release's copy of that path `
      + `was discarded (${this.describeDiscarded(destination)})`,
    );
    fs.rmSync(destination, { recursive: true, force: true });
    this.moveBindPath(source, destination, rel, job);
    moved?.push(rel);
  }

  /**
   * Name what a preserve-the-live-copy collision is about to delete.
   *
   * The discarded side is the release's own checkout, so it is always readable
   * by the gateway user even when the live side is not. Without this the log
   * says only that "the release's copy was discarded" — which reads as a
   * `.gitkeep` and hides the case that matters: a release shipping a new
   * `init.sql` or entrypoint script *inside* a path whose live copy wins, where
   * the file is dropped on every update and nothing ever says which.
   */
  private describeDiscarded(destination: string, limit = 10): string {
    let names: string[];
    try {
      names = fs.statSync(destination).isDirectory()
        ? fs.readdirSync(destination).sort()
        : [path.basename(destination)];
    } catch {
      return 'contents unreadable';
    }
    if (names.length === 0) return 'it was empty';
    const shown = names.slice(0, limit).map((n) => `"${n}"`).join(', ');
    return names.length > limit
      ? `${shown} and ${names.length - limit} more`
      : shown;
  }

  /**
   * Undo {@link moveBindMounts}. Returns the paths it could **not** move back:
   * those still live only under `fromDir`, so the caller must keep that
   * directory rather than clean it up.
   *
   * A path that is missing at the source, or already present at the
   * destination, is not a failure — it needs no move and is not reported.
   */
  private restoreBindMounts(fromDir: string, toDir: string, moved: string[], job: JobState): string[] {
    const unrestored: string[] = [];
    for (const rel of [...moved].reverse()) {
      if (!this.isSafeBindRel(fromDir, toDir, rel)) {
        this.log(job, `Warning: skipping bind-mount path outside the app directory: "${rel}"`);
        unrestored.push(rel);
        continue;
      }
      const source = path.resolve(fromDir, rel);
      const destination = path.resolve(toDir, rel);
      if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
      try {
        this.ensureDirWithinNoSymlink(toDir, path.dirname(destination));
        this.moveBindPath(source, destination, rel, job);
      } catch (err) {
        this.log(job, `Warning: could not restore bind-mount path "${rel}": ${(err as Error).message}`);
        unrestored.push(rel);
      }
    }
    return unrestored;
  }

  /**
   * Move one bind-mount path between app directories.
   *
   * `rename(2)` that moves a **directory** to a different parent needs write
   * permission on the directory itself — the kernel has to update its `..`
   * entry — not just on the two parents, which is exactly what the swap does. A bind mount the app's own container created is owned by that
   * image's uid (postgres initdb leaves its data directory mode 0700), so the
   * gateway user cannot rename it and the update swap failed with EACCES on
   * every attempt.
   *
   * The same host-vs-container ownership split is already handled elsewhere in
   * this file — backups tar through a root helper container, {@link rmrf} falls
   * back to `sudo rm -rf`. The swap was the one path still doing it bare, so
   * the fallback here matches the backup mechanism: a throwaway root container.
   *
   * The helper mounts the **nearest common ancestor** of the two paths rather
   * than each parent separately, and that is load-bearing: two bind mounts are
   * two mount points, so `rename(2)` across them fails EXDEV and busybox `mv`
   * silently degrades to copy-then-unlink. Measured by inode, two mounts give a
   * new inode (a copy) where one mount preserves it (a real rename). For a
   * database directory the degraded path means duplicating it on disk and
   * losing the atomicity the swap depends on.
   *
   * The single mount is therefore the apps root, not one app's directory — the
   * two app directories are siblings under it. The helper is a throwaway
   * container whose only command is the `mv`, and it is reached only after the
   * gateway user's own rename was refused.
   */
  private moveBindPath(source: string, destination: string, rel: string, job: JobState): void {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (err) {
      if (!isPermissionError(err)) throw err;
    }
    const base = commonAncestorDir(source, destination);
    const from = path.relative(base, source);
    const to = path.relative(base, destination);
    if (base === path.parse(base).root || base.includes(':') || from === '' || to === ''
      || from.split(path.sep).includes('..') || to.split(path.sep).includes('..')) {
      // A colon would be read as the mount separator by `docker -v`, silently
      // mounting something other than what was asked for.
      throw new Error(`Cannot move bind-mount path "${rel}" as root: unsafe mount base "${base}"`);
    }
    this.log(
      job,
      `Bind-mount path "${rel}" is not writable by the gateway user (created by the app's container) `
      + '— moving it with a root helper container',
    );
    this.run(
      [
        'docker', 'run', '--rm',
        '-v', `${base}:/mnt`,
        BACKUP_HELPER_IMAGE,
        'mv', path.posix.join('/mnt', from.split(path.sep).join('/')),
        path.posix.join('/mnt', to.split(path.sep).join('/')),
      ],
      undefined,
      BIND_MOVE_TIMEOUT_MS,
    );
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
   *
   * Runs the cold-start steps and `up` under two budgets, but only pays for the
   * cold path when the host actually lacks the images. `up` alone would pull and
   * build whatever is missing, and then that work shares the healthcheck-wait
   * budget — on a host with no image cache (data dir restored onto a fresh
   * machine, migrated host, pruned Docker) that budget expires mid-build, at
   * which point the SIGKILL in {@link defaultAsyncSpawn} *cancels* the build and
   * leaves no image and no container (issue #425).
   */
  private async composeUpAsync(appName: string, dir: string): Promise<void> {
    // Only a cold host pays for pull/build. `up` fetches solely what is missing,
    // whereas `build` re-runs every time it is called — issuing it
    // unconditionally would re-execute every Dockerfile on every boot, and
    // `appHousekeeping` prunes build cache older than a week, so for an app
    // whose image was already there that is a from-scratch rebuild in front of
    // a start that needed none.
    if (await this.needsImageBuild(appName, dir)) {
      // Pull first: services declared with `image:` only are never built, so on
      // a cold host they have to be fetched — and `up` would otherwise fetch
      // them under the short wait budget. `--ignore-buildable` skips the
      // services that build, which the next step handles.
      await this.tryColdStart(appName, dir, ['pull', '--ignore-buildable']);
      await this.tryColdStart(appName, dir, ['build']);
    }
    await this.runAsync(
      ['docker', 'compose', '-p', appName, 'up', '-d', '--wait'],
      dir,
      this.restoreConfig.waitTimeoutMs,
    );
  }

  /**
   * Run one best-effort cold-start step (`pull` / `build`) under the build
   * budget. Errors are swallowed on purpose so `up` stays the single authority
   * on whether the app starts: it re-does whatever is still missing and reports
   * the real failure together with the container logs.
   */
  private async tryColdStart(appName: string, dir: string, step: string[]): Promise<void> {
    try {
      await this.runAsync(
        ['docker', 'compose', '-p', appName, ...step],
        dir,
        this.restoreConfig.buildTimeoutMs,
      );
    } catch {
      /* fall through — `up` redoes it and surfaces the actual failure */
    }
  }

  /**
   * True when at least one image the compose project needs is absent from the
   * local daemon — the cold-host case that must build before it can start.
   *
   * Every failure path here answers `false`. "No signal" must mean "skip the
   * pre-build", which leaves {@link composeUpAsync} behaving exactly as it did
   * before the build step existed — `up` still builds whatever is missing. The
   * opposite default would rebuild apps that only needed starting, which is the
   * cost this probe exists to avoid.
   */
  private async needsImageBuild(appName: string, dir: string): Promise<boolean> {
    let images: string[];
    try {
      const { stdout } = await this.runAsync(
        ['docker', 'compose', '-p', appName, 'config', '--images'],
        dir,
        IMAGE_PROBE_TIMEOUT_MS,
      );
      // Image names come from the app's own compose file, so they are untrusted
      // here: one starting with '-' would be read as a flag by `image inspect`.
      // They are passed as argv (never a shell string), so dropping those is
      // the only guard needed.
      images = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('-'));
    } catch {
      return false;
    }
    if (images.length === 0) return false;
    try {
      // `docker image inspect` exits non-zero when *any* argument is missing,
      // so one call covers the whole project. `--format` keeps the output to
      // one id per image instead of the full manifest JSON.
      const res = await this.spawnAsync(
        'docker',
        ['image', 'inspect', '--format', '{{.Id}}', ...images],
        { cwd: dir, timeoutMs: IMAGE_PROBE_TIMEOUT_MS },
      );
      return res.status !== 0;
    } catch {
      return false;
    }
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

  /**
   * Best-effort: capture the image IDs a compose project's services currently
   * resolve to. Used by {@link update} to reclaim the *previous* version's
   * images after a successful update WITHOUT running `compose down` — `down`
   * selects by the `-p <project>` label, and the freshly-started new stack now
   * shares that label, so a `down` on the old backup dir would tear the new
   * container back down (issue #283). Returns a de-duplicated list of image
   * IDs, or `[]` on any error (nothing to reclaim / docker unavailable).
   */
  /**
   * Tag every image the app is *currently* running under a private
   * `<repo>:cg-rollback-<id>` name, and return the pairs.
   *
   * A `build:` service's new image reuses the tag of the one in production
   * (`<project>-<service>:latest`), so once the update's build succeeds that
   * tag names the new release. Rolling only the source directory back would
   * bring the app up on the failed release's image. Holding a second tag keeps
   * the old image addressable *and* alive — under the containerd image store an
   * untagged image is not kept around as a `<none>` image to find later.
   *
   * Only images this app builds are preserved: compose names them
   * `<project>-<service>`, and a pulled tag (`postgres:16-alpine`) is never
   * overwritten by a build, so it needs no protection. Best-effort throughout —
   * anything that cannot be preserved is simply absent from the result, and the
   * rollback rebuilds from the restored source instead.
   */
  private preserveRunningImages(
    appName: string,
    dir: string,
    job: JobState,
  ): PreservedImage[] {
    let rows: unknown[];
    try {
      const { stdout } = this.run(
        ['docker', 'compose', '-p', appName, 'images', '--format', 'json'],
        dir,
        15_000,
      );
      rows = parseJsonRows(stdout);
    } catch {
      return [];
    }

    const preserved: PreservedImage[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as { ID?: unknown; Repository?: unknown; Tag?: unknown };
      const id = typeof r.ID === 'string' ? r.ID.trim() : '';
      const repo = typeof r.Repository === 'string' ? r.Repository.trim() : '';
      const tag = typeof r.Tag === 'string' && r.Tag.trim() ? r.Tag.trim() : 'latest';
      if (!id || !repo.startsWith(`${appName}-`)) continue;
      const ref = `${repo}:${tag}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const backupRef = `${repo}:${ROLLBACK_TAG_PREFIX}${id.replace(/^sha256:/, '').slice(0, 12)}`;
      try {
        this.run(['docker', 'image', 'tag', id, backupRef], dir, 15_000);
        preserved.push({ ref, backupRef });
      } catch (err) {
        // Recorded with no backup reference: the rollback must know this tag is
        // unprotected and rebuild, rather than read an empty list as "no built
        // images, nothing at risk".
        preserved.push({ ref, backupRef: '' });
        this.log(
          job,
          `Warning: could not preserve image "${ref}" for rollback (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    }
    return preserved;
  }

  /**
   * Put each preserved image back on the reference the update's build took
   * over. Returns true when nothing is at risk (an empty list — the app builds
   * no images) or every reference is back on its original image; false when at
   * least one could not be, so the caller rebuilds from the rolled-back source
   * rather than starting the failed release's build.
   */
  private restorePreservedImages(
    images: PreservedImage[],
    dir: string,
    job: JobState,
  ): boolean {
    let allRestored = true;
    for (const { ref, backupRef } of images) {
      if (!backupRef) {
        allRestored = false;
        this.log(job, `Image "${ref}" was not preserved — rebuilding from the rolled-back source`);
        continue;
      }
      try {
        this.run(['docker', 'image', 'tag', backupRef, ref], dir, 15_000);
        this.log(job, `Restored image "${ref}" to the pre-update build`);
      } catch (err) {
        allRestored = false;
        this.log(
          job,
          `Warning: could not restore image "${ref}" (${
            err instanceof Error ? err.message : String(err)
          }) — rebuilding from the rolled-back source instead`,
        );
      }
    }
    return allRestored;
  }

  /**
   * Drop the private rollback tags. Removing a reference only untags the image
   * while another tag remains, so this never deletes an image the app still
   * uses. Must run before the post-update image reclaim: an extra tag would
   * make `docker image rm <id>` refuse.
   */
  private dropPreservedImageTags(images: PreservedImage[]): void {
    for (const { backupRef } of images) {
      if (!backupRef) continue;
      try {
        this.run(['docker', 'image', 'rm', backupRef], os.tmpdir(), 15_000);
      } catch { /* already gone — non-fatal */ }
    }
  }

  private captureComposeImageIds(appName: string, dir: string): string[] {
    try {
      const { stdout } = this.run(
        ['docker', 'compose', '-p', appName, 'images', '--quiet'],
        dir,
        15_000,
      );
      return [...new Set(
        stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean),
      )];
    } catch {
      return [];
    }
  }

  /**
   * Image references (repo:tag) an app's compose file declares, e.g.
   * "ghcr.io/x/monitor:1.1". Used to reclaim a superseded *pulled* tag on
   * update — a tag bump the image-ID reclaim misses, because a pulled image
   * carrying more than one repo tag cannot be removed by ID (issue #302).
   * Best-effort — returns [] on any error.
   */
  private captureComposeImageRefs(appName: string, dir: string): string[] {
    try {
      const { stdout } = this.run(
        ['docker', 'compose', '-p', appName, 'config', '--images'],
        dir,
        15_000,
      );
      return [...new Set(
        stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean),
      )];
    } catch {
      return [];
    }
  }

  // ─── Docker housekeeping (issue #302) ───────────────────────────────────────

  /** Resolve the housekeeping toggles against their conservative defaults. */
  private resolveHousekeeping(): {
    buildCachePrune: boolean;
    buildCacheMaxAgeHours: number;
    danglingImagePrune: boolean;
  } {
    const hk = this.housekeepingConfig ?? {};
    return {
      buildCachePrune: hk.buildCachePrune ?? true,
      buildCacheMaxAgeHours: hk.buildCacheMaxAgeHours ?? 168,
      danglingImagePrune: hk.danglingImagePrune ?? true,
    };
  }

  /**
   * Best-effort Docker housekeeping after a successful build (install + update).
   * Reclaims ONLY provably-unreferenced junk:
   *   - build cache older than the configured window — time-filtered on purpose
   *     so a concurrent build's fresh layers are never evicted;
   *   - dangling `<none>` images with no container (safe by definition).
   * Gated by config (all toggles off ⇒ no prune calls). Every prune is wrapped
   * so a failure NEVER fails the parent install/update. Enforces the safety
   * floor: no `-a`, no `system prune`, no volume prune (issue #302).
   */
  private pruneAfterBuild(job: JobState): void {
    const hk = this.resolveHousekeeping();
    if (hk.buildCachePrune) {
      try {
        this.run(
          ['docker', 'builder', 'prune', '-f', '--filter', `until=${hk.buildCacheMaxAgeHours}h`],
          os.tmpdir(),
          120_000,
        );
        this.log(job, `Build cache pruned (older than ${hk.buildCacheMaxAgeHours}h)`);
      } catch (err) {
        this.log(job, `Build-cache prune skipped (non-fatal): ${(err as Error).message}`);
      }
    }
    if (hk.danglingImagePrune) {
      try {
        // `image prune -f` (NEVER `-a`) — removes only untagged <none> layers
        // with no container, so tagged images of other stopped apps survive.
        this.run(['docker', 'image', 'prune', '-f'], os.tmpdir(), 120_000);
        this.log(job, 'Dangling images pruned');
      } catch (err) {
        this.log(job, `Dangling-image prune skipped (non-fatal): ${(err as Error).message}`);
      }
    }
  }

  /**
   * Reclaim this app's own superseded pulled tags after an update (issue #302).
   * The image-ID reclaim misses a pulled-tag bump (e.g. monitor:1.1 → :1.2.0):
   * a pulled image with more than one repo tag can't be removed by ID. Remove
   * exactly the app's prior refs that the NEW stack no longer references.
   * `image rm <ref>` fails safely (and is caught) when a container still uses
   * the image, so an in-use image is never yanked. Only this app's own tags are
   * ever touched — never a blanket prune.
   */
  private reclaimSupersededTags(
    job: JobState,
    oldImageRefs: string[],
    newImageRefs: string[],
  ): void {
    const newRefSet = new Set(newImageRefs);
    for (const ref of oldImageRefs) {
      if (newRefSet.has(ref)) continue; // still used by new stack — keep
      try {
        this.run(['docker', 'image', 'rm', ref], os.tmpdir(), 60_000);
        this.log(job, `Reclaimed superseded image tag ${ref}`);
      } catch {
        /* in use / already gone — non-fatal */
      }
    }
  }

  /** Read-only reclaim report (issue #302). Best-effort; never mutates state. */
  housekeepingReport(): HousekeepingReport {
    return this.buildHousekeepingReport();
  }

  /**
   * Execute the SAFE reclaim (build cache + dangling images only) and return a
   * fresh report. This is an explicit operator action, so it runs regardless of
   * the auto-path config toggles — but it still honors the fixed safety floor:
   * never `-a`, never `system prune`, never a volume/auto delete. The build-cache
   * window uses the configured value (default 168h).
   */
  housekeepingPrune(): HousekeepingResult {
    const hk = this.resolveHousekeeping();
    const pruned = { buildCache: false, danglingImages: false };
    try {
      this.run(
        ['docker', 'builder', 'prune', '-f', '--filter', `until=${hk.buildCacheMaxAgeHours}h`],
        os.tmpdir(),
        120_000,
      );
      pruned.buildCache = true;
    } catch {
      /* best-effort */
    }
    try {
      this.run(['docker', 'image', 'prune', '-f'], os.tmpdir(), 120_000);
      pruned.danglingImages = true;
    } catch {
      /* best-effort */
    }
    return { mode: 'prune', pruned, report: this.buildHousekeepingReport() };
  }

  private buildHousekeepingReport(): HousekeepingReport {
    return {
      buildCacheReclaimable: this.readBuildCacheReclaimable(),
      danglingImageCount: this.splitLines(
        this.safeRunStdout(['docker', 'image', 'ls', '--filter', 'dangling=true', '--quiet']),
      ).length,
      orphanVolumes: this.splitLines(
        this.safeRunStdout(['docker', 'volume', 'ls', '--filter', 'dangling=true', '--quiet']),
      ),
    };
  }

  /** `docker` stdout, or '' on any error (report helpers must never throw). */
  private safeRunStdout(args: string[], timeoutMs = 30_000): string {
    try {
      return this.run(args, os.tmpdir(), timeoutMs).stdout;
    } catch {
      return '';
    }
  }

  private splitLines(s: string): string[] {
    return s.trim().split('\n').map((x) => x.trim()).filter(Boolean);
  }

  /** Reclaimable build-cache size from the `docker system df` "Build Cache" row. */
  private readBuildCacheReclaimable(): string {
    const out = this.safeRunStdout([
      'docker', 'system', 'df', '--format', '{{.Type}}\t{{.Reclaimable}}',
    ]);
    for (const line of this.splitLines(out)) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const type = line.slice(0, tab).trim().toLowerCase();
      if (type.includes('build cache')) return line.slice(tab + 1).trim();
    }
    return '';
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
  /**
   * Last exit code of a `restarting` container, parsed from the human-readable
   * `Status` string (`"Restarting (N) …"`). Undefined when the container is not
   * restarting or the code could not be parsed. Docker leaves the structured
   * `ExitCode` field at 0 while a container is restarting, so this is the only
   * signal that separates a crash-loop (N≠0) from a healthy transient restart (N=0).
   */
  restartExitCode?: number;
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
      const rec = o as { State: string; ExitCode?: unknown; Status?: unknown };
      const container: ComposePsContainer = {
        state: rec.State.toLowerCase(),
        exitCode: typeof rec.ExitCode === 'number' ? rec.ExitCode : 0,
      };
      // A restarting container's last exit code lives only in the Status string
      // ("Restarting (N) …"); the ExitCode field reads 0 while restarting. Capture
      // N so the status mapper can tell a crash-loop (N≠0) from a healthy restart.
      if (typeof rec.Status === 'string') {
        const m = /restarting \((\d+)\)/i.exec(rec.Status);
        if (m) container.restartExitCode = Number(m[1]);
      }
      out.push(container);
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
 * Container exit codes produced by a signal kill rather than a crash: 137 =
 * 128+9 (SIGKILL), 143 = 128+15 (SIGTERM). `docker compose stop` sends SIGTERM
 * and, if a container doesn't self-terminate within the grace period, force-kills
 * it with SIGKILL — so a plainly-`exited` container carrying one of these codes
 * is the normal result of a stop, not evidence of a failure. Excluded from the
 * plain-exited → `error` branch below so an explicit Stop reports `stopped`, not
 * `error`. Genuine crash-loops (a `restarting` container with a non-zero
 * `restartExitCode`) are caught earlier and are unaffected by this.
 */
const STOP_SIGNAL_EXIT_CODES = new Set([137, 143]);

/**
 * Map an app's compose-project container states to a single AppEntry status:
 *   - no containers                                   → stopped
 *   - any restarting after a NON-ZERO exit (crash-loop) → error
 *   - any running / restarting (clean/transient)      → running
 *   - any dead, or exited with a non-signal non-zero exit code → error (crash)
 *   - else (clean exit / signal-kill / created / paused) → stopped
 *
 * The crash-loop check comes first and wins over a healthy sibling: a container
 * stuck endlessly restarting on a non-zero exit is not serving, so surfacing it
 * as `error` is more honest than reporting the app `running`. A single clean
 * restart (`Restarting (0) …`) or a container that has already recovered to
 * `running` stays `running` — no flicker for normal transient restarts.
 *
 * A plainly-`exited` (non-restarting) container that was killed by a stop signal
 * (137/143) is treated as stopped, not a crash: it's the expected outcome of an
 * explicit `docker compose stop` force-killing a container that ignored SIGTERM.
 * Only `dead`, or an exit with a non-signal non-zero code (a real crash under a
 * `restart: no` policy), still maps to `error`. See {@link STOP_SIGNAL_EXIT_CODES}.
 */
export function mapContainerStatesToAppStatus(
  containers: ComposePsContainer[],
): AppEntry['status'] {
  if (containers.length === 0) return 'stopped';
  if (
    containers.some(
      (c) => c.state === 'restarting' && c.restartExitCode !== undefined && c.restartExitCode !== 0,
    )
  ) {
    return 'error';
  }
  if (containers.some((c) => c.state === 'running' || c.state === 'restarting')) {
    return 'running';
  }
  if (
    containers.some(
      (c) =>
        c.state === 'dead' ||
        (c.state === 'exited' && c.exitCode !== 0 && !STOP_SIGNAL_EXIT_CODES.has(c.exitCode)),
    )
  ) {
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
 * `docker compose` CLI process we spawned, NOT the containers. **Once the images
 * exist**, dockerd keeps bringing them up in the background, so a timeout means
 * "we stopped waiting on the healthcheck", not "the start was cancelled" — the
 * app may well come up healthy moments later.
 *
 * That does NOT hold while an image is still being built. A build session is
 * driven by the client, so killing the CLI cancels it: the timeout leaves no
 * image and no container, and nothing arrives later. This is why the restore
 * builds under its own, far larger budget before it waits — see
 * {@link AppInstaller.composeUpAsync} and issue #425.
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
          // SIGKILL the compose CLI. Containers already handed to dockerd keep
          // starting; a build in progress does not survive. See the note above.
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
