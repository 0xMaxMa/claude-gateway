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

test('enabled app browser schemas discover, inspect and verify only scoped browser managed work', async () => {
  const adapters = new Map<string, GatewayTaskAdapter>(); const f = fixture(true, adapters);
  const run=jest.fn(async()=>({status:'needs_verification' as const,reason:'COMPLETION_CANDIDATE',steps:0,evaluations:1}));
  const binding = { version: 1 as const, id: 'browser-a', name: 'Private browser', principalId: 'u', conversationId: f.context.conversationId, run,inspect:async(_result:any,_signal:any,_authorized:any,screenshot?:boolean)=>({observedAt:Date.now(),observation:{generation:'g',elements:[{ref:'x',label:'Name',value:'Expected'}]},...(screenshot?{screenshot:{type:'image' as const,mimeType:'image/png' as const,data:'iVBORw0KGgo='}}:{})}) };
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
    const rows=f.store.all('SELECT id,state FROM tasks'); expect(rows).toHaveLength(1);expect(rows[0].state).toBe('needs_reconciliation');
    const taskId=String(rows[0].id);
    const screenshot=await agent.call({task_id:taskId,browser_evidence:'screenshot'},'task_status');
    expect(screenshot.screenshot).toEqual({type:'image',mimeType:'image/png',data:'iVBORw0KGgo='});
    const proof=await agent.call({task_id:taskId,browser_evidence:'fresh'},'task_status');
    expect(proof.browserEvidence.page.elements[0].value).toBe('Expected');
    expect(Object.keys(proof)[0]).toBe('verification');
    expect(proof.tasks[0].currentInstructions).toBe('Verify expected result');
    expect(proof.verification.arguments).toMatchObject({task_id:taskId,mode:'verify_browser',evidence_id:proof.browserEvidence.evidenceId});
    const incomplete=await agent.call({task_id:taskId,expected_revision:f.store.task(taskId)!.revision,mode:'verify_browser',expected_request_id:proof.browserEvidence.requestId,instruction:'Name matches'},'task_update');
    expect(incomplete).toMatchObject({error:'BROWSER_EVIDENCE_REQUIRED',message:expect.stringContaining('evidence_id')});
    expect(f.store.task(taskId)!.revision).toBe(1);

    const foreign=f.issue({role:'agent',context:{...f.context,principalId:'foreign'}});
    expect(await foreign.call({task_id:taskId,browser_evidence:'fresh'},'task_status')).toHaveProperty('error');
    let hookStarted!:()=>void,releaseHook!:()=>void;const hookEntered=new Promise<void>(resolve=>{hookStarted=resolve;});
    const revocable=f.issue({role:'agent',context:f.context,beforeMutation:async()=>{hookStarted();await new Promise<void>(resolve=>{releaseHook=resolve;});}});
    const rejected=revocable.call({task_id:taskId,expected_revision:f.store.task(taskId)!.revision,mode:'verify_browser',expected_request_id:proof.browserEvidence.requestId,evidence_id:proof.browserEvidence.evidenceId,instruction:'Name matches'},'task_update');
    await hookEntered;revocable.revoke();releaseHook();expect(await rejected).toHaveProperty('error');
    expect(f.store.task(taskId)!.state).toBe('needs_reconciliation');
    const confirmed=await agent.call({task_id:taskId,expected_revision:f.store.task(taskId)!.revision,mode:'verify_browser',expected_request_id:proof.browserEvidence.requestId,evidence_id:proof.browserEvidence.evidenceId,instruction:'Fresh Name field matches Expected'},'task_update');
    expect(confirmed).not.toHaveProperty('error');expect(f.store.task(taskId)!.state).toBe('completed');
    expect(f.store.task(String(rows[0].id))?.gatewayTarget).toMatchObject({adapter:'browser',sessionId:'browser-a'});
    expect(f.store.all('SELECT * FROM worker_pool')).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(1);
    let started!:()=>void,finish!:()=>void;const startedRead=new Promise<void>(resolve=>{started=resolve;});
    jest.spyOn(binding,'inspect').mockImplementation(async()=>{started();await new Promise<void>(resolve=>{finish=resolve;});return {observedAt:Date.now(),observation:{generation:'g',elements:[{ref:'x',label:'Name',value:'Expected'}]}};});
    const pending=agent.call({task_id:taskId,browser_evidence:'fresh'},'task_status');await startedRead;agent.revoke();finish();
    expect(await pending).toHaveProperty('error');
  } finally {await controller.close();await browser.close();await f.close();}
});

for(const container of [false,true])test(`computer trace pages remain scoped and revocable (${container?'container':'host'})`,async()=>{
 const adapters=new Map<string,GatewayTaskAdapter>(),f=fixture(container,adapters);
 const diagnostics=jest.fn(async()=>({recordedOnly:true,events:[],nextOffset:null}));
 adapters.set('computer',{name:'computer',diagnostics} as unknown as GatewayTaskAdapter);f.bridge.computerEnabled=()=>true;
 try{await f.bridge.start();const task=f.tasks.spawn({...f.context,actionId:'computer-fixture'},{title:'Inspect Mac',instructions:'Inspect',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
  const agent=f.issue({role:'agent',context:f.context});
  expect(await agent.call({task_id:task.taskId,computer_trace_offset:0},'task_status')).toMatchObject({computerTrace:{recordedOnly:true}});
  const foreign=f.issue({role:'agent',context:{...f.context,principalId:'foreign'}});expect(await foreign.call({task_id:task.taskId,computer_trace_offset:0},'task_status')).toHaveProperty('error');
  expect(await agent.call({task_id:task.taskId,computer_trace_offset:-1},'task_status')).toHaveProperty('error');
  let started!:()=>void,finish!:()=>void;const entered=new Promise<void>(r=>{started=r;});diagnostics.mockImplementationOnce(async()=>{started();await new Promise<void>(r=>{finish=r;});return {recordedOnly:true,events:[],nextOffset:null};});
  const pending=agent.call({task_id:task.taskId,computer_trace_offset:0},'task_status');await entered;agent.revoke();finish();expect(await pending).toHaveProperty('error');
 }finally{await f.close();}
});

test.each([false,true])('pending field status attaches a scoped snapshot; capture failure keeps the question (container=%s)',async container=>{
 const adapters=new Map<string,GatewayTaskAdapter>(),f=fixture(container,adapters);
 const screenshot={type:'image',mimeType:'image/png',data:'fixture-image'};
 const evidence=jest.fn(async()=>({requestId:'request',recorded:{},fresh:{observedAt:100,observation:{elements:[{label:'From',value:'CNX'}]},screenshot}}));
 adapters.set('browser',{name:'browser',evidence} as unknown as GatewayTaskAdapter);
 try{
  await f.bridge.start();const task=f.tasks.spawn({...f.context,actionId:'pending-field'},{title:'Flights',instructions:'CNX to Osaka',targetProfile:'gateway-managed',gatewayTarget:{adapter:'browser',sessionId:'tab',name:'Browser'}});
  task.state='waiting_input';task.pendingQuestion={questionId:'q',text:'Destination?'} as any;task.browserReport={status:'blocked',reason:'FIELD_TEXT_REQUIRED',steps:0,evaluations:1,fieldRequest:{ref:'to',label:'To',reason:'missing'}};
  f.store.transaction(()=>f.store.saveTask(task,task.stateVersion));
  const agent=f.issue({role:'agent',context:f.context});
  expect(await agent.call({task_id:task.taskId},'task_status')).toMatchObject({screenshot,fieldContext:{snapshot:'fresh'},tasks:[{pendingQuestion:{questionId:'q'}}]});
  expect(evidence.mock.calls[0]).toMatchObject([expect.anything(),true,expect.anything(),true]);
  evidence.mockRejectedValueOnce(Error('capture unavailable')).mockResolvedValueOnce({requestId:'request',recorded:{}} as any);
  expect(await agent.call({task_id:task.taskId},'task_status')).toMatchObject({fieldContext:{snapshot:'unavailable'},tasks:[{pendingQuestion:{questionId:'q'}}]});
  const foreign=f.issue({role:'agent',context:{...f.context,principalId:'foreign'}});
  expect(await foreign.call({task_id:task.taskId},'task_status')).toHaveProperty('error');
 }finally{await f.close();}
});

for(const container of [false,true])test(`computer snapshots and prepared inputs are scoped on host/container ${container}`,async()=>{
 const computerEvidence=jest.fn(async()=>({recordedOnly:true,snapshot:{state:{application:'com.apple.Maps'}},screenshot:{type:'image',mimeType:'image/jpeg',data:'/9j/AA=='}}));
 const adapters=new Map<string,GatewayTaskAdapter>([['computer',{name:'computer',computerEvidence} as any]]),f=fixture(container,adapters);f.bridge.computerEnabled=()=>true;
 try{await f.bridge.start();const plan=[{application:'com.apple.Maps',label:'Search',text:'Bangkok'}];const task=f.tasks.spawn({...f.context,actionId:'snapshot-fixture'},{title:'Maps',instructions:'Search Bangkok',computerInputs:plan,targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 expect(f.tasks.revision(task.taskId,1).computerInputs).toEqual(plan);
 const agent=f.issue({role:'agent',context:f.context});expect(await agent.call({task_id:task.taskId,computer_evidence:'recorded'},'task_status')).toMatchObject({computerEvidence:{recordedOnly:true}});
 const foreign=f.issue({role:'agent',context:{...f.context,principalId:'foreign'}});expect(await foreign.call({task_id:task.taskId,computer_evidence:'screenshot'},'task_status')).toHaveProperty('error');
 expect(await agent.call({task_id:task.taskId,computer_evidence:'fresh',browser_evidence:'fresh'},'task_status')).toHaveProperty('error');
 f.tasks.update({...f.context,actionId:'new-goal'},task.taskId,1,'Search Tokyo','when_ready');expect(f.tasks.revision(task.taskId,2).computerInputs).toBeUndefined();
 }finally{await f.close();}
});

test('parent verifies a computer completion candidate and rejects duplicate verification',async()=>{
 const f=fixture(false);
 try{
  const spawn=(id:string)=>f.tasks.spawn({...f.context,actionId:id},{title:'Maps',instructions:'Open Maps',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:id,name:'Mac'}});
  const task=spawn('verify-computer-fixture'),attempt=f.tasks.claim(task.taskId)!;f.tasks.started(attempt.attemptId,attempt.generation);
  let current=f.store.task(task.taskId)!;current.gatewayDispatch={requestId:'r',submittedAt:Date.now()};f.store.transaction(()=>f.store.saveTask(current,current.stateVersion));
  f.tasks.finish(attempt.attemptId,attempt.generation,{type:'failed',computerReport:{status:'needs_verification',reason:'COMPLETION_CANDIDATE',steps:1,evaluations:2}});
  const check=jest.fn();const verified=f.tasks.verifyComputer({...f.context,actionId:'verify'},task.taskId,1,'r','e','Fresh Maps window is visible',check);expect(verified.state).toBe('completed');expect(check).toHaveBeenCalledTimes(1);
  expect(()=>f.tasks.verifyComputer({...f.context,actionId:'verify-again'},task.taskId,1,'r','e','Visible',check)).toThrow();
 }finally{await f.close();}
});
