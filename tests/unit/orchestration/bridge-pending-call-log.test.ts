import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-pending-')), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const store = new OrchestrationStore(join(root, 'db'), 'operator'), tasks = new TaskService(store);
  const receipt = store.acceptInput({ scope: { agentId: 'operator', agentSessionId: 'chat', source: 'api', accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' }, text: 'make images' });
  const context = { ...receipt, ...new DecisionService(store).begin(receipt.conversationId, 'owner', [receipt.inputId]), principalId: 'owner', execute: true, writeMemory: false };
  const bridge = new TaskBridge(tasks);
  bridge.slowCallWarnMs = 50;
  bridge.models = () => new Promise(() => {});
  await bridge.start();
  const directory = join(root, 'ticket'); bridge.issue({ role: 'agent', context } as Parameters<TaskBridge['issue']>[0], directory, workspace);
  const auth = JSON.parse(readFileSync(join(directory, 'ticket.json'), 'utf8'));
  const call = (tool: string, args: Record<string, unknown>, giveUpAfterMs: number) => new Promise<string>(ok => {
    const req = request(auth.url, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token } }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => ok(body)); });
    const giveUp = setTimeout(() => { req.destroy(); ok('gave up'); }, giveUpAfterMs);
    req.on('close', () => clearTimeout(giveUp));
    req.on('error', () => ok('gave up'));
    req.end(JSON.stringify({ tool, args, action_id: 'cmd-' + tool }));
  });
  return { call, store, close: async () => { await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

const bridgeLogs = (warn: jest.SpyInstance) => warn.mock.calls.map(([line]) => { try { return JSON.parse(String(line)); } catch { return undefined; } })
  .filter(entry => typeof entry?.message === 'string' && entry.message.startsWith('Task bridge call') || entry?.message === 'Task bridge caller disconnected before the response');

test('a task_spawn stuck before commit logs its tool and step while pending and when the caller gives up', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const f = await fixture();
  try {
    expect(await f.call('task_spawn', { title: 'Images', instructions: 'Make before/after images', target_profile: 'default-worker', model: 'claude-sonnet-5-5' }, 300)).toBe('gave up');
    await new Promise(resolve => setTimeout(resolve, 50));
    const logs = bridgeLogs(warn);
    expect(logs.map(entry => entry.message)).toEqual(['Task bridge call still pending', 'Task bridge caller disconnected before the response']);
    for (const entry of logs) expect(entry.data).toMatchObject({ agentId: 'operator', tool: 'task_spawn', step: 'task_spawn:models' });
    expect(logs[1].data.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(JSON.stringify(logs)).not.toContain('before/after');
    expect(f.store.get('SELECT COUNT(*) AS n FROM task_commands')).toEqual({ n: 0 });
  } finally { await f.close(); warn.mockRestore(); }
});

test('a call that answers promptly logs nothing', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const f = await fixture();
  try {
    expect(await f.call('task_status', {}, 2000)).not.toBe('gave up');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(bridgeLogs(warn)).toEqual([]);
  } finally { await f.close(); warn.mockRestore(); }
});
