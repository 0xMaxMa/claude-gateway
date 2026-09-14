import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, realpath, stat, chmod, open, rename, rm } from 'fs/promises';
import { join, relative, isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import { OrchestrationStore } from '../store';
import { OrchestrationError } from '../types';

// Resolve subprocess support only when this feature is invoked.
const exec = (file: string, args: string[], options: import('child_process').ExecFileOptions = {}) =>
  promisify(execFile)(file, args, { ...options, encoding: 'utf8' as const });
/** Conservative retention: archive clean worktrees and private shared-project
 * snapshots. Dirty worktrees remain available for review. Never delete a shared
 * project, uncertain attempt, or path outside the orchestration's resource directory. */
export class ResourceCleanup {
  private running?: Promise<void>;
  private readonly controller = new AbortController();
  constructor(private readonly store: OrchestrationStore, private readonly resourceRoot: string, private readonly archiveRoot: string, private readonly retentionDays: number) {}
  tick(now = Date.now()): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run(now).finally(() => { this.running = undefined; });
    return this.running;
  }
  async settle(): Promise<void> { await this.running; }
  stop(): void { this.controller.abort(); }
  private async run(now: number): Promise<void> {
    const rows = this.store.all(`SELECT r.* FROM task_resources r JOIN tasks t ON r.task_id=t.id WHERE t.active_attempt_id IS NULL AND t.state IN ('completed','failed','cancelled')
      AND r.mode NOT IN ('host','container') AND r.lifecycle_state IN ('active','retained','retained_dirty') AND COALESCE(r.cleanup_after,t.updated_at+?)<=? LIMIT 10`, this.retentionDays * 86400000, now);
    for (const row of rows) {
      if (this.controller.signal.aborted) break;
      try {
        if (row.mode === 'host') continue; // Operator-owned filesystem is never an expiring task artifact.
        if (!/^[a-f0-9-]{36}$/.test(String(row.id)) || !/^[a-f0-9-]{36}$/.test(String(row.task_id))) throw new OrchestrationError('INVALID_RESOURCE_PATH');
        const directory = row.mode === 'shared-lock' ? join(this.resourceRoot, String(row.task_id)) : String(row.worktree_path);
        const [root, location] = await Promise.all([realpath(this.resourceRoot), realpath(directory)]);
        const ref = relative(root, location);
        if (!ref || ref.startsWith('..') || isAbsolute(ref)) throw new OrchestrationError('INVALID_RESOURCE_PATH');
        let main: string | undefined;
        let archivedHead: string | undefined;
        if (row.mode === 'isolated-worktree') {
          const status = await exec('git', ['-C', location, 'status', '--porcelain'], { timeout: 15000, maxBuffer: 1048576 });
          if (status.stdout.trim()) { this.store.run("UPDATE task_resources SET lifecycle_state='retained_dirty',cleanup_after=? WHERE id=?", now + 86400000, row.id); continue; }
          const listed = await exec('git', ['-C', location, 'worktree', 'list', '--porcelain'], { timeout: 15000, maxBuffer: 1048576 });
          if (!listed.stdout.split('\n').includes(`worktree ${location}`)) throw new OrchestrationError('RESOURCE_OWNERSHIP_MISMATCH');
          main = listed.stdout.split('\n').find(line => line.startsWith('worktree '))?.slice(9);
          if (!main || main === location) throw new OrchestrationError('RESOURCE_OWNERSHIP_MISMATCH');
          archivedHead = (await exec('git', ['-C', location, 'rev-parse', 'HEAD'], { timeout: 15000 })).stdout.trim();
        } else if (row.mode !== 'isolated-directory' && (row.mode !== 'shared-lock' || row.lifecycle_state !== 'retained')) continue;
        await mkdir(this.archiveRoot, { recursive: true, mode: 0o700 });
        const archive = join(this.archiveRoot, `${row.id}.tar.gz`), temporary = `${archive}.${randomUUID()}.tmp`;
        this.store.run("UPDATE task_resources SET lifecycle_state='archiving' WHERE id=?", row.id);
        await exec('tar', ['-czf', temporary, '--exclude=.git', '-C', root, '--', ref], { timeout: 60000, maxBuffer: 1048576, signal: this.controller.signal });
        await chmod(temporary, 0o600);
        await exec('tar', ['-tzf', temporary], { timeout: 60000, maxBuffer: 4194304, signal: this.controller.signal });
        if (!(await stat(temporary)).size) throw new OrchestrationError('EMPTY_RESOURCE_ARCHIVE');
        const file = await open(temporary, 'r'); try { await file.sync(); } finally { await file.close(); }
        await rename(temporary, archive);
        const archiveDirectory = await open(this.archiveRoot, 'r'); try { await archiveDirectory.sync(); } finally { await archiveDirectory.close(); }
        // The archive is durable before any owned working files are removed.
        if (main) {
          if ((await exec('git', ['-C', location, 'rev-parse', 'HEAD'], { timeout: 15000 })).stdout.trim() !== archivedHead) throw new OrchestrationError('RESOURCE_CHANGED_DURING_ARCHIVE');
          const clean = await exec('git', ['-C', location, 'status', '--porcelain'], { timeout: 15000, maxBuffer: 1048576 });
          if (clean.stdout.trim()) { this.store.run("UPDATE task_resources SET lifecycle_state='retained_dirty',cleanup_after=? WHERE id=?", now + 86400000, row.id); continue; }
          await exec('git', ['-C', main, 'worktree', 'remove', '--', location], { timeout: 30000, maxBuffer: 1048576 });
        } else await rm(location, { recursive: true });
        this.store.run("UPDATE task_resources SET lifecycle_state='archived',context_snapshot_ref=?,lock_key=NULL WHERE id=?", archive, row.id);
      } catch {
        // No automatic destructive retry after an ambiguous cleanup boundary.
        this.store.run("UPDATE task_resources SET lifecycle_state='cleanup_unknown' WHERE id=?", row.id);
      }
    }
  }
}
