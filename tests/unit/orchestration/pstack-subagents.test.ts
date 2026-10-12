import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge, SUBAGENT_READONLY } from '../../../src/orchestration/bridge';
import type { CommandContext, TaskAttempt, TaskSnapshot } from '../../../src/orchestration/types';
import type { ModelConfig } from '../../../src/types';
import { pstackClaudeConfig } from '../../helpers/pstack-fixture';

/**
 * pstack subagents as gateway tasks (#583). A worker of a set-up agent gets
 * subagent_spawn/subagent_wait/subagent_cancel in place of Claude Code's
 * native Agent; each subagent is a child task linked to its parent, ends with
 * it, and reports to it rather than to the channel.
 */

const MODELS: ModelConfig[] = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', alias: 'sonnet', contextWindow: 200000 },
  { id: 'gpt-6-astra[1m]', label: 'GPT 6 Astra', alias: 'gpt6astra', contextWindow: 1050000 },
];

let root: string, store: OrchestrationStore, tasks: TaskService, bridge: TaskBridge, context: CommandContext;
let fixture: ReturnType<typeof pstackClaudeConfig>, previous: string | undefined, n = 0;
beforeEach(async () => {
  fixture = pstackClaudeConfig();
  previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = fixture.configDir;
  root = mkdtempSync(join(tmpdir(), 'pstack-subagents-'));
  store = new OrchestrationStore(':memory:', 'a');
  tasks = new TaskService(store, { tasks: { workspaceMode: 'host', maxConcurrentPerAgent: 10, maxConcurrentPerConversation: 10 } }, root);
  bridge = new TaskBridge(tasks); bridge.models = async () => MODELS; await bridge.start();
  const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'api', accountId: 'u', principalId: 'u', chatId: 'c', threadKey: '' }, text: 'Review the change' });
  context = { ...input, ...new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]), principalId: 'u', execute: true, writeMemory: false, actionId: '' };
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); fixture.cleanup();
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
  jest.restoreAllMocks();
});

/** A running worker attempt for a task. */
function running(task: TaskSnapshot): TaskAttempt {
  const attempt = tasks.claim(task.taskId)!;
  tasks.started(attempt.attemptId, attempt.generation);
  return attempt;
}
function rootWorker(): { task: TaskSnapshot; attempt: TaskAttempt } {
  const task = tasks.spawn({ ...context, model: 'claude-sonnet-5-5', actionId: `root-${++n}` }, { title: 'Root', instructions: 'Use pstack', targetProfile: 'default-worker', effort: 'high' });
  return { task, attempt: running(task) };
}
async function call(attempt: TaskAttempt, tool: string, args: Record<string, unknown>, subagents = true): Promise<any> {
  const dir = join(root, `ticket-${++n}`);
  bridge.issue({ role: 'worker', attemptId: attempt.attemptId, generation: attempt.generation, subagents }, dir, root);
  const auth = JSON.parse(readFileSync(join(dir, 'ticket.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const req = request(auth.url, { method: 'POST' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); });
    req.setHeader('Authorization', 'Bearer ' + auth.token); req.on('error', reject);
    req.end(JSON.stringify({ tool, args, action_id: `act-${n}` }));
  });
}
const spawn = (attempt: TaskAttempt, args: Record<string, unknown>) => call(attempt, 'subagent_spawn', { description: 'Review', prompt: 'Review the diff', run_in_background: true, ...args });
const complete = (attempt: TaskAttempt, summary: string) => tasks.finish(attempt.attemptId, attempt.generation, { type: 'completed', result: { summary, artifactIds: [] } });

test('a subagent becomes a linked child task with the agent definition, model and effort it names', async () => {
  const { task: parent, attempt } = rootWorker();
  const reply = await spawn(attempt, { subagent_type: 'pstack:effort-xhigh', model: 'gpt-6-astra[1m]', isolation: 'worktree' });
  expect(reply).toMatchObject({ model: 'gpt-6-astra[1m]', effort: 'xhigh', state: 'queued', isolation: 'ignored' });
  const child = store.task(reply.task_id)!;
  expect(child).toMatchObject({ parentTaskId: parent.taskId, rootTaskId: parent.taskId, depth: 1, subagentType: 'pstack:effort-xhigh',
    conversationId: parent.conversationId, ownerPrincipalId: 'u', targetProfile: 'default-worker', capabilities: parent.capabilities });
  const instructions = tasks.revision(child.taskId, 1).instructions;
  expect(instructions).toContain('Do the task in your prompt.');
  expect(instructions).toContain(`pstack plugin root: ${fixture.installPath}`);
  expect(instructions.endsWith('Review the diff')).toBe(true);
});

test('no model (or inherit-parent/auto) runs on the parent model and, without an effort agent, the parent effort', async () => {
  const { attempt } = rootWorker();
  for (const model of [undefined, 'inherit-parent', 'auto']) {
    const reply = await spawn(attempt, model ? { model } : {});
    expect(store.task(reply.task_id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
  }
});

test.each([['sonnet', 'MODEL_ALIAS_NOT_ALLOWED'], ['gpt-7', 'UNKNOWN_MODEL']])('model %s is refused with %s and spawns nothing', async (model, code) => {
  const { attempt } = rootWorker();
  const reply = await spawn(attempt, { model });
  expect(reply.error).toBe(code);
  expect(reply.details[0].correction).toContain('claude-sonnet-5-5');
  expect(store.all("SELECT id FROM tasks WHERE json_extract(snapshot_json,'$.parentTaskId') IS NOT NULL")).toHaveLength(0);
});

test('an unknown pstack agent is refused', async () => {
  const { attempt } = rootWorker();
  expect((await spawn(attempt, { subagent_type: 'pstack:nope' })).error).toBe('INVALID_INPUT');
});

test('readonly is recorded and stated in the instructions', async () => {
  const { attempt } = rootWorker();
  const reply = await spawn(attempt, { readonly: true });
  expect(store.task(reply.task_id)!.readonly).toBe(true);
  expect(tasks.revision(reply.task_id, 1).instructions).toContain(SUBAGENT_READONLY);
});

test('subagents nest three deep; the fourth level is refused', async () => {
  let { attempt } = rootWorker();
  for (const depth of [1, 2, 3]) {
    const reply = await spawn(attempt, {});
    expect(store.task(reply.task_id)!.depth).toBe(depth);
    attempt = running(store.task(reply.task_id)!);
  }
  const refused = await spawn(attempt, {});
  expect(refused.error).toBe('SUBAGENT_DEPTH_EXCEEDED');
});

test('only a worker given subagents may call the tools', async () => {
  const { attempt } = rootWorker();
  expect((await call(attempt, 'subagent_spawn', { description: 'x', prompt: 'y' }, false)).error).toBe('TOOL_DENIED');
});

test('subagent_wait returns every result once all finish, including a question as that subagent\'s result', async () => {
  const { attempt } = rootWorker();
  const a = (await spawn(attempt, {})).task_id, b = (await spawn(attempt, {})).task_id;
  const waiting = call(attempt, 'subagent_wait', { task_ids: [a, b] });
  await new Promise(r => setTimeout(r, 300));
  complete(running(store.task(a)!), 'Found two issues');
  const childB = running(store.task(b)!);
  tasks.requestInput(childB.attemptId, childB.generation, 'Which base branch?');
  const { results } = await waiting;
  expect(results).toEqual([
    expect.objectContaining({ task_id: a, state: 'completed', result: 'Found two issues' }),
    expect.objectContaining({ task_id: b, state: 'waiting_input', question: 'Which base branch?' }),
  ]);
});

test('a foreground subagent_spawn waits and returns the result, like Agent', async () => {
  const { attempt } = rootWorker();
  const pending = call(attempt, 'subagent_spawn', { description: 'Review', prompt: 'p' });
  let child: TaskSnapshot | undefined;
  for (let i = 0; i < 50 && !child; i++) { await new Promise(r => setTimeout(r, 50)); child = store.all("SELECT snapshot_json FROM tasks WHERE json_extract(snapshot_json,'$.parentTaskId') IS NOT NULL").map(r => JSON.parse(String(r.snapshot_json)))[0]; }
  complete(running(child!), 'LGTM');
  expect(await pending).toMatchObject({ task_id: child!.taskId, state: 'completed', result: 'LGTM' });
});

test('subagents never notify the channel; a parent that ends cancels its whole subtree', async () => {
  const { task: parent, attempt } = rootWorker();
  const child = store.task((await spawn(attempt, {})).task_id)!;
  const childAttempt = running(child);
  const grandchild = store.task((await spawn(childAttempt, {})).task_id)!;
  complete(attempt, 'Root done');
  expect(store.task(child.taskId)!.state).toBe('cancel_requested');
  expect(store.task(grandchild.taskId)!.state).toBe('cancelled');
  expect(store.all('SELECT task_id FROM notifications').map(r => r.task_id)).toEqual([parent.taskId]);
});

test('subagent_cancel cancels only the caller\'s own subagents', async () => {
  const { attempt } = rootWorker();
  const mine = (await spawn(attempt, {})).task_id;
  const other = rootWorker();
  expect((await call(other.attempt, 'subagent_cancel', { task_ids: [mine] })).error).toBe('ACCESS_DENIED');
  expect((await call(attempt, 'subagent_cancel', { task_ids: [mine] })).results).toEqual([{ task_id: mine, state: 'cancelled' }]);
});

test('the agent\'s task index lists roots only; the root\'s status lists its subagents', async () => {
  const { task: parent, attempt } = rootWorker();
  const child = (await spawn(attempt, { model: 'gpt-6-astra[1m]' })).task_id;
  expect(tasks.context(context.conversationId, 'u', context.decisionId).map(t => t.taskId)).toEqual([parent.taskId]);
  expect((tasks.status(context.conversationId, 'u', parent.taskId)[0] as any).subagents).toEqual([
    expect.objectContaining({ taskId: child, parentTaskId: parent.taskId, model: 'gpt-6-astra[1m]', state: 'queued' }),
  ]);
});

test('the worker MCP server is told to expose the tools', () => {
  const { attempt } = rootWorker();
  for (const subagents of [true, false]) {
    const dir = join(root, `mcp-${subagents}`);
    bridge.issue({ role: 'worker', attemptId: attempt.attemptId, generation: attempt.generation, subagents }, dir, root);
    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).mcpServers.gateway.env.GATEWAY_SUBAGENTS).toBe(subagents ? 'true' : '');
  }
});

// Review of #583 findings.
describe('review fixes', () => {
  test('waiting parents do not starve their subagents: children are claimable past the concurrency limits', async () => {
    tasks = new TaskService(store, { tasks: { workspaceMode: 'host', maxConcurrentPerAgent: 1, maxConcurrentPerConversation: 1 } }, root);
    await bridge.close(); bridge = new TaskBridge(tasks); bridge.models = async () => MODELS; await bridge.start();
    const { attempt } = rootWorker();
    const child = store.task((await spawn(attempt, {})).task_id)!;
    expect(tasks.claim(child.taskId)).toBeDefined();
    // A second root is still held to the limit.
    const other = tasks.spawn({ ...context, actionId: 'other-root' }, { title: 'Other', instructions: 'x', targetProfile: 'default-worker' });
    expect(tasks.claim(other.taskId)).toBeUndefined();
  });

  test('a read-only subagent\'s own subagents are read-only too', async () => {
    const { attempt } = rootWorker();
    const reader = store.task((await spawn(attempt, { readonly: true })).task_id)!;
    const grandchild = await spawn(running(reader), {});
    expect(store.task(grandchild.task_id)!.readonly).toBe(true);
    expect(tasks.revision(grandchild.task_id, 1).instructions).not.toContain(SUBAGENT_READONLY);
  });

  test('a subagent\'s question never becomes a user question', async () => {
    const { TaskQuestions } = require('../../../src/orchestration/task-questions');
    const { attempt } = rootWorker();
    const child = running(store.task((await spawn(attempt, {})).task_id)!);
    tasks.requestInput(child.attemptId, child.generation, 'Which base branch?');
    new TaskQuestions(store).tick?.();
    expect(store.all('SELECT question_id FROM task_questions')).toHaveLength(0);
  });

  test('a parent that is stopping cancels its subtree at once and cannot spawn more', async () => {
    const { task: parent, attempt } = rootWorker();
    const child = store.task((await spawn(attempt, {})).task_id)!;
    tasks.cancelByUser(parent.conversationId, 'u', parent.taskId);
    expect(store.task(parent.taskId)!.state).toBe('cancel_requested');
    expect(store.task(child.taskId)!.state).toBe('cancelled');
    expect((await spawn(attempt, {})).error).toBe('STATE_CONFLICT');
  });

  test('a subagent stuck in needs_reconciliation is reported, not waited on', async () => {
    const { attempt } = rootWorker();
    const child = running(store.task((await spawn(attempt, {})).task_id)!);
    tasks.finish(child.attemptId, child.generation, { type: 'unknown' } as any);
    expect(store.task(child.taskId)!.state).toBe('needs_reconciliation');
    expect((await call(attempt, 'subagent_wait', { task_ids: [child.taskId] })).results[0]).toMatchObject({ state: 'needs_reconciliation' });
  });
});
