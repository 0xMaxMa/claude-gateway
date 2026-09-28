import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';

// Issue #546: a report/non-executing turn that tries task_answer used to get a
// bare {"error":"EXECUTION_DENIED"} with no message, indistinguishable from an
// infrastructure outage or a lost answer. The bridge must surface the
// permission boundary as a non-retryable, explained failure that points at the
// recovery route, without granting the report turn execute capability.
test('report-turn task_answer is denied with an explained, non-retryable permission boundary (issue #546)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'report-turn-answer-'));
  const store = new OrchestrationStore(':memory:', 'a');
  const tasks = new TaskService(store, undefined, root), bridge = new TaskBridge(tasks);
  const decisions = new DecisionService(store);
  try {
    const scope = { agentId: 'a', agentSessionId: 's', source: 'api' as const, accountId: 'u', principalId: 'u', chatId: 'c', threadKey: '' };
    // An executing turn spawns the task and drives it to a pending question.
    const input = store.acceptInput({ scope, text: 'Do the authorized work' });
    const decision = decisions.begin(input.conversationId, 'u', [input.inputId]);
    const task = tasks.spawn({ ...input, ...decision, principalId: 'u', execute: true, writeMemory: false, actionId: 'spawn' },
      { title: 'Work', instructions: 'Ask which resource to use', targetProfile: 'media-worker' });
    const attempt = tasks.claim(task.taskId)!;
    tasks.started(attempt.attemptId, attempt.generation);
    const waiting = tasks.requestInput(attempt.attemptId, attempt.generation, 'Which resource should I use?');
    const questionId = waiting.pendingQuestion!.questionId;
    decisions.finish(decision, 'Working on it.');

    // A separate report/non-executing turn (execute: false) tries to answer.
    const reportInput = store.acceptInput({ scope, text: '(status report)', storeUserMessage: false });
    const reportDecision = decisions.begin(reportInput.conversationId, 'u', [reportInput.inputId]);
    await bridge.start();
    bridge.issue({ role: 'agent', context: { ...reportInput, ...reportDecision, principalId: 'u', execute: false, writeMemory: false } }, join(root, 'ticket'), root);
    const ticket = JSON.parse(readFileSync(join(root, 'ticket/ticket.json'), 'utf8'));
    const response = await fetch(ticket.url, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'task_answer', action_id: 'answer', args: { task_id: task.taskId, question_id: questionId, answer: '/some/path' } }) });
    const body = await response.json() as { error: string; message?: string; retryable?: boolean };

    expect(response.status).toBe(400);
    expect(body.error).toBe('EXECUTION_DENIED');
    // The model must be able to tell this apart from an outage and know it need not retry here.
    expect(body.retryable).toBe(false);
    expect(typeof body.message).toBe('string');
    expect(body.message).toMatch(/report\/non-executing turn/);
    expect(body.message).toMatch(/not a system outage/);
    expect(body.message).toMatch(/durably saved/);
    // The permission boundary held: no answer was committed on the report turn.
    expect(store.task(task.taskId)!.state).toBe('waiting_input');
    expect(store.task(task.taskId)!.pendingQuestion!.questionId).toBe(questionId);
  } finally { await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
