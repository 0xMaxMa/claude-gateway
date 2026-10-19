import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import { listProjects, mapLimit, resolveProjectDir } from './fs';
import { ok, ProjectName, ProjectsErrorCode, Result } from './paths';

export type DiskState = 'ok' | 'partial' | 'failed';

export interface DiskNumbers {
  total: number;
  used: number;
  free: number;
}

export interface ProjectDisk {
  name: ProjectName;
  bytes: number | null;
  state: DiskState;
}

export interface DiskReport {
  supported: boolean;
  disk: DiskNumbers | null;
  projects: ProjectDisk[];
  computedAt: string;
  cached: boolean;
}

export const PROJECT_TIMEOUT_MS = 10_000;
export const OVERALL_TIMEOUT_MS = 30_000;
export const CONCURRENCY = 3;
export const CACHE_MS = 60_000;
export const REFRESH_MIN_GAP_MS = 5_000;

const KILL_GRACE_MS = 1_000;

/** Outcome of one `du` run. `bytes` is null when du printed no total; `timedOut` when it was killed. */
export interface DuOutcome {
  bytes: number | null;
  exitCode: number | null;
  timedOut: boolean;
}

export interface DiskSys {
  platform: string;
  du(dir: string, timeoutMs: number): Promise<DuOutcome>;
  statfs(root: string): Promise<DiskNumbers | null>;
}

/**
 * Blocks the folder really occupies: hardlinks count once (du's default), symlinks are not followed (du's default),
 * and `-x` keeps du on the folder's own filesystem so a mount inside a project is not charged to it.
 */
export function duArgs(dir: string): string[] {
  return ['-s', '-k', '-x', '--', dir];
}

/** The first output line is `<kilobytes><TAB><path>`. Anything else is not a total. */
export function parseDu(stdout: string): number | null {
  const first = stdout.split('\n', 1)[0];
  const tab = first.indexOf('\t');
  if (tab <= 0) return null;
  const digits = first.slice(0, tab);
  const kb = Number(digits);
  if (!Number.isSafeInteger(kb) || kb < 0 || String(kb) !== digits) return null;
  return kb * 1024;
}

function duEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, LC_ALL: 'C' };
}

function runDu(dir: string, timeoutMs: number): Promise<DuOutcome> {
  return new Promise((resolve) => {
    const child = spawn('du', duArgs(dir), { env: duEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= 64 * 1024) chunks.push(c);
    });
    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ bytes: timedOut ? null : parseDu(Buffer.concat(chunks).toString('utf8')), exitCode, timedOut });
    };
    child.on('error', () => settle(null));
    child.on('close', settle);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      setTimeout(() => settle(null), KILL_GRACE_MS).unref();
    }, timeoutMs);
  });
}

async function statfsNumbers(root: string): Promise<DiskNumbers | null> {
  try {
    const s = await fsp.statfs(root);
    const total = s.blocks * s.bsize;
    return { total, used: total - s.bfree * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

export function systemDiskSys(platform: string = process.platform): DiskSys {
  return { platform, du: runDu, statfs: statfsNumbers };
}

function toProjectDisk(name: ProjectName, o: DuOutcome): ProjectDisk {
  if (o.timedOut) return { name, bytes: o.bytes, state: 'partial' };
  if (o.bytes === null) return { name, bytes: null, state: 'failed' };
  // du exits 1 when it could not read part of the tree but still prints the total of what it read.
  return { name, bytes: o.bytes, state: o.exitCode === 0 ? 'ok' : 'partial' };
}

export interface DiskOptions {
  sys?: DiskSys;
  now?: () => number;
  projectTimeoutMs?: number;
  overallTimeoutMs?: number;
  cacheMs?: number;
  refreshGapMs?: number;
}

/**
 * Disk usage of the projects under one root. The whole answer is cached; concurrent callers share one run; a
 * `refresh` skips the cache but not the shared run, and is honoured at most once per `refreshGapMs`, after which it
 * is served like a plain read.
 */
export class DiskUsage {
  private readonly sys: DiskSys;
  private readonly now: () => number;
  private readonly projectTimeoutMs: number;
  private readonly overallTimeoutMs: number;
  private readonly cacheMs: number;
  private readonly refreshGapMs: number;
  private cache: { report: DiskReport; at: number } | null = null;
  private inflight: Promise<Result<DiskReport, ProjectsErrorCode>> | null = null;
  private lastRefreshAt = -Infinity;

  constructor(
    private readonly root: string,
    opts: DiskOptions = {},
  ) {
    this.sys = opts.sys ?? systemDiskSys();
    this.now = opts.now ?? Date.now;
    this.projectTimeoutMs = opts.projectTimeoutMs ?? PROJECT_TIMEOUT_MS;
    this.overallTimeoutMs = opts.overallTimeoutMs ?? OVERALL_TIMEOUT_MS;
    this.cacheMs = opts.cacheMs ?? CACHE_MS;
    this.refreshGapMs = opts.refreshGapMs ?? REFRESH_MIN_GAP_MS;
  }

  get(refresh: boolean): Promise<Result<DiskReport, ProjectsErrorCode>> {
    if (this.sys.platform === 'win32') {
      return Promise.resolve(ok({ supported: false, disk: null, projects: [], computedAt: new Date(this.now()).toISOString(), cached: false }));
    }
    if (this.inflight) return this.inflight;
    const now = this.now();
    const wantsRefresh = refresh && now - this.lastRefreshAt >= this.refreshGapMs;
    if (!wantsRefresh && this.cache && now - this.cache.at < this.cacheMs) {
      return Promise.resolve(ok({ ...this.cache.report, cached: true }));
    }
    if (wantsRefresh) this.lastRefreshAt = now;
    const run = this.compute().finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async compute(): Promise<Result<DiskReport, ProjectsErrorCode>> {
    const list = await listProjects(this.root);
    if (!list.ok) return list;
    const startedAt = this.now();
    const deadline = startedAt + this.overallTimeoutMs;
    const projects = await mapLimit(list.value.projects, CONCURRENCY, async ({ name }): Promise<ProjectDisk> => {
      const dir = await resolveProjectDir(this.root, name);
      if (!dir.ok) return { name, bytes: null, state: 'failed' };
      const left = deadline - this.now();
      if (left <= 0) return { name, bytes: null, state: 'partial' };
      return toProjectDisk(name, await this.sys.du(dir.value, Math.min(this.projectTimeoutMs, left)));
    });
    const disk = list.value.exists ? await this.sys.statfs(list.value.root) : null;
    const report: DiskReport = { supported: true, disk, projects, computedAt: new Date(this.now()).toISOString(), cached: false };
    this.cache = { report, at: this.now() };
    return ok(report);
  }
}

