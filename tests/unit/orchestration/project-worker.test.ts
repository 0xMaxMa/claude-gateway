import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { TaskWorkspaces } from '../../../src/orchestration/tasks/workspace';
import { ClaudeWorkerDriver } from '../../../src/orchestration/tasks/driver';
import { resolveProjectCwd } from '../../../src/projects/chat';
import type { ProjectName } from '../../../src/projects/paths';
import { AgentConfig, GatewayConfig } from '../../../src/types';

// A real SessionProcess spawn of the mock CLI, which records its cwd and argv.
const MOCK = resolve(__dirname, '../../helpers/mock-claude-worker.js');

interface Run { root: string; projectDir: string; argsfile: string; start: () => ReturnType<ClaudeWorkerDriver['start']>; spawned: () => { cwd: string; args: string[] } }

async function fixture(body: (run: Run) => Promise<void>, options: { trusted?: boolean } = {}): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-worker-')));
  const workspace = join(root, 'workspace'), projectDir = join(root, 'projects', 'demo'), argsfile = join(root, 'args.json');
  mkdirSync(workspace); mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(workspace, 'CLAUDE.md'), 'Persona');
  const saved = { bin: process.env.CLAUDE_BIN, mode: process.env.MOCK_WORKER_MODE, args: process.env.MOCK_WORKER_ARGSFILE };
  Object.assign(process.env, { CLAUDE_BIN: `${process.execPath} ${MOCK}`, MOCK_WORKER_MODE: 'complete', MOCK_WORKER_ARGSFILE: argsfile });
  const agent = { id: 'a', workspace, description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { tasks: { workspaceMode: 'host' } } } as unknown as AgentConfig;
  const gateway = { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs'), projects: { root: join(root, 'projects'), trusted: options.trusted ? ['demo'] : [] } }, agents: [agent] } as unknown as GatewayConfig;
  const store = new OrchestrationStore(':memory:', 'a');
  const tasks = new TaskService(store, agent.orchestration, workspace, async () => resolveProjectCwd(gateway, 'demo' as ProjectName));
  const bridge = new TaskBridge(tasks);
  try {
    await bridge.start();
    const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'api', accountId: 'u', principalId: 'u', chatId: 'c', threadKey: '' }, text: 'Work' });
    const decision = new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]);
    const context = { ...input, ...decision, principalId: 'u', actionId: 'spawn', execute: true, writeMemory: false };
    const task = tasks.spawn(context, { project: await tasks.projectPin(context), title: 'Work', instructions: 'Work', targetProfile: 'default-worker' });
    const attempt = tasks.claim(task.taskId)!;
    const driver = new ClaudeWorkerDriver(agent, gateway, tasks, bridge, new TaskWorkspaces(store, workspace, join(root, 'resources')), join(root, 'private'));
    await body({ root, projectDir, argsfile, start: () => driver.start(store.task(task.taskId)!, attempt, true), spawned: () => JSON.parse(readFileSync(argsfile, 'utf8')) });
  } finally {
    for (const [key, value] of [['CLAUDE_BIN', saved.bin], ['MOCK_WORKER_MODE', saved.mode], ['MOCK_WORKER_ARGSFILE', saved.args]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

test('a project task worker runs in the project folder', async () => {
  await fixture(async ({ projectDir, start, spawned }) => {
    const handle = await start();
    expect(await handle.result).toMatchObject({ type: 'completed' });
    expect(spawned().cwd).toBe(projectDir);
  });
}, 60000);

test('a project folder renamed between admission and start fails the task with PROJECT_UNAVAILABLE', async () => {
  await fixture(async ({ root, projectDir, argsfile, start }) => {
    renameSync(projectDir, join(root, 'projects', 'renamed'));
    await expect(start()).rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE' });
    expect(existsSync(argsfile)).toBe(false);
  });
}, 60000);

// The mock runs project SessionStart hooks the way the CLI does: only when --setting-sources includes project.
function hookedProject(projectDir: string, marker: string): void {
  mkdirSync(join(projectDir, '.claude'));
  writeFileSync(join(projectDir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }] } }));
}

test('an untrusted project worker loads user settings only, so the repo SessionStart hook never fires', async () => {
  await fixture(async ({ root, projectDir, start, spawned }) => {
    hookedProject(projectDir, join(root, 'hook-fired'));
    expect(await (await start()).result).toMatchObject({ type: 'completed' });
    const { args } = spawned();
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(existsSync(join(root, 'hook-fired'))).toBe(false);
  });
}, 60000);

test('a trusted project worker keeps the default setting sources, so the repo SessionStart hook fires', async () => {
  await fixture(async ({ root, projectDir, start, spawned }) => {
    hookedProject(projectDir, join(root, 'hook-fired'));
    expect(await (await start()).result).toMatchObject({ type: 'completed' });
    expect(spawned().args).not.toContain('--setting-sources');
    expect(existsSync(join(root, 'hook-fired'))).toBe(true);
  }, { trusted: true });
}, 60000);
