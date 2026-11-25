import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { TaskWorkspaces } from '../../../src/orchestration/tasks/workspace';
import { ClaudeWorkerDriver } from '../../../src/orchestration/tasks/driver';
import { WorkerScheduler, WorkerHandle } from '../../../src/orchestration/tasks/scheduler';
import { recoverOrchestration } from '../../../src/orchestration/recovery';
import type { AgentConfig, GatewayConfig } from '../../../src/types';
import type { CommandContext, TaskAttempt } from '../../../src/orchestration/types';

// Issue #666: an attempt claimed (`starting`) whose worker was never spawned has no
// process identity, so cleanup could never prove it stopped. The task stayed in
// needs_reconciliation / CLEANUP_UNCONFIRMED forever: every cancel and every
// restart came back to the same state.
let root: string, store: OrchestrationStore, tasks: TaskService, context: CommandContext, cleanupDriver: ClaudeWorkerDriver;
const scope = { agentId: 'a', agentSessionId: 's', source: 'api' as const, accountId: 'u', chatId: 'c', threadKey: '', principalId: 'u' };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unspawned-'));
  store = new OrchestrationStore(':memory:', 'a');
  tasks = new TaskService(store);
  const input = store.acceptInput({ scope, text: 'Release 2.1.0' });
  const decision = new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]);
  context = { ...input, ...decision, principalId: 'u', execute: true, writeMemory: false, actionId: 'spawn' };
  const agent = { id: 'a', workspace: root, description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] } } as unknown as AgentConfig;
  const gateway = { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig;
  // A restarted gateway judges the persisted attempt with a fresh driver.
  cleanupDriver = new ClaudeWorkerDriver(agent, gateway, tasks, new TaskBridge(tasks), new TaskWorkspaces(store, root, join(root, 'resources')), join(root, 'private'));
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const spawn = (actionId = 'spawn') => tasks.spawn({ ...context, actionId }, { title: 'Release', instructions: 'Tag and publish 2.1.0', targetProfile: 'media-worker' });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
/** The real driver decides cleanup; starting a new attempt only records it. */
const scheduler = () => {
  const starts: string[] = [];
  const s = new WorkerScheduler(tasks, {
    cleanup: (attempt: TaskAttempt) => cleanupDriver.cleanup(attempt),
    start: async task => {
      starts.push(task.taskId);
      let stop!: () => void;
      const result = new Promise<{ type: 'stopped' }>(resolve => { stop = () => resolve({ type: 'stopped' }); });
      return { accepted: Promise.resolve(), result, stop: async () => stop() } as WorkerHandle;
    },
  });
  return { s, starts };
};
const heldSlots = (taskId: string) => Number(store.get('SELECT COUNT(*) n FROM worker_pool WHERE active_task_id=?', taskId)!.n);

test('a claimed attempt is marked as not yet spawned', () => {
  const attempt = tasks.claim(spawn().taskId)!;
  expect(store.attempt(attempt.attemptId)!.processSpawn).toBe('not_requested');
});

test('a gateway that dies after the claim but before the spawn resumes the task on restart', async () => {
  const task = spawn();
  tasks.claim(task.taskId);
  recoverOrchestration(store);
  expect(store.task(task.taskId)!.state).toBe('needs_reconciliation');
  const { s, starts } = scheduler();
  await s.tick(); await settle();
  const after = store.task(task.taskId)!;
  expect(after.state).toBe('running');
  expect(after.failure).toBeUndefined();
  expect(starts).toEqual([task.taskId]);
  await s.close();
});

test('restarts before the spawn do not spend restart resumes or brief the worker about an interruption', async () => {
  const task = spawn();
  tasks.claim(task.taskId);
  for (let restart = 0; restart <= 4; restart++) {
    recoverOrchestration(store);
    // The new attempt never gets past preparation, so the next restart again finds a claimed, unspawned attempt.
    const s = new WorkerScheduler(tasks, { cleanup: attempt => cleanupDriver.cleanup(attempt), start: () => new Promise<WorkerHandle>(() => {}) });
    await s.tick(); await settle();
    expect(store.task(task.taskId)!.state).toBe('starting');
  }
  expect(store.task(task.taskId)!.restartResume).toBeUndefined();
  expect(store.task(task.taskId)!.failure).toBeUndefined();
});

test('a subagent claimed but not spawned when the gateway restarted is cancelled with its resumed parent and frees its slot', async () => {
  const parent = spawn('parent'), parentAttempt = tasks.claim(parent.taskId)!;
  tasks.started(parentAttempt.attemptId, parentAttempt.generation);
  const child = tasks.spawnSubagent(parentAttempt.attemptId, parentAttempt.generation, 'child', { title: 'Check', instructions: 'Check CI' });
  expect(tasks.claim(child.taskId)).toBeDefined();
  recoverOrchestration(store);
  expect(store.task(child.taskId)!.state).toBe('needs_reconciliation');
  // The parent's worker is proven gone after the restart; the subagent's attempt never spawned.
  const s = new WorkerScheduler(tasks, {
    cleanup: async attempt => attempt.taskId === parent.taskId || cleanupDriver.cleanup(attempt),
    start: () => new Promise<WorkerHandle>(() => {}),
  });
  await s.tick(); await s.tick(); await settle();
  expect(store.task(child.taskId)!.state).toBe('cancelled');
  expect(heldSlots(child.taskId)).toBe(0);
});

test('cancelling an attempt that never spawned ends cancelled and frees its worker slot', async () => {
  const task = spawn();
  tasks.claim(task.taskId);
  expect(heldSlots(task.taskId)).toBe(1);
  expect(tasks.cancelByUser(context.conversationId, 'u', task.taskId).state).toBe('cancel_requested');
  const { s, starts } = scheduler();
  await s.tick(); await settle();
  expect(store.task(task.taskId)!.state).toBe('cancelled');
  expect(store.task(task.taskId)!.activeAttemptId).toBeUndefined();
  expect(heldSlots(task.taskId)).toBe(0);
  expect(starts).toEqual([]);
  await s.close();
});

test('an attempt whose spawn was requested but whose identity was never recorded is not presumed stopped', async () => {
  const task = spawn(), attempt = tasks.claim(task.taskId)!;
  tasks.recordSpawn(attempt);
  expect(store.attempt(attempt.attemptId)!.processSpawn).toBe('requested');
  recoverOrchestration(store);
  const { s, starts } = scheduler();
  await s.tick(); await settle();
  const after = store.task(task.taskId)!;
  expect(after.state).toBe('needs_reconciliation');
  expect(after.failure?.code).toBe('CLEANUP_UNCONFIRMED');
  expect(starts).toEqual([]);
  await s.close();
});

test('the spawn is not recorded once the attempt stopped being the one starting', () => {
  const task = spawn(), attempt = tasks.claim(task.taskId)!;
  tasks.cancelByUser(context.conversationId, 'u', task.taskId);
  expect(() => tasks.recordSpawn(attempt)).toThrow(expect.objectContaining({ code: 'ATTEMPT_CANCELLED_BEFORE_START' }));
  expect(store.attempt(attempt.attemptId)!.processSpawn).toBe('not_requested');
});

test('an attempt from before spawn tracking keeps its unconfirmed cleanup', async () => {
  const task = spawn(), attempt = tasks.claim(task.taskId)!;
  const legacy = store.attempt(attempt.attemptId)!;
  delete legacy.processSpawn;
  store.transaction(() => store.saveAttempt(legacy));
  expect(await cleanupDriver.cleanup(legacy)).toBe(false);
});
