import { createContext, runInContext } from 'node:vm';
import { applySheetLines, PstackConfigError } from '../../../src/pstack/config';
import { pstackRoleDefault } from '../../../src/pstack/sheet';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { subagentLines } from '../../../src/orchestration/telegram-tool-status';
import { dashboardClient } from '../../../src/ui/dashboard-client';
import type { TaskSnapshot } from '../../../src/orchestration/types';
import { PSTACK_ROLES } from '../../helpers/pstack-fixture';

/**
 * Cross-provider pstack panels (#584): editing a panel role one entry at a
 * time, and how a panel's subagents show up — one Telegram status line per
 * root, a table on the root's status, a tree on the dashboard.
 */

const PLUGIN = { roles: PSTACK_ROLES, tiers: { default: 'opus', strongest: 'fable', panel: ['opus', 'fable', 'sonnet', 'haiku'] } };

describe('/pstack-setup panel entries', () => {
  const defaults = (role: string) => pstackRoleDefault(PLUGIN, role);

  it('appends to and removes from a panel, starting from the skill default', () => {
    let block = applySheetLines({}, 'interrogate reviewers += gpt-6-sol[1m] @high', defaults);
    expect(block.roles!['interrogate reviewers']).toBe('claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5, claude-haiku-5-5, gpt-6-sol[1m] @high');
    block = applySheetLines(block, 'interrogate reviewers -= claude-haiku-5-5\ninterrogate reviewers -= gpt-6-sol[1m]', defaults);
    expect(block.roles!['interrogate reviewers']).toBe('claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5');
  });

  it('a list emptied entry by entry drops the override', () => {
    const block = applySheetLines({ roles: { 'arena runners': 'claude-opus-5-5 @xhigh' } }, 'arena runners -= claude-opus-5-5', defaults);
    expect(block.roles).toBeUndefined();
  });

  it('refuses to remove a model that is not in the list', () => {
    expect(() => applySheetLines({ roles: { 'arena runners': 'claude-opus-5-5' } }, 'arena runners -= gpt-6-sol[1m]', defaults)).toThrow(PstackConfigError);
  });
});

describe('panel subagents on display', () => {
  let store: OrchestrationStore, tasks: TaskService, conversationId: string, root: TaskSnapshot;
  const LABELS: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'gpt-6-sol[1m]': 'GPT 6 Sol', 'claude-haiku-5-5': 'Haiku 5.5' };
  beforeEach(() => {
    store = new OrchestrationStore(':memory:', 'a');
    tasks = new TaskService(store, { tasks: { workspaceMode: 'host', maxConcurrentPerAgent: 10, maxConcurrentPerConversation: 10 } }, '/tmp');
    const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'telegram', accountId: 'u', principalId: 'u', chatId: 'c', threadKey: '' }, text: 'interrogate this' });
    const context = { ...input, ...new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]), principalId: 'u', execute: true, writeMemory: false, actionId: 'root', model: 'claude-opus-5-5' };
    conversationId = input.conversationId;
    root = tasks.spawn(context, { title: 'interrogate', instructions: 'Run interrogate', targetProfile: 'default-worker' });
    const attempt = tasks.claim(root.taskId)!; tasks.started(attempt.attemptId, attempt.generation);
    let n = 0;
    const child = (model: string) => tasks.spawnSubagent(attempt.attemptId, attempt.generation, `c${++n}`, { title: 'Review', instructions: 'r', model });
    const [opus, gpt, , haiku] = [child('claude-opus-5-5'), child('gpt-6-sol[1m]'), child('claude-opus-5-5'), child('claude-haiku-5-5')];
    const done = tasks.claim(opus.taskId)!; tasks.started(done.attemptId, done.generation);
    tasks.finish(done.attemptId, done.generation, { type: 'completed', result: { summary: 'ok', artifactIds: [] } });
    const failed = tasks.claim(haiku.taskId)!; tasks.started(failed.attemptId, failed.generation);
    tasks.finish(failed.attemptId, failed.generation, { type: 'failed', failure: { code: 'WORKER_TIMEOUT', message: 'timed out', observedAt: Date.now() } });
    const codex = tasks.claim(gpt.taskId)!; codex.harness = 'codex'; store.transaction(() => store.saveAttempt(codex)); tasks.started(codex.attemptId, codex.generation);
  });
  afterEach(() => store.close());

  it('Telegram shows one line per running root with each subagent\'s model label and state', () => {
    expect(subagentLines(store, conversationId, id => LABELS[id] ?? id)).toEqual([
      'interrogate: 2/4 · ✅ Opus 5.5 · ⏳ GPT 6 Sol · ⏳ Opus 5.5 · ❌ Haiku 5.5 (worker timeout)',
    ]);
  });

  it('a finished root has no line', () => {
    const attempt = store.attempt(store.task(root.taskId)!.activeAttemptId!)!;
    tasks.finish(attempt.attemptId, attempt.generation, { type: 'completed', result: { summary: 'Lead summary', artifactIds: [] } });
    expect(subagentLines(store, conversationId)).toEqual([]);
  });

  it('the root\'s status carries model · harness · effort · state · duration for each subagent', () => {
    const subagents = (tasks.status(conversationId, 'u', root.taskId)[0] as any).subagents;
    expect(subagents.map((s: any) => [s.model, s.harness, s.state])).toEqual([
      ['claude-opus-5-5', undefined, 'completed'], ['gpt-6-sol[1m]', 'codex', 'running'], ['claude-opus-5-5', undefined, 'queued'], ['claude-haiku-5-5', undefined, 'failed'],
    ]);
    expect(subagents[0].durationMs).toEqual(expect.any(Number));
    expect(subagents[3].failure).toBe('WORKER_TIMEOUT');
    expect(subagents[2].durationMs).toBeUndefined();
  });
});

describe('dashboard task tree', () => {
  function rowsFor(tasks: Array<Record<string, unknown>>) {
    const start = dashboardClient.indexOf('function dashboardTaskRows(){');
    const end = dashboardClient.indexOf('function dashText(', start);
    const context = createContext({ dashboardRows: () => [{ a: { id: 'a' }, s: { sessionId: 's', tasks } }], escHtml: (v: string) => v });
    runInContext(dashboardClient.slice(start, end) + ';function dashText(v){return escHtml(v==null?"—":String(v));}', context);
    return { order: (runInContext('dashboardTaskRows()', context) as Array<{ t: { taskId: string } }>).map(r => r.t.taskId), label: (t: unknown) => runInContext('subagentLabel', context)(t) as string };
  }

  it('lists subagents under their parent, oldest first, and roots by recency', () => {
    const { order } = rowsFor([
      { taskId: 'root-old', updatedAt: 1 },
      { taskId: 'child-2', parentTaskId: 'root-new', depth: 1, updatedAt: 9 },
      { taskId: 'root-new', updatedAt: 5 },
      { taskId: 'grandchild', parentTaskId: 'child-1', depth: 2, updatedAt: 8 },
      { taskId: 'child-1', parentTaskId: 'root-new', depth: 1, updatedAt: 7 },
      { taskId: 'orphan', parentTaskId: 'gone', depth: 1, updatedAt: 3 },
    ]);
    expect(order).toEqual(['root-new', 'child-1', 'grandchild', 'child-2', 'orphan', 'root-old']);
  });

  it('labels a subagent with its depth, model, harness and effort', () => {
    const { label } = rowsFor([]);
    expect(label({ parentTaskId: 'p', depth: 2, model: 'gpt-6-sol[1m]', harness: 'codex', effort: 'high' })).toContain('↳ ↳ gpt-6-sol[1m] · Codex · high');
    expect(label({ taskId: 'root' })).toBe('');
  });
});
