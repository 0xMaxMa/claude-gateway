import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { MAX_AGENT_CONTEXT_REFS, TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import type { AgentConfig } from '../../../src/types';

// Issue #574 review: the agent-supplied bound must hold on every spawn path, with or without pending intake inputs.
function fixture(container: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'agent-refs-')), workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new OrchestrationStore(join(root, 'db'), 'a'), tasks = new TaskService(store), decisions = new DecisionService(store);
  const scope = { agentId: 'a', agentSessionId: 'session', source: 'api' as const, accountId: 'u', chatId: 'c', threadKey: '', principalId: 'u' };
  const input = store.acceptInput({ scope, text: 'work' });
  const context = { ...input, ...decisions.begin(input.conversationId, 'u', [input.inputId]), principalId: 'u', execute: true, writeMemory: false };
  const bridge = container
    ? new TaskBridge(tasks, undefined, undefined, undefined, { agent: { id: 'a', workspace } as AgentConfig, spool: join(root, 'spool') })
    : new TaskBridge(tasks);
  return { root, workspace, store, context, bridge, close: async () => { await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function spawn(f: ReturnType<typeof fixture>, refs: string[], extra: Record<string, unknown> = {}) {
  await f.bridge.start();
  const dir = join(f.root, 'ticket');
  f.bridge.issue({ role: 'agent', context: f.context, capabilities: async () => ({}), ...extra } as any, dir, f.workspace);
  const auth = JSON.parse(readFileSync(join(dir, 'ticket.json'), 'utf8'));
  return new Promise<any>((resolve, reject) => {
    const call = auth.socket ? request({ socketPath: auth.socket, path: '/call', method: 'POST' }, finish) : request(auth.url, { method: 'POST' }, finish);
    function finish(res: any) { let b = ''; res.on('data', (c: any) => b += c); res.on('end', () => resolve(JSON.parse(b))); }
    call.setHeader('Authorization', 'Bearer ' + auth.token);
    call.on('error', reject);
    call.end(JSON.stringify({ tool: 'task_spawn', args: { title: 'T', instructions: 'work', target_profile: 'default-worker', context_refs: refs }, action_id: 'spawn' }));
  });
}

const tooMany = Array.from({ length: MAX_AGENT_CONTEXT_REFS + 1 }, (_, i) => `r${i}`);
const message = new RegExp(`context_refs has ${MAX_AGENT_CONTEXT_REFS + 1} entries; an agent may reference at most ${MAX_AGENT_CONTEXT_REFS}`);

test.each([['host agent, no pending intake inputs', false], ['container agent', true]])('%s: 65 agent refs are rejected with the actionable error', async (_name, container) => {
  const f = fixture(container);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const reply = await spawn(f, tooMany);
    expect(JSON.stringify(reply)).toMatch(message);
  } finally { await f.close(); }
});

test('host agent with an intake hook that adds input IDs: 65 agent refs are rejected before the hook runs', async () => {
  const f = fixture(false);
  const beforeMutation = jest.fn(async () => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const reply = await spawn(f, tooMany, { beforeMutation });
    expect(JSON.stringify(reply)).toMatch(message);
    expect(beforeMutation).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
