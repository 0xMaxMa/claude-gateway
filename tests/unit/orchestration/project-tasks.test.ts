import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { resolveProjectCwd } from '../../../src/projects/chat';
import type { ProjectName } from '../../../src/projects/paths';
import type { GatewayConfig } from '../../../src/types';

interface Fixture {
  root: string;
  projectDir: string;
  store: OrchestrationStore;
  tasks: TaskService;
  scopes: unknown[];
  spawn: (action: string, args?: Record<string, unknown>) => Promise<{ status: number; body: any }>;
}

async function fixture(body: (f: Fixture) => Promise<void>, options: { bound?: boolean; mode?: 'host' | 'isolated-worktree'; harness?: 'claude' | 'codex' } = {}): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-tasks-')));
  const projectDir = join(root, 'projects', 'demo');
  mkdirSync(projectDir, { recursive: true });
  const gateway = { gateway: { projects: { root: join(root, 'projects') } } } as GatewayConfig;
  const scopes: unknown[] = [];
  const store = new OrchestrationStore(':memory:', 'a');
  const tasks = new TaskService(store, { tasks: { workspaceMode: options.mode ?? 'host' } } as any, join(root, 'workspace'), async scope => {
    scopes.push(scope);
    return options.bound === false ? undefined : resolveProjectCwd(gateway, 'demo' as ProjectName);
  }, () => options.harness ?? 'claude');
  const bridge = new TaskBridge(tasks);
  try {
    const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's1', source: 'api', accountId: 'u', principalId: 'u', chatId: 'c1', threadKey: '' }, text: 'Work in the project' });
    const decision = new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]);
    await bridge.start();
    bridge.issue({ role: 'agent', context: { ...input, ...decision, principalId: 'u', execute: true, writeMemory: false } }, join(root, 'ticket'), root);
    const ticket = JSON.parse(readFileSync(join(root, 'ticket/ticket.json'), 'utf8'));
    const spawn = async (action: string, args: Record<string, unknown> = {}) => {
      const response = await fetch(ticket.url, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'task_spawn', action_id: action, args: { title: action, instructions: 'Edit the code', target_profile: 'default-worker', ...args } }) });
      return { status: response.status, body: await response.json() };
    };
    await body({ root, projectDir, store, tasks, scopes, spawn });
  } finally {
    await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
}

test('task_spawn asks the host which project the chat session is bound to', async () => {
  await fixture(async ({ projectDir, store, scopes, spawn }) => {
    const spawned = await spawn('first');
    expect(spawned.status).toBe(200);
    expect(scopes).toEqual([expect.objectContaining({ source: 'api', agentSessionId: 's1', chatId: 'c1' })]);
    const task = store.task(spawned.body.taskId)!;
    expect(task.project).toBe('demo');
    expect(task.resourceProfile).toEqual({ projectRoot: projectDir, mode: 'host' });
  });
});

test('a session with no project keeps the configured worker root', async () => {
  await fixture(async ({ root, store, spawn }) => {
    const spawned = await spawn('first');
    const task = store.task(spawned.body.taskId)!;
    expect(task.project).toBeUndefined();
    expect(task.resourceProfile?.projectRoot).toBe(join(root, 'workspace'));
  }, { bound: false });
});

test('a model-supplied working directory stays inside the project or the spawn fails', async () => {
  await fixture(async ({ root, projectDir, store, spawn }) => {
    mkdirSync(join(root, 'projects', 'other'));
    mkdirSync(join(projectDir, 'src'));
    symlinkSync(join(root, 'projects', 'other'), join(projectDir, 'escape'));
    for (const [action, dir] of [['dotdot', '../other'], ['parent', join(projectDir, '..', 'other')], ['absolute', join(root, 'projects', 'other')], ['symlink', join(projectDir, 'escape')]]) {
      const spawned = await spawn(action, { working_directory: dir });
      expect({ action, status: spawned.status, error: spawned.body.error }).toEqual({ action, status: expect.any(Number), error: 'WORKING_DIRECTORY_OUTSIDE_PROJECT' });
    }
    expect(store.all('SELECT id FROM tasks')).toHaveLength(0);
    const inside = await spawn('inside', { working_directory: join(projectDir, 'src') });
    expect(store.task(inside.body.taskId)).toMatchObject({ project: 'demo', resourceProfile: { projectRoot: join(projectDir, 'src') } });
  });
});

test('a working directory may be relative to the project folder, and must be a folder', async () => {
  await fixture(async ({ projectDir, store, spawn }) => {
    mkdirSync(join(projectDir, 'src'));
    writeFileSync(join(projectDir, 'README.md'), 'hi');
    const relative = await spawn('relative', { working_directory: 'src' });
    expect(store.task(relative.body.taskId)).toMatchObject({ project: 'demo', resourceProfile: { projectRoot: join(projectDir, 'src') } });
    for (const [action, dir] of [['file', join(projectDir, 'README.md')], ['relative-file', 'README.md'], ['missing', 'nope']]) {
      const spawned = await spawn(action, { working_directory: dir });
      expect({ action, error: spawned.body.error }).toEqual({ action, error: 'WORKING_DIRECTORY_OUTSIDE_PROJECT' });
    }
    expect(store.all('SELECT id FROM tasks')).toHaveLength(1);
  });
});

test('later and continued tasks in the chat inherit the project', async () => {
  await fixture(async ({ projectDir, store, spawn }) => {
    const first = await spawn('first');
    const second = await spawn('second');
    const continued = await spawn('continued', { continue_task_id: first.body.taskId });
    for (const spawned of [second, continued]) {
      expect(store.task(spawned.body.taskId)).toMatchObject({ project: 'demo', resourceProfile: { projectRoot: projectDir, mode: 'host' } });
    }
  });
});

test('a follow-up keeps the subfolder its prior task ran in, and a fresh task does not', async () => {
  await fixture(async ({ projectDir, store, spawn }) => {
    mkdirSync(join(projectDir, 'src'));
    const first = await spawn('first', { working_directory: join(projectDir, 'src') });
    const continued = await spawn('continued', { continue_task_id: first.body.taskId });
    expect(store.task(continued.body.taskId)).toMatchObject({ project: 'demo', resourceProfile: { projectRoot: join(projectDir, 'src'), mode: 'host' } });
    const fresh = await spawn('fresh');
    expect(store.task(fresh.body.taskId)?.resourceProfile?.projectRoot).toBe(projectDir);
  });
});

test('a follow-up whose prior folder is gone runs at the project root', async () => {
  await fixture(async ({ projectDir, store, spawn }) => {
    mkdirSync(join(projectDir, 'src'));
    const first = await spawn('first', { working_directory: join(projectDir, 'src') });
    rmSync(join(projectDir, 'src'), { recursive: true });
    const continued = await spawn('continued', { continue_task_id: first.body.taskId });
    expect(store.task(continued.body.taskId)?.resourceProfile?.projectRoot).toBe(projectDir);
  });
});

for (const mode of ['isolated-worktree', 'shared-lock'] as const) {
  test(`a project-bound chat cannot queue tasks in ${mode} mode`, async () => {
    await fixture(async ({ store, spawn }) => {
      const spawned = await spawn('first');
      expect(spawned.body.error).toBe('PROJECT_UNSUPPORTED_AGENT');
      expect(store.all('SELECT id FROM tasks')).toHaveLength(0);
    }, { mode: mode as any });
  });
}

test('a project-bound chat cannot queue a task on the Codex worker harness, and no receipt is committed', async () => {
  await fixture(async ({ store, spawn }) => {
    const spawned = await spawn('first');
    expect(spawned.body.error).toBe('PROJECT_UNSUPPORTED_AGENT');
    expect(store.all('SELECT id FROM tasks')).toHaveLength(0);
    expect(store.all('SELECT action_id FROM task_commands')).toHaveLength(0);
  }, { harness: 'codex' });
});

test('an unbound chat still queues tasks on the Codex worker harness', async () => {
  await fixture(async ({ spawn }) => {
    expect((await spawn('first')).status).toBe(200);
  }, { bound: false, harness: 'codex' });
});

test('a retried task_spawn returns the committed task even after the project folder moved', async () => {
  await fixture(async ({ root, projectDir, spawn }) => {
    const first = await spawn('first');
    renameSync(projectDir, join(root, 'projects', 'moved'));
    const again = await spawn('first');
    expect({ status: again.status, taskId: again.body.taskId }).toEqual({ status: 200, taskId: first.body.taskId });
    expect((await spawn('second')).body.error).toBe('PROJECT_UNAVAILABLE');
  });
});
