import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { providerRefusalNotice } from '../../../src/orchestration/response-errors';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { TaskWorkspaces } from '../../../src/orchestration/tasks/workspace';
import { ClaudeWorkerDriver } from '../../../src/orchestration/tasks/driver';
import { SessionProcess } from '../../../src/session/process';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// Claude Code 2.1.296 stream-json shapes (--include-partial-messages); values are synthetic.
const EXPLANATION = 'Ein beliebiger Text des Anbieters: diese Anfrage wurde blockiert.';
const start = (id: string) => ({ type: 'stream_event', event: { type: 'message_start', message: { id, model: 'fixture', content: [], stop_reason: null, stop_details: null } } });
const stop = (stop_reason: string, stop_details: unknown = null) => ({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason, stop_sequence: null, stop_details } } });
const details = { type: 'refusal', category: 'cyber', explanation: EXPLANATION };
const text = (value: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } } });
/** A refused message, a fallback answer, and a successful terminal result. */
const refusedThenAnswered = (answer: string, refusalDetails: unknown = details) => [
  start('msg_refused'), stop('refusal', refusalDetails), { type: 'stream_event', event: { type: 'message_stop' } },
  start('msg_fallback'), text(answer), stop('end_turn'),
  { type: 'assistant', message: { id: 'msg_fallback', content: [{ type: 'text', text: answer }] } },
  { type: 'result', subtype: 'success', is_error: false, result: answer, stop_reason: 'end_turn', safety_stops: 1 },
];
/** A refusal the CLI surfaces as an API error instead of a fallback answer. */
const refusedAsApiError = [
  start('msg_refused'), stop('refusal', details),
  { type: 'assistant', isApiErrorMessage: true, error: 'invalid_request', refusedMessageId: 'msg_refused',
    message: { id: randomUUID(), model: '<synthetic>', stop_reason: 'refusal', stop_details: details, content: [{ type: 'text', text: 'API Error: request blocked' }] } },
  { type: 'result', subtype: 'success', is_error: true, result: 'API Error: request blocked' },
];
const refusal = { messageId: 'msg_refused', category: 'cyber', explanation: EXPLANATION };

function fakeProcess(script: () => Record<string, unknown>[]) {
  return Object.assign(new EventEmitter(), { start: async () => {}, interrupt: () => {}, stop: async () => {},
    sendMessage(this: EventEmitter) { for (const event of script()) this.emit('output', JSON.stringify(event)); } });
}

describe('startProcessTurn refusal evidence (#586)', () => {
  it('a refusal followed by a fallback answer keeps both facts', async () => {
    const turn = startProcessTurn(fakeProcess(() => refusedThenAnswered('Fallback answer')) as any, 'request', 1000);
    await expect(turn.result).resolves.toEqual({ text: 'Fallback answer', interrupted: false, providerRefusals: [refusal] });
  });

  it('a refusal surfaced as an API error stays on the failure, deduplicated to one native refusal', async () => {
    const turn = startProcessTurn(fakeProcess(() => refusedAsApiError) as any, 'request', 1000);
    const error = await turn.result.catch(failure => failure);
    expect(error).toMatchObject({ code: 'INFERENCE_FAILED', providerRefusals: [refusal] });
  });

  it('a later turn on the same process does not inherit an earlier refusal', async () => {
    let call = 0;
    const process = fakeProcess(() => call++ === 0 ? refusedThenAnswered('First') : [{ type: 'result', is_error: false, result: 'Second' }]);
    await expect(startProcessTurn(process as any, 'one', 1000).result).resolves.toMatchObject({ providerRefusals: [refusal] });
    await expect(startProcessTurn(process as any, 'two', 1000, undefined, undefined, [], undefined, undefined, true).result)
      .resolves.toEqual({ text: 'Second', interrupted: false });
  });

  it('a normal answer that talks about refusals carries no refusal', async () => {
    const answer = 'The provider refused the earlier request for safety reasons.';
    const turn = startProcessTurn(fakeProcess(() => [start('m'), text(answer), stop('end_turn'), { type: 'result', is_error: false, result: answer }]) as any, 'request', 1000);
    await expect(turn.result).resolves.not.toHaveProperty('providerRefusals');
  });
});

describe('providerRefusalNotice (#586)', () => {
  it('attributes the provider text and does not claim the refused step ran', () => {
    const notice = providerRefusalNotice([refusal]);
    expect(notice).toContain('Category: cyber');
    expect(notice).toContain(`Provider explanation: "${EXPLANATION}"`);
    expect(notice).toContain('does not by itself confirm that the refused step was carried out');
  });

  it('states tool calls without an execution result separately from those that returned one', () => {
    const notice = providerRefusalNotice([{ ...refusal, toolCalls: [{ id: 't1', result: false }, { id: 't2', result: false }, { id: 't3', result: true }] }]);
    expect(notice).toContain('Tool calls in the refused message with no recorded execution result: 2.');
    expect(notice).toContain('Tool calls in the refused message that returned a result: 1.');
  });

  it('says no explanation was supplied instead of reconstructing one', () => {
    const notice = providerRefusalNotice([{ messageId: 'm' }]);
    expect(notice).toContain('The provider did not supply a specific explanation.');
    expect(notice).not.toContain('Category');
    expect(notice).not.toContain('Provider explanation');
  });
});

describe('orchestration runtime refusal reporting (#586)', () => {
  let root: string, sessions: SessionStore, history: HistoryDB, runtime: AgentOrchestrationRuntime | undefined;
  let script: () => Record<string, unknown>[];
  const scope = (session: string) => ({ agentId: 'a', agentSessionId: session, source: 'api' as const, accountId: 'owner', chatId: session, threadKey: '', principalId: 'owner' });
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'provider-refusal-runtime-'));
    const workspace = join(root, 'a', 'workspace'); mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Fixture identity');
    const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
    sessions = new SessionStore(root); history = HistoryDB.forAgent(root, 'a');
    runtime = await AgentOrchestrationRuntime.open(agent, { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig, join(root, 'a'), sessions, history, {
      releaseAgentSession: async () => {},
      createAgentSession: async (_session, profile) => Object.assign(fakeProcess(() => script()), { runtimeProfile: profile }) as unknown as SessionProcess,
    });
  });
  afterEach(async () => {
    await runtime?.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  });
  const send = async (session: string, message: string) => {
    await sessions.ensureApiSession('a', session, session);
    return runtime!.send({ scope: scope(session), text: message }, { execute: false, writeMemory: false }, { timeoutMs: 2000 });
  };
  const events = () => runtime!.store.all("SELECT payload_json FROM conversation_events WHERE type='response.provider_refusal'").map(row => JSON.parse(String(row.payload_json)).payload);
  const notices = () => runtime!.store.all("SELECT r.generated_text FROM assistant_responses r JOIN conversation_decisions d ON d.id=r.decision_id WHERE d.kind='notice'").map(row => String(row.generated_text));

  it('delivers the answer, records durable evidence, and adds an attributed diagnostic', async () => {
    script = () => refusedThenAnswered('Here is what I could do.');
    await expect(send(randomUUID(), 'Do the thing')).resolves.toBe('Here is what I could do.');
    expect(events()).toEqual([expect.objectContaining({ refusals: [refusal] })]);
    expect(notices()).toEqual([providerRefusalNotice([refusal])]);
  });

  it('reports a refusal with no provider details without inventing a cause', async () => {
    script = () => refusedThenAnswered('Answer.', null);
    await send(randomUUID(), 'Do the thing');
    expect(events()).toEqual([expect.objectContaining({ refusals: [{ messageId: 'msg_refused' }] })]);
    expect(notices()).toEqual([expect.stringContaining('The provider did not supply a specific explanation.')]);
  });

  it('keeps refusal evidence when the refusal fails the turn', async () => {
    script = () => refusedAsApiError;
    await expect(send(randomUUID(), 'Do the thing')).rejects.toMatchObject({ code: 'INFERENCE_FAILED' });
    expect(events()).toEqual([expect.objectContaining({ refusals: [refusal] })]);
    expect(notices()).toEqual([providerRefusalNotice([refusal])]);
  });

  it('does not attach one session\'s refusal to another session or a later turn', async () => {
    script = () => refusedThenAnswered('First.');
    const first = randomUUID();
    await send(first, 'One');
    script = () => [{ type: 'result', is_error: false, result: 'Clean.' }];
    await send(first, 'Two');
    await send(randomUUID(), 'Three');
    expect(events()).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  it('records nothing for an ordinary answer', async () => {
    script = () => [start('m'), text('All good.'), stop('end_turn'), { type: 'result', is_error: false, result: 'All good.' }];
    await send(randomUUID(), 'Hello');
    expect(events()).toEqual([]);
    expect(notices()).toEqual([]);
  });
});

describe('worker refusal evidence (#586)', () => {
  it.each([
    ['completed', () => refusedThenAnswered('Worker report: partial.'), 'completed', 'result'],
    ['failed', () => refusedAsApiError, 'failed', 'failure'],
  ] as const)('a %s worker turn keeps its refusal on the task and records a task event', async (_label, script, state, field) => {
    const root = mkdtempSync(join(tmpdir(), 'worker-refusal-')), workspace = join(root, 'workspace');
    mkdirSync(workspace); writeFileSync(join(workspace, 'CLAUDE.md'), 'Fixture');
    const store = new OrchestrationStore(':memory:', 'a'), tasks = new TaskService(store), bridge = new TaskBridge(tasks);
    const agent = { id: 'a', workspace, description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
    const gateway = { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig;
    jest.spyOn(SessionProcess.prototype, 'start').mockImplementation(async () => {});
    jest.spyOn(SessionProcess.prototype, 'sendMessage').mockImplementation(function (this: SessionProcess) { for (const event of script()) this.emit('output', JSON.stringify(event)); });
    jest.spyOn(SessionProcess.prototype, 'stop').mockImplementation(async function (this: SessionProcess) { this.managedGroupStopped = true; });
    try {
      await bridge.start();
      const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'api', accountId: 'u', principalId: 'u', chatId: 's', threadKey: '' }, text: 'Work' });
      const decision = new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]);
      const task = tasks.spawn({ ...input, ...decision, principalId: 'u', actionId: 'spawn', execute: true, writeMemory: false }, { title: 'Work', instructions: 'Work', targetProfile: 'media-worker' });
      const attempt = tasks.claim(task.taskId)!;
      const driver = new ClaudeWorkerDriver(agent, gateway, tasks, bridge, new TaskWorkspaces(store, workspace, join(root, 'resources')), join(root, 'private'));
      const outcome = await (await driver.start(store.task(task.taskId)!, attempt, true)).result;
      tasks.finish(attempt.attemptId, attempt.generation, outcome);
      // task_status(task_id) returns this snapshot to the agent that reports the result.
      expect(tasks.status(input.conversationId, 'u', task.taskId)[0]).toMatchObject({ state, [field]: { providerRefusals: [refusal] } });
      expect(store.all("SELECT payload_json FROM conversation_events WHERE type='task.provider_refusal'").map(row => JSON.parse(String(row.payload_json)).payload))
        .toEqual([expect.objectContaining({ refusals: [refusal] })]);
    } finally { jest.restoreAllMocks(); await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

test('a stopped worker attempt keeps refusal evidence without replacing its stop reason (#586)', () => {
  const store = new OrchestrationStore(':memory:', 'a'), tasks = new TaskService(store);
  try {
    const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'api', accountId: 'u', principalId: 'u', chatId: 's', threadKey: '' }, text: 'Work' });
    const decision = new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]);
    const task = tasks.spawn({ ...input, ...decision, principalId: 'u', actionId: 'spawn', execute: true, writeMemory: false }, { title: 'Work', instructions: 'Work', targetProfile: 'default-worker' });
    const attempt = tasks.claim(task.taskId)!;
    tasks.started(attempt.attemptId, attempt.generation, { pid: 1, startedAt: Date.now(), instanceId: 'test' });
    expect(tasks.finish(attempt.attemptId, attempt.generation, { type: 'stopped', providerRefusals: [refusal] })).toMatchObject({ failure: { code: 'WORKER_STOPPED' } });
    expect(store.all("SELECT payload_json FROM conversation_events WHERE type='task.provider_refusal'").map(row => JSON.parse(String(row.payload_json)).payload))
      .toEqual([expect.objectContaining({ refusals: [refusal] })]);
  } finally { store.close(); }
});
