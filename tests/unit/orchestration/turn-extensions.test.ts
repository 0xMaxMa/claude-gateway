import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TurnUsageCollector } from '../../../src/orchestration/token-usage';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { measuredTurns, recordTokenTurn, tokenReport } from '../../../src/orchestration/token-ledger';
import { executionTool } from '../../../src/orchestration/tool-name';
import { generateTokenReportHtml, TokenReportView } from '../../../src/ui/token-report';
import { dashboardPresentationClient, turnExtensionsHtml } from '../../../src/ui/dashboard-presentation';

const init = {
  type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: ['Read', 'Skill', 'mcp__gateway__subagent_spawn'],
  plugins: [{ name: 'pstack', path: '/home/user/.claude/plugins/cache/pstack-claude/pstack/0.9.84', source: 'pstack@pstack-claude' }, { name: 'local', path: '/tmp/local-plugin' }],
  skills: ['pstack:how', 'pstack:reflect', 'deploy'], agents: ['general-purpose', 'pstack:how-explorer'],
  mcp_servers: [{ name: 'gateway', status: 'connected' }, { name: 'browser', status: 'failed' }],
};

test('the CLI init inventory is kept by name, never by path', () => {
  const collector = new TurnUsageCollector();
  collector.observe(init);
  const snapshot = collector.snapshot();
  expect(snapshot.extensions).toEqual({
    plugins: ['local', 'pstack@pstack-claude'], skills: ['deploy', 'pstack:how', 'pstack:reflect'],
    agents: ['general-purpose', 'pstack:how-explorer'],
    mcpServers: [{ name: 'browser', status: 'failed' }, { name: 'gateway', status: 'connected' }],
  });
  expect(JSON.stringify(snapshot)).not.toContain('/home/user');
  expect(JSON.stringify(snapshot)).not.toContain('/tmp/local-plugin');
});

test('an init event without extension fields records no inventory, and malformed entries are dropped', () => {
  const collector = new TurnUsageCollector();
  collector.observe({ type: 'system', subtype: 'init', tools: ['Read'] });
  expect(collector.snapshot().extensions).toBeUndefined();
  collector.observe({ type: 'system', subtype: 'init', tools: ['Read'], skills: ['ok', 7, ''], plugins: [{ path: '/x' }, 'bare'], mcp_servers: [{ status: 'connected' }] });
  expect(collector.snapshot().extensions).toEqual({ plugins: ['bare'], skills: ['ok'], agents: [], mcpServers: [] });
});

test('a Skill tool call records the invoked skill name', () => {
  const collector = new TurnUsageCollector();
  collector.observe({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Skill', input: {} } } });
  collector.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'pstack:how', args: 'why is it slow' } }] } });
  collector.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's2', name: 'Skill', input: { skill: 42 } }] } });
  expect(collector.snapshot()).toMatchObject({ usedTools: ['Skill'], usedSkills: ['pstack:how'] });
});

// Review of #591 (L12): tool_call runs only the catalog's bare names and refuses `mcp__gateway__x`,
// so showing that call as `mcp__gateway__x` made a refused call look like the tool ran.
test('a deferred call is shown with the name it asked for', () => {
  // Third review of #591: tool_call now runs a gateway tool named with its own namespace, so it shows as that tool.
  expect(executionTool({ name: 'mcp__gateway__tool_call', input: { name: 'mcp__gateway__browser_create_session', arguments: {} } }).name).toBe('mcp__gateway__browser_create_session');
  expect(executionTool({ name: 'mcp__gateway__tool_call', input: { name: 'browser_create_session' } }).name).toBe('mcp__gateway__browser_create_session');
  // Another server's prefix is a claim, not a namespace: it stays inside this connector's.
  expect(executionTool({ name: 'mcp__browser__tool_call', input: { name: 'mcp__gateway__memory_write' } }).name).toBe('mcp__browser__mcp__gateway__memory_write');
});

test('a subagent worker turn carries its parent, depth, effort and read-only mode', () => {
  const store = new OrchestrationStore(':memory:', 'agent');
  try {
    const tasks = new TaskService(store, { tasks: { workspaceMode: 'host' } }, '/project');
    const input = store.acceptInput({ scope: { agentId: 'agent', agentSessionId: 'session', source: 'api', accountId: 'owner', principalId: 'owner', chatId: 'chat', threadKey: '' }, text: '/pstack:how why' });
    const decision = new DecisionService(store).begin(input.conversationId, 'owner', [input.inputId]);
    const context = { ...input, ...decision, principalId: 'owner', execute: true, writeMemory: false };
    const root = tasks.spawn({ ...context, actionId: 'root' }, { title: 'Root', instructions: 'Run pstack how', targetProfile: 'default-worker' });
    const child = tasks.spawn({ ...context, actionId: 'child' }, { title: 'Explorer', instructions: 'Explore', targetProfile: 'default-worker' });
    store.run(`UPDATE tasks SET snapshot_json=json_set(snapshot_json,'$.parentTaskId',?,'$.rootTaskId',?,'$.depth',1,'$.subagentType','pstack:how-explorer','$.effort','high','$.readonly',json('true')) WHERE id=?`, root.taskId, root.taskId, child.taskId);
    for (const task of [root, child]) {
      const attempt = tasks.claim(task.taskId)!;
      recordTokenTurn(store, { id: attempt.attemptId, sessionId: 'session', role: 'worker', category: 'worker', taskId: task.taskId, taskRevision: attempt.revision, toolIds: [], inputTokens: 0, totalTokens: 0, startedAt: 1 });
    }
    const [rootTurn, childTurn] = tokenReport(store, 'session').turns.sort((a, b) => (a.taskId === root.taskId ? -1 : b.taskId === root.taskId ? 1 : 0));
    expect(rootTurn.subagent).toBeUndefined();
    expect(childTurn.subagent).toEqual({ parentTaskId: root.taskId, depth: 1, type: 'pstack:how-explorer', effort: 'high', readonly: true });
  } finally { store.close(); }
});

const turn: TokenReportView['turns'][number] = {
  id: 'worker-turn', role: 'worker', category: 'worker', taskId: 'task-child', harness: 'claude', startedAt: '2026-10-14',
  usage: { inputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 1, totalTokens: 2 },
  loadedTools: ['Read', 'Skill'], usedTools: ['Skill'], usedSkills: ['pstack:how'],
  extensions: { plugins: ['pstack@pstack-claude'], skills: ['pstack:how'], agents: ['pstack:how-explorer'], mcpServers: [{ name: 'gateway', status: 'connected' }, { name: 'browser', status: 'failed' }] },
  requests: [{ id: 'r1', usage: { inputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 1, totalTokens: 2 }, toolSchemas: { messageId: 'r1', requestId: 'q1', loaded: ['Read'], deferred: ['mcp__gateway__cron_list'], source: 'cli-request-body' } }],
  subagent: { parentTaskId: 'task-root', depth: 2, type: 'pstack:how-explorer', effort: 'high', readonly: true },
};

test('turn details show used skills, the session inventory, deferred tools and the subagent line', () => {
  const html = generateTokenReportHtml('agent', { sessionId: 's', coverage: 'recorded-turns-only', totals: { agentTokens: null, workerTokens: 2, totalTokens: 2 }, turns: [turn] });
  expect(html).toContain('<h3>Used skills</h3><ul class="tool-name-list"><li><code>pstack:how</code></li></ul>');
  expect(html).toContain('<h3>Plugins</h3><ul class="tool-name-list"><li><code>pstack@pstack-claude</code></li></ul>');
  expect(html).toContain('<h3>Skills available</h3>');
  expect(html).toContain('<h3>Agents available</h3><ul class="tool-name-list"><li><code>pstack:how-explorer</code></li></ul>');
  expect(html).toContain('<li><code>browser (failed)</code></li><li><code>gateway</code></li>');
  expect(html).toContain('<h3>Tools at session start</h3><ul class="tool-name-list"><li><code>Read</code></li><li><code>Skill</code></li></ul>');
  expect(html).toContain('<h3>Deferred tools (not loaded; available through tool search)</h3><ul class="tool-name-list"><li><code>mcp__gateway__cron_list</code></li></ul>');
  expect(html).toContain('Subagent of task <code>task-root</code> · depth 2 · pstack:how-explorer · effort high · read-only');
});

test('Codex turns say skills are not recorded instead of showing none', () => {
  const html = turnExtensionsHtml({ harness: 'codex', usedSkills: [] });
  expect(html).toContain('<h3>Used skills</h3><p class="muted">Not recorded for Codex workers</p>');
});

test('stored inventory cannot inject markup, and the dashboard client gets the same renderer', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = turnExtensionsHtml({ usedSkills: [evil], extensions: { plugins: [evil], skills: [], agents: [], mcpServers: [{ name: evil, status: evil }] }, subagent: { parentTaskId: evil, depth: 1, type: evil } });
  expect(html).not.toContain(evil);
  expect(dashboardPresentationClient).toContain('function turnExtensionsHtml(');
});

// Review of #591 (M3): the list is of tools whose schemas were NOT loaded, and a tool the
// turn later loaded through tool search was listed as deferred beside its loaded entry.
test('deferred tools are the ones no request of the turn loaded', () => {
  const schemas = (loaded: string[], deferred: string[]) => ({ toolSchemas: { loaded, deferred } });
  const html = turnExtensionsHtml({ usedSkills: [], requests: [schemas(['Read'], ['mcp__gateway__cron_list', 'mcp__gateway__task_spawn']), schemas(['Read', 'mcp__gateway__task_spawn'], ['mcp__gateway__cron_list'])] });
  expect(html).toContain('<h3>Deferred tools (not loaded; available through tool search)</h3><ul class="tool-name-list"><li><code>mcp__gateway__cron_list</code></li></ul>');
  expect(html).not.toContain('loaded through tool search');
  expect(turnExtensionsHtml({ usedSkills: [], requests: [schemas(['Read', 'mcp__gateway__cron_list'], []), schemas(['Read'], ['mcp__gateway__cron_list'])] })).not.toContain('Deferred tools');
});

// Review of #591 (L14): a queued turn, or one recorded without the skill list, said "Used skills: None".
test('a turn without a recorded skill list shows no Used skills section', () => {
  expect(turnExtensionsHtml({})).not.toContain('Used skills');
  expect(turnExtensionsHtml({ pending: true, usedSkills: [] })).not.toContain('Used skills');
  expect(turnExtensionsHtml({ usedSkills: [] })).toContain('<h3>Used skills</h3>');
});

// Review of #591 (M4): the overview polls the projected metrics; the inventory is read for one turn's details only.
test('the polled metrics leave out the skill and extension inventory', () => {
  const store = new OrchestrationStore(':memory:', 'agent');
  try {
    expect(measuredTurns(store, 'session')).toEqual([]);
    recordTokenTurn(store, { id: 'turn', sessionId: 'session', role: 'worker', category: 'worker', toolIds: [], inputTokens: 1, totalTokens: 2, startedAt: 1,
      usage: turn.usage, usedSkills: ['pstack:how'], extensions: turn.extensions });
    const metrics = JSON.parse(String(store.get('SELECT payload_json FROM token_turn_metrics WHERE id=?', 'turn')!.payload_json));
    expect(metrics).not.toHaveProperty('extensions');
    expect(metrics).not.toHaveProperty('usedSkills');
    expect(metrics.totalTokens).toBe(2);
    expect(measuredTurns(store, 'session')[0]).toMatchObject({ id: 'turn', extensions: undefined, usedSkills: undefined });
    expect(tokenReport(store, 'session').turns[0]).toMatchObject({ usedSkills: ['pstack:how'], extensions: turn.extensions });
  } finally { store.close(); }
});
