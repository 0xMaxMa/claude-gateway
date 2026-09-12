import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, readFile, realpath } from 'fs/promises';
import { join, resolve, relative, isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import { OrchestrationStore } from '../store';
import { OrchestrationError } from '../types';
import { SharedWorkspace } from './shared-workspace';

// Resolve subprocess support only when this feature is invoked.
const exec = (file: string, args: string[], options: import('child_process').ExecFileOptions = {}) =>
  promisify(execFile)(file, args, { ...options, encoding: 'utf8' as const });
export class TaskWorkspaces {
  private readonly shared: SharedWorkspace;
  constructor(private readonly store: OrchestrationStore, private readonly projectRoot: string, private readonly resourcesRoot: string,
    private readonly mode: 'isolated-worktree' | 'shared-lock' | 'host' | 'container' = 'host') {
    this.shared = new SharedWorkspace(store, projectRoot, resourcesRoot);
  }
  private profile(taskId: string): TaskWorkspaces {
    const profile = this.store.task(taskId)?.resourceProfile;
    return profile && (profile.projectRoot !== this.projectRoot || profile.mode !== this.mode)
      ? new TaskWorkspaces(this.store, profile.projectRoot, this.resourcesRoot, profile.mode) : this;
  }
  available(taskId: string): boolean {
    if (['media-worker', 'skill-worker'].includes(this.store.task(taskId)?.targetProfile ?? '')) return true;
    const profile = this.profile(taskId);
    return profile !== this ? profile.available(taskId) : this.mode !== 'shared-lock' || this.shared.available(taskId);
  }
  release(taskId: string): Promise<void> { return this.shared.release(taskId); }
  settle(): Promise<void> { return this.shared.settle(); }
  async prepare(taskId: string): Promise<{ path: string; baseCommit: string; resourceId: string }> {
    const selected = this.profile(taskId);
    if (selected !== this) return selected.prepare(taskId);
    if (this.mode === 'host' || this.mode === 'container') {
      const location = await realpath(this.projectRoot);
      const old = this.store.get("SELECT * FROM task_resources WHERE task_id=? AND mode=?", taskId, this.mode);
      if (old) return { path: String(old.worktree_path), baseCommit: this.mode, resourceId: String(old.id) };
      const resourceId = randomUUID();
      this.store.run('INSERT INTO task_resources VALUES(?,?,?,?,?,?,?,?,?,?)', resourceId, taskId, resourceId, this.mode, this.mode, location, null, null, 'active', null);
      return { path: location, baseCommit: this.mode, resourceId };
    }
    if (['media-worker', 'skill-worker'].includes(this.store.task(taskId)?.targetProfile ?? '')) {
      const old = this.store.get("SELECT * FROM task_resources WHERE task_id=? AND mode='isolated-directory'", taskId);
      if (old) {
        if (old.lifecycle_state !== 'active') throw new OrchestrationError('RESOURCE_RECONCILIATION_REQUIRED');
        return { path: String(old.worktree_path), baseCommit: 'empty', resourceId: String(old.id) };
      }
      const location = resolve(this.resourcesRoot, taskId), resourceId = randomUUID();
      this.store.run('INSERT INTO task_resources VALUES(?,?,?,?,?,?,?,?,?,?)', resourceId, taskId, resourceId, 'isolated-directory', 'empty', location, null, null, 'preparing', null);
      await mkdir(location, { recursive: true, mode: 0o700 });
      this.store.run("UPDATE task_resources SET lifecycle_state='active' WHERE id=?", resourceId);
      return { path: location, baseCommit: 'empty', resourceId };
    }
    const profile = this.profile(taskId);
    if (profile !== this) return profile.prepare(taskId);
    if (this.mode === 'shared-lock') return this.shared.prepare(taskId);
    const existing = this.store.get("SELECT * FROM task_resources WHERE task_id=? AND lifecycle_state='active'", taskId);
    if (existing) {
      const location = String(existing.worktree_path);
      const listed = await exec('git', ['-C', this.projectRoot, 'worktree', 'list', '--porcelain'], { timeout: 15000 });
      if (!listed.stdout.split('\n').includes(`worktree ${location}`)) throw new OrchestrationError('RESOURCE_RECONCILIATION_REQUIRED');
      return { path: location, baseCommit: String(existing.base_commit), resourceId: String(existing.id) };
    }
    const { stdout } = await exec('git', ['-C', this.projectRoot, 'rev-parse', '--show-toplevel'], { timeout: 15000 });
    const repository = stdout.trim();
    const { stdout: base } = await exec('git', ['-C', repository, 'rev-parse', 'HEAD'], { timeout: 15000 });
    const baseCommit = base.trim();
    const location = resolve(this.resourcesRoot, taskId);
    const rel = relative(resolve(this.resourcesRoot), location);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new OrchestrationError('INVALID_RESOURCE_PATH');
    await mkdir(this.resourcesRoot, { recursive: true, mode: 0o700 });
    const resourceId = randomUUID();
    this.store.transaction(() => {
      this.store.run('INSERT INTO task_resources VALUES(?,?,?,?,?,?,?,?,?,?)', resourceId, taskId, resourceId, 'isolated-worktree', baseCommit, location, null, null, 'preparing', null);
    });
    try {
      await exec('git', ['-C', repository, 'worktree', 'add', '--detach', location, baseCommit], { timeout: 30000 });
      this.store.run("UPDATE task_resources SET lifecycle_state='active' WHERE id=?", resourceId);
      return { path: location, baseCommit, resourceId };
    } catch (error) {
      // Keep the resource identity for reconciliation; never delete a possibly
      // useful worktree after an ambiguous process/tool failure.
      this.store.run("UPDATE task_resources SET lifecycle_state='needs_reconciliation' WHERE id=?", resourceId);
      throw error;
    }
  }
  async artifact(taskId: string): Promise<{ changedFiles: string[]; diff: string; resourceId: string }> {
    const row = this.store.get("SELECT * FROM task_resources WHERE task_id=? AND lifecycle_state='active'", taskId);
    if (!row) throw new OrchestrationError('RESOURCE_NOT_FOUND');
    const cwd = String(row.worktree_path);
    if (row.mode === 'host' || row.mode === 'container' || row.mode === 'isolated-directory') return { changedFiles: [], diff: '', resourceId: String(row.id) };
    if (row.mode === 'shared-lock') {
      const before: Record<string, string> = Object.assign(Object.create(null), JSON.parse(await readFile(String(row.context_snapshot_ref), 'utf8')));
      const after = await this.shared.scan(cwd);
      const changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]);
      let diff = '';
      for (const file of changedFiles) {
        const baseline = before[file] ? join(this.resourcesRoot, taskId, 'base', file) : '/dev/null';
        const current = after[file] ? join(cwd, file) : '/dev/null';
        const result = await exec('git', ['diff', '--no-index', '--', baseline, current], { timeout: 15000, maxBuffer: 2097152 })
          .catch(error => { if (error.code === 1 && typeof error.stdout === 'string') return { stdout: error.stdout }; throw error; });
        if (Buffer.byteLength(diff) + Buffer.byteLength(result.stdout) > 4194304) { diff += '\n[Remaining diff retained in snapshot/project.]\n'; break; }
        diff += result.stdout;
      }
      return { changedFiles, diff, resourceId: String(row.id) };
    }
    const [status, diff, untracked] = await Promise.all([
      exec('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 15000, maxBuffer: 1048576 }),
      exec('git', ['-C', cwd, 'diff', String(row.base_commit), '--'], { timeout: 15000, maxBuffer: 4194304 }),
      exec('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z'], { timeout: 15000, maxBuffer: 1048576 }),
    ]);
    let patch = diff.stdout;
    const files = untracked.stdout.split('\0').filter(Boolean);
    for (const file of files.slice(0, 100)) {
      const result = await exec('git', ['-C', cwd, 'diff', '--no-index', '--', '/dev/null', file], { timeout: 15000, maxBuffer: 1048576 })
        .catch(error => { if (error.code === 1 && typeof error.stdout === 'string') return { stdout: error.stdout }; throw error; });
      if (Buffer.byteLength(patch) + Buffer.byteLength(result.stdout) > 4194304) { patch += '\n[Additional diff retained in worktree; artifact size limit reached.]\n'; break; }
      patch += result.stdout;
    }
    if (files.length > 100) patch += '\n[Additional untracked files retained in worktree.]\n';
    return { changedFiles: status.stdout.split('\n').filter(Boolean), diff: patch, resourceId: String(row.id) };
  }
}
