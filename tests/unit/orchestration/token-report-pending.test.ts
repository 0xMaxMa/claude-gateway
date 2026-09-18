import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { recordTokenTurn, tokenReport, summarizeTokenTurns } from '../../../src/orchestration/token-ledger';
import { recoverOrchestration } from '../../../src/orchestration/recovery';
import { DashboardReader } from '../../../src/orchestration/dashboard-reader';
import { generateTokenReportHtml, TokenReportView } from '../../../src/ui/token-report';

const usage = (n: number) => ({inputTokens:n,cacheCreationTokens:0,cacheReadTokens:0,outputTokens:0,totalTokens:n});
const agentTurn = (id: string, tokens: number, startedAt = Date.now()) =>
  ({id,sessionId:'session',role:'agent' as const,category:'input' as const,startedAt,toolIds:[],inputTokens:tokens,totalTokens:tokens,usage:usage(tokens)});

/** The report rows as the page actually consumes them. Declared structurally rather than
 *  imported so this suite compiles against the pre-fix ledger as well — its failures are
 *  then missing behaviour, not TypeScript errors about fields that do not exist yet. */
type Row = { id: string; role?: string; category?: string; state?: string; usage?: unknown;
  inputTexts?: string[]; inputSequences?: number[]; pending?: boolean; queuedMs?: number; attemptGeneration?: number };
const rowsOf = (view: { turns: unknown[] }): Row[] => view.turns as Row[];
const render = (view: Record<string, unknown>): string => generateTokenReportHtml('a', view as unknown as TokenReportView);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pending-turn-')), file = join(root, 'db');
  const store = new OrchestrationStore(file, 'a');
  const scope = {agentId:'a',agentSessionId:'session',source:'api' as const,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
  return { root, file, store, scope, decisions: new DecisionService(store),
    close: () => { store.close(); rmSync(root, {recursive:true,force:true}); } };
}

/** The label rendered in a row's first cell — the thing that must not shift. */
function labelOf(html: string, turnId: string): string {
  const match = new RegExp(`<tr class="turn-row[^"]*"[^>]*data-turn-id="${turnId}"[^>]*>\\s*<td><strong>([^<]*)</strong>`).exec(html);
  return match ? match[1] : 'NO ROW RENDERED';
}

test('a message queued behind a running turn is visible at once and resolves into its measured turn', () => {
  const f = fixture();
  try {
    // Turn one is running and has already recorded usage.
    const first = f.store.acceptInput({scope:f.scope,text:'first message'});
    const running = f.decisions.begin(first.conversationId, 'owner', [first.inputId]);
    recordTokenTurn(f.store, agentTurn(running.decisionId, 5));
    // Turn two arrives while turn one still holds the session. runtime.ts serialises
    // decisions per session, so this input simply waits; before this change the report
    // had no row for it at all and the message looked lost.
    const queued = f.store.acceptInput({scope:f.scope,text:'second message'});

    const waiting = rowsOf(tokenReport(f.store, 'session'));
    const pending = waiting.find(row => row.pending);
    expect(pending).toMatchObject({id:queued.inputId,category:'input',state:'queued',usage:null});
    expect(pending!.inputTexts).toEqual(['second message']);
    expect(pending!.inputSequences).toEqual([2]);
    expect(pending!.queuedMs).toBeGreaterThanOrEqual(0);
    // The measured ledger is untouched: exactly one real row exists.
    expect(waiting.filter(row => !row.pending).map(row => row.id)).toEqual([running.decisionId]);

    // Its decision begins; still no usage reported, so the row stays — as 'starting'.
    f.decisions.finish(running, 'done');
    const second = f.decisions.begin(queued.conversationId, 'owner', [queued.inputId]);
    expect(rowsOf(tokenReport(f.store, 'session')).find(row => row.pending))
      .toMatchObject({id:queued.inputId,state:'starting'});

    // First usage event: the pending row is replaced by the real measured turn.
    recordTokenTurn(f.store, agentTurn(second.decisionId, 9));
    const resolved = rowsOf(tokenReport(f.store, 'session'));
    expect(resolved.some(row => row.pending)).toBe(false);
    const real = resolved.find(row => row.id === second.decisionId)!;
    expect((real.usage as {totalTokens:number}).totalTokens).toBe(9);
    expect(real.inputTexts).toEqual(['second message']);
    expect(real.inputSequences).toEqual([2]);
    // The wait is measured, so a turn queued behind another is not mistaken for a slow one.
    expect(typeof real.queuedMs).toBe('number');
    expect(real.queuedMs!).toBeGreaterThanOrEqual(0);
  } finally { f.close(); }
});

test('a pending row is never counted as usage in any aggregate', () => {
  const f = fixture();
  try {
    const first = f.store.acceptInput({scope:f.scope,text:'measured'});
    const decision = f.decisions.begin(first.conversationId, 'owner', [first.inputId]);
    recordTokenTurn(f.store, agentTurn(decision.decisionId, 40));
    f.decisions.finish(decision, 'done');
    f.store.acceptInput({scope:f.scope,text:'queued and unmeasured'});

    const view = tokenReport(f.store, 'session');
    expect(rowsOf(view).filter(row => row.pending)).toHaveLength(1);
    expect(view.totals).toEqual({agentTokens:40,workerTokens:null,totalTokens:40});
    expect(view.distribution).toEqual([{category:'input',tokens:40}]);
    expect(view.usageByRole).toEqual([{role:'agent',inputTokens:40,cacheCreationTokens:0,cacheReadTokens:0,outputTokens:0}]);
    // Anything derived from the turn list must skip it too.
    expect(summarizeTokenTurns(view.turns).totalTokens).toBe(40);
    // Recorded-turn pagination counts recorded turns only; the queued row is reported apart.
    const html = render({...view, pagination:{offset:0,limit:25,total:1}});
    expect(html).toContain('of 1 recorded turns · 1 queued (not yet recorded)');
    expect(html).toContain('Total tokens<strong>40');
    expect(html).toContain('Agent tokens<strong>40');
  } finally { f.close(); }
});

test('the queued row reaches the dashboard reader thread as well', async () => {
  const f = fixture();
  const reader = new DashboardReader(join(process.cwd(), 'dist/orchestration/dashboard-reader-worker.js'));
  try {
    const first = f.store.acceptInput({scope:f.scope,text:'running work'});
    const decision = f.decisions.begin(first.conversationId, 'owner', [first.inputId]);
    recordTokenTurn(f.store, agentTurn(decision.decisionId, 12));
    f.store.acceptInput({scope:f.scope,text:'waiting behind it'});
    const report = await reader.read('report', f.file, {sessionId:'session'});
    const pending = rowsOf(report).find(row => row.pending);
    expect(pending).toBeDefined();
    expect(pending!.inputTexts).toEqual(['waiting behind it']);
    expect(pending!.state).toBe('queued');
    // Totals still come from the ledger alone.
    expect(report.totals.totalTokens).toBe(12);
    expect(report.pagination.total).toBe(1);
  } finally { await reader.close(); f.close(); }
});

test('an interrupted, stopped or restarted turn never leaves a permanently waiting row', () => {
  const f = fixture();
  try {
    const pendingIds = () => rowsOf(tokenReport(f.store, 'session')).filter(row => row.pending)
      .map(row => `${row.id}:${row.state}`);

    // (a) The user stops the turn explicitly: the input is handled and will not run again,
    // so it must NOT keep claiming to be queued.
    const stopped = f.store.acceptInput({scope:f.scope,text:'explicitly stopped'});
    const stoppedDecision = f.decisions.begin(stopped.conversationId, 'owner', [stopped.inputId]);
    f.decisions.interrupt(stoppedDecision);
    f.decisions.releaseInterrupted(stoppedDecision, true);
    expect(pendingIds()).toEqual([]);

    // (b) The turn is interrupted without an explicit stop: the input is requeued, so a
    // queued row is the truthful state, not a silent disappearance.
    const requeued = f.store.acceptInput({scope:f.scope,text:'interrupted and requeued'});
    const requeuedDecision = f.decisions.begin(requeued.conversationId, 'owner', [requeued.inputId]);
    f.decisions.interrupt(requeuedDecision);
    f.decisions.releaseInterrupted(requeuedDecision, false);
    expect(pendingIds()).toEqual([`${requeued.inputId}:queued`]);

    // (c) The gateway restarts mid-turn. recoverOrchestration resets assigned→accepted, so
    // the row must fall back to 'queued' rather than staying stuck on 'starting'.
    const restarted = f.decisions.begin(requeued.conversationId, 'owner', [requeued.inputId]);
    expect(pendingIds()).toEqual([`${requeued.inputId}:starting`]);
    recoverOrchestration(f.store);
    expect(pendingIds()).toEqual([`${requeued.inputId}:queued`]);
    expect(restarted.decisionId).toBeTruthy();

    // (d) A failed turn is terminal: the input is handled and the row is gone.
    const failing = f.decisions.begin(requeued.conversationId, 'owner', [requeued.inputId]);
    f.decisions.finish(failing, 'broke', 'failed');
    expect(pendingIds()).toEqual([]);
  } finally { f.close(); }
});

test('a worker row carries its stored attempt number instead of a render-order guess', () => {
  const f = fixture();
  try {
    const input = f.store.acceptInput({scope:f.scope,text:'do the work'});
    const decision = f.decisions.begin(input.conversationId, 'owner', [input.inputId]);
    const tasks = new TaskService(f.store);
    const task = tasks.spawn({...input,...decision,principalId:'owner',actionId:'one',execute:true,writeMemory:false},
      {title:'Task',instructions:'assignment',targetProfile:'default-worker'});
    const attempt = tasks.claim(task.taskId)!;
    recordTokenTurn(f.store, {id:attempt.attemptId,taskId:task.taskId,sessionId:'session',role:'worker',
      category:'worker',startedAt:Date.now(),toolIds:[],inputTokens:3,totalTokens:3,usage:usage(3)});
    const row = rowsOf(tokenReport(f.store, 'session')).find(turn => turn.id === attempt.attemptId)!;
    expect(row.attemptGeneration).toBe(attempt.generation);
  } finally { f.close(); }
});

test('a row label does not shift when a late, older row lands', () => {
  // The old label was "Turn #(total - offset - index)". A row that sorts OLDER than the
  // rows already on the page raises `total` without changing their index, so every newer
  // row silently renumbered itself on the next 5s refresh.
  const worker = (id: string, generation: number, startedAt: number) => ({
    id, role:'worker', category:'worker', taskId:'task', attemptGeneration:generation,
    startedAt, usage:usage(10), loadedTools:null, usedTools:[],
  });
  const base = {sessionId:'session',coverage:'recorded-turns-only',
    totals:{agentTokens:null,workerTokens:10,totalTokens:10}};
  const before = render({...base, pagination:{offset:0,limit:25,total:1}, turns:[worker('w2',2,3000)]});
  const after = render({...base, pagination:{offset:0,limit:25,total:2}, turns:[worker('w2',2,3000), worker('w1',1,1000)]});
  expect(labelOf(before, 'w2')).toBe('Attempt #2');
  expect(labelOf(after, 'w2')).toBe(labelOf(before, 'w2'));
  expect(labelOf(after, 'w1')).toBe('Attempt #1');
  // An agent turn keeps using the stored input sequence, which was already stable.
  const withInput = render({...base, turns:[{id:'d',role:'agent',category:'input',startedAt:1,inputSequences:[417],usage:usage(1),loadedTools:null,usedTools:[]}]});
  expect(labelOf(withInput, 'd')).toBe('Input #417');
  // A row with neither stored value says so rather than inventing a sequence.
  const unnumbered = render({...base, turns:[{id:'x',role:'agent',category:'input',startedAt:1,usage:usage(1),loadedTools:null,usedTools:[]}]});
  expect(labelOf(unnumbered, 'x')).toBe('Unnumbered turn');
  expect(unnumbered).not.toContain('Turn #');
});

test('a queued row is visibly waiting and its untrusted text is escaped', () => {
  const html = render({
    sessionId:'session', coverage:'recorded-turns-only',
    totals:{agentTokens:null,workerTokens:null,totalTokens:null},
    turns:[{id:'input-1',role:'agent',category:'input',startedAt:Date.now()-141300,pending:true,queuedMs:141300,
      state:'queued',inputSequences:[483],inputTexts:['<script>alert(1)</script>delete the worktrees'],
      inputModalities:['text'],usage:null,loadedTools:null,usedTools:[]}],
  });
  expect(html).toContain('turn-row turn-pending');
  expect(html).toContain('Waiting 2m 21s');
  expect(html).toContain('Input #483');
  expect(html).toContain('is not counted in any total');
  expect(html).not.toContain('<script>alert(1)</script>');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;delete the worktrees');
  // No usage anywhere on the row, and the cards stay unmeasured.
  expect(html).toContain('Total tokens<strong>—');
  // A measured turn that waited shows the wait without claiming to be pending.
  const measured = render({
    sessionId:'session', coverage:'recorded-turns-only',
    totals:{agentTokens:30,workerTokens:null,totalTokens:30},
    turns:[{id:'d',role:'agent',category:'input',startedAt:Date.now(),queuedMs:141300,inputSequences:[483],
      usage:usage(30),loadedTools:null,usedTools:[]}],
  });
  expect(measured).toContain('Queued 2m 21s');
  expect(measured).not.toContain('turn-pending');
});
