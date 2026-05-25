import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── Data model ───────────────────────────────────────────────────────────────

export interface PortEntry {
  name: string;
  service: string;
  hostPort: number;
  containerPort: number;
  type: 'api' | 'web';
  rateLimit: number;
}

export interface AppEntry {
  name: string;
  version: string;
  commit: string;
  githubUrl: string;
  installPath: string;
  ports: PortEntry[];
  /** serviceName → host socket path (/run/claude-gateway/apps/<name>-<svc>.sock) */
  sockets: Record<string, string>;
  installedAt: string;
  updatedAt: string;
  status: 'running' | 'stopped' | 'error' | 'building';
  source: 'registry' | 'custom' | 'local';
  agentPaths?: { claudeBin: string; nodeBin: string; npmRoot: string; claudeVersion?: string };
  /** Agent service declared in app.yaml (path + name). Null means no agent. */
  agentDeclaration?: { path: string; name: string } | null;
}

interface AppsFile {
  apps: AppEntry[];
}

// ─── Registry ────────────────────────────────────────────────────────────────

const DEFAULT_APPS_PATH = path.join(os.homedir(), '.claude-gateway', 'apps.json');

/**
 * Persistent store for installed apps.
 * All mutations are atomic (tmp-file + rename) and serialised through:
 *   1. An in-process promise chain (fast path, single-process safety)
 *   2. An advisory file lock (cross-process safety: O_EXCL on .lock file)
 */
export class AppsRegistry {
  private readonly filePath: string;
  private inProcessLock: Promise<void> = Promise.resolve();

  constructor(filePath = DEFAULT_APPS_PATH) {
    this.filePath = filePath;
  }

  // ─── Mutual exclusion ──────────────────────────────────────────────────────

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Layer 1: in-process serialisation
    let release!: () => void;
    const prev = this.inProcessLock;
    this.inProcessLock = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      // Layer 2: cross-process advisory file lock
      return await this.withFileLock(fn);
    } finally {
      release();
    }
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + 5000;

    // Ensure directory exists before trying to create lock file
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    // Acquire lock via atomic O_EXCL file creation
    while (true) {
      try {
        const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        const pidBuf = Buffer.from(String(process.pid));
        fs.writeSync(fd, pidBuf, 0, pidBuf.length);
        fs.closeSync(fd);
        break; // Lock acquired
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if (Date.now() > deadline) throw new Error('Failed to acquire registry lock after 5s');
        // Check for stale lock (holding process may have crashed)
        try {
          const holderPid = parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
          if (!isNaN(holderPid) && holderPid !== process.pid) {
            try {
              process.kill(holderPid, 0);
              // Process is alive — wait and retry
            } catch (killErr) {
              if ((killErr as NodeJS.ErrnoException).code !== 'EPERM') {
                // ESRCH: process doesn't exist — stale lock, remove and retry immediately
                fs.unlinkSync(lockPath);
                continue;
              }
              // EPERM: process exists but owned by another user (e.g. root) — it's alive, don't steal lock
            }
          }
        } catch { /* Can't read lock file — retry */ }
        await new Promise<void>((r) => setTimeout(r, 20));
      }
    }

    try {
      return await fn();
    } finally {
      try { fs.unlinkSync(lockPath); } catch { /* Already removed */ }
    }
  }

  // ─── File I/O ──────────────────────────────────────────────────────────────

  private readSync(): AppsFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as { apps?: unknown }).apps)
      ) {
        return { apps: [] };
      }
      return parsed as AppsFile;
    } catch {
      return { apps: [] };
    }
  }

  private writeAtomic(data: AppsFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async list(): Promise<AppEntry[]> {
    return this.withLock(async () => this.readSync().apps);
  }

  async get(name: string): Promise<AppEntry | undefined> {
    return this.withLock(async () => this.readSync().apps.find((a) => a.name === name));
  }

  async upsert(entry: AppEntry): Promise<void> {
    return this.withLock(async () => {
      const data = this.readSync();
      const idx = data.apps.findIndex((a) => a.name === entry.name);
      if (idx >= 0) {
        data.apps[idx] = entry;
      } else {
        data.apps.push(entry);
      }
      this.writeAtomic(data);
    });
  }

  async remove(name: string): Promise<void> {
    return this.withLock(async () => {
      const data = this.readSync();
      data.apps = data.apps.filter((a) => a.name !== name);
      this.writeAtomic(data);
    });
  }

  async updateStatus(name: string, status: AppEntry['status']): Promise<void> {
    return this.withLock(async () => {
      const data = this.readSync();
      const entry = data.apps.find((a) => a.name === name);
      if (entry) {
        entry.status = status;
        entry.updatedAt = new Date().toISOString();
        this.writeAtomic(data);
      }
    });
  }
}
