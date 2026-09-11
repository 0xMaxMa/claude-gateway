import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { StopControls, stopMenuText } from '../../../src/orchestration/stop-controls';

function fixture() {
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),decisions=new DecisionService(store),stop=jest.fn(()=>true),controls=new StopControls(store,tasks,stop);
 const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'owner',chatId:'c',threadKey:'',principalId:'owner'},text:'work'});
 const decision=decisions.begin(input.conversationId,'owner',[input.inputId]);let n=0;
 const spawn=()=>tasks.spawn({...input,...decision,principalId:'owner',actionId:'task-'+ ++n,execute:true,writeMemory:false},{title:'Task '+n,instructions:'fixture',targetProfile:'default-worker'});
 return {store,tasks,controls,stop,spawn};
}
test('stop interrupts only the agent; choosing a frozen task number cancels only that task without inference',()=>{
 const f=fixture();try{
  const a=f.spawn(),b=f.spawn();const attempt=f.tasks.claim(a.taskId)!;f.tasks.started(attempt.attemptId,attempt.generation);
  const menu=f.controls.open('s','owner');expect(f.stop).toHaveBeenCalledWith('s');expect(stopMenuText(menu)).toContain('Task 1');const index=menu.tasks.findIndex(t=>t.taskId===b.taskId)+1;
  const c=f.spawn();expect(f.store.task(a.taskId)!.state).toBe('running');
  expect(f.controls.replyCommand('s','owner',String(index))).toBe(`/stop ${menu.menuId} ${index}`);
  expect(f.controls.choose('s','owner',menu.menuId,index).state).toBe('cancelled');
  expect(f.store.task(a.taskId)!.state).toBe('running');expect(f.store.task(c.taskId)!.state).toBe('queued');expect(f.store.task(b.taskId)!.state).toBe('cancelled');
 }finally{f.store.close();}
});
test('running work reports stopping until worker termination; completed selection never targets replacement work',()=>{
 const f=fixture();try{
  const a=f.spawn(),attempt=f.tasks.claim(a.taskId)!;f.tasks.started(attempt.attemptId,attempt.generation);
  const m=f.controls.open('s','owner');expect(f.controls.choose('s','owner',m.menuId,1).state).toBe('cancel_requested');
  f.tasks.finish(attempt.attemptId,attempt.generation,{type:'stopped'});expect(f.store.task(a.taskId)!.state).toBe('cancelled');
  const b=f.spawn(),next=f.controls.open('s','owner');f.tasks.cancelByUser(b.conversationId,'owner',b.taskId);const c=f.spawn();
  f.controls.choose('s','owner',next.menuId,1);expect(f.store.task(c.taskId)!.state).toBe('queued');
 }finally{f.store.close();}
});
test('cross-user/session selections, stale menus and unrelated numeric replies cannot cancel work',()=>{
 const f=fixture();try{
  const a=f.spawn(),menu=f.controls.open('s','owner');
  expect(()=>f.controls.open('s','stranger')).toThrow('ACCESS_DENIED');
  expect(()=>f.controls.choose('s','stranger',menu.menuId,1)).toThrow();
  expect(()=>f.controls.choose('other','owner',menu.menuId,1)).toThrow();
  expect(f.controls.replyCommand('s','stranger','1')).toBeUndefined();
  f.controls.replyCommand('s','owner','New question');expect(f.controls.replyCommand('s','owner','1')).toBeUndefined();
  expect(()=>f.controls.choose('s','owner',menu.menuId,1)).toThrow('STOP_MENU_EXPIRED');
  const fresh=f.controls.open('s','owner');f.controls.choose('s','owner',fresh.menuId,0);expect(f.store.task(a.taskId)!.state).toBe('queued');
  const expired=f.controls.open('s','owner');const now=jest.spyOn(Date,'now').mockReturnValue(Date.now()+300001);
  try{expect(()=>f.controls.choose('s','owner',expired.menuId,1)).toThrow('STOP_MENU_EXPIRED');}finally{now.mockRestore();}
 }finally{f.store.close();}
});

test('an old active task remains visible and cancellable behind more than 100 terminal tasks', () => {
 const f=fixture();try {
  const task=f.spawn(),attempt=f.tasks.claim(task.taskId)!;f.tasks.started(attempt.attemptId,attempt.generation);
  for(let i=0;i<110;i++) { const completed=f.spawn();f.tasks.cancelByUser(completed.conversationId,'owner',completed.taskId); }
  expect(f.tasks.status(task.conversationId,'owner').find(t=>t.taskId===task.taskId)?.state).toBe('running');
  const menu=f.controls.open('s','owner');expect(menu.tasks.map(t=>t.taskId)).toEqual([task.taskId]);
  expect(f.controls.choose('s','owner',menu.menuId,1).state).toBe('cancel_requested');
 }finally{f.store.close();}
});


test('button stop menu shows task names only in buttons, without duplicate numbered instructions', () => {
 const menu={menuId:'m',stopped:true,tasks:[{taskId:'t',title:'Long task title',state:'running'}]};
 expect(stopMenuText(menu,true)).toBe('Agent reply stopped.\nWhich task would you like to stop?');
 expect(stopMenuText({...menu,tasks:[]},true)).toBe('Agent reply stopped.');
 expect(stopMenuText({...menu,stopped:false,tasks:[]},true)).toBe('Nothing to stop.');
 expect(stopMenuText(menu)).toContain('1. Long task title');
});

test.each([true,false])('interrupted decision retains history but delivers only when requested (%s)', deliver => {
 const store=new OrchestrationStore(':memory:','a'),send=jest.fn(),decisions=new DecisionService(store,send);
 try {
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'telegram',accountId:'owner',chatId:'c',threadKey:'',principalId:'owner'},text:'work'});
  const decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
  decisions.interrupt(decision);
  decisions.finish(decision,'Response stopped.','interrupted',undefined,deliver);
  expect(send).toHaveBeenCalledTimes(deliver ? 1 : 0);
  expect(store.get('SELECT state FROM assistant_responses WHERE id=?',decision.responseId!)?.state).toBe('interrupted');
  expect(store.get('SELECT status FROM conversation_inputs WHERE id=?',input.inputId)?.status).toBe('handled');
  expect(store.get('SELECT response_id FROM history_operations WHERE response_id=?',decision.responseId!)).toBeDefined();
 } finally {store.close();}
});
