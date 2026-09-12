import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { DecisionService } from '../../../src/orchestration/decisions';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-life-')), dir = join(root,'a'), workspace = join(dir,'workspace');
  mkdirSync(workspace,{recursive:true}); writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
  const agent = {id:'a',workspace,description:'',env:'',claude:{model:'fixture',extraFlags:[]},orchestration:{enabled:true}} as AgentConfig;
  const gateway = {gateway:{ orchestration: true,headless:true},agents:[agent]} as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root,'a');
  const open = () => AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{
    createAgentSession:async()=>Object.assign(new EventEmitter(),{start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){this.emit('output',JSON.stringify({type:'result',result:'Hello'}));}}) as unknown as SessionProcess,
    releaseAgentSession:async()=>{},
  },{start:async()=>{let done!: (v:any)=>void;return {accepted:Promise.resolve(),result:new Promise(resolve=>{done=resolve;}),stop:async()=>done({type:'stopped'})};}});
  const scope = (id:string) => ({agentId:'a',agentSessionId:id,source:'api' as const,accountId:'owner',chatId:id,threadKey:'',principalId:'owner'});
  const dispose = () => {(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});};
  return {open,scope,dispose};
}

test('dashboard ignores historical conversations, admits a used old session before the row limit, and resets on restart without deleting history', async () => {
  const f=await fixture();let runtime=await f.open();
  try {
    const decisions = new DecisionService(runtime.store);
    for(let i=0;i<60;i++) {
      const input=runtime.store.acceptInput({scope:f.scope('old-'+i),text:'History'});
      decisions.finish(decisions.begin(input.conversationId,'owner',[input.inputId]),'Old answer');
    }
    expect(runtime.dashboardSummary().sessions).toEqual([]);
    await runtime.send({scope:f.scope('old-0'),text:'Back again'},{execute:false,writeMemory:false},{timeoutMs:1000});
    expect(runtime.dashboardSummary().sessions.map(s=>s.sessionId)).toEqual(['old-0']);
    await runtime.close();runtime=await f.open();
    expect(runtime.dashboardSummary().sessions).toEqual([]);
    expect(runtime.store.get('SELECT COUNT(*) n FROM conversations')!.n).toBe(60);
    await runtime.send({scope:f.scope('new'),text:'Hello'},{execute:false,writeMemory:false},{timeoutMs:1000});
    expect(runtime.dashboardSummary().sessions.map(s=>s.sessionId)).toEqual(['new']);
  } finally {await runtime.close();f.dispose();}
});

test('a recovered queued worker makes its parent visible in the current runtime', async () => {
  const f=await fixture();let runtime=await f.open();
  try {
    const input=runtime.store.acceptInput({scope:f.scope('recovered'),text:'Work'});
    const decisions=new DecisionService(runtime.store),decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
    runtime.tasks.spawn({...input,...decision,principalId:'owner',actionId:'spawn',execute:true,writeMemory:false},{title:'Recovery',instructions:'Fixture work',targetProfile:'default-worker'});
    decisions.finish(decision,'Queued');
    await runtime.close();runtime=await f.open();
    expect(runtime.dashboardSummary().sessions.map(s=>s.sessionId)).toEqual(['recovered']);
  } finally {await runtime.close();f.dispose();}
});
