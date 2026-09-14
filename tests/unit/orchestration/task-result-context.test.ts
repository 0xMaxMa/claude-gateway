import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';

function fixture() {
  const store = new OrchestrationStore(':memory:', 'agent');
  const tasks = new TaskService(store), decisions = new DecisionService(store);
  const scope = {agentId: 'agent', agentSessionId: 'session', source: 'api' as const, accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'owner'};
  const input = store.acceptInput({scope, text: 'Do the requested work'});
  const decision = decisions.begin(input.conversationId, 'owner', [input.inputId]);
  let seq = 0;
  const complete = (summary: string) => {
    const task = tasks.spawn({...input, ...decision, principalId: 'owner', execute: true, writeMemory: false, actionId: `spawn-${seq++}`},
      {title: 'Fixture task', instructions: 'Inspect fixture', targetProfile: 'default-worker'});
    const attempt = tasks.claim(task.taskId)!;
    tasks.started(attempt.attemptId, attempt.generation);
    const result = {summary, artifactIds: [], diff: {text: 'Complete recorded diff', truncated: false}};
    tasks.finish(attempt.attemptId, attempt.generation, {type: 'completed', result});
    return {taskId: task.taskId, result};
  };
  const report = () => {
    decisions.finish(decision, 'Queued');
    const next = store.acceptInput({scope, text: 'Report the result', storeUserMessage: false});
    return decisions.begin(input.conversationId, 'owner', [next.inputId]);
  };
  return {store, tasks, input, decision, complete, report};
}

test('current reports preserve every result field; historical indexes avoid resending result bodies', () => {
  const f = fixture();
  try {
    const full = 'หลักฐาน 日本語 🎯 '.repeat(5000) + 'FINAL: skill and shared knowledge findings';
    const task = f.complete(full);
    const event = f.store.get("SELECT payload_json FROM conversation_events WHERE type='task.state_changed' ORDER BY seq DESC LIMIT 1")!;
    expect(JSON.parse(String(event.payload_json)).payload).toMatchObject({resultAvailable: true, resultRef: {task_id: task.taskId}});
    expect(f.store.task(task.taskId)!.result).toEqual(task.result);
    const indexed = f.tasks.context(f.input.conversationId, 'owner', f.decision.decisionId);
    expect(indexed[0]).toMatchObject({resultAvailable: true, details: {tool: 'task_status', task_id: task.taskId}});
    expect(indexed[0]).not.toHaveProperty('result');
    expect(JSON.stringify(indexed).length).toBeLessThan(full.length / 4);
    expect(f.tasks.status(f.input.conversationId, 'owner', task.taskId)[0].result).toEqual(task.result);
    expect(f.tasks.status(f.input.conversationId, 'owner')[0].result).toEqual(task.result);
    const report = f.report();
    expect(f.tasks.context(f.input.conversationId, 'owner', report.decisionId)[0]).toMatchObject({result: task.result});
  } finally { f.store.close(); }
});

test('an older task being reported is included in full even outside the latest 100 completed tasks', () => {
  const f = fixture();
  try {
    const old = f.complete('Long-lived task result '.repeat(100) + 'END');
    f.store.run('UPDATE tasks SET created_at=0 WHERE id=?', old.taskId);
    for (let i = 0; i < 100; i++) f.complete('Unrelated historical result');
    f.store.run("UPDATE notifications SET status='handled' WHERE task_id!=?", old.taskId);
    expect(f.tasks.status(f.input.conversationId, 'owner').some(task => task.taskId === old.taskId)).toBe(false);
    const report = f.report();
    const context = f.tasks.context(f.input.conversationId, 'owner', report.decisionId);
    expect(context.find(task => task.taskId === old.taskId)).toMatchObject({result: old.result});
    expect(JSON.stringify(context)).not.toContain('Unrelated historical result');
  } finally { f.store.close(); }
});

test('result context retains conversation authorization', () => {
  const f = fixture();
  try {
    f.complete('Private result');
    expect(() => f.tasks.context(f.input.conversationId, 'stranger', f.decision.decisionId)).toThrow('ACCESS_DENIED');
  } finally { f.store.close(); }
});
