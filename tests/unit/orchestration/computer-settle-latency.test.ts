import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {GatewayTaskController,type GatewayTaskAdapter} from '../../../src/orchestration/gateway-tasks/controller';

// Evidence: after a direct command's trace ended the task stayed "running" for
// ~1 s until the next 1 s poll, so a command typed then was treated as a
// correction. A settled round and a queued follow-up must be applied without
// waiting for the poll interval.
test('a settled round is applied and the next queued command dispatched without the poll interval',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-settle-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'calc',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const task=tasks.spawn({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'},{title:'Calc',instructions:'Open Calculator',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 const submitted:string[]=[];let release:(()=>void)|undefined;const settled=new Map<string,boolean>();
 const adapter:GatewayTaskAdapter={name:'computer',discover:()=>({}),resolve:()=>({adapter:'computer',sessionId:'mac',name:'Mac'}),cancel:async()=>{},
  submit:async(_t,requestId,instructions)=>{submitted.push(instructions);settled.set(requestId,false);release=()=>{settled.set(requestId,true);void controller.tick();};},
  inspect:async(_t,requestId)=>settled.get(requestId)?{type:'paused',computerReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,phase:'terminal'}}:'running'};
 const controller=new GatewayTaskController(tasks,new Map([['computer',adapter]]));
 const send=(text:string)=>tasks.controlByUser(accepted.conversationId,'u',task.taskId,{id:randomUUID(),action:'revise',expectedRevision:store.task(task.taskId)!.revision,text});
 const flush=async()=>{for(let i=0;i<20;i++)await new Promise(setImmediate);};
 try{
  await controller.tick();release!();await flush();
  expect(store.task(task.taskId)!.state).toBe('waiting_input');
  send('9');await controller.tick();send('+');
  release!();await flush();
  // No timer tick ran: the settle notification applied "9" and dispatched "+".
  expect(submitted).toEqual(['Open Calculator','9','+']);
 }finally{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}
});

// P2-11: measured wall time with the real 1 s poll timer running. The recorded
// trace showed ~1 s "running" after a command's trace ended and ~1 s from an
// interrupt to the next "starting".
test.each(['next command','interrupt'])('%s: the follow-up round is dispatched well under the 1 s poll interval',async path=>{
 const root=mkdtempSync(join(tmpdir(),'computer-latency-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'calc',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const task=tasks.spawn({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'},{title:'Calc',instructions:'Open Calculator',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 const submittedAt:number[]=[];const outcomes=new Map<string,any>();let finish:((outcome:any)=>void)|undefined;
 const adapter:GatewayTaskAdapter={name:'computer',discover:()=>({}),resolve:()=>({adapter:'computer',sessionId:'mac',name:'Mac'}),cancel:async()=>{},
  submit:async(_t,requestId)=>{submittedAt.push(Date.now());finish=outcome=>{outcomes.set(requestId,outcome);void controller.tick();};},
  interrupt:()=>finish?.({type:'stopped',computerReport:{status:'cancelled',reason:'REVISION_SUPERSEDED',steps:0,evaluations:0,phase:'terminal'}}),
  inspect:async(_t,requestId)=>outcomes.get(requestId)??'running'};
 const controller=new GatewayTaskController(tasks,new Map([['computer',adapter]]));
 const waitFor=async(n:number)=>{const deadline=Date.now()+3000;while(submittedAt.length<n&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));};
 try{
  controller.start();await waitFor(1);
  let started:number;
  if(path==='next command'){
   finish!({type:'paused',computerReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,phase:'terminal'}});
   await new Promise(r=>setTimeout(r,20));
   const sent=tasks.controlByUser(accepted.conversationId,'u',task.taskId,{id:randomUUID(),action:'revise',expectedRevision:store.task(task.taskId)!.revision,text:'9'});
   controller.signalControl(sent);await waitFor(2);
   // Now "+" is typed while "9" runs; measure from "9" settling to "+" dispatch.
   tasks.controlByUser(accepted.conversationId,'u',task.taskId,{id:randomUUID(),action:'revise',expectedRevision:store.task(task.taskId)!.revision,text:'+'});
   started=Date.now();finish!({type:'paused',computerReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,phase:'terminal'}});
   await waitFor(3);
  }else{
   const sent=tasks.controlByUser(accepted.conversationId,'u',task.taskId,{id:randomUUID(),action:'revise',expectedRevision:store.task(task.taskId)!.revision,text:'Use Notes instead'});
   started=Date.now();controller.signalControl(sent);await waitFor(2);
  }
  const elapsed=submittedAt.at(-1)!-started;
  process.stdout.write(`LATENCY ${path}: ${elapsed} ms\n`);
  expect(submittedAt.length).toBe(path==='next command'?3:2);
  expect(elapsed).toBeLessThan(300);
 }finally{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}
});
