import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import type {WorkerOutcome} from '../../../src/orchestration/types';

// Rapid direct commands observed in conversation 7d256cb7 (revisions 19-22):
// "9", "+", "3", "=" typed ~1.5-3 s apart while the previous round was still
// settling. Each must reach the device verbatim, in order, exactly once.
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'computer-queue-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'Use my calculator',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const context={...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'};
 const task=tasks.spawn(context,{title:'Calculator',instructions:'Open Calculator',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 const send=(text:string)=>tasks.controlByUser(accepted.conversationId,'u',task.taskId,{id:randomUUID(),action:'revise',expectedRevision:store.task(task.taskId)!.revision,text});
 const run=()=>{const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);return attempt;};
 const settle=(attempt:{attemptId:string;generation:number},outcome:WorkerOutcome={type:'paused',computerReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,phase:'terminal'}})=>tasks.finish(attempt.attemptId,attempt.generation,outcome);
 const instructions=()=>store.all('SELECT payload_json FROM task_revisions WHERE task_id=? ORDER BY revision',task.taskId).map(row=>JSON.parse(String(row.payload_json)).instructions as string).slice(1);
 // The agent's opening round settles; the user then types "9" directly.
 settle(run());send('9');
 return {store,tasks,task,send,run,settle,instructions,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}

test('direct commands typed while a round is running are queued FIFO and delivered verbatim',()=>{
 const f=fixture();try{
  let attempt=f.run();
  // Typed while "9" is still running: never a correction, never superseded.
  expect(f.send('+').state).toBe('running');
  expect(f.send('3').state).toBe('running');
  expect(f.store.task(f.task.taskId)!.queuedCommands?.map(c=>c.text)).toEqual(['+','3']);
  expect(f.store.task(f.task.taskId)!.revision).toBe(2);
  f.settle(attempt);
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'queued',revision:3});
  attempt=f.run();
  expect(f.send('=').state).toBe('running');
  f.settle(attempt);attempt=f.run();f.settle(attempt);attempt=f.run();f.settle(attempt);
  expect(f.instructions()).toEqual(['9','+','3','=']);
  expect(f.instructions().some(text=>text.includes('Latest user correction'))).toBe(false);
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'waiting_input',revision:5});
  expect(f.store.task(f.task.taskId)!.queuedCommands??[]).toEqual([]);
 }finally{f.close();}
});

test('a command typed after a queued round starts, but before it is claimed, is queued rather than nested',()=>{
 const f=fixture();try{
  const attempt=f.run();f.send('+');f.settle(attempt);
  expect(f.store.task(f.task.taskId)!.state).toBe('queued');
  f.send('3');f.send('=');
  expect(f.instructions()).toEqual(['9','+']);
  for(let i=0;i<3;i++)f.settle(f.run());
  expect(f.instructions()).toEqual(['9','+','3','=']);
 }finally{f.close();}
});

test('a failed round drops queued commands and says so instead of replaying them',()=>{
 const f=fixture();try{
  const attempt=f.run();f.send('+');f.send('3');
  f.settle(attempt,{type:'failed',failure:{code:'COMPUTER_ACTION_REJECTED',message:'rejected',observedAt:Date.now()},computerReport:{status:'blocked',reason:'ACTION_REJECTED',steps:0,evaluations:1,phase:'terminal'}});
  const task=f.store.task(f.task.taskId)!;
  expect(task.state).toBe('failed');expect(task.queuedCommands??[]).toEqual([]);
  expect(task.latestProgress?.text).toContain('2 queued commands were not sent');
  expect(f.instructions()).toEqual(['9']);
 }finally{f.close();}
});

test('pause clears queued commands',()=>{
 const f=fixture();try{
  f.run();f.send('+');
  f.tasks.controlByUser(f.task.conversationId,'u',f.task.taskId,{id:randomUUID(),action:'pause',expectedRevision:f.store.task(f.task.taskId)!.revision});
  expect(f.store.task(f.task.taskId)!.queuedCommands??[]).toEqual([]);
 }finally{f.close();}
});

test('a command typed during an agent-planned round corrects it once; later commands queue instead of nesting',()=>{
 const f=fixture();try{
  // Revision 2 ("9") stands in for an agent-planned goal round here.
  const task=f.store.task(f.task.taskId)!;
  f.store.run('UPDATE task_revisions SET payload_json=json_remove(payload_json,\'$.directCommand\') WHERE task_id=? AND revision=?',task.taskId,task.revision);
  f.run();
  expect(f.send('Stop, use Notes instead').state).toBe('interrupting');
  expect(f.send('=').state).toBe('interrupting');
  expect(f.store.task(f.task.taskId)!.queuedCommands?.map(c=>c.text)).toEqual(['=']);
  expect(f.instructions().filter(text=>text.startsWith('Latest user correction'))).toHaveLength(1);
 }finally{f.close();}
});

test('M1: speech while a direct command runs is not a pause, so it queues FIFO instead of merging as a correction',()=>{
 const f=fixture();try{
  f.run();
  expect(f.tasks.voicePauseApplies(f.task.taskId)).toBe(false);
  expect(f.send('6').state).toBe('running');
  expect(f.store.task(f.task.taskId)!.queuedCommands?.map(c=>c.text)).toEqual(['6']);
  expect(f.instructions().some(text=>text.includes('Latest user correction'))).toBe(false);
  // The agent driving: speech is an interruption and still pauses.
  f.tasks.controlByUser(f.store.task(f.task.taskId)!.conversationId,'u',f.task.taskId,{id:randomUUID(),action:'agent',expectedRevision:f.store.task(f.task.taskId)!.revision});
  expect(f.tasks.voicePauseApplies(f.task.taskId)).toBe(true);
 }finally{f.close();}
});

test('M2: pausing with queued commands says which commands were not sent',()=>{
 const f=fixture();try{
  f.run();f.send('+');f.send('3');
  const paused=f.tasks.controlByUser(f.store.task(f.task.taskId)!.conversationId,'u',f.task.taskId,{id:randomUUID(),action:'pause',expectedRevision:f.store.task(f.task.taskId)!.revision});
  expect(paused.queuedCommands).toBeUndefined();
  expect(paused.latestProgress?.text).toContain('2 queued commands were not sent: "+", "3".');
  expect(f.store.all("SELECT 1 FROM conversation_events WHERE type='task.command_queue_dropped'")).toHaveLength(1);
 }finally{f.close();}
});

test('L3: handing control to the agent drops the user\'s queued commands and says so',()=>{
 const f=fixture();try{
  const attempt=f.run();f.send('+');f.send('3');
  const handed=f.tasks.controlByUser(f.store.task(f.task.taskId)!.conversationId,'u',f.task.taskId,{id:randomUUID(),action:'agent',expectedRevision:f.store.task(f.task.taskId)!.revision});
  expect(handed.queuedCommands).toBeUndefined();
  expect(handed.latestProgress?.text).toContain('2 queued commands were not sent: "+", "3".');
  f.settle(attempt);
  expect(f.instructions()).toEqual(['9']);
 }finally{f.close();}
});
