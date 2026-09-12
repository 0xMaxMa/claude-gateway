import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {taskReport} from '../../../src/orchestration/task-report';

function fixture(){
 const store=new OrchestrationStore(':memory:','a');
 const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'cron',source:'api',accountId:'u',principalId:'u',chatId:'cron',threadKey:''},text:'Check status',requestId:'run'});
 const decisions=new DecisionService(store);const decision=decisions.begin(input.conversationId,'u',[input.inputId],'run');
 const tasks=new TaskService(store,{tasks:{workspaceMode:'host'}});
 const context={...input,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'};
 return {store,input,decisions,decision,tasks,context};
}
test('scheduled completion waits beyond acknowledgement and worker completion for the committed agent report',()=>{
 const f=fixture();try{
  expect(taskReport(f.store,f.input.inputId)).toEqual({pending:false});
  const task=f.tasks.spawn(f.context,{title:'Check',instructions:'Check',targetProfile:'media-worker'});
  f.decisions.finish(f.decision,'Queued');
  expect(taskReport(f.store,f.input.inputId)).toEqual({pending:true});
  const attempt=f.tasks.claim(task.taskId)!;
  f.tasks.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'Actual data',artifactIds:[]}});
  expect(taskReport(f.store,f.input.inputId)).toEqual({pending:true});
  const follow=f.store.acceptInput({scope:{agentId:'a',agentSessionId:'cron',source:'api',accountId:'u',principalId:'u',chatId:'cron',threadKey:''},text:'Report results'});
  const report=f.decisions.begin(follow.conversationId,'u',[follow.inputId]);
  f.decisions.finish(report,'Verified final report');
  expect(taskReport(f.store,f.input.inputId)).toEqual({pending:false,text:'Verified final report'});
  expect(taskReport(f.store,follow.inputId)).toEqual({pending:false});
 }finally{f.store.close();}
});
test('a failed worker cannot make a scheduled run successful',()=>{
 const f=fixture();try{
  const task=f.tasks.spawn(f.context,{title:'Check',instructions:'Check',targetProfile:'media-worker'});
  f.decisions.finish(f.decision,'Queued');const attempt=f.tasks.claim(task.taskId)!;
  f.tasks.finish(attempt.attemptId,attempt.generation,{type:'failed',failure:{code:'WORKER_START_FAILED',message:'Missing prerequisite',observedAt:Date.now()}});
  expect(()=>taskReport(f.store,f.input.inputId)).toThrow('WORKER_START_FAILED');
 }finally{f.store.close();}
});

test('runtime waits for the final report and scopes the wait to the authenticated run',async()=>{
 const {AgentOrchestrationRuntime}=await import('../../../src/orchestration/runtime');
 const f=fixture();jest.useFakeTimers();
 try{
  const task=f.tasks.spawn(f.context,{title:'Check',instructions:'Check',targetProfile:'media-worker'});
  f.decisions.finish(f.decision,'Queued');const attempt=f.tasks.claim(task.taskId)!;
  const runtime=Object.assign(Object.create(AgentOrchestrationRuntime.prototype),{store:f.store,scheduledReports:new Set(),closing:false,pumpMailbox:jest.fn()});
  let completed=false;
  const waiting=runtime.waitForTaskReport('cron','u','run','Queued',Date.now()+2000).then((text:string)=>{completed=true;return text;});
  await jest.advanceTimersByTimeAsync(250);expect(completed).toBe(false);
  f.tasks.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'Data',artifactIds:[]}});
  await jest.advanceTimersByTimeAsync(250);expect(completed).toBe(false);
  const follow=f.store.acceptInput({scope:{agentId:'a',agentSessionId:'cron',source:'api',accountId:'u',principalId:'u',chatId:'cron',threadKey:''},text:'Report'});
  f.decisions.finish(f.decisions.begin(follow.conversationId,'u',[follow.inputId]),'Final data report');
  await jest.advanceTimersByTimeAsync(250);await expect(waiting).resolves.toBe('Final data report');
  expect(runtime.scheduledReports.size).toBe(0);
  await expect(runtime.waitForTaskReport('cron','intruder','run','Queued',Date.now()+2000)).rejects.toThrow('INPUT_NOT_FOUND');
 }finally{jest.useRealTimers();f.store.close();}
});
