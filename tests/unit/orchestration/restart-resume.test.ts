import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { WorkerScheduler, WorkerHandle } from '../../../src/orchestration/tasks/scheduler';
import { shutdownFailure } from '../../../src/orchestration/tasks/failure';
import { recoverOrchestration } from '../../../src/orchestration/recovery';
import { MAX_RESTART_RESUMES } from '../../../src/orchestration/restart-resume';
import { CommandContext } from '../../../src/orchestration/types';

// Issue #603: a task interrupted by a gateway shutdown ended `failed` and was never resumed.
// The only follow-up was a non-executing report turn, so agents asked the user whether to
// continue (or told them to type "continue") although the work was already authorized.
let store: OrchestrationStore, tasks: TaskService, context: CommandContext;
const scope = { agentId: 'a', agentSessionId: 's', source: 'api' as const, accountId: 'u', chatId: 'c', threadKey: '', principalId: 'u' };
beforeEach(() => {
  store = new OrchestrationStore(':memory:', 'a');
  tasks = new TaskService(store);
  const input = store.acceptInput({ scope, text: 'Release 2.1.0' });
  const decision = new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]);
  context = { ...input, ...decision, principalId: 'u', execute: true, writeMemory: false, actionId: 'spawn' };
});
afterEach(() => store.close());
const spawn = (actionId = 'spawn') => tasks.spawn({ ...context, actionId }, { title: 'Release', instructions: 'Tag, push and publish 2.1.0', targetProfile: 'media-worker' });
const notifications = (taskId: string) => Number(store.get('SELECT COUNT(*) n FROM notifications WHERE task_id=?', taskId)!.n);
const interrupt = (taskId: string) => {
  const attempt = tasks.claim(taskId)!;
  tasks.started(attempt.attemptId, attempt.generation);
  return tasks.finish(attempt.attemptId, attempt.generation, { type: 'stopped', failure: shutdownFailure() });
};

/** A worker that runs until the gateway stops it. */
const blockingDriver = () => {
  const starts: string[] = [];
  return { starts, driver: { start: async (task: { taskId: string }) => {
    starts.push(task.taskId);
    let stop!: () => void;
    const result = new Promise<{ type: 'stopped' }>(resolve => { stop = () => resolve({ type: 'stopped' }); });
    return { accepted: Promise.resolve(), result, stop: async () => stop() } as WorkerHandle;
  } } };
};
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('a running task interrupted by gateway shutdown is re-queued, not failed, and sends no ask-to-continue report', async () => {
  const task = spawn();
  const { driver, starts } = blockingDriver();
  const before = new WorkerScheduler(tasks, driver);
  await before.tick(); await settle();
  expect(store.task(task.taskId)!.state).toBe('running');
  await before.close();

  const interrupted = store.task(task.taskId)!;
  expect(interrupted.state).toBe('queued');
  expect(interrupted.restartResumes).toBe(1);
  expect(interrupted.failure?.code).toBe('GATEWAY_SHUTDOWN');
  expect(notifications(task.taskId)).toBe(0);
  // The original user authorization travels with the same task.
  expect(interrupted.capabilities).toEqual({ execute: true, writeMemory: false });

  // After the restart the same task runs again without any user or agent action.
  recoverOrchestration(store);
  const after = new WorkerScheduler(tasks, driver);
  await after.tick(); await settle();
  expect(starts).toEqual([task.taskId, task.taskId]);
  expect(store.task(task.taskId)!.state).toBe('running');
  expect(store.task(task.taskId)!.failure).toBeUndefined();
  await after.close();
});

test(`repeated shutdown interruptions stop after ${MAX_RESTART_RESUMES} automatic resumes and report a blocker`, () => {
  const task = spawn();
  for (let i = 1; i <= MAX_RESTART_RESUMES; i++) {
    expect(interrupt(task.taskId).state).toBe('queued');
    expect(store.task(task.taskId)!.restartResumes).toBe(i);
  }
  const final = interrupt(task.taskId);
  expect(final.state).toBe('failed');
  expect(final.failure?.code).toBe('GATEWAY_SHUTDOWN_REPEATED');
  expect(final.failure?.message).toContain(String(MAX_RESTART_RESUMES + 1));
  expect(notifications(task.taskId)).toBe(1);
});

test('a task the user cancelled during shutdown is not resumed', async () => {
  const task = spawn();
  const { driver, starts } = blockingDriver();
  const scheduler = new WorkerScheduler(tasks, driver);
  await scheduler.tick(); await settle();
  tasks.cancelByUser(context.conversationId, 'u', task.taskId);
  expect(store.task(task.taskId)!.state).toBe('cancel_requested');
  await scheduler.close();
  expect(store.task(task.taskId)!.state).toBe('cancelled');
  recoverOrchestration(store);
  const after = new WorkerScheduler(tasks, driver);
  await after.tick(); await settle();
  expect(starts).toEqual([task.taskId]);
  await after.close();
});

test('a re-queued task the user cancels before it restarts stays cancelled', () => {
  const task = spawn();
  expect(interrupt(task.taskId).state).toBe('queued');
  expect(tasks.cancelByUser(context.conversationId, 'u', task.taskId).state).toBe('cancelled');
  recoverOrchestration(store);
  expect(tasks.claim(task.taskId)).toBeUndefined();
  expect(store.task(task.taskId)!.state).toBe('cancelled');
});

test('a task waiting for user input keeps its question through shutdown instead of resuming', () => {
  const task = spawn();
  const attempt = tasks.claim(task.taskId)!;
  tasks.started(attempt.attemptId, attempt.generation);
  tasks.requestInput(attempt.attemptId, attempt.generation, 'Which registry?');
  const after = tasks.finish(attempt.attemptId, attempt.generation, { type: 'stopped', failure: shutdownFailure() });
  expect(after.state).toBe('waiting_input');
  expect(after.pendingQuestion?.text).toBe('Which registry?');
  expect(after.restartResumes).toBeUndefined();
});

test('gateway-managed tasks and subagents are not re-queued by the shutdown path', () => {
  const managed = tasks.spawn({ ...context, actionId: 'managed' }, { title: 'Safemode', instructions: 'Inspect', targetProfile: 'gateway-managed', gatewayTarget: { adapter: 'safemode', sessionId: 'safe-1', name: 'Safe mode' } });
  expect(interrupt(managed.taskId).state).toBe('failed');

  const parent = spawn('parent'), parentAttempt = tasks.claim(parent.taskId)!;
  tasks.started(parentAttempt.attemptId, parentAttempt.generation);
  const child = tasks.spawnSubagent(parentAttempt.attemptId, parentAttempt.generation, 'c1', { title: 'Child', instructions: 'Read files' });
  expect(interrupt(child.taskId).state).toBe('failed');
});

test('a task that failed with GATEWAY_SHUTDOWN before this change is not resumed by restart recovery', () => {
  const task = spawn();
  const attempt = tasks.claim(task.taskId)!;
  tasks.started(attempt.attemptId, attempt.generation);
  tasks.finish(attempt.attemptId, attempt.generation, { type: 'stopped', failure: shutdownFailure() });
  // Simulate a row persisted by an older gateway: terminal, with no resume bookkeeping.
  const legacy = store.task(task.taskId)!;
  legacy.state = 'failed'; delete legacy.restartResumes;
  store.transaction(() => store.saveTask(legacy, legacy.stateVersion));
  recoverOrchestration(store);
  expect(store.task(task.taskId)!.state).toBe('failed');
  expect(tasks.claim(task.taskId)).toBeUndefined();
});
