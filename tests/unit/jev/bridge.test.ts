import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { request } from 'http';
import { urlToHttpOptions } from 'url';
import { TaskBridge, containerTaskTools } from '../../../src/orchestration/bridge';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskFiles } from '../../../src/orchestration/task-files';
import { DecisionService } from '../../../src/orchestration/decisions';
import { JevService } from '../../../src/jev/service';
import { BrowserTaskAdapter } from '../../../src/orchestration/gateway-tasks/browser';
import { GatewayTaskAdapter, GatewayTaskController } from '../../../src/orchestration/gateway-tasks/controller';
import { AgentConfig } from '../../../src/types';
const input = { state: 'Hello', questions: { greeting: { type: 'noul', instructions: 'Greeting?' } } };
function fixture(container: boolean, adapters = new Map<string, GatewayTaskAdapter>()) {
  const root = mkdtempSync(join(tmpdir(), 'jev-bridge-')), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const store = new OrchestrationStore(join(root, 'db'), 'a'), tasks = new TaskService(store), files = new TaskFiles(store, root);
  const accepted = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'api', accountId: 'u', chatId: 'c', threadKey: '', principalId: 'u' }, text: 'Evaluate greeting' });
  const decision = new DecisionService(store).begin(accepted.conversationId, 'u', [accepted.inputId]);
  const context = { ...accepted, ...decision, principalId: 'u', execute: true, writeMemory: false };
  const bridge = new TaskBridge(tasks, files, undefined, undefined, container ? { agent: { id: 'a', workspace } as AgentConfig, spool: join(root, 'spool') } : undefined, undefined, adapters);
  let enabled = true;
  const fetcher = jest.fn(async () => new Response(JSON.stringify({ model: 'jev', answers: { greeting: { type: 'noul', noul: .9 } }, usage: { input_tokens: 7, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } }));
  const service = new JevService({ getConfig: () => ({ enabled, provider: 'typesafe', model: 'jev' }), resolveConnection: async () => ({ baseUrl: 'https://provider.example', apiKey: 'vendor-private-placeholder' }), fetch: fetcher as any });
  bridge.jevEnabled = () => enabled;
  bridge.jevCall = jest.fn(async (scope, args, actionId, signal) => service.evaluate(args as any, { principalId: scope.role === 'agent' ? scope.context.principalId : 'u', consumer: scope.role, signal, authorize: () => enabled }));
  let sequence = 0;
  const issue = (scope: Parameters<TaskBridge['issue']>[0]) => {
    const directory = join(root, 'ticket-' + ++sequence), issued = bridge.issue(scope, directory, workspace);
    const ticket = JSON.parse(readFileSync(join(directory, 'ticket.json'), 'utf8'));
    const call = (args: any = input, tool = 'jev_evaluate') => new Promise<any>((resolve, reject) => {
      const options = ticket.socket ? { socketPath: ticket.socket, path: '/call' } : urlToHttpOptions(new URL(ticket.url));
      const r = request({ ...options, method: 'POST', headers: { Authorization: 'Bearer ' + ticket.token } }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(JSON.parse(body))); });
      r.on('error', reject); r.end(JSON.stringify({ tool, args, action_id: 'evaluate-' + ++sequence }));
    });
    return { ...issued, directory, ticket, call };
  };
  const worker = () => {
    const task = tasks.spawn({ ...context, actionId: 'spawn-' + ++sequence }, { title: 'test', instructions: 'test', targetProfile: 'default-worker' });
    const attempt = tasks.claim(task.taskId)!;
    return { task, attempt, ticket: issue({ role: 'worker', attemptId: attempt.attemptId, generation: attempt.generation }) };
  };
  return { root, workspace, store, tasks, bridge, context, issue, worker, fetcher, setEnabled: (value: boolean) => { enabled = value; }, close: async () => { await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
describe.each([false, true])('Jev actual task bridge container=%s', container => {
  test('authorized agent and worker share evaluation without receiving vendor credentials', async () => {
    const f = fixture(container);
    try {
      await f.bridge.start(); const agent = f.issue({ role: 'agent', context: f.context }); const worker = f.worker();
      expect(await agent.call()).toMatchObject({ answers: { greeting: { noul: .9 } } }); expect(await worker.ticket.call()).toMatchObject({ usage: { input_tokens: 7 } });
      expect(f.fetcher).toHaveBeenCalledTimes(2);
      for (const ticket of [agent, worker.ticket]) {
        expect(JSON.stringify(ticket.ticket)).not.toContain('vendor-private-placeholder');
        expect(readFileSync(ticket.profile.mcpConfigPath, 'utf8')).not.toContain('vendor-private-placeholder');
        expect(ticket.profile.jevEnabled).toBe(true);
        if (container) expect(ticket.ticket.tools.map((t: any) => t.name)).toContain('jev_evaluate');
      }
    } finally { await f.close(); }
  });
  test('read-only, compact-only and foreign-principal agent tickets cannot incur inference', async () => {
    const f = fixture(container);
    try {
      await f.bridge.start();
      for (const scope of [
        { role: 'agent' as const, context: { ...f.context, execute: false } },
        { role: 'agent' as const, context: f.context, compactOnly: true },
        { role: 'agent' as const, context: { ...f.context, principalId: 'other' } },
      ]) expect(await f.issue(scope).call()).toHaveProperty('error');
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  test('disabled features and revoked tickets reject before provider calls', async () => {
    const f = fixture(container);
    try {
      await f.bridge.start(); f.setEnabled(false);
      const agent = f.issue({ role: 'agent', context: f.context });
      expect(agent.profile.jevEnabled).toBe(false);
      if (container) expect(agent.ticket.tools.map((t: any) => t.name)).not.toContain('jev_evaluate');
      expect(await agent.call()).toMatchObject({ error: 'ACCESS_DENIED', reason: 'JEV_NOT_ALLOWED' });
      f.setEnabled(true); agent.revoke();
      expect(await agent.call()).toMatchObject({ error: 'ACCESS_DENIED', reason: 'TICKET_INVALID_OR_REVOKED' }); expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  test('worker attempt scope is revalidated and stale worker tickets cannot continue', async () => {
    const f = fixture(container);
    try {
      await f.bridge.start(); const worker = f.worker();
      f.tasks.finish(worker.attempt.attemptId, worker.attempt.generation, { type: 'completed', result: { summary: 'Done', artifactIds: [] } });
      expect(await worker.ticket.call()).toHaveProperty('error'); expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  test('revoking an active ticket cancels pending inference instead of publishing the answer', async () => {
    const f = fixture(container);
    try {
      await f.bridge.start(); const agent = f.issue({ role: 'agent', context: f.context });
      let started!: () => void; const dispatched = new Promise<void>(resolve => { started = resolve; });
      f.fetcher.mockImplementation(() => { started(); return new Promise(() => {}); });
      const pending = agent.call(); await dispatched; agent.revoke();
      expect(await pending).toMatchObject({ error: 'JEV_CANCELLED' });
    } finally { await f.close(); }
  });
  test('callers cannot override model, credential or another principal in tool arguments', async () => {
    const f = fixture(container);
    try {
      await f.bridge.start(); const agent = f.issue({ role: 'agent', context: f.context });
      for (const extra of [{ principalId: 'other' }, { model: 'different' }, { apiKey: 'untrusted' }, { baseUrl: 'https://other.example' }]) expect(await agent.call({ ...input, ...extra })).toMatchObject({ error: 'JEV_INVALID_REQUEST' });
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
test('container schemas expose Jev only when explicitly enabled, without host tools', () => {
  for (const role of ['agent', 'worker'] as const) {
    expect(containerTaskTools(role).map(t => t.name)).not.toContain('jev_evaluate');
    expect(containerTaskTools(role, true).map(t => t.name)).toContain('jev_evaluate');
    expect(containerTaskTools(role, true).map(t => t.name)).not.toContain('safemode_send');
  }
});

test('enabled app browser schemas discover and submit only scoped browser managed work', async () => {
  const adapters = new Map<string, GatewayTaskAdapter>(); const f = fixture(true, adapters);
  const transport = {
    observe: async () => ({ revision: 'r', fingerprint: 'f', state: 'Expected result is present', actions: [] }),
    checkAccess: async () => true, execute: jest.fn(async () => ({ outcome: 'applied' as const })),
    verifyCompletion: async () => ({ verified: true, evidence: 'Independent result element matched' }),
  };
  const binding = { version: 1 as const, id: 'browser-a', name: 'Private browser', principalId: 'u', conversationId: f.context.conversationId, transport };
  const browser = new BrowserTaskAdapter({ agentId: 'a', root: join(f.root, 'receipts'), allowed: () => true, bindings: () => [binding], evaluate: async () => ({
    requestId:'r',requestedModel:'jev',model:'jev',usage:{input_tokens:1,output_tokens:1},answers:{
      operation:{type:'choice',choice:'DONE',confidence:1,probabilities:{DONE:1}},target:{type:'choice',choice:'NONE',confidence:1,probabilities:{NONE:1}},
    },
  }) }); adapters.set('browser', browser); f.bridge.browserEnabled = () => true;
  const controller = new GatewayTaskController(f.tasks, adapters);
  try {
    await f.bridge.start(); const agent = f.issue({ role: 'agent', context: f.context });
    expect(agent.profile.browserEnabled).toBe(true);
    const tools = agent.ticket.tools;
    expect(tools.find((t:any)=>t.name==='capabilities_list').inputSchema.properties.scope.enum).toEqual(['capabilities','browser']);
    expect(tools.find((t:any)=>t.name==='task_spawn').inputSchema.properties.gateway_target.properties.adapter.enum).toEqual(['browser']);
    expect(await agent.call({scope:'browser'},'capabilities_list')).toMatchObject({targets:[{session_id:'browser-a'}]});
    expect(await agent.call({scope:'safemode'},'capabilities_list')).toMatchObject({error:'ACCESS_DENIED',reason:'SAFEMODE_HOST_ONLY'});
    const spawned = await agent.call({title:'Verify result',instructions:'Verify expected result',target_profile:'gateway-managed',gateway_target:{adapter:'browser',session_id:'browser-a'}},'task_spawn');
    expect(spawned).not.toHaveProperty('error');
    for(let i=0;i<20;i++){await controller.tick();await new Promise(resolve=>setImmediate(resolve));}
    const rows=f.store.all('SELECT id,state FROM tasks'); expect(rows).toHaveLength(1);expect(rows[0].state).toBe('completed');
    expect(f.store.task(String(rows[0].id))?.gatewayTarget).toMatchObject({adapter:'browser',sessionId:'browser-a'});
    expect(f.store.all('SELECT * FROM worker_pool')).toHaveLength(0);
    expect(transport.execute).not.toHaveBeenCalled();
  } finally {await controller.close();await browser.close();await f.close();}
});
