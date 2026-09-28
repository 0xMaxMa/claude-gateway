import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { TaskWorkspaces } from '../../../src/orchestration/tasks/workspace';
import { ClaudeWorkerDriver } from '../../../src/orchestration/tasks/driver';
import { liveGroupMembers, processSupervisorSupported } from '../../../src/orchestration/process-supervisor';
import { setProcessPlatform } from '../../../src/orchestration/process-platform';
import type { TaskAttempt } from '../../../src/orchestration/types';
import { AgentConfig, GatewayConfig } from '../../../src/types';

// End-to-end through the real SessionProcess spawn on this OS: a mock Claude CLI
// is launched as a supervised worker, its completion is reported only after the
// supervisor proves the tree stopped, and cancellation kills a grandchild.
const MOCK = resolve(__dirname, '../../helpers/mock-claude-worker.js');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 15000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); } };

async function fixture(mode: 'complete' | 'hang', body: (run: { start: () => Promise<Awaited<ReturnType<ClaudeWorkerDriver['start']>>>; pidfile: string; store: OrchestrationStore; taskId: string; recover: (identity: TaskAttempt['processIdentity']) => Promise<boolean> }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'worker-tree-')), workspace = join(root, 'workspace'), pidfile = join(root, 'grandchild.pid');
  mkdirSync(workspace); writeFileSync(join(workspace, 'CLAUDE.md'), 'Fixture');
  const saved = { bin: process.env.CLAUDE_BIN, mode: process.env.MOCK_WORKER_MODE, pidfile: process.env.MOCK_WORKER_PIDFILE };
  Object.assign(process.env, { CLAUDE_BIN: `${process.execPath} ${MOCK}`, MOCK_WORKER_MODE: mode, MOCK_WORKER_PIDFILE: pidfile });
  const store = new OrchestrationStore(':memory:', 'a'), tasks = new TaskService(store), bridge = new TaskBridge(tasks);
  const agent = { id: 'a', workspace, description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { tasks: { workspaceMode: 'host' } } } as unknown as AgentConfig;
  const gateway = { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig;
  try {
    await bridge.start();
    const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'api', accountId: 'u', principalId: 'u', chatId: 's', threadKey: '' }, text: 'Work' });
    const decision = new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]);
    const task = tasks.spawn({ ...input, ...decision, principalId: 'u', actionId: 'spawn', execute: true, writeMemory: false }, { title: 'Work', instructions: 'Work', targetProfile: 'media-worker' });
    const attempt = tasks.claim(task.taskId)!;
    const driver = new ClaudeWorkerDriver(agent, gateway, tasks, bridge, new TaskWorkspaces(store, workspace, join(root, 'resources')), join(root, 'private'));
    // A restarted gateway has only the persisted identity: a new driver and a
    // fresh platform backend (no in-memory Windows lineage).
    const recover = (identity: TaskAttempt['processIdentity']) => { setProcessPlatform(undefined); return new ClaudeWorkerDriver(agent, gateway, tasks, bridge, new TaskWorkspaces(store, workspace, join(root, 'resources')), join(root, 'private')).cleanup({ ...attempt, processIdentity: identity }); };
    await body({ start: () => driver.start(store.task(task.taskId)!, attempt, true), pidfile, store, taskId: task.taskId, recover });
  } finally {
    for (const [key, value] of [['CLAUDE_BIN', saved.bin], ['MOCK_WORKER_MODE', saved.mode], ['MOCK_WORKER_PIDFILE', saved.pidfile]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

test('this host has a process supervisor', () => { expect(processSupervisorSupported()).toBe(['linux', 'darwin', 'win32'].includes(process.platform)); });

test('a supervised worker completes only after its process tree is proven stopped', async () => {
  await fixture('complete', async ({ start }) => {
    const handle = await start();
    await handle.accepted;
    const identity = await handle.identity!();
    expect(identity).toMatchObject({ pid: expect.any(Number), bootId: expect.any(String), startTicks: expect.any(String) });
    const outcome = await handle.result;
    expect(outcome).toMatchObject({ type: 'completed', result: { summary: 'Worker finished the task.' } });
    expect(await liveGroupMembers(identity!.pid)).toEqual([]);
  });
}, 60000);

test('cancelling a running worker kills the whole tree, grandchild included', async () => {
  await fixture('hang', async ({ start, pidfile }) => {
    const handle = await start();
    await handle.accepted;
    await until(() => existsSync(pidfile) && readFileSync(pidfile, 'utf8').length > 0);
    const grandchild = Number(readFileSync(pidfile, 'utf8'));
    const identity = await handle.identity!();
    expect(alive(grandchild)).toBe(true);
    expect(await liveGroupMembers(identity!.pid)).toEqual(expect.arrayContaining([identity!.pid, grandchild]));
    await handle.stop();
    expect(await handle.result).toMatchObject({ type: 'stopped' });
    await until(() => !alive(grandchild), 5000);
    expect(await liveGroupMembers(identity!.pid)).toEqual([]);
  });
}, 60000);

test('after a gateway restart the persisted identity stops the surviving tree, grandchild included', async () => {
  await fixture('hang', async ({ start, pidfile, recover }) => {
    const handle = await start();
    await handle.accepted;
    await until(() => existsSync(pidfile) && readFileSync(pidfile, 'utf8').length > 0);
    const grandchild = Number(readFileSync(pidfile, 'utf8'));
    const identity = await handle.identity!();
    expect(await recover({ ...identity!, startTicks: 'reused' })).toBe(false);
    expect(alive(grandchild)).toBe(true);
    expect(await recover(identity)).toBe(true);
    await until(() => !alive(grandchild), 5000);
    expect(await liveGroupMembers(identity!.pid)).toEqual([]);
    await handle.stop(); await handle.result;
  });
}, 60000);
