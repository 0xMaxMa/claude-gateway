import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── Data model ───────────────────────────────────────────────────────────────

export interface PortEntry {
  name: string;
  service: string;
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
  agentPaths?: { claudeBin: string; nodeBin: string; npmRoot: string };
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
 * All mutations are atomic (tmp-file + rename) and serialised through a promise lock.
 */
export class AppsRegistry {
  private readonly filePath: string;
  private lock: Promise<void> = Promise.resolve();

  constructor(filePath = DEFAULT_APPS_PATH) {
    this.filePath = filePath;
  }

  // ─── Mutual exclusion ──────────────────────────────────────────────────────

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.lock;
    this.lock = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
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
