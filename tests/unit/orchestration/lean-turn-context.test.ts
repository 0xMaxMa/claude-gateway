import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { committedCommandContext } from '../../../src/orchestration/decision-context';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

const USER_TEXT = 'Zลบงาน queue ทิ้งให้หมด — the newest and most volatile bytes of the turn';

test('the per-turn message ends with the user text, keeping the volatile bytes behind the stable context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lean-turn-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const prompts: string[] = [], overlays: string[] = [];
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    createAgentSession: async (_id, profile) => Object.assign(new EventEmitter(), {
      start: async () => {}, stop: async () => {},
      sendMessage: function (this: EventEmitter, prompt: string) {
        overlays.push(profile.overlay); prompts.push(prompt);
        this.emit('output', JSON.stringify({ type: 'result', result: 'Done.' }));
      },
    }) as unknown as SessionProcess, releaseAgentSession: async () => {},
  });
  const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
  try {
    expect(await runtime.send({ scope, text: USER_TEXT }, { execute: true, writeMemory: false }, { timeoutMs: 2000 })).toBe('Done.');
    const prompt = prompts[0];
    // The cache breakpoint sits at the end of this message, so the one part that differs on
    // every single turn has to come last or nothing before it can ever be reused.
    expect(prompt.endsWith('\n' + USER_TEXT)).toBe(true);
    expect(prompt.split(USER_TEXT)).toHaveLength(2); // carried once, not duplicated at the front
    expect(prompt.indexOf('[Orchestration context: persisted task snapshots')).toBeLessThan(prompt.indexOf(USER_TEXT));
    expect(prompt.indexOf('Recent committed command receipts')).toBeLessThan(prompt.indexOf(USER_TEXT));
    // A real user message is labelled as such, so its authority is not confused with the
    // orchestration report request that occupies the same slot on a notification turn.
    expect(prompt).toContain('[Current user message — the request to answer now]');
    expect(prompt).not.toContain('Current orchestration request');
    // The cached prefix stays free of per-turn content, as PR #502's invariance fix requires.
    expect(overlays[0]).not.toContain(USER_TEXT);
  } finally { await runtime.close(); (history as never as {db:{close():void}}).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const store = new OrchestrationStore(':memory:', 'agent');
  const tasks = new TaskService(store), decisions = new DecisionService(store);
  const scope = { agentId: 'agent', agentSessionId: 'session', source: 'api' as const, accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'owner' };
  const input = store.acceptInput({ scope, text: 'Do the requested work' });
  const decision = decisions.begin(input.conversationId, 'owner', [input.inputId]);
  let seq = 0;
  const spawn = (title: string) => tasks.spawn({ ...input, ...decision, principalId: 'owner', execute: true, writeMemory: false, actionId: `spawn-${seq++}` },
    { title, instructions: 'Inspect fixture', targetProfile: 'default-worker' });
  const checkpoint = { version: 1 as const, observedAt: 1, attemptId: 'attempt',
    checkpoint: { phase: 'evidence', evidenceVersion: 'v1', nextAction: 'continue', checks: [{ id: 'c', outcome: 'WORKFLOW_REPORT_BODY', evidenceVersion: 'v1' }], findings: [] }, reviews: [] };
  const run = (title: string, finished: boolean) => {
    const task = spawn(title);
    const attempt = tasks.claim(task.taskId)!;
    tasks.started(attempt.attemptId, attempt.generation);
    const stored = store.task(task.taskId)!;
    store.run('UPDATE tasks SET snapshot_json=? WHERE id=?', JSON.stringify({ ...stored, workflow: checkpoint }), task.taskId);
    if (finished) tasks.finish(attempt.attemptId, attempt.generation, { type: 'completed', result: { summary: 'RESULT_BODY', artifactIds: [] } });
    return task.taskId;
  };
  return { store, tasks, input, decision, run };
}

test('the task index is a bounded page whose finished rows carry no report body, with detail on demand', () => {
  const f = fixture();
  try {
    const running = f.run('Still working', false);
    const finished: string[] = [];
    for (let i = 0; i < 25; i++) finished.push(f.run(`Finished ${i}`, true));
    f.store.run("UPDATE notifications SET status='handled'");
    const index = f.tasks.context(f.input.conversationId, 'owner', f.decision.decisionId);
    // Every unfinished task is always present, so "what is running/queued/blocked" stays answerable.
    expect(index.find(task => task.taskId === running)).toBeTruthy();
    expect(index.filter(task => ['completed', 'failed', 'cancelled'].includes(task.state))).toHaveLength(20);
    expect(index.find(task => task.taskId === finished[0])).toBeUndefined(); // oldest fell off the page
    // A finished task's checkpoint/review history and result body are reports, not index fields.
    const closed = index.find(task => task.taskId === finished[24]) as Record<string, unknown>;
    expect(closed).toMatchObject({ state: 'completed', resultAvailable: true, details: { tool: 'task_status', task_id: finished[24] } });
    expect(closed.workflow).toBeUndefined();
    const closedRows = index.filter(task => ['completed', 'failed', 'cancelled'].includes(task.state));
    expect(JSON.stringify(closedRows)).not.toContain('WORKFLOW_REPORT_BODY');
    expect(JSON.stringify(index)).not.toContain('RESULT_BODY');
    // An unfinished task keeps its live workflow: that is the progress the agent reasons about.
    expect((index.find(task => task.taskId === running) as Record<string, unknown>).workflow).toMatchObject({ checkpoint: { phase: 'evidence' } });
    // Nothing dropped from the index is lost: task_status with a task_id still returns it.
    const detail = f.tasks.status(f.input.conversationId, 'owner', finished[24])[0];
    expect(JSON.stringify(detail.workflow)).toContain('WORKFLOW_REPORT_BODY');
    expect(detail.result!.summary).toBe('RESULT_BODY');
  } finally { f.store.close(); }
});

test('committed receipts are a short window of allowlisted fields, keeping the pending question', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 14; i++) f.run(`Committed ${i}`, true);
    const heavy = f.store.all('SELECT action_id,receipt_json FROM task_commands ORDER BY rowid DESC LIMIT 1')[0];
    f.store.run('UPDATE task_commands SET receipt_json=? WHERE action_id=?', JSON.stringify({
      ...JSON.parse(String(heavy.receipt_json)),
      instructions: 'INSTRUCTIONS_BODY '.repeat(200), resourceProfile: { projectRoot: '/repo', mode: 'host' },
      capabilities: { execute: true, writeMemory: false }, conversationId: 'CONVERSATION_ECHO',
      pendingQuestion: { questionId: 'q1', text: 'Approve?', revision: 1 },
    }), heavy.action_id);
    const committed = committedCommandContext(f.store, f.input.conversationId);
    expect(committed).toHaveLength(10);
    const receipt = committed[0].receipt as Record<string, unknown>;
    // A receipt is the snapshot as committed, so a spawn receipt is still queued.
    expect(receipt).toMatchObject({ title: 'Committed 13', state: 'queued', pendingQuestion: { questionId: 'q1' } });
    // An allowlist: heavy or already-known fields are not copied into every later turn.
    for (const dropped of ['instructions', 'resourceProfile', 'capabilities', 'conversationId', 'agentSessionId', 'ownerPrincipalId', 'initiatingInputId']) {
      expect(receipt[dropped]).toBeUndefined();
    }
    expect(JSON.stringify(committed)).not.toContain('INSTRUCTIONS_BODY');
    expect(JSON.stringify(committed)).not.toContain('CONVERSATION_ECHO');
  } finally { f.store.close(); }
});
