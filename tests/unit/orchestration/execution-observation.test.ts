import { toolActivity } from '../../../src/orchestration/tool-activity';
import { EventEmitter, once } from 'events';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import { SessionProcess } from '../../../src/session/process';
import { ProcessActivitySampler } from '../../../src/orchestration/process-activity';
import { stopProcessGroup } from '../../../src/orchestration/process-supervisor';
import { toolOutcome, TurnObservation } from '../../../src/orchestration/execution-observation';

function fixture(observe = jest.fn(), total?: number) {
 const proc = Object.assign(new EventEmitter(), {start: async()=>{},sendMessage:jest.fn(),interrupt:jest.fn(),stop:jest.fn(async()=>{proc.emit('exit');})}) as unknown as SessionProcess;
 const turn = startProcessTurn(proc,'work',total,undefined,undefined,[],{startupTimeoutMs:1000,firstResponseTimeoutMs:1000,idleTimeoutMs:100,acceptToolProgress:true,idleAction:'observe',onObservation:observe});
 const emit=(event:unknown)=>proc.emit('output',JSON.stringify(event));
 emit({type:'assistant',message:{content:[{type:'tool_use',id:'b',name:'Bash',input:{}}]}});
 return {proc,turn,emit};
}
test('silent tool survives hours without heartbeats, reports quiet state, and remains cancellable',async()=>{
 jest.useFakeTimers();
 try {
  const observer=jest.fn(), {proc,turn}=fixture(observer);
  await jest.advanceTimersByTimeAsync(2*60*60*1000);
  expect(proc.stop).not.toHaveBeenCalled();
  expect(observer).toHaveBeenLastCalledWith(expect.objectContaining({quiet:true,activeTools:['Bash']}));
  const count=observer.mock.calls.length;
  await turn.stop();await expect(turn.result).resolves.toMatchObject({interrupted:true});
  await jest.advanceTimersByTimeAsync(60000);expect(observer).toHaveBeenCalledTimes(count);
  expect(proc.stop).toHaveBeenCalledTimes(1);
 } finally {jest.useRealTimers();}
});
test('tool completion clears wait state; quiet model wait is observed, not killed; explicit total limit still applies',async()=>{
 jest.useFakeTimers();
 try {
  const observer=jest.fn(), {proc,turn,emit}=fixture(observer,40000);
  emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'b',content:'Tests: 12 passed, 1 failed, 13 total'}]}});
  await jest.advanceTimersByTimeAsync(20000);
  expect(proc.stop).not.toHaveBeenCalled();
  expect(observer).toHaveBeenLastCalledWith(expect.objectContaining({activeTools:[],lastTool:expect.objectContaining({name:'Bash',status:'returned'})}));
  const failed=expect(turn.result).rejects.toMatchObject({code:'TIMEOUT',timeout:{phase:'total'}});
  await jest.advanceTimersByTimeAsync(20000);await failed;
 } finally {jest.useRealTimers();}
});
test('generic outcomes use protocol metadata, not tool output or a test framework',()=>{
 expect(toolOutcome('mcp__calendar__list',{is_error:false},1)).toEqual({name:'mcp__calendar__list',status:'returned',observedAt:1});
 expect(toolOutcome('Bash',{is_error:true,exit_code:2},1)).toEqual({name:'Bash',status:'error',observedAt:1,exitCode:2});
 expect(toolOutcome('Browser',{exit_code:'0'},1)).not.toHaveProperty('exitCode');
});

(process.platform==='linux'?test:test.skip)('real silent piped command survives idle threshold; counters detect children and cancellation stops the tree',async()=>{
 // stdout is buffered behind tail, as in the reported failure. No CLI heartbeat.
 const child=spawn(process.execPath,['-e',`const {spawn}=require('child_process');
 const emit=e=>console.log(JSON.stringify(e));
 emit({type:'assistant',message:{content:[{type:'tool_use',id:'b',name:'Bash',input:{}}]}});
 const job=spawn('sh',['-c', 'node -e "let end=Date.now()+800;while(Date.now()<end){};setInterval(()=>{},1000)" | tail -1'],{stdio:'ignore'});
 setInterval(()=>{},1000);`],{detached:true,stdio:['ignore','pipe','ignore']});
 const proc=Object.assign(new EventEmitter(),{start:async()=>{},sendMessage:()=>{},interrupt:()=>{},stop:async()=>{await stopProcessGroup(child.pid!);}}) as unknown as SessionProcess;
 child.on('exit',()=>proc.emit('exit'));
 const observations:TurnObservation[]=[];
 const turn=startProcessTurn(proc,'work',undefined,undefined,undefined,[],{startupTimeoutMs:3000,firstResponseTimeoutMs:3000,idleTimeoutMs:50,idleAction:'observe',onObservation:o=>observations.push(o)});
 const lines=createInterface({input:child.stdout!});lines.on('line',l=>proc.emit('output',l));
 try {
  await turn.accepted;
  const sampler=new ProcessActivitySampler(()=>child.pid);
  await sampler.sample();
  await new Promise(r=>setTimeout(r,350));
  const measured=await sampler.sample();
  expect(measured.available).toBe(true);expect(measured.processCount).toBeGreaterThanOrEqual(3);
  expect(measured.cpuTicksDelta).toBeGreaterThan(0);
  expect(observations.some(o=>o.quiet&&o.activeTools.includes('Bash'))).toBe(true);
  expect(child.exitCode).toBeNull();
  await turn.stop();await expect(turn.result).resolves.toMatchObject({interrupted:true});
  expect((await sampler.sample()).available).toBe(false);
 } finally {lines.close();await stopProcessGroup(child.pid!);}
},15000);
(process.platform==='linux'?test:test.skip)('sleeping tree has no manufactured progress and unavailable telemetry stays unavailable',async()=>{
 const child=spawn('sleep',['30'],{detached:true,stdio:'ignore'});
 try {
  await once(child,'spawn');
  const sampler=new ProcessActivitySampler(()=>child.pid);
  await sampler.sample();await new Promise(r=>setTimeout(r,50));
  expect(await sampler.sample()).toMatchObject({available:true,cpuTicksDelta:0,readBytesDelta:0,writeBytesDelta:0,membershipChanged:false});
  expect(await new ProcessActivitySampler(()=>child.pid,false).sample()).toMatchObject({available:false});
 } finally {await stopProcessGroup(child.pid!);}
});

(process.platform==='linux'?test:test.skip)('real command can finish normally after a silent interval longer than the worker observation threshold',async()=>{
 const child=spawn(process.execPath,['-e',`console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'b',name:'Bash',input:{}}]}}));
 require('child_process').execFile('sh',['-c','sleep 0.4; printf "done\\n" | tail -1'],(error,stdout)=>{
 console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'b',content:stdout}]}}));
 console.log(JSON.stringify({type:'result',result:stdout.trim()}));});`],{detached:true,stdio:['ignore','pipe','ignore']});
 const proc=Object.assign(new EventEmitter(),{start:async()=>{},sendMessage:()=>{},interrupt:()=>{},stop:jest.fn(async()=>{await stopProcessGroup(child.pid!);})}) as unknown as SessionProcess;
 const turn=startProcessTurn(proc,'work',undefined,undefined,undefined,[],{startupTimeoutMs:3000,firstResponseTimeoutMs:3000,idleTimeoutMs:30,idleAction:'observe'});
 const lines=createInterface({input:child.stdout!});lines.on('line',l=>proc.emit('output',l));child.on('exit',()=>proc.emit('exit'));
 try {await expect(turn.result).resolves.toMatchObject({text:'done',interrupted:false});expect(proc.stop).not.toHaveBeenCalled();}
 finally {lines.close();await stopProcessGroup(child.pid!);}
},10000);

(process.platform==='linux'?test:test.skip)('logical I/O counters detect output even when it is not streamed to the observer',async()=>{
 const child=spawn(process.execPath,['-e',`const fs=require('fs');const b=Buffer.alloc(8192);setInterval(()=>fs.writeSync(1,b),10);console.error('ready');`],{detached:true,stdio:['ignore','ignore','pipe']});
 try {
  await once(child.stderr!,'data');
  const sampler=new ProcessActivitySampler(()=>child.pid);
  await sampler.sample();await new Promise(r=>setTimeout(r,100));
  expect((await sampler.sample()).writeBytesDelta).toBeGreaterThan(0);
 } finally {await stopProcessGroup(child.pid!);}
});


test.each(['Bash','mcp__browser__navigate','mcp__calendar__list','mcp__image__generate'])('tool events for %s do not interpret arbitrary content as diagnostics', name=>{
 const publish=jest.fn(),read=toolActivity(publish);
 read(JSON.stringify({message:{content:[{type:'tool_use',id:'one',name,input:{}}]}}));
 read(JSON.stringify({message:{content:[{type:'tool_result',tool_use_id:'one',is_error:true,content:'Tests: 999 passed, 999 total\nprivate output'}]}}));
 expect(publish).toHaveBeenLastCalledWith({type:'tool_result',id:'one',name,is_error:true});
 expect(JSON.stringify(publish.mock.calls)).not.toContain('private output');
 expect(JSON.stringify(publish.mock.calls)).not.toContain('999');
});
