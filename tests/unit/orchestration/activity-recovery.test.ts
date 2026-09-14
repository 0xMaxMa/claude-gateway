import { EventEmitter } from 'events';
import { AgentRunner } from '../../../src/agent/runner';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import { SessionProcess } from '../../../src/session/process';

test.each([true, false])('late legacy recovery cannot replay a managed turn (global enabled=%s)', async enabled => {
  const runner = Object.create(AgentRunner.prototype) as any;
  const interrupt = jest.fn();
  runner.agentConfig = { orchestration: { enabled, channels: ['telegram'] } };
  runner.sessions = new Map([['123', { runtimeProfile: enabled ? undefined : { role: 'agent' }, interrupt }]]);
  const response = { writeHead: jest.fn(), end: jest.fn() };
  await runner.handleRecoverRequest(JSON.stringify({ chatId: '123', stage: 'inject' }), response);
  expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({ ok: false, error: expect.stringContaining('owned by orchestration') });
  expect(interrupt).not.toHaveBeenCalled();
});
test('real managed inference silence still times out and stops the process', async () => {
  jest.useFakeTimers();
  const process = new EventEmitter() as SessionProcess;
  process.start = async () => {}; process.sendMessage = jest.fn(); process.interrupt = jest.fn(); process.stop = jest.fn(async () => {});
  try {
    const turn = startProcessTurn(process, 'work', 1000);
    const failed = expect(turn.result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await jest.advanceTimersByTimeAsync(1000);
    await failed;
    expect(process.interrupt).toHaveBeenCalledTimes(1);
    expect(process.stop).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

test('voice turns consume structured_output instead of the CLI result prose',async()=>{
 const proc=Object.assign(new EventEmitter(),{runtimeProfile:{role:'agent',responseSchema:{}},start:async()=>{},sendMessage:jest.fn(),stop:jest.fn(async()=>{}),interrupt:jest.fn()}) as unknown as SessionProcess;
 const turn=startProcessTurn(proc,'hello',1000);
 await Promise.resolve();
 proc.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['StructuredOutput']}));
 const fields={display_text:'こんにちは',spoken_text:'こんにちは'};
 proc.emit('output',JSON.stringify({type:'result',result:'plain final note',structured_output:fields}));
 expect(JSON.parse((await turn.result).text)).toEqual(fields);expect(proc.stop).not.toHaveBeenCalled();
});

function timeoutFixture(total=2000) {
 const proc=Object.assign(new EventEmitter(),{start:async()=>{},sendMessage:jest.fn(),stop:jest.fn(async()=>{}),interrupt:jest.fn()}) as unknown as SessionProcess;
 const turn=startProcessTurn(proc,'work',total,undefined,undefined,[],{startupTimeoutMs:300,firstResponseTimeoutMs:300,idleTimeoutMs:100});
 const emit=(event:unknown)=>proc.emit('output',JSON.stringify(event));
 return {proc,turn,emit};
}
test('cold startup and first-token wait do not consume the progress silence budget',async()=>{
 jest.useFakeTimers();
 try {
  const {proc,turn,emit}=timeoutFixture();
  await jest.advanceTimersByTimeAsync(250);expect(proc.stop).not.toHaveBeenCalled();
  emit({type:'system',subtype:'init'});
  await jest.advanceTimersByTimeAsync(250);expect(proc.stop).not.toHaveBeenCalled();
  for(let i=0;i<5;i++){
   emit({type:'stream_event',event:{delta:{type:'thinking_delta',thinking:'working'}}});
   await jest.advanceTimersByTimeAsync(90);
  }
  emit({type:'result',result:'done'});
  await expect(turn.result).resolves.toMatchObject({text:'done'});
  await jest.advanceTimersByTimeAsync(3000);expect(proc.stop).not.toHaveBeenCalled();
 }finally{jest.useRealTimers();}
});
test.each(['startup','first_response','idle'] as const)('real %s stall has diagnostic timing and stops once',async phase=>{
 jest.useFakeTimers();
 try{
  const {proc,turn,emit}=timeoutFixture();
  const failed=expect(turn.result).rejects.toMatchObject({code:'TIMEOUT',timeout:{phase,elapsedMs:expect.any(Number),idleMs:expect.any(Number)}});
  if(phase!=='startup')emit({type:'system',subtype:'init'});
  if(phase==='idle')emit({type:'stream_event',event:{delta:{type:'text_delta',text:'progress'}}});
  for(let i=0;i<4;i++){emit({type:'system',subtype:'status',status:'still alive'});await jest.advanceTimersByTimeAsync(100);}
  await failed;expect(proc.stop).toHaveBeenCalledTimes(1);expect(proc.listenerCount('output')).toBe(0);
 }finally{jest.useRealTimers();}
});
test('continuous progress cannot extend the caller hard deadline',async()=>{
 jest.useFakeTimers();
 try{
  const {proc,turn,emit}=timeoutFixture(350);
  const failed=expect(turn.result).rejects.toMatchObject({code:'TIMEOUT',timeout:{phase:'total',elapsedMs:350}});
  for(let i=0;i<4;i++){emit({type:'stream_event',event:{delta:{type:'text_delta',text:'progress'}}});await jest.advanceTimersByTimeAsync(90);}
  await failed;expect(proc.stop).toHaveBeenCalledTimes(1);
 }finally{jest.useRealTimers();}
});

test('message headers neither start the short idle timer nor keep a silent model alive',async()=>{
 jest.useFakeTimers();
 try {
  const {proc,turn,emit}=timeoutFixture();
  emit({type:'system',subtype:'init'});
  emit({type:'stream_event',event:{type:'message_start',message:{usage:{input_tokens:100}}}});
  await jest.advanceTimersByTimeAsync(200);
  expect(proc.stop).not.toHaveBeenCalled();
  emit({type:'stream_event',event:{delta:{type:'thinking_delta',thinking:'checking'}}});
  await jest.advanceTimersByTimeAsync(90);
  emit({type:'result',result:'done'});
  await expect(turn.result).resolves.toMatchObject({text:'done'});
  const silent=timeoutFixture();
  const failed=expect(silent.turn.result).rejects.toMatchObject({code:'TIMEOUT',timeout:{phase:'first_response'}});
  silent.emit({type:'system',subtype:'init'});
  for(let i=0;i<3;i++){
   silent.emit({type:'stream_event',event:{type:'message_start'}});
   await jest.advanceTimersByTimeAsync(100);
  }
  await failed;expect(silent.proc.stop).toHaveBeenCalledTimes(1);
 }finally{jest.useRealTimers();}
});

test('legacy 15-second template does not kill inference; explicit idle budgets remain configurable',async()=>{
 const {resolveOrchestrationConfig}=await import('../../../src/orchestration/config');
 const legacy=resolveOrchestrationConfig({conversation:{decisionTimeoutMs:15000}}).conversation;
 expect(legacy.idleTimeoutMs).toBe(120000);
 expect(resolveOrchestrationConfig({conversation:{decisionTimeoutMs:15000,idleTimeoutMs:15000}}).conversation.idleTimeoutMs).toBe(15000);
 expect(resolveOrchestrationConfig({conversation:{decisionTimeoutMs:45000}}).conversation.idleTimeoutMs).toBe(45000);
 jest.useFakeTimers();
 try{
  const proc=Object.assign(new EventEmitter(),{start:async()=>{},sendMessage:jest.fn(),stop:jest.fn(async()=>{}),interrupt:jest.fn()}) as unknown as SessionProcess;
  const turn=startProcessTurn(proc,'check',120000,undefined,undefined,[],legacy);
  await jest.advanceTimersByTimeAsync(6000);
  proc.emit('output',JSON.stringify({type:'stream_event',event:{delta:{type:'thinking_delta',thinking:'checking'}}}));
  await jest.advanceTimersByTimeAsync(30000);
  expect(proc.stop).not.toHaveBeenCalled();
  proc.emit('output',JSON.stringify({type:'result',result:'checked'}));
  await expect(turn.result).resolves.toMatchObject({text:'checked'});
 }finally{jest.useRealTimers();}
});

test('worker tool activity can continue beyond forty minutes without a fixed deadline',async()=>{
 jest.useFakeTimers();
 try{
  const proc=Object.assign(new EventEmitter(),{start:async()=>{},sendMessage:jest.fn(),stop:jest.fn(async()=>{}),interrupt:jest.fn()}) as unknown as SessionProcess;
  const turn=startProcessTurn(proc,'long work',undefined,undefined,undefined,[],{startupTimeoutMs:120000,firstResponseTimeoutMs:120000,idleTimeoutMs:300000,acceptToolProgress:true});
  await jest.advanceTimersByTimeAsync(1);
  proc.emit('output',JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'bash-long',name:'Bash',input:{}}]}}));
  for(let minute=1;minute<=45;minute++){
   await jest.advanceTimersByTimeAsync(60000);
   proc.emit('output',JSON.stringify({type:'tool_progress',tool_use_id:'bash-long',elapsed_time_seconds:minute*60}));
  }
  expect(proc.stop).not.toHaveBeenCalled();
  proc.emit('output',JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'bash-long',content:'tests passed'}]}}));
  proc.emit('output',JSON.stringify({type:'result',result:'Finished after 45 minutes'}));
  await expect(turn.result).resolves.toMatchObject({text:'Finished after 45 minutes'});
 }finally{jest.useRealTimers();}
});
test.each(['duplicate','unrelated','completed'] as const)('worker ignores %s tool heartbeats when checking for a stall',async kind=>{
 jest.useFakeTimers();
 try{
  const proc=Object.assign(new EventEmitter(),{start:async()=>{},sendMessage:jest.fn(),stop:jest.fn(async()=>{}),interrupt:jest.fn()}) as unknown as SessionProcess;
  const turn=startProcessTurn(proc,'work',undefined,undefined,undefined,[],{startupTimeoutMs:300,firstResponseTimeoutMs:300,idleTimeoutMs:100,acceptToolProgress:true});
  const emit=(event:unknown)=>proc.emit('output',JSON.stringify(event));
  emit({type:'assistant',message:{content:[{type:'tool_use',id:'t',name:'Bash',input:{}}]}});
  emit({type:'tool_progress',tool_use_id:'t',elapsed_time_seconds:1});
  if(kind==='completed')emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t',content:'done'}]}});
  const failed=expect(turn.result).rejects.toMatchObject({code:'TIMEOUT',timeout:{phase:'idle'}});
  for(let i=0;i<3;i++){
   await jest.advanceTimersByTimeAsync(40);
   emit({type:'tool_progress',tool_use_id:kind==='unrelated'?'other':'t',elapsed_time_seconds:kind==='duplicate'?1:i+2});
  }
  await failed;expect(proc.stop).toHaveBeenCalledTimes(1);
 }finally{jest.useRealTimers();}
});
