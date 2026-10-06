import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { COMPUTER_ADAPTER_ERROR, TaskBridge } from '../../../src/orchestration/bridge';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import type { GatewayTaskAdapter } from '../../../src/orchestration/gateway-tasks/controller';
import { ComputerTaskAdapter } from '../../../src/orchestration/gateway-tasks/computer';

async function fixture(failure: () => never, real?: (root: string) => GatewayTaskAdapter) {
  const root = mkdtempSync(join(tmpdir(), 'computer-bridge-')), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const adapter = real ? real(root) : { name: 'computer', discover: failure, resolve: failure, submit: failure } as unknown as GatewayTaskAdapter;
  const store = new OrchestrationStore(join(root, 'db'), 'operator'), tasks = new TaskService(store);
  const receipt = store.acceptInput({ scope: { agentId: 'operator', agentSessionId: 'chat', source: 'api', accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' }, text: 'open calculator' });
  const context = { ...receipt, ...new DecisionService(store).begin(receipt.conversationId, 'owner', [receipt.inputId]), principalId: 'owner', execute: true, writeMemory: false };
  const bridge = new TaskBridge(tasks, undefined, undefined, undefined, undefined, undefined, new Map([['computer', adapter]])); await bridge.start();
  const directory = join(root, 'ticket'); bridge.issue({ role: 'agent', context } as Parameters<TaskBridge['issue']>[0], directory, workspace);
  const auth = JSON.parse(readFileSync(join(directory, 'ticket.json'), 'utf8'));
  const call = (tool: string, args: Record<string, unknown>) => new Promise<{ status: number; body: any }>((ok, fail) => {
    const req = request(auth.url, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token } }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => ok({ status: res.statusCode!, body: JSON.parse(body) })); });
    req.on('error', fail); req.end(JSON.stringify({ tool, args, action_id: 'cmd-1' }));
  });
  return { call, close: async () => { await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('COMPUTER_NOT_ALLOWED surfaces as its own non-retryable code, not INVALID_REQUEST', async () => {
  const f = await fixture(() => { throw Error('COMPUTER_NOT_ALLOWED'); });
  try {
    const { status, body } = await f.call('capabilities_list', { scope: 'computer' });
    expect(status).toBe(400);
    expect(body.error).toBe('COMPUTER_NOT_ALLOWED');
    expect(body.retryable).toBe(false);
    expect(body.message).toMatch(/not enabled for this agent/);
  } finally { await f.close(); }
});

test('other computer adapter codes surface as themselves; arbitrary messages stay INVALID_REQUEST', async () => {
  for (const [message, code] of [['COMPUTER_ACCESS_UNAVAILABLE', 'COMPUTER_ACCESS_UNAVAILABLE'], ['INVALID_COMPUTER_GOAL', 'INVALID_COMPUTER_GOAL'], ['boom: /home/user/secret', 'INVALID_REQUEST'], ['COMPUTER_lower', 'INVALID_REQUEST']]) {
    const f = await fixture(() => { throw Error(message); });
    try {
      const { body } = await f.call('capabilities_list', { scope: 'computer' });
      expect(body.error).toBe(code);
      expect(JSON.stringify(body)).not.toContain('secret');
    } finally { await f.close(); }
  }
  expect(COMPUTER_ADAPTER_ERROR.test('COMPUTER_' + 'A'.repeat(80))).toBe(false);
});

test('the real computer adapter reports COMPUTER_NOT_ALLOWED for discovery and task_spawn when Computer Use is off', async () => {
  const f = await fixture(() => { throw Error('unused'); }, root => new ComputerTaskAdapter({ agentId: 'operator', root: join(root, 'computer'), connectors: {} as any, allowed: () => false,
    member: () => true, active: () => true, evaluate: async () => { throw Error('unused'); }, needsInput: () => false }));
  try {
    expect((await f.call('capabilities_list', { scope: 'computer' })).body).toMatchObject({ error: 'COMPUTER_NOT_ALLOWED', retryable: false });
    const spawned = await f.call('task_spawn', { title: 'Open Calculator', instructions: 'Calculate 5+5', target_profile: 'gateway-managed', gateway_target: { adapter: 'computer', session_id: 'device-1' } });
    expect(spawned.body.error).toBe('COMPUTER_NOT_ALLOWED');
  } finally { await f.close(); }
});
