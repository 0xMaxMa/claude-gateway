import {AgentRunner} from '../../src/agent/runner';
import {AgentOrchestrationRuntime} from '../../src/orchestration/runtime';
import {OrchestrationStore} from '../../src/orchestration/store';
import {DecisionService} from '../../src/orchestration/decisions';
import {recordTokenTurn,tokenReport} from '../../src/orchestration/token-ledger';

test('session command uses the dashboard measurement and observed model, then expires after one hour',async()=>{
 const store=new OrchestrationStore(':memory:','agent');
 const now=Date.now();jest.spyOn(Date,'now').mockReturnValue(now);
 try{
  const input=store.acceptInput({scope:{agentId:'agent',agentSessionId:'session',source:'api',accountId:'a',chatId:'c',threadKey:'',principalId:'p'},text:'Hello'});
  const decisions=new DecisionService(store),decision=decisions.begin(input.conversationId,'p',[input.inputId]);
  decisions.finish(decision,'Hello');
  const usage=(n:number)=>({inputTokens:n,cacheCreationTokens:0,cacheReadTokens:0,outputTokens:1000,totalTokens:n+1000});
  recordTokenTurn(store,{id:decision.decisionId,sessionId:'session',role:'agent',category:'input',toolIds:[],inputTokens:0,totalTokens:0,startedAt:now,model:'observed-model',requests:[{id:'old',usage:usage(990000)},{id:'latest',usage:usage(179000)}]});
  const runtime=Object.assign(Object.create(AgentOrchestrationRuntime.prototype),{store});
  const runner=Object.assign(Object.create(AgentRunner.prototype),{orchestration:runtime,dashboardContextWindow:jest.fn(async()=>200000),agentConfig:{claude:{model:'different-selected-model'}}});
  expect(await runner.sessionContextInfo('session')).toMatchObject({text:'180K / 200K · 90%',contextUsedPct:90,contextTokens:tokenReport(store,'session').contextWindow!.used});
  expect(runner.dashboardContextWindow).toHaveBeenCalledWith('observed-model');
  jest.mocked(Date.now).mockReturnValue(now+3600000);
  expect((await runner.sessionContextInfo('session')).contextTokens).toBe(180000);
  jest.mocked(Date.now).mockReturnValue(now+3600001);
  expect(await runner.sessionContextInfo('session')).toMatchObject({text:'—',contextUsedPct:null,contextTokens:null});
 }finally{store.close();jest.restoreAllMocks();}
});

test('missing measurements and unknown model capacity never become zero percent',async()=>{
 const runner=Object.assign(Object.create(AgentRunner.prototype),{orchestration:{sessionContextWindow:()=>null},dashboardContextWindow:async()=>null});
 expect(await runner.sessionContextInfo('session')).toMatchObject({text:'—',contextUsedPct:null});
 runner.orchestration.sessionContextWindow=()=>({used:1200,model:'unknown'});
 expect(await runner.sessionContextInfo('session')).toMatchObject({text:'1.2K / —',contextUsedPct:null});
});

test('channel session status omits legacy message counts and only suggests compact for measured usage',async()=>{
 const send=jest.fn();
 const runner=Object.assign(Object.create(AgentRunner.prototype),{
  sessionStore:{listSessions:async()=>({activeSessionId:'s',sessions:[{id:'s',name:'Session 1',messageCount:2596,archivedCount:1159,lastInputTokens:999999}]})},
  channelFor:()=> 'telegram',writeAutoForward:send,agentConfig:{claude:{model:'selected-model'}},
  sessionContextInfo:async()=>({text:'180K / 200K · 90%',contextUsedPct:90}),
 });
 await runner.handleCommandSessionInfo('a','c');
 expect(send.mock.calls[0][1]).toContain('180K / 200K · 90%');
 expect(send.mock.calls[0][1]).toContain('Model: selected-model');
 expect(send.mock.calls[0][1]).toContain('consider /compact');
 expect(send.mock.calls[0][1]).not.toMatch(/Messages:|archived|2596/);
 runner.sessionContextInfo=async()=>({text:'—',contextUsedPct:null});
 await runner.handleCommandSessionInfo('a','c');
 expect(send.mock.calls[1][1]).not.toContain('Near limit');
});

test('legacy session status retains measured usage while absent and stale values stay unknown', async () => {
 const send = jest.fn();
 const meta = {id:'legacy',name:'Legacy',lastActive:Date.now(),lastInputTokens:180000,model:'measured-model'};
 const runner = Object.assign(Object.create(AgentRunner.prototype), {
  sessionStore:{listSessions:async()=>({activeSessionId:'legacy',sessions:[meta]})},
  agentConfig:{claude:{model:'default-model'}},channelFor:()=> 'telegram',writeAutoForward:send,
  dashboardContextWindow:jest.fn(async()=>200000),
 });
 await runner.handleCommandSessionInfo('a','c');
 expect(send.mock.calls[0][1]).toContain('180K / 200K · 90%');
 expect(runner.dashboardContextWindow).toHaveBeenCalledWith('measured-model');
 expect((await runner.sessionContextInfo('legacy',{...meta,lastActive:Date.now()-3600001})).contextTokens).toBeNull();
 expect((await runner.sessionContextInfo('legacy',{...meta,lastInputTokens:undefined})).contextTokens).toBeNull();
 // An expired orchestration measurement must not fall back to old legacy metadata.
 runner.orchestration={sessionContextWindow:()=>null,ownsSession:()=>true};
 expect((await runner.sessionContextInfo('legacy',meta)).contextTokens).toBeNull();
 runner.orchestration.ownsSession=()=>false;
 expect((await runner.sessionContextInfo('legacy',meta)).contextTokens).toBe(180000);
});


test('session displays the selected next-turn model without replacing the observed context model', async () => {
 const send = jest.fn();
 const runner = Object.assign(Object.create(AgentRunner.prototype), {
  agentConfig:{id:'a',claude:{model:'old-selected-model'}},persistModelToConfig:jest.fn(async()=>{}),
  sessionStore:{listSessions:async()=>({activeSessionId:'s',sessions:[{id:'s',name:'Session',model:'old-observed-model'}]})},
  channelFor:()=> 'telegram',writeAutoForward:send,
  sessionContextInfo:async()=>({text:'180K / 200K · 90%',contextModel:'old-observed-model',contextTokens:180000,contextWindow:200000,contextUsedPct:90}),
 });
 await runner.setModel('claude-sonnet-5[1m]');
 await runner.handleCommandSessionInfo('a','c');
 expect(send.mock.calls[0][1]).toContain('Model: claude-sonnet-5[1m]');
 expect(send.mock.calls[0][1]).toContain('180K / 200K · 90%');
 expect(await runner.getApiSessionInfo('c','s')).toMatchObject({model:'claude-sonnet-5[1m]',contextModel:'old-observed-model'});
});
