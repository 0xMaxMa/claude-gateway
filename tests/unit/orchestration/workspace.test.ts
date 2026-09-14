import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskWorkspaces } from '../../../src/orchestration/tasks/workspace';
import { ResourceCleanup } from '../../../src/orchestration/tasks/cleanup';

test('non-Git shared workspace excludes another agent and retains a snapshot/diff until its owner stops', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-shared-')), project = join(root, 'project');
  mkdirSync(project); writeFileSync(join(project, 'code.txt'), 'before\n');
  const a = new OrchestrationStore(join(root, 'a.db'), 'a'), b = new OrchestrationStore(join(root, 'b.db'), 'b');
  function fixture(store: OrchestrationStore) {
    const input = store.acceptInput({ scope: { agentId: store.agentId, agentSessionId: 'agentSession', source: 'api', accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'owner' }, text: 'edit' });
    const decisions = new DecisionService(store), decision = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    const tasks = new TaskService(store);
    const task = tasks.spawn({ ...input, ...decision, principalId: 'owner', actionId: 'one', execute: true, writeMemory: false }, { title: 'edit', instructions: 'edit', targetProfile: 'default-worker' });
    const attempt = tasks.claim(task.taskId)!;
    return { tasks, task, attempt, resources: new TaskWorkspaces(store, project, join(root, store.agentId, 'resources'), 'shared-lock') };
  }
  const first = fixture(a), second = fixture(b);
  try {
    const resource = await first.resources.prepare(first.task.taskId);
    expect(second.resources.available(second.task.taskId)).toBe(false);
    await expect(second.resources.prepare(second.task.taskId)).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
    second.tasks.deferUnstarted(second.attempt.attemptId, second.attempt.generation);
    first.tasks.started(first.attempt.attemptId, first.attempt.generation);
    writeFileSync(join(project, 'code.txt'), 'after\n');
    const artifact = await first.resources.artifact(first.task.taskId);
    expect(artifact.changedFiles).toEqual(['code.txt']); expect(artifact.diff).toContain('-before'); expect(artifact.diff).toContain('+after');
    expect(resource.baseCommit).toMatch(/^snapshot:/);
    first.tasks.finish(first.attempt.attemptId, first.attempt.generation, { type: 'unknown' });
    await first.resources.release(first.task.taskId);
    expect(second.resources.available(second.task.taskId)).toBe(false);
    first.tasks.reconcile(first.task.taskId, 'failed', 'Verified the prior fixture worker stopped.');
    await Promise.all([first.resources.release(first.task.taskId), first.resources.release(first.task.taskId)]);
    expect(second.resources.available(second.task.taskId)).toBe(true);
    const next = await second.resources.prepare(second.task.taskId);
    expect(next.path).toBe(project);
    expect(first.resources.available(first.task.taskId)).toBe(false);
    expect(readFileSync(join(project, 'code.txt'), 'utf8')).toBe('after\n');
    expect(a.get('SELECT lifecycle_state FROM task_resources WHERE id=?', resource.resourceId)!.lifecycle_state).toBe('retained');
    a.run('UPDATE task_resources SET cleanup_after=0');
    await new ResourceCleanup(a, join(root, 'a', 'resources'), join(root, 'archives'), 1).tick();
    expect(a.get('SELECT lifecycle_state FROM task_resources WHERE id=?', resource.resourceId)!.lifecycle_state).toBe('archived');
    expect(readFileSync(join(project, 'code.txt'), 'utf8')).toBe('after\n');
    expect(second.resources.available(second.task.taskId)).toBe(true); // still owns the project lock
  } finally { await first.resources.settle(); await second.resources.settle(); a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
});

test('retention archives a clean owned worktree but preserves an unreviewed dirty worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-cleanup-')), project = join(root, 'project'), resources = join(root, 'resources');
  mkdirSync(project); writeFileSync(join(project, 'code.txt'), 'original\n');
  execFileSync('git', ['init', '-q', project]); execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const store = new OrchestrationStore(join(root, 'orchestration.db'), 'a'), tasks = new TaskService(store, { tasks: { projectRoot: project, workspaceMode: 'isolated-worktree' } });
  const workspaces = new TaskWorkspaces(store, project, resources, 'isolated-worktree'), cleaner = new ResourceCleanup(store, resources, join(root, 'archives'), 1);
  const decisions = new DecisionService(store);
  try {
    const paths: string[] = [];
    for (let i = 0; i < 2; i++) {
      const receipt = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 'agentSession', source: 'api', accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'owner' }, text: 'task' });
      const decision = decisions.begin(receipt.conversationId, 'owner', [receipt.inputId]);
      const task = tasks.spawn({ ...receipt, ...decision, principalId: 'owner', actionId: String(i), execute: true, writeMemory: false }, { title: 'task', instructions: 'task', targetProfile: 'default-worker' });
      const attempt = tasks.claim(task.taskId)!;
      const workspace = await workspaces.prepare(task.taskId); paths.push(workspace.path);
      tasks.started(attempt.attemptId, attempt.generation);
      if (!i) writeFileSync(join(workspace.path, 'code.txt'), 'unreviewed change\n');
      tasks.finish(attempt.attemptId, attempt.generation, { type: 'completed', result: { summary: 'done', artifactIds: [workspace.resourceId] } });
      decisions.finish(decision, 'done');
    }
    store.run('UPDATE task_resources SET cleanup_after=0'); await cleaner.tick();
    expect(existsSync(paths[0])).toBe(true); expect(existsSync(paths[1])).toBe(false);
    expect(store.get("SELECT COUNT(*) n FROM task_resources WHERE lifecycle_state='retained_dirty'")!.n).toBe(1);
    const archive = store.get("SELECT context_snapshot_ref FROM task_resources WHERE lifecycle_state='archived'")!;
    expect(existsSync(String(archive.context_snapshot_ref))).toBe(true);
    expect(readFileSync(join(project, 'code.txt'), 'utf8')).toBe('original\n');
  } finally { await cleaner.settle(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('default mode starts every worker profile in the Agent non-Git workspace and cleanup never deletes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-host-')), project = join(root, 'project');
  mkdirSync(project); writeFileSync(join(project, 'keep.txt'), 'user data');
  const store = new OrchestrationStore(join(root, 'state.db'), 'a');
  const tasks = new TaskService(store, undefined, project);
  const workspaces = new TaskWorkspaces(store, project, join(root, 'resources'));
  try {
    const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'api', accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'owner' }, text: 'host work' });
    const decision = new DecisionService(store).begin(input.conversationId, 'owner', [input.inputId]);
    for (const targetProfile of ['default-worker', 'media-worker', 'skill-worker']) {
      const task = tasks.spawn({ ...input, ...decision, principalId: 'owner', actionId: targetProfile, execute: true, writeMemory: false },
        { title: 'host work', instructions: 'host work', targetProfile });
      const resource = await workspaces.prepare(task.taskId);
      expect(resource.path).toBe(project); expect(resource.baseCommit).toBe('host');
      expect((await workspaces.artifact(task.taskId)).diff).toBe('');
      const attempt = tasks.claim(task.taskId)!;
      tasks.finish(attempt.attemptId, attempt.generation, { type: 'failed' });
    }
    store.run('UPDATE task_resources SET cleanup_after=0');
    await new ResourceCleanup(store, join(root, 'resources'), join(root, 'archives'), 1).tick();
    expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('user data');
    expect(existsSync(join(project, '.git'))).toBe(false);
    expect(store.all("SELECT * FROM task_resources WHERE mode='host' AND lifecycle_state='active'")).toHaveLength(3);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
