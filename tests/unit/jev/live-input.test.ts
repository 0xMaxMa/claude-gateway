import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OrchestrationStore,AcceptInput} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {liveExecutionInput} from '../../../src/orchestration/live-execution-input';

for(const modality of ['text','live_voice'] as const)test(`${modality} correction applies once and records one canonical input and resumes idle rounds without an agent`,()=>{
 const root=mkdtempSync(join(tmpdir(),'live-input-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store),decisions=new DecisionService(store);
 try{
  const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'u',chatId:'c',threadKey:'',principalId:'u'},capabilities={execute:true,writeMemory:false};
  const accepted=store.acceptInput({scope,text:'Book flights',capabilities});
  const decision=decisions.begin(accepted.conversationId,'u',[accepted.inputId]);
  const task=tasks.spawn({...accepted,...decision,principalId:'u',...capabilities,actionId:'spawn'},{title:'Flights',instructions:'Two adults, three children, London',targetProfile:'gateway-managed',gatewayTarget:{adapter:'browser',sessionId:'target',name:'Browser'}});
  const input:AcceptInput={scope,text:'Manchester instead',modality:modality==='live_voice'?modality:undefined,ingressKey:randomUUID(),metadata:{executionTaskId:task.taskId}};
  const first=liveExecutionInput(store,tasks,input,capabilities)!;
  const retry=liveExecutionInput(store,tasks,input,capabilities)!;
  expect(store.get('SELECT store_user_message FROM conversation_inputs WHERE id=?',first.inputId)!.store_user_message).toBe(0);
  expect(retry.inputId).toBe(first.inputId);expect(retry.reused).toBe(true);
  expect(store.task(task.taskId)!.revision).toBe(2);
  expect(store.get('SELECT status FROM conversation_inputs WHERE id=?',first.inputId)!.status).toBe('handled');
  expect(tasks.revision(task.taskId,2).instructions).toContain('Two adults, three children');
  expect(store.get("SELECT COUNT(*) AS n FROM assistant_responses WHERE state='completed'")!.n).toBe(0);
  const settled=store.task(task.taskId)!;
  store.transaction(()=>{settled.state='completed';settled.executionControl=undefined;store.saveTask(settled,settled.stateVersion);});
  const nextGoal=liveExecutionInput(store,tasks,{...input,text:'Now inspect the results',ingressKey:randomUUID()},capabilities)!;
  expect(nextGoal).toMatchObject({status:'applied',revision:3,taskId:task.taskId});
  expect(store.task(task.taskId)!.revision).toBe(3);
  expect(tasks.revision(task.taskId,3).instructions).not.toContain('Book flights');
  expect(tasks.revision(task.taskId,3).instructions).not.toContain('Two adults');
  expect(store.get('SELECT status FROM conversation_inputs WHERE id=?',nextGoal.inputId)!.status).toBe('handled');
  const other=liveExecutionInput(store,tasks,{...input,scope:{...scope,agentSessionId:'other',chatId:'other'},ingressKey:randomUUID()},capabilities)!;
  expect(other.task).toBeUndefined();expect(store.task(task.taskId)!.revision).toBe(3);
  const denied=liveExecutionInput(store,tasks,{...input,ingressKey:randomUUID()},{execute:false,writeMemory:false})!;
  expect(denied.task).toBeUndefined();expect(store.task(task.taskId)!.revision).toBe(3);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
