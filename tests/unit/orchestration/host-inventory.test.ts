import { EventEmitter } from 'events';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import type { SessionProcess } from '../../../src/session/process';

test('agent can inspect capability metadata without receiving a worker execution tool', async () => {
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process,{runtimeProfile:{role:'agent'},start:async()=>{},stop:jest.fn(async()=>{}),sendMessage:()=>{
    process.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['mcp__gateway__capabilities_list','mcp__gateway__task_spawn']}));
    process.emit('output',JSON.stringify({type:'result',result:'catalog read'}));
  }});
  await expect(startProcessTurn(process,'List capabilities',1000).result).resolves.toMatchObject({text:'catalog read'});
});

test.each([true, false])('host inventory inheritance is explicit: %s', async hostExecution => {
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, { runtimeProfile: { role: 'worker', hostExecution }, start: async () => {},
    stop: jest.fn(async () => {}), sendMessage: () => {
      process.emit('output', JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash', 'WebFetch', 'mcp__custom__tool'] }));
      process.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    } });
  const turn = startProcessTurn(process, 'task', 1000);
  if (hostExecution) await expect(turn.result).resolves.toMatchObject({ text: 'done' });
  else await expect(turn.result).rejects.toMatchObject({ code: 'PROFILE_INVENTORY_MISMATCH' });
});


test.each([true, false])('agent accepts only connector tools present in its spawned config: %s', async configured => {
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, {runtimeProfile:{role:'agent'},start:async()=>{},stop:jest.fn(async()=>{}),
    isSpawnedConnectorTool:(name:string)=>configured && name==='mcp__github__list_issues',
    sendMessage:()=>{
      process.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['mcp__gateway__task_status','mcp__github__list_issues']}));
      process.emit('output',JSON.stringify({type:'result',result:'done'}));
    }});
  const turn=startProcessTurn(process,'task',1000);
  if(configured)await expect(turn.result).resolves.toMatchObject({text:'done'});
  else await expect(turn.result).rejects.toMatchObject({code:'PROFILE_INVENTORY_MISMATCH'});
});


test('the agent intake tool is accepted on every turn, whatever the feature state', async () => {
  // conversation_intake is declared unconditionally so the cached tools prefix stays
  // byte-identical, so the CLI reports it on every agent turn — including the turns where
  // semantic intake is inactive. Validating it against a per-turn feature flag rejected the
  // turn outright (PROFILE_INVENTORY_MISMATCH) exactly then; the bridge refuses the call
  // instead. The profile therefore carries no intake flag at all any more.
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, {runtimeProfile:{role:'agent'},start:async()=>{},stop:jest.fn(async()=>{}),
    sendMessage:()=>{
      process.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['mcp__gateway__task_status','mcp__gateway__conversation_intake']}));
      process.emit('output',JSON.stringify({type:'result',result:'done'}));
    }});
  await expect(startProcessTurn(process,'task',1000).result).resolves.toMatchObject({text:'done'});
});

test('an agent still cannot receive a tool outside its declared inventory', async () => {
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, {runtimeProfile:{role:'agent'},start:async()=>{},stop:jest.fn(async()=>{}),
    sendMessage:()=>{
      process.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['mcp__gateway__conversation_intake','mcp__gateway__task_stage_file']}));
      process.emit('output',JSON.stringify({type:'result',result:'done'}));
    }});
  await expect(startProcessTurn(process,'task',1000).result).rejects.toMatchObject({code:'PROFILE_INVENTORY_MISMATCH'});
});
