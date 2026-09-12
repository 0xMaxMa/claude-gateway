import { readFileSync, existsSync } from 'fs';
import { mkdir, open, readFile, readdir, realpath, unlink } from 'fs/promises';
import { join, relative } from 'path';
import { createHash, randomUUID } from 'crypto';
import { OrchestrationStore, Row } from '../store';
import { OrchestrationError, TERMINAL_TASK_STATES } from '../types';

const LOCK = '.gateway-orchestration-task-lock';
const SKIP = new Set(['.git', 'node_modules', '.venv', LOCK]);
type Manifest = Record<string, string>;
const releaseQueues = new WeakMap<OrchestrationStore, Map<string, Promise<void>>>();

/** Persistent owner file, rather than an expiring lease: a gateway crash does
 * not prove its old worker stopped. Other agents must not steal the workspace. */
export class SharedWorkspace {
  private readonly releasing: Map<string, Promise<void>>;
  constructor(private readonly store: OrchestrationStore, private readonly project: string, private readonly resources: string) {
    let queue = releaseQueues.get(store);
    if (!queue) { queue = new Map(); releaseQueues.set(store, queue); }
    this.releasing = queue;
  }
  available(taskId: string): boolean {
    const file = join(this.project, LOCK);
    if (!existsSync(file)) return true;
    try {
      const owner = JSON.parse(readFileSync(file, 'utf8'));
      return owner.taskId === taskId && owner.agentId === this.store.agentId && owner.database === this.store.filename;
    } catch { return false; }
  }
  private async durableWrite(file: string, data: string | Buffer, exclusive = false): Promise<void> {
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    const handle = await open(file, exclusive ? 'wx' : 'w', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    const directory = await open(join(file, '..'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async scan(root: string, copyTo?: string): Promise<Manifest> {
    const manifest: Manifest = Object.create(null); let bytes = 0, count = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const file = join(directory, entry.name), ref = relative(root, file);
        if (entry.isSymbolicLink()) throw new OrchestrationError('SHARED_WORKSPACE_SYMLINK');
        if (entry.isDirectory()) { await visit(file); continue; }
        if (!entry.isFile()) throw new OrchestrationError('UNSUPPORTED_WORKSPACE_FILE');
        if (++count > 256) throw new OrchestrationError('WORKSPACE_SNAPSHOT_TOO_LARGE');
        const handle = await open(file, 'r'); let content: Buffer;
        try {
          const info = await handle.stat();
          if (info.size > 1048576 || bytes + info.size > 16777216) throw new OrchestrationError('WORKSPACE_SNAPSHOT_TOO_LARGE');
          content = await handle.readFile(); bytes += content.length;
          if (content.length > 1048576 || bytes > 16777216) throw new OrchestrationError('WORKSPACE_SNAPSHOT_TOO_LARGE');
        } finally { await handle.close(); }
        manifest[ref] = createHash('sha256').update(content).digest('hex');
        if (copyTo) await this.durableWrite(join(copyTo, ref), content);
      }
    };
    await visit(root); return manifest;
  }
  async prepare(taskId: string): Promise<{ path: string; baseCommit: string; resourceId: string }> {
    const existing = this.store.get("SELECT * FROM task_resources WHERE task_id=? AND mode='shared-lock' AND lifecycle_state='active'", taskId);
    if (existing) {
      await this.assertOwner(existing);
      await readFile(String(existing.context_snapshot_ref));
      return { path: String(existing.worktree_path), baseCommit: String(existing.base_commit), resourceId: String(existing.id) };
    }
    if (this.store.get("SELECT id FROM task_resources WHERE task_id=? AND mode='shared-lock' AND lifecycle_state IN ('preparing','needs_reconciliation')", taskId)) throw new OrchestrationError('RESOURCE_RECONCILIATION_REQUIRED');
    const project = await realpath(this.project), resourceId = randomUUID();
    const snapshot = join(this.resources, taskId, 'snapshot.json');
    this.store.transaction(() => this.store.run('INSERT INTO task_resources VALUES(?,?,?,?,?,?,?,?,?,?)', resourceId, taskId, project, 'shared-lock', null, project, snapshot, project, 'preparing', null));
    try {
      await this.durableWrite(join(project, LOCK), JSON.stringify({ resourceId, taskId, agentId: this.store.agentId, database: this.store.filename }), true);
      const manifest = await this.scan(project, join(this.resources, taskId, 'base'));
      const serialized = JSON.stringify(manifest), baseCommit = `snapshot:${createHash('sha256').update(serialized).digest('hex')}`;
      await this.durableWrite(snapshot, serialized);
      this.store.run("UPDATE task_resources SET lifecycle_state='active',base_commit=? WHERE id=?", baseCommit, resourceId);
      return { path: project, baseCommit, resourceId };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        this.store.run("UPDATE task_resources SET lifecycle_state='unused',lock_key=NULL WHERE id=?", resourceId);
        throw new OrchestrationError('RESOURCE_BUSY');
      }
      this.store.run("UPDATE task_resources SET lifecycle_state='needs_reconciliation' WHERE id=?", resourceId);
      throw error;
    }
  }
  private async assertOwner(row: Row): Promise<void> {
    const owner = JSON.parse(await readFile(join(String(row.worktree_path), LOCK), 'utf8'));
    if (owner.resourceId !== row.id || owner.taskId !== row.task_id || owner.agentId !== this.store.agentId || owner.database !== this.store.filename) throw new OrchestrationError('RESOURCE_OWNERSHIP_MISMATCH');
  }
  release(taskId: string): Promise<void> {
    const pending = this.releasing.get(taskId);
    if (pending) return pending;
    const result = this.releaseNow(taskId).finally(() => this.releasing.delete(taskId));
    this.releasing.set(taskId, result); return result;
  }
  async settle(): Promise<void> { await Promise.allSettled([...this.releasing.values()]); }
  private async releaseNow(taskId: string): Promise<void> {
    const task = this.store.task(taskId);
    if (!task || !TERMINAL_TASK_STATES.has(task.state)) return;
    for (const row of this.store.all("SELECT * FROM task_resources WHERE task_id=? AND mode='shared-lock' AND lifecycle_state IN ('active','preparing','needs_reconciliation','releasing')", taskId)) {
      const lock = join(String(row.worktree_path), LOCK);
      if (existsSync(lock)) {
        await this.assertOwner(row);
        this.store.run("UPDATE task_resources SET lifecycle_state='releasing' WHERE id=?", row.id);
        await unlink(lock);
        const directory = await open(String(row.worktree_path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      this.store.run("UPDATE task_resources SET lifecycle_state='retained',lock_key=NULL WHERE id=?", row.id);
    }
  }
}
