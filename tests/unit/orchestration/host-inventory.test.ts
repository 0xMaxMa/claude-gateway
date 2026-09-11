import { EventEmitter } from 'events';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import type { SessionProcess } from '../../../src/session/process';

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
