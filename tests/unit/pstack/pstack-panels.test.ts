import { createContext, runInContext } from 'node:vm';
import { applySheetLines, PstackConfigError } from '../../../src/pstack/config';
import { pstackPanelDefault } from '../../../src/pstack/sheet';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { subagentLines } from '../../../src/orchestration/telegram-tool-status';
import { dashboardClient } from '../../../src/ui/dashboard-client';
import { dashboardEscape } from '../../../src/ui/dashboard-presentation';
import type { TaskSnapshot } from '../../../src/orchestration/types';
import { PSTACK_ROLES } from '../../helpers/pstack-fixture';

/**
 * Cross-provider pstack panels (#584): editing a panel role one entry at a
 * time, and how a panel's subagents show up — one Telegram status line per
 * root, a table on the root's status, a tree on the dashboard.
 */

const PLUGIN = { roles: PSTACK_ROLES, tiers: { default: 'opus', strongest: 'fable', panel: ['opus', 'fable', 'sonnet', 'haiku'] } };

describe('/pstack-setup panel entries', () => {
  const defaults = (role: string) => pstackPanelDefault(PLUGIN, role);

  it('appends to and removes from a panel, starting from the skill default', () => {
    let block = applySheetLines({}, 'interrogate reviewers += gpt-6-sol[1m] @high', defaults);
    expect(block.roles!['interrogate reviewers']).toBe('claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5, claude-haiku-5-5, gpt-6-sol[1m] @high');
    block = applySheetLines(block, 'interrogate reviewers -= claude-haiku-5-5\ninterrogate reviewers -= gpt-6-sol[1m]', defaults);
    expect(block.roles!['interrogate reviewers']).toBe('claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5');
  });

  // Review of #584: emptying a panel used to fall back silently to the skill default.
  it('refuses to remove the last entry, pointing at "<role>: default"', () => {
    expect(() => applySheetLines({ roles: { 'arena runners': 'claude-opus-5-5 @xhigh' } }, 'arena runners -= claude-opus-5-5', defaults)).toThrow('arena runners: default');
  });

  it('refuses to remove a model that is not in the list, and matches models case-insensitively', () => {
    expect(() => applySheetLines({ roles: { 'arena runners': 'claude-opus-5-5' } }, 'arena runners -= gpt-6-sol[1m]', defaults)).toThrow(PstackConfigError);
    expect(applySheetLines({ roles: { 'arena runners': 'claude-opus-5-5, GPT-6-SOL[1m] @high' } }, 'arena runners -= gpt-6-sol[1m]', defaults).roles).toEqual({ 'arena runners': 'claude-opus-5-5' });
  });

  // Review of #591 (M1): `-= <model> @<level>` removes that one entry; a bare model still removes all of its entries.
  it('removes one entry when the line names its level, and refuses a duplicate entry', () => {
    const both = { roles: { 'arena runners': 'claude-opus-5-5 @xhigh, claude-opus-5-5 @low' } };
    expect(applySheetLines(both, 'arena runners -= claude-opus-5-5 @low', defaults).roles).toEqual({ 'arena runners': 'claude-opus-5-5 @xhigh' });
    expect(() => applySheetLines(both, 'arena runners -= claude-opus-5-5 @high', defaults)).toThrow('is not in arena runners');
    expect(() => applySheetLines(both, 'arena runners -= claude-opus-5-5', defaults)).toThrow('at least one entry');
    expect(() => applySheetLines(both, 'arena runners += Claude-Opus-5-5 @xhigh', defaults)).toThrow('already in arena runners');
  });

  // Re-review of #584: `+=` on a one-model role made a list the skill reads as one model.
  it('edits panel roles only', () => {
    expect(() => applySheetLines({}, 'bug-fix += gpt-6-sol[1m]', defaults)).toThrow('bug-fix is not a panel');
    expect(() => applySheetLines({ roles: { 'bug-fix': 'claude-opus-5-5' } }, 'bug-fix -= claude-opus-5-5', defaults)).toThrow('bug-fix is not a panel');
  });

  it('adds exactly one entry per "+=" line', () => {
    expect(() => applySheetLines({}, 'arena runners += claude-opus-5-5, gpt-6-sol[1m]', defaults)).toThrow('one entry');
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

  // Re-review of #584: a correlated EXISTS scanned every subagent in the store on each 2 s tick.
  it('finds panels through indexes only', () => {
    const statements: string[] = [];
    const all = store.all.bind(store);
    jest.spyOn(store, 'all').mockImplementation((sql, ...params) => { statements.push(sql); return all(sql, ...params); });
    subagentLines(store, conversationId);
    const plans = statements.flatMap(sql => all(`EXPLAIN QUERY PLAN ${sql}`, 'x').map(row => String(row.detail)));
    expect(plans.filter(detail => /^SCAN/.test(detail))).toEqual([]);
  });

  it('counts every subagent of a large panel and keeps a multi-line title on one line', () => {
    store.run("UPDATE tasks SET snapshot_json=json_set(snapshot_json,'$.title',?) WHERE id=?", 'inter\nrogate', root.taskId);
    const attempt = store.attempt(store.task(root.taskId)!.activeAttemptId!)!;
    // Finished one by one, as a long-running root accumulates them; the queue cap bounds only unfinished ones.
    for (let i = 0; i < 36; i++) {
      const extra = tasks.spawnSubagent(attempt.attemptId, attempt.generation, `extra${i}`, { title: 'Review', instructions: 'r', model: 'claude-opus-5-5' });
      const run = tasks.claim(extra.taskId)!; tasks.started(run.attemptId, run.generation);
      tasks.finish(run.attemptId, run.generation, { type: 'completed', result: { summary: 'ok', artifactIds: [] } });
    }
    const [line] = subagentLines(store, conversationId);
    expect(line.startsWith('inter rogate: 38/40 · ')).toBe(true);
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
    const context = createContext({ dashboardRows: () => [{ a: { id: 'a' }, s: { sessionId: 's', tasks } }], escHtml: dashboardEscape });
    runInContext(dashboardClient.slice(start, end) + ';function dashText(v){return escHtml(v==null?"—":String(v));}', context);
    return { order: (runInContext('dashboardTaskRows()', context) as Array<{ t: { taskId: string } }>).map(r => r.t.taskId), label: (t: unknown) => runInContext('subagentLabel', context)(t) as string };
  }

  // child-1 updated last but was created first: siblings keep creation order (review of #584).
  it('lists subagents under their parent, oldest first, and roots by recency', () => {
    const { order } = rowsFor([
      { taskId: 'root-old', createdAt: 1, updatedAt: 1 },
      { taskId: 'child-2', parentTaskId: 'root-new', depth: 1, createdAt: 7, updatedAt: 7 },
      { taskId: 'root-new', createdAt: 4, updatedAt: 5 },
      { taskId: 'grandchild', parentTaskId: 'child-1', depth: 2, createdAt: 6, updatedAt: 8 },
      { taskId: 'child-1', parentTaskId: 'root-new', depth: 1, createdAt: 5, updatedAt: 9 },
      { taskId: 'orphan', parentTaskId: 'gone', depth: 1, createdAt: 3, updatedAt: 3 },
    ]);
    expect(order).toEqual(['root-new', 'child-1', 'grandchild', 'child-2', 'orphan', 'root-old']);
  });

  it('labels a subagent with its depth, model, harness and effort', () => {
    const { label } = rowsFor([]);
    expect(label({ parentTaskId: 'p', depth: 2, model: 'gpt-6-sol[1m]', harness: 'codex', effort: 'high' })).toContain('↳ ↳ gpt-6-sol[1m] · Codex · high');
    expect(label({ taskId: 'root' })).toBe('');
  });

  // Review of #591 (L15): the stand-in escaper escaped nothing, so dropping the escape would have passed.
  it('escapes a stored model name in the label', () => {
    const html = rowsFor([]).label({ parentTaskId: 'p', depth: 1, model: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

// Review of #584: the panel is the root's direct subagents only.
test('a reviewer\'s own helpers are not counted as panel members', () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const tasks = new TaskService(store, { tasks: { workspaceMode: 'host', maxConcurrentPerAgent: 10, maxConcurrentPerConversation: 10 } }, '/tmp');
  const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'telegram', accountId: 'u', principalId: 'u', chatId: 'c', threadKey: '' }, text: 'x' });
  const context = { ...input, ...new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]), principalId: 'u', execute: true, writeMemory: false, actionId: 'root' };
  const root = tasks.spawn(context, { title: 'interrogate', instructions: 'x', targetProfile: 'default-worker' });
  const a = tasks.claim(root.taskId)!; tasks.started(a.attemptId, a.generation);
  const reviewer = tasks.spawnSubagent(a.attemptId, a.generation, 'r1', { title: 'Review', instructions: 'r', model: 'claude-opus-5-5' });
  const b = tasks.claim(reviewer.taskId)!; tasks.started(b.attemptId, b.generation);
  tasks.spawnSubagent(b.attemptId, b.generation, 'h1', { title: 'Helper', instructions: 'h', model: 'claude-haiku-5-5' });
  expect(subagentLines(store, input.conversationId)).toEqual(['interrogate: 0/1 · ⏳ claude-opus-5-5']);
  store.close();
});
