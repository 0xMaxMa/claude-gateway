import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TurnUsageCollector } from '../../../src/orchestration/token-usage';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { recordTokenTurn, tokenReport, summarizeTokenTurns, measuredTurns } from '../../../src/orchestration/token-ledger';
import { EventEmitter } from 'events';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import type { SessionProcess } from '../../../src/session/process';
import { toolActivity } from '../../../src/orchestration/tool-activity';

test('stream starts, cumulative deltas and repeated assistant blocks count each request once', () => {
  const c = new TurnUsageCollector();
  const usage = {input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 20,
    cache_creation: {ephemeral_1h_input_tokens: 100}};
  c.observe({type:'stream_event',event:{type:'message_start',message:{id:'m1',model:'test-model',usage:{...usage,output_tokens:1}}}});
  c.observe({type:'stream_event',event:{type:'message_delta',usage:{output_tokens:20}}});
  const message = {type:'assistant',message:{id:'m1',usage,content:[{type:'tool_use',id:'t1',name:'Read'}]}};
  c.observe(message); c.observe(message);
  c.observe({type:'assistant',message:{id:'m2',usage:{input_tokens:5,output_tokens:3}}});
  c.observe({type:'result',usage:{input_tokens:15,cache_creation_input_tokens:100,cache_read_input_tokens:500,output_tokens:23}});
  expect(c.snapshot()).toMatchObject({usage:{inputTokens:15,cacheCreationTokens:100,cacheReadTokens:500,outputTokens:23,totalTokens:638,cacheCreation1hTokens:100},usedTools:['Read'],loadedTools:null});
  expect(c.snapshot().requests).toHaveLength(2);
});

test('missing usage remains unavailable and aggregate-only usage does not invent requests', () => {
  const c = new TurnUsageCollector();
  c.observe({type:'system',subtype:'init',tools:['Bash','Read','Bash'],model:'fixture'});
  expect(c.snapshot()).toMatchObject({usage:null,requests:[],loadedTools:['Bash','Read']});
  c.observe({type:'result',usage:{input_tokens:9,cache_read_input_tokens:20,output_tokens:2}});
  expect(c.snapshot()).toMatchObject({usage:{totalTokens:31},requests:[]});
});

test('invalid usage cannot poison totals; output thinking is not added again', () => {
  const c = new TurnUsageCollector();
  c.observe({type:'assistant',message:{id:'m1',usage:{input_tokens:-1,output_tokens:8,thinking_tokens:7,cache_read_input_tokens:'30'}}});
  expect(c.snapshot().usage?.totalTokens).toBe(8);
});

test('ledger is session scoped, idempotent, and includes each worker attempt once', () => {
  const store = new OrchestrationStore(':memory:','agent');
  try {
    const collector = new TurnUsageCollector();
    collector.observe({type:'result',usage:{input_tokens:10,output_tokens:5}});
    const base = {toolIds:[],inputTokens:10,totalTokens:15,startedAt:1,...collector.snapshot()};
    const agent = {...base,id:'decision-a',sessionId:'session-a',role:'agent' as const,category:'input' as const};
    recordTokenTurn(store,agent);recordTokenTurn(store,agent);
    recordTokenTurn(store,{...base,id:'attempt-a',sessionId:'session-a',role:'worker',category:'worker',taskId:'task-a'});
    recordTokenTurn(store,{...base,id:'attempt-b',sessionId:'session-a',role:'worker',category:'worker',taskId:'task-a'});
    recordTokenTurn(store,{...base,id:'other',sessionId:'session-b',role:'worker',category:'worker'});
    expect(tokenReport(store,'session-a').totals).toEqual({agentTokens:15,workerTokens:30,totalTokens:45});
    expect(tokenReport(store,'session-a').turns).toHaveLength(3);
    const read = jest.spyOn(store, 'all');
    expect(measuredTurns(store,'session-a')).toHaveLength(3);
    const calls = read.mock.calls.length;
    expect(measuredTurns(store,'session-a')).toHaveLength(3);
    expect(read.mock.calls).toHaveLength(calls);
    recordTokenTurn(store,{...agent,usage:{...agent.usage!,outputTokens:10,totalTokens:20}});
    expect(summarizeTokenTurns(measuredTurns(store,'session-a')).totalTokens).toBe(50);
    expect(summarizeTokenTurns([])).toMatchObject({totalTokens:null,loadedTools:null});
  } finally {store.close();}
});

test('managed metrics add requests and caches once and persist progress before a result', async () => {
  const p = new EventEmitter() as SessionProcess;
  const metrics = jest.fn(), progress = jest.fn();
  Object.assign(p,{start:async()=>{},stop:async()=>{},sendMessage:()=>{
    for (const id of ['a','b']) {
      const event = {type:'assistant',message:{id,usage:{input_tokens:10,cache_creation_input_tokens:100,cache_read_input_tokens:500,output_tokens:20},content:[]}};
      p.emit('output',JSON.stringify(event));p.emit('output',JSON.stringify(event));
    }
    expect(progress).toHaveBeenCalled();
    p.emit('output',JSON.stringify({type:'result',result:'done',usage:{input_tokens:20,cache_creation_input_tokens:200,cache_read_input_tokens:1000,output_tokens:40}}));
  }});
  await startProcessTurn(p,'request',1000,undefined,metrics,[],{startupTimeoutMs:1000,firstResponseTimeoutMs:1000,idleTimeoutMs:1000,onUsage:progress}).result;
  expect(metrics).toHaveBeenCalledTimes(1);
  expect(metrics.mock.calls[0][0]).toMatchObject({inputTokens:1220,totalTokens:1260,usage:{outputTokens:40},requests:[{id:'a'},{id:'b'}]});
});

test('deferred calls report the underlying tool and preserve input secret filtering', () => {
  const publish = jest.fn(), activity = toolActivity(publish), collector = new TurnUsageCollector();
  collector.observe({type:'stream_event',event:{type:'content_block_start',content_block:{type:'tool_use',name:'mcp__gateway__tool_call',input:{}}}});
  const event = {type:'assistant',message:{content:[{type:'tool_use',id:'x',name:'mcp__gateway__tool_call',input:{name:'browser_navigate',arguments:{url:'https://example.test',api_key:'private'}}}]}};
  activity(JSON.stringify(event));collector.observe(event);
  activity(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'x',is_error:false}]}}));
  expect(publish.mock.calls[0][0]).toMatchObject({name:'mcp__gateway__browser_navigate',input:{url:'https://example.test'}});
  expect(publish.mock.calls[0][0].input).not.toHaveProperty('api_key');
  expect(publish.mock.calls[1][0].name).toBe('mcp__gateway__browser_navigate');
  expect(collector.snapshot().usedTools).toEqual(['mcp__gateway__browser_navigate']);
});


test('worker report preserves initial assignment and applied answer/guidance after a mid-attempt revision', () => {
  const store = new OrchestrationStore(':memory:', 'agent');
  try {
    const tasks = new TaskService(store, { tasks: { workspaceMode: 'host' } }, '/project');
    const input = store.acceptInput({scope: {agentId:'agent',agentSessionId:'session',source:'api',accountId:'owner',principalId:'owner',chatId:'chat',threadKey:''},text:'Investigate and wait for my decision'});
    const decision = new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]);
    const task = tasks.spawn({...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'}, {title:'Investigation',instructions:'Original brief',targetProfile:'default-worker'});
    const attempt = tasks.claim(task.taskId)!;
    const initial = tasks.revision(task.taskId, attempt.revision);
    const initialRevision = attempt.revision;
    const updated = {...initial,revision:initialRevision+1,instructions:'Updated brief',answers:[{questionId:'question',text:'Proceed with option B',inputId:input.inputId}],guidance:'Verify the selected option first'};
    store.run('INSERT INTO task_revisions VALUES(?,?,?)',task.taskId,updated.revision,JSON.stringify(updated));
    attempt.revision=updated.revision;store.transaction(() => store.saveAttempt(attempt));
    recordTokenTurn(store,{id:attempt.attemptId,sessionId:'session',role:'worker',category:'worker',taskId:task.taskId,taskRevision:initialRevision,toolIds:[],inputTokens:0,totalTokens:0,startedAt:1});
    const texts = tokenReport(store,'session').turns[0].inputTexts!.join('\n');
    expect(texts).toContain('Assignment at attempt start');
    expect(texts).toContain('Original brief');expect(texts).toContain('Updated brief');
    expect(texts).toContain('Proceed with option B');expect(texts).toContain('Verify the selected option first');
    expect(texts).toContain('orchestrator interpretation');
    expect(tokenReport(store,'another-session').turns).toHaveLength(0);
  } finally {store.close();}
});


test('report JSON distinguishes missing role usage from measured zero', () => {
  const store = new OrchestrationStore(':memory:', 'agent');
  try {
    expect(tokenReport(store, 'session').totals).toEqual({agentTokens:null,workerTokens:null,totalTokens:null});
    const base = {sessionId:'session',toolIds:[],inputTokens:0,totalTokens:0,startedAt:1};
    recordTokenTurn(store, {...base,id:'a',role:'agent',category:'input',usage:null});
    const collector = new TurnUsageCollector();
    collector.observe({type:'result',usage:{input_tokens:0,output_tokens:0}});
    recordTokenTurn(store, {...base,id:'w',role:'worker',category:'worker',...collector.snapshot()});
    expect(tokenReport(store, 'session').totals).toEqual({agentTokens:null,workerTokens:0,totalTokens:0});
    recordTokenTurn(store, {...base,id:'a',role:'agent',category:'input',...collector.snapshot()});
    expect(tokenReport(store, 'session').totals).toEqual({agentTokens:0,workerTokens:0,totalTokens:0});
  } finally { store.close(); }
});

test('failed turn details expose the recorded diagnostic without leaking unrelated session errors',()=>{
 const store=new OrchestrationStore(':memory:','agent');
 try{
  const input=store.acceptInput({scope:{agentId:'agent',agentSessionId:'session',source:'api',accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'},text:'work'});
  const decisions=new DecisionService(store),decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
  store.transaction(()=>store.appendEvent(input.conversationId,'response.error',{responseId:decision.responseId,code:'INFERENCE_FAILED'}));
  decisions.finish(decision,'','failed');
  recordTokenTurn(store,{id:decision.decisionId,sessionId:'session',role:'agent',category:'report',startedAt:1,toolIds:[],inputTokens:0,totalTokens:0});
  expect(tokenReport(store,'session').turns[0]).toMatchObject({state:'failed',failureCode:'INFERENCE_FAILED'});
  expect(tokenReport(store,'other').turns).toEqual([]);
 }finally{store.close();}
});

test('lazy connector calls count the underlying tool without a phantom partial wrapper',()=>{
 const collector=new TurnUsageCollector();
 collector.observe({type:'stream_event',event:{content_block:{type:'tool_use',name:'mcp__browser__tool_call',input:{}}}});
 collector.observe({type:'assistant',message:{content:[{type:'tool_use',name:'mcp__browser__tool_call',input:{name:'page_observe',arguments:{tabId:42}}}]}});
 expect(collector.snapshot().usedTools).toEqual(['mcp__browser__page_observe']);
});
