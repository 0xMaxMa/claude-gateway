import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { OrchestrationError } from '../../../src/orchestration/types';
import type { AgentConfig } from '../../../src/types';

async function fixture(allowed?: boolean, container = false) {
  const root = mkdtempSync(join(tmpdir(), 'safemode-bridge-')), workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const store = new OrchestrationStore(join(root, 'db'), 'operator'), tasks = new TaskService(store);
  const input = store.acceptInput({ scope: { agentId: 'operator', agentSessionId: 'test-session', source: 'api', accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' }, text: 'inspect' });
  const decision = new DecisionService(store).begin(input.conversationId, 'owner', [input.inputId]);
  const context = { ...input, ...decision, principalId: 'owner', execute: true, writeMemory: false };
  const bridge = new TaskBridge(tasks, undefined, undefined, undefined,
    container ? { agent: { id: 'operator', workspace } as AgentConfig, spool: join(root, 'spool') } : undefined, allowed);
  await bridge.start();
  let count = 0;
  function issue(overrides: Partial<Parameters<TaskBridge['issue']>[0]> = {}) {
    const directory = join(root, 'ticket-' + ++count);
    const issued = bridge.issue({ role: 'agent', context, ...overrides } as Parameters<TaskBridge['issue']>[0], directory, workspace);
    const auth = JSON.parse(readFileSync(join(directory, 'ticket.json'), 'utf8'));
    return { ...issued, call: (operation: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const options = { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token } };
      const onResponse = (res: import('http').IncomingMessage) => {
        let body = ''; res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
      };
      const req = auth.socket ? request({ ...options, socketPath: auth.socket, path: '/call' }, onResponse) : request(auth.url, options, onResponse);
      req.on('error', reject); req.end(JSON.stringify({ tool: 'safemode_validate', args: { operation }, action_id: 'validation' }));
    }) };
  }
  return { issue, context, close: async () => { await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe('scoped safemode operator authorization', () => {
  test('default and explicit non-allowlisted agents cannot inspect or mutate global diagnostics', async () => {
    for (const access of [undefined, false]) {
      const f = await fixture(access);
      try {
        const ticket = f.issue();
        for (const operation of ['list', 'status', 'logs', 'send', 'stop']) expect(await ticket.call(operation)).toEqual({ status: 403, body: { error: 'ACCESS_DENIED' } });
      } finally { await f.close(); }
    }
  });
  test('allowlisted operator can inspect without execution but cannot send or stop', async () => {
    const f = await fixture(true);
    try {
      const ticket = f.issue({ context: { ...f.context, execute: false } });
      for (const operation of ['list', 'status', 'logs']) expect(await ticket.call(operation)).toEqual({ status: 200, body: { allowed: true } });
      for (const operation of ['send', 'stop']) expect((await ticket.call(operation)).status).toBe(403);
    } finally { await f.close(); }
  });
  test('mutation admission must pass before send or stop is authorized', async () => {
    const f = await fixture(true);
    try {
      const admission = jest.fn(async () => { throw new OrchestrationError('ACCESS_DENIED'); });
      const ticket = f.issue({ beforeMutation: admission });
      for (const operation of ['send', 'stop']) expect((await ticket.call(operation)).status).toBe(403);
      expect(admission).toHaveBeenCalledTimes(2);
      const accepted = f.issue({ beforeMutation: async () => {} });
      expect((await accepted.call('send')).body).toEqual({ allowed: true });
    } finally { await f.close(); }
  });
  test('membership, compaction scopes, revoked tickets and unknown operations cannot bypass admission', async () => {
    const f = await fixture(true);
    try {
      const outsider = f.issue({ context: { ...f.context, principalId: 'another-user' } });
      expect((await outsider.call('list')).body.error).toBeDefined();
      const compact = f.issue({ compactOnly: true }); expect((await compact.call('list')).status).toBe(403);
      const revoked = f.issue(); revoked.revoke(); expect((await revoked.call('list')).status).toBe(403);
      const valid = f.issue(); expect((await valid.call('delete')).body).toEqual({ error: 'INVALID_INPUT' });
    } finally { await f.close(); }
  });
  test('app agent is denied host diagnostics even when accidentally allowlisted', async () => {
    const f = await fixture(true, true);
    try {
      const ticket = f.issue();
      for (const operation of ['list', 'send', 'stop']) expect((await ticket.call(operation)).status).toBe(403);
    } finally { await f.close(); }
  });
});
