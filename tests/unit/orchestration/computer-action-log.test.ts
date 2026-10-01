import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService,taskIndexEntry} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import type {ComputerTaskReport,WorkerOutcome} from '../../../src/orchestration/types';

// Session 35bd8aff (task a68812d5): revision 1 opened Calculator and pressed
// All Clear (step run 2/2, ALL_STEPS_DONE), revisions 2-10 were voice commands.
// After disconnect the final summary said Clear had not been pressed: only the
// last revision's report was in context. Reports below are the recorded shapes.
const rev1:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:2,evaluations:2,phase:'terminal',
 stepRun:{total:2,completed:2,stopReason:'ALL_STEPS_DONE',remaining:[]} as any,lastAction:{kind:'press',label:'All Clear',role:'AXButton'}};
const pressed=(label:string):ComputerTaskReport=>({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,phase:'terminal',lastAction:{kind:'press',label,role:'AXButton'}});
const low:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1,phase:'terminal',
 trace:[{phase:'decided',confidence:0.45,sequence:3,round:1,at:1,revision:9,steps:0,evaluations:1},{phase:'waiting',reason:'LOW_CONFIDENCE',sequence:4,round:1,at:2,revision:9,steps:0,evaluations:1}]};

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'computer-log-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'เปิดเครื่องคิดเลขครับ แล้วก็เคลียร์ข้อมูลใหม่',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const task=tasks.spawn({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'},{title:'Calculator',instructions:'Open Calculator, then press All Clear',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 const round=(computerReport:ComputerTaskReport,type:WorkerOutcome['type']='paused')=>{const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);return tasks.finish(attempt.attemptId,attempt.generation,{type,computerReport} as WorkerOutcome);};
 const send=(text:string)=>tasks.controlByUser(accepted.conversationId,'u',task.taskId,{id:randomUUID(),action:'revise',expectedRevision:store.task(task.taskId)!.revision,text});
 return {store,tasks,task,round,send,conversationId:accepted.conversationId,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}

test('V6: the summary context keeps the revision 1 All Clear action after later failures',()=>{
 const f=fixture();try{
  f.round(rev1);
  for(const [command,report] of [['เอาล่ะ กดเลข 1',pressed('1')],['เครื่องหมายบวก',pressed('Add')],['ห้า',low],['ห้า',low]] as const){f.send(command);f.round(report);}
  f.tasks.cancelByUser(f.conversationId,'u',f.task.taskId);
  const stored=f.store.task(f.task.taskId)!;
  // The reporting turn hydrates the stored snapshot; other turns see the index entry.
  for(const context of [f.tasks.status(f.conversationId,'u',f.task.taskId)[0],taskIndexEntry(stored)] as any[]){
   expect(context.actionLog[0]).toMatchObject({revision:1});
   expect(context.actionLog[0].result).toContain('pressed "All Clear"');
   expect(context.actionLog.map((e:any)=>e.revision)).toEqual([1,2,3,4,5]);
   expect(context.actionLog[3]).toMatchObject({revision:4,command:'ห้า'});
   // A recorded LOW_CONFIDENCE round (no longer produced for a direct command) stays not done.
   expect(context.actionLog[3].result).toMatch(/^Not done: LOW_CONFIDENCE/);
  }
 }finally{f.close();}
});

test('V6: the action log is bounded in entries and text',()=>{
 const f=fixture();try{
  f.round(rev1);
  for(let i=0;i<30;i++){f.send('x'.repeat(4000));f.round(low);}
  const log=(f.store.task(f.task.taskId) as any).actionLog;
  expect(log).toHaveLength(12);
  expect(log.at(-1).revision).toBe(31);
  expect(log.every((e:any)=>e.command.length<=80&&e.result.length<=240)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(log))).toBeLessThan(6000);
 }finally{f.close();}
});

test('L1: a correction logs the user\'s latest words, not the preamble, and typed text is never logged',()=>{
 const f=fixture();try{
  // Sent while the agent's opening round runs: stored as a correction revision.
  const attempt=f.tasks.claim(f.task.taskId)!;f.tasks.started(attempt.attemptId,attempt.generation);
  f.send('กด 5 แทน');
  expect(f.tasks.revision(f.task.taskId,2).instructions).toMatch(/^Latest user correction/);
  f.tasks.finish(attempt.attemptId,attempt.generation,{type:'paused',computerReport:pressed('1')} as WorkerOutcome);
  f.round(pressed('5'));
  f.send('พิมพ์ "hunter2 secret"');f.round(pressed('Field'));
  const log=(f.store.task(f.task.taskId) as any).actionLog;
  expect(log.find((e:any)=>e.revision===2).command).toBe('กด 5 แทน');
  const typed=log.find((e:any)=>e.revision===3);
  expect(typed.command).toBe('พิมพ์ "[text]"');
  expect(JSON.stringify(log)).not.toContain('hunter2');
 }finally{f.close();}
});
