import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { AgentCliSessions } from '../../../src/orchestration/agent-cli-session';
import { DecisionService } from '../../../src/orchestration/decisions';
import { SessionCompaction, recoverSessionCompaction, resolveSessionCompaction } from '../../../src/orchestration/session-compaction';
import { recordTokenTurn } from '../../../src/orchestration/token-ledger';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

let root:string,store:OrchestrationStore;
const cfg=resolveSessionCompaction({enabled:true});
const usage={inputTokens:600000,cacheCreationTokens:0,cacheReadTokens:0,outputTokens:10,totalTokens:600010};
function seed(id='s',tokens=600000) {
  new AgentCliSessions(store);
  const receipt=store.acceptInput({scope:{agentId:'a',agentSessionId:id,source:'api',accountId:'api',chatId:id,threadKey:'',principalId:'owner'},text:'original input',attachmentIds:['media/original.png']});
  const decisions=new DecisionService(store),decision=decisions.begin(receipt.conversationId,'owner',[receipt.inputId]);
  decisions.finish(decision,'complete','completed');
  store.run('UPDATE conversation_inputs SET created_at=? WHERE id=?',Date.now()-7200000,receipt.inputId);
  store.run('UPDATE conversation_decisions SET started_at=?,ended_at=? WHERE id=?',Date.now()-7200000,Date.now()-7200000,decision.decisionId);
  store.run('INSERT INTO agent_cli_sessions VALUES(?,?,?,?)',id,'cli-'+id,'/fixture',Date.now());
  recordTokenTurn(store,{id:'measure-'+id,sessionId:id,role:'agent',category:'input',startedAt:Date.now()-7200000,endedAt:Date.now()-7200000,
    usage:{...usage,inputTokens:tokens,totalTokens:tokens+10},requests:[{id:'request-'+id,model:'fixture',usage:{...usage,inputTokens:tokens,totalTokens:tokens+10}}],model:'fixture'} as any);
  return receipt;
}
function maintenance(overrides:Record<string,unknown>={}) {
  const deps={busy:()=>false,stopping:()=>false,model:()=> 'fixture',window:jest.fn(async()=>1000000),compact:jest.fn(async()=>{}),...overrides};
  return {deps,manager:new SessionCompaction(store,'a',deps as any)};
}
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'nightly-'));store=new OrchestrationStore(join(root,'orchestration.db'),'a');new AgentCliSessions(store);});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
test('quiet oversized session compacts once without modifying original messages or attachments',async()=>{
  seed();const before=store.all('SELECT * FROM conversation_inputs');const {deps,manager}=maintenance();
  const run=await manager.run(cfg);
  expect(deps.compact).toHaveBeenCalledWith('s','fixture');
  expect(run.items[0]).toMatchObject({status:'completed',beforeTokens:600010,afterTokens:null});
  expect(store.all('SELECT * FROM conversation_inputs')).toEqual(before);
  expect((await manager.run(cfg)).items[0].reason).toBe('unchanged_measurement');
  const restarted=maintenance();expect((await restarted.manager.run(cfg)).items[0].reason).toBe('unchanged_measurement');
  expect(restarted.deps.compact).not.toHaveBeenCalled();
});
test.each(['busy','queued','recent','below','unknown'])('skips %s without native compaction',async kind=>{
  const receipt=seed('s',kind==='below'?499000:600000);
  if(kind==='queued')store.run("UPDATE conversation_inputs SET status='accepted' WHERE id=?",receipt.inputId);
  if(kind==='recent')store.run('UPDATE conversation_inputs SET created_at=? WHERE id=?',Date.now(),receipt.inputId);
  const {manager,deps}=maintenance({busy:()=>kind==='busy',window:async()=>kind==='unknown'?0:1000000});
  expect((await manager.run(cfg)).items[0].status).toBe('skipped');expect(deps.compact).not.toHaveBeenCalled();
});
test('activity arriving during catalog lookup is rechecked before maintenance',async()=>{
  const receipt=seed();const {manager,deps}=maintenance({window:async()=>{store.run("UPDATE conversation_inputs SET status='accepted' WHERE id=?",receipt.inputId);return 1000000;}});
  expect((await manager.run(cfg)).items[0].reason).toBe('pending_input');expect(deps.compact).not.toHaveBeenCalled();
});
test('failure records a safe code and allows a later nightly retry',async()=>{
  seed();const {manager,deps}=maintenance({compact:jest.fn(async()=>{throw Object.assign(new Error('private provider payload'),{code:'COMPACT_NOT_CONFIRMED'});})});
  const run=await manager.run(cfg);expect(run.status).toBe('partial_failure');expect(run.items[0].errorCode).toBe('COMPACT_NOT_CONFIRMED');
  expect(JSON.stringify(manager.report())).not.toContain('private provider');
  await manager.run(cfg);expect(deps.compact).toHaveBeenCalledTimes(2);
});
test('run limit counts attempted compactions, not low-context sessions',async()=>{
  seed('small',1);seed('large');seed('another');const {manager,deps}=maintenance();
  const run=await manager.run({...cfg,maxSessionsPerRun:1});expect(deps.compact).toHaveBeenCalledTimes(1);
  expect(run.items.some(item=>item.reason==='run_limit')).toBe(true);
});
test('gateway-wide serial slot never runs two compactions concurrently',async()=>{
  seed();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const a=maintenance({compact:jest.fn(()=>gate)}),b=maintenance();
  const first=a.manager.run(cfg),second=b.manager.run(cfg);
  await new Promise(r=>setImmediate(r));expect(a.deps.compact).toHaveBeenCalledTimes(1);expect(b.deps.compact).not.toHaveBeenCalled();
  release();await Promise.all([first,second]);expect(b.deps.compact).not.toHaveBeenCalled();
});
test('configuration inherits, sanitizes and defaults to opt-in',()=>{
  expect(resolveSessionCompaction()).toEqual({enabled:false,thresholdPercent:50,quietMinutes:60,maxSessionsPerRun:5});
  expect(resolveSessionCompaction({thresholdPercent:NaN},{enabled:true,quietMinutes:90})).toMatchObject({enabled:true,thresholdPercent:50,quietMinutes:90});
});
test('missing native transcript is skipped without rewriting chat history',async()=>{
  seed();const before=store.all('SELECT * FROM conversation_inputs');
  const {manager}=maintenance({compact:async()=>{throw Object.assign(new Error('missing'),{code:'NO_CLI_SESSION'});}});
  const run=await manager.run(cfg);expect(run.status).toBe('completed');
  expect(run.items[0]).toMatchObject({status:'skipped',reason:'missing_transcript'});
  expect(store.all('SELECT * FROM conversation_inputs')).toEqual(before);
});
test('a crashed in-flight run is reported interrupted and cannot repeat its stale measurement',async()=>{
  seed();maintenance();
  store.run("INSERT INTO session_compaction_runs VALUES('crashed',1,NULL,'running',?)",JSON.stringify(cfg));
  store.run("INSERT INTO session_compaction_items VALUES('crashed','s',?)",JSON.stringify({sessionId:'s',status:'running'}));
  store.run("INSERT INTO session_compaction_marks VALUES('s','measure-s',1)");
  const {manager,deps}=maintenance();
  expect(manager.report()[0]).toMatchObject({status:'interrupted',items:[{status:'failed',errorCode:'INTERRUPTED'}]});
  expect((await manager.run(cfg)).items[0].reason).toBe('unchanged_measurement');expect(deps.compact).not.toHaveBeenCalled();
});
test('startup recovery is harmless before maintenance tables exist',()=>{
  expect(()=>recoverSessionCompaction(store)).not.toThrow();
  expect(store.get("SELECT name FROM sqlite_master WHERE name='session_compaction_runs'")).toBeUndefined();
});
test('runtime startup recovers crashed audit state before any nightly manager is created',async()=>{
  seed();maintenance();
  store.run("INSERT INTO session_compaction_runs VALUES('crashed',1,NULL,'running',?)",JSON.stringify(cfg));
  store.run("INSERT INTO session_compaction_items VALUES('crashed','s',?)",JSON.stringify({sessionId:'s',status:'running'}));
  store.run("INSERT INTO session_compaction_items VALUES('crashed','done',?)",JSON.stringify({sessionId:'done',status:'completed',endedAt:2}));
  store.run("INSERT INTO session_compaction_marks VALUES('s','measure-s',1)");
  store.close();
  const agent:AgentConfig={id:'a',workspace:join(root,'a/workspace'),description:'fixture',env:'',claude:{model:'fixture',extraFlags:[]}};
  const gateway={gateway:{orchestration:false,headless:true,logDir:join(root,'logs')},agents:[agent]} as GatewayConfig;
  const history=HistoryDB.forAgent(root,'a');
  let runtime:AgentOrchestrationRuntime|undefined;
  try {
    runtime=await AgentOrchestrationRuntime.open(agent,gateway,root,new SessionStore(root),history,{
      createAgentSession:async()=>{throw new Error('Startup must not compact');},releaseAgentSession:async()=>{},
    });
    expect((runtime as any).sessionCompaction).toBeUndefined();
    expect(runtime.store.get("SELECT status,ended_at FROM session_compaction_runs WHERE id='crashed'")).toMatchObject({status:'interrupted',ended_at:expect.any(Number)});
    expect(JSON.parse(String(runtime.store.get("SELECT payload_json FROM session_compaction_items WHERE session_id='s'")!.payload_json))).toMatchObject({status:'failed',errorCode:'INTERRUPTED'});
    expect(JSON.parse(String(runtime.store.get("SELECT payload_json FROM session_compaction_items WHERE session_id='done'")!.payload_json))).toMatchObject({status:'completed',endedAt:2});
    expect(runtime.store.get("SELECT measurement_id FROM session_compaction_marks WHERE session_id='s'")!.measurement_id).toBe('measure-s');
  } finally {
    await runtime?.close();(history as any).db.close();HistoryDB.evict(root,'a');
    store=new OrchestrationStore(join(root,'orchestration.db'),'a');
  }
});
