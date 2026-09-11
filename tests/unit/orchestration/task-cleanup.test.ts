import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskControls } from '../../../src/orchestration/task-controls';
import { WorkerScheduler } from '../../../src/orchestration/tasks/scheduler';

function fixture() {
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),controls=new TaskControls(store,tasks);
 const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'owner',chatId:'c',threadKey:'',principalId:'owner'},text:'work'});
 const decision=new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]);
 const context={...input,...decision,principalId:'owner',actionId:'spawn',execute:true,writeMemory:false};
 const task=tasks.spawn(context,{title:'Old task',instructions:'work',targetProfile:'default-worker'});
 const attempt=tasks.claim(task.taskId)!; tasks.started(attempt.attemptId,attempt.generation,{pid:12345,startedAt:1,instanceId:'old'});
 tasks.finish(attempt.attemptId,attempt.generation,{type:'unknown'});
 return {store,tasks,controls,context,task,attempt};
}
test('uncertain cancellation verifies termination, can retry, and removes only the cancelled task from pending work',async()=>{
 const f=fixture(); const cleanup=jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
 const start=jest.fn();const scheduler=new WorkerScheduler(f.tasks,{cleanup,start,available:()=>false});
 try {
  const other=f.tasks.spawn({...f.context,actionId:'another'},{title:'Replacement',instructions:'work',targetProfile:'default-worker'});
  expect(f.controls.detail('s','owner',f.task.taskId).canStop).toBe(true);
  expect(()=>f.controls.cancel('s','intruder',f.task.taskId)).toThrow('ACCESS_DENIED');
  expect(f.controls.cancel('s','owner',f.task.taskId).state).toBe('cancel_requested');
  await scheduler.tick();
  expect(f.controls.detail('s','owner',f.task.taskId)).toMatchObject({state:'needs_reconciliation',canStop:true,failure:{code:'CLEANUP_UNCONFIRMED'}});
  f.tasks.cancel({...f.context,actionId:'retry'},f.task.taskId,other.taskId);
  await scheduler.tick();
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'cancelled',replacedByTaskId:other.taskId});
  expect(f.store.task(f.task.taskId)!.activeAttemptId).toBeUndefined();
  expect(f.controls.list('s','owner').tasks.map(t=>t.taskId)).toEqual([other.taskId]);
  expect(cleanup).toHaveBeenCalledTimes(2);expect(start).not.toHaveBeenCalled();
  await scheduler.tick();expect(cleanup).toHaveBeenCalledTimes(2);
 } finally {await scheduler.close();f.store.close();}
});
test('a missing process checker never claims cancellation succeeded',async()=>{
 const f=fixture(),scheduler=new WorkerScheduler(f.tasks,{start:jest.fn()});
 try {f.controls.cancel('s','owner',f.task.taskId);await scheduler.tick();expect(f.store.task(f.task.taskId)!.state).toBe('needs_reconciliation');}
 finally {await scheduler.close();f.store.close();}
});
test('task evidence includes recorded file locations and tool descriptions without claiming filesystem verification',()=>{
 const f=fixture();try {
  const before=f.store.task(f.task.taskId)!.updatedAt;
  const now=jest.spyOn(Date,'now').mockReturnValue(before+60000);
  try {
   f.store.transaction(()=>f.store.appendEvent(f.task.conversationId,'tool.activity',{name:'Edit',type:'tool_use',input:{file_path:'/separate/worktree/app.ts',description:'Fix app tests'}},f.task.taskId));
  }finally{now.mockRestore();}
  const status=f.tasks.status(f.task.conversationId,'owner',f.task.taskId)[0];
  expect(status.workspaceEvidence).toEqual({registered:[],observedFilePaths:['/separate/worktree/app.ts'],currentFilesystemVerified:false});
  expect(status.recentTools![0].description).toBe('Fix app tests');
  expect(f.controls.detail('s','owner',f.task.taskId).updatedAt).toBe(before+60000);
  expect(f.store.task(f.task.taskId)!.updatedAt).toBe(before);
  const other=f.tasks.spawn({...f.context,actionId:'other'},{title:'Other',instructions:'work',targetProfile:'default-worker'});
  expect(f.tasks.status(other.conversationId,'owner',other.taskId)[0].workspaceEvidence!.observedFilePaths).toEqual([]);
  expect(()=>f.tasks.status(f.task.conversationId,'intruder',f.task.taskId)).toThrow('ACCESS_DENIED');
  expect(()=>f.tasks.cancel({...f.context,actionId:'self'},f.task.taskId,f.task.taskId)).toThrow('INVALID_REPLACEMENT');
 } finally {f.store.close();}
});

test('shutdown waits for in-flight cleanup before allowing the store to close',async()=>{
 const f=fixture();let resolve!:(value:boolean)=>void;
 const cleanup=jest.fn(()=>new Promise<boolean>(r=>{resolve=r;}));
 const scheduler=new WorkerScheduler(f.tasks,{cleanup,start:jest.fn()});
 try {
  f.controls.cancel('s','owner',f.task.taskId);
  const tick=scheduler.tick();let closed=false;const close=scheduler.close().then(()=>{closed=true;});
  await Promise.resolve();expect(closed).toBe(false);
  resolve(true);await tick;await close;
  expect(f.store.task(f.task.taskId)!.state).toBe('cancelled');
 }finally{f.store.close();}
});
