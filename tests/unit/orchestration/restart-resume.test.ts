import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { WorkerScheduler, WorkerHandle } from '../../../src/orchestration/tasks/scheduler';
import { shutdownFailure } from '../../../src/orchestration/tasks/failure';
import { recoverOrchestration } from '../../../src/orchestration/recovery';
import { MAX_RESTART_RESUMES, ORPHANED_SHUTDOWN_WINDOW_MS } from '../../../src/orchestration/restart-resume';
import { CommandContext, TaskSnapshot } from '../../../src/orchestration/types';

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
  expect(interrupted.restartResume).toMatchObject({ count: 1, pending: true });
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
    expect(store.task(task.taskId)!.restartResume?.count).toBe(i);
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
  expect(after.restartResume).toBeUndefined();
});

test('gateway-managed tasks and subagents are not re-queued by the shutdown path', () => {
  const managed = tasks.spawn({ ...context, actionId: 'managed' }, { title: 'Safemode', instructions: 'Inspect', targetProfile: 'gateway-managed', gatewayTarget: { adapter: 'safemode', sessionId: 'safe-1', name: 'Safe mode' } });
  expect(interrupt(managed.taskId).state).toBe('failed');

  const parent = spawn('parent'), parentAttempt = tasks.claim(parent.taskId)!;
  tasks.started(parentAttempt.attemptId, parentAttempt.generation);
  const child = tasks.spawnSubagent(parentAttempt.attemptId, parentAttempt.generation, 'c1', { title: 'Child', instructions: 'Read files' });
  expect(interrupt(child.taskId).state).toBe('failed');
});

describe('a GATEWAY_SHUTDOWN failure settled by a gateway without restart resume (#605)', () => {
  // The process an upgrade replaces ran the pre-#603 shutdown path: the task ended failed, with
  // no resume bookkeeping and its failure report pending, and nothing resumed it after the restart.
  let spawned = 0;
  // Rewrites the row in place, as the stopping process persisted it, keeping the state version its report refers to.
  const persist = (task: TaskSnapshot) => store.run('UPDATE tasks SET snapshot_json=? WHERE id=?', JSON.stringify(task), task.taskId);
  const legacyShutdown = (observedAt = Date.now()) => {
    const task = spawn(`legacy-${spawned++}`);
    const attempt = tasks.claim(task.taskId)!;
    tasks.started(attempt.attemptId, attempt.generation);
    tasks.finish(attempt.attemptId, attempt.generation, { type: 'failed', failure: { code: 'WORKER_FAILED', message: 'placeholder', observedAt } });
    const legacy = store.task(task.taskId)!;
    legacy.failure = { code: 'GATEWAY_SHUTDOWN', message: 'Gateway shutdown interrupted this worker. Inspect existing changes before continuing; do not blindly repeat side effects.', observedAt };
    persist(legacy);
    return store.task(task.taskId)!;
  };
  const pendingNotifications = (taskId: string) => Number(store.get("SELECT COUNT(*) n FROM notifications WHERE task_id=? AND status='pending'", taskId)!.n);

  test('is resumed once by startup recovery, without its failure report', async () => {
    const task = legacyShutdown();
    expect(task.state).toBe('failed');
    expect(pendingNotifications(task.taskId)).toBe(1);
    recoverOrchestration(store);
    const resumed = store.task(task.taskId)!;
    expect(resumed.state).toBe('queued');
    expect(resumed.restartResume).toMatchObject({ count: 1, revision: 1, pending: true });
    expect(pendingNotifications(task.taskId)).toBe(0);
    // Idempotent: a second startup does not resume it again.
    recoverOrchestration(store);
    expect(store.task(task.taskId)!.restartResume).toMatchObject({ count: 1 });
    const { driver, starts } = blockingDriver();
    const after = new WorkerScheduler(tasks, driver);
    await after.tick(); await settle();
    expect(starts).toEqual([task.taskId]);
    expect(store.task(task.taskId)!.state).toBe('running');
    await after.close();
  });

  test(`ends GATEWAY_SHUTDOWN_REPEATED once its revision has used ${MAX_RESTART_RESUMES} resumes`, () => {
    const task = legacyShutdown();
    task.restartResume = { count: MAX_RESTART_RESUMES, revision: 1, pending: false };
    persist(task);
    recoverOrchestration(store);
    const after = store.task(task.taskId)!;
    expect(after.state).toBe('failed');
    expect(after.failure?.code).toBe('GATEWAY_SHUTDOWN_REPEATED');
    // Its pending report now refers to the blocker state, not the superseded shutdown failure.
    expect(store.get("SELECT task_state_version v FROM notifications WHERE task_id=? AND status='pending'", task.taskId)!.v).toBe(after.stateVersion);
    expect(tasks.claim(task.taskId)).toBeUndefined();
  });

  test('is not resumed when its failure was already reported, so the user may have acted on it', () => {
    const task = legacyShutdown();
    store.run("UPDATE notifications SET status='handled' WHERE task_id=?", task.taskId);
    recoverOrchestration(store);
    expect(store.task(task.taskId)!.state).toBe('failed');
    expect(store.task(task.taskId)!.restartResume).toBeUndefined();
  });

  test('is not resumed when it is old, cancelled, asking, gateway-managed, a subagent or superseded', () => {
    const edit = (change: (task: TaskSnapshot) => void) => {
      const task = legacyShutdown();
      change(task);
      persist(task);
      return task;
    };
    const skipped = [
      legacyShutdown(Date.now() - ORPHANED_SHUTDOWN_WINDOW_MS - 1000),
      edit(task => { task.cancellation = { requestedBy: 'user', requestedAt: Date.now() }; }),
      edit(task => { task.pendingQuestion = { questionId: 'q', text: 'Which registry?', revision: 1 }; }),
      edit(task => { task.gatewayTarget = { adapter: 'safemode', sessionId: 'safe-1', name: 'Safe mode' }; }),
      edit(task => { task.parentTaskId = 'parent'; }),
      edit(task => { task.revision = 2; }),
    ];
    recoverOrchestration(store);
    for (const task of skipped) {
      const after = store.task(task.taskId)!;
      expect(after.state).toBe('failed');
      expect(after.failure?.code).toBe('GATEWAY_SHUTDOWN');
      expect(after.restartResume).toBeUndefined();
    }
  });
});

test('the resume cap counts interruptions of one revision; a new user revision starts a fresh budget', () => {
  const task = spawn();
  for (let i = 0; i < MAX_RESTART_RESUMES; i++) interrupt(task.taskId);
  expect(store.task(task.taskId)!.restartResume?.count).toBe(MAX_RESTART_RESUMES);
  const updated = tasks.update({ ...context, actionId: 'update' }, task.taskId, 1, 'Also publish the docs', 'when_ready');
  expect(updated.revision).toBe(2);
  expect(interrupt(task.taskId).state).toBe('queued');
  expect(store.task(task.taskId)!.restartResume).toMatchObject({ count: 1, revision: 2 });
});

test('the last worker progress survives a second interruption that reported nothing new', () => {
  const task = spawn();
  const first = tasks.claim(task.taskId)!;
  tasks.started(first.attemptId, first.generation);
  tasks.progress(first.attemptId, first.generation, 'Tag v9.9.9 pushed; publish not started.');
  tasks.finish(first.attemptId, first.generation, { type: 'stopped', failure: shutdownFailure() });
  interrupt(task.taskId);
  expect(store.task(task.taskId)!.restartResume).toMatchObject({ count: 2, pending: true, lastProgress: 'Tag v9.9.9 pushed; publish not started.' });
});

test('a resumed attempt that fails before starting does not keep the resume brief pending', () => {
  const task = spawn();
  interrupt(task.taskId);
  const attempt = tasks.claim(task.taskId)!;
  const failed = tasks.finish(attempt.attemptId, attempt.generation, { type: 'failed', failure: { code: 'WORKER_START_FAILED', message: 'spawn failed', observedAt: Date.now() } });
  expect(failed.state).toBe('failed');
  expect(failed.restartResume?.pending).toBe(false);
});

describe('a worker that outlived a crashed or killed gateway', () => {
  const crash = () => {
    const task = spawn(), attempt = tasks.claim(task.taskId)!;
    tasks.started(attempt.attemptId, attempt.generation);
    recoverOrchestration(store);
    expect(store.task(task.taskId)!.state).toBe('needs_reconciliation');
    return task;
  };
  const scheduler = (stopped: boolean) => {
    const cleanup = jest.fn(async () => stopped);
    const { driver, starts } = blockingDriver();
    return { cleanup, starts, scheduler: new WorkerScheduler(tasks, { ...driver, cleanup }) };
  };
  test('is stopped, then its task resumes like a graceful shutdown', async () => {
    const task = crash();
    const { scheduler: s, cleanup, starts } = scheduler(true);
    await s.tick(); await settle();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(store.task(task.taskId)!.restartResume).toMatchObject({ count: 1 });
    expect(starts).toEqual([task.taskId]);
    expect(notifications(task.taskId)).toBe(0);
    await s.close();
  });
  test('carries the last worker progress into the resumed brief', async () => {
    const task = spawn(), attempt = tasks.claim(task.taskId)!;
    tasks.started(attempt.attemptId, attempt.generation);
    tasks.progress(attempt.attemptId, attempt.generation, 'Branch pushed; waiting for CI.');
    recoverOrchestration(store);
    const { scheduler: s } = scheduler(true);
    await s.tick(); await settle();
    expect(store.task(task.taskId)!.restartResume?.lastProgress).toBe('Branch pushed; waiting for CI.');
    await s.close();
  });
  test('is cleaned up but not resumed when the user had stopped the task or it awaited an answer', async () => {
    const stoppedTask = spawn('stopped'), stoppedAttempt = tasks.claim(stoppedTask.taskId)!;
    tasks.started(stoppedAttempt.attemptId, stoppedAttempt.generation);
    tasks.cancelByUser(context.conversationId, 'u', stoppedTask.taskId);
    const asking = spawn('asking'), askingAttempt = tasks.claim(asking.taskId)!;
    tasks.started(askingAttempt.attemptId, askingAttempt.generation);
    tasks.requestInput(askingAttempt.attemptId, askingAttempt.generation, 'Which registry?');
    recoverOrchestration(store);
    expect(store.task(stoppedTask.taskId)!.restartRecovery).toBeUndefined();
    expect(store.task(asking.taskId)!.restartRecovery).toBeUndefined();
    const { scheduler: s, starts } = scheduler(true);
    await s.tick(); await settle();
    expect(starts).toEqual([]);
    expect(store.task(stoppedTask.taskId)!.restartResume).toBeUndefined();
    expect(store.task(asking.taskId)!.restartResume).toBeUndefined();
    await s.close();
  });
  test('a task the user stops while it awaits recovery is never resumed', async () => {
    const task = crash();
    expect(tasks.cancelByUser(context.conversationId, 'u', task.taskId).state).toBe('cancel_requested');
    const { scheduler: s, starts } = scheduler(true);
    await s.tick(); await settle();
    expect(store.task(task.taskId)!.state).toBe('cancelled');
    expect(starts).toEqual([]);
    await s.close();
  });
  test('stays in reconciliation and reports the blocker when it cannot be proven stopped', async () => {
    const task = crash();
    const { scheduler: s, starts } = scheduler(false);
    await s.tick(); await s.tick(); await settle();
    const after = store.task(task.taskId)!;
    expect(after.state).toBe('needs_reconciliation');
    expect(after.failure?.code).toBe('CLEANUP_UNCONFIRMED');
    expect(starts).toEqual([]);
    expect(notifications(task.taskId)).toBe(1);
    await s.close();
  });
});

test('a graceful shutdown that cannot confirm the worker stopped resumes after the next gateway stops it', async () => {
  const task = spawn();
  const attempt = tasks.claim(task.taskId)!;
  tasks.started(attempt.attemptId, attempt.generation);
  const after = tasks.finish(attempt.attemptId, attempt.generation, { type: 'unknown', failure: shutdownFailure() });
  expect(after.state).toBe('needs_reconciliation');
  expect(after.restartRecovery).toBeDefined();
  expect(notifications(task.taskId)).toBe(0);
  recoverOrchestration(store);
  const { driver } = blockingDriver();
  const s = new WorkerScheduler(tasks, { ...driver, cleanup: async () => true });
  await s.tick(); await settle();
  expect(store.task(task.taskId)!.restartResume).toMatchObject({ count: 1 });
  expect(store.task(task.taskId)!.state).toBe('running');
  await s.close();
});
