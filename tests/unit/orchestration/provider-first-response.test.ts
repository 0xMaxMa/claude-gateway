import { EventEmitter } from 'events';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import type { SessionProcess } from '../../../src/session/process';
import { providerFailure } from '../../../src/orchestration/provider-admission';

test('native provider retries cannot extend the first-response deadline or establish recovery',async()=>{
  jest.useFakeTimers();
  const process=Object.assign(new EventEmitter(),{start:async()=>{},sendMessage:()=>{},interrupt:()=>{},stop:async()=>{}}) as unknown as SessionProcess;
  try {
    const turn=startProcessTurn(process,'request',10000,undefined,undefined,[],{startupTimeoutMs:1000,firstResponseTimeoutMs:1000,idleTimeoutMs:1000});
    const ready=jest.fn(); void turn.providerReady.then(ready).catch(()=>{});
    const failure=turn.result.catch(error=>error);
    process.emit('output',JSON.stringify({type:'system',subtype:'init'}));
    for(let i=0;i<4;i++) {
      await jest.advanceTimersByTimeAsync(200);
      process.emit('output',JSON.stringify({type:'assistant',isApiErrorMessage:true,error:{type:'rate_limit_error',status:429,retryAfterMs:5000},message:{content:[{type:'text',text:'Rate limited'}]}}));
    }
    await jest.advanceTimersByTimeAsync(200);
    const error=await failure;
    expect(error).toMatchObject({code:'TIMEOUT',timeout:{phase:'first_response'},status:429,retryAfterMs:5000});
    expect(providerFailure(error)?.reason).toBe('rate_limit');
    expect(ready).not.toHaveBeenCalled();
  } finally {jest.useRealTimers();}
});

test('a real model response releases recovery independently of a long running tool',async()=>{
  const process=Object.assign(new EventEmitter(),{start:async()=>{},sendMessage:()=>{},interrupt:()=>{},stop:async()=>{}}) as unknown as SessionProcess;
  const turn=startProcessTurn(process,'request',10000);
  process.emit('output',JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'tool',name:'Read',input:{}}]}}));
  await expect(turn.providerReady).resolves.toBeUndefined();
  let completed=false;void turn.result.then(()=>{completed=true;});
  await Promise.resolve();expect(completed).toBe(false);
  process.emit('output',JSON.stringify({type:'result',result:'Done'}));
  await turn.result;
});

test('a stream-json API-error record is a provider error even without an error kind',async()=>{
  const process=Object.assign(new EventEmitter(),{start:async()=>{},sendMessage:()=>{},interrupt:()=>{},stop:async()=>{}}) as unknown as SessionProcess;
  const turn=startProcessTurn(process,'request',10000);
  const ready=jest.fn(); void turn.providerReady.then(ready).catch(()=>{});
  // Claude Code stream-json marks the synthetic record with is_api_error_message (snake_case).
  process.emit('output',JSON.stringify({type:'assistant',parent_tool_use_id:null,session_id:'s',uuid:'u',is_api_error_message:true,message:{id:'4a7060a3-76f2-414b-b0b2-33a1144988ce',model:'<synthetic>',role:'assistant',type:'message',stop_reason:'stop_sequence',content:[{type:'text',text:'API Error: request blocked'}]}}));
  process.emit('output',JSON.stringify({type:'result',subtype:'success',is_error:true,result:'API Error: request blocked'}));
  await expect(turn.result).rejects.toMatchObject({code:'INFERENCE_FAILED',providerOrigin:true,providerMessage:'API Error: request blocked'});
  expect(ready).not.toHaveBeenCalled();
});
