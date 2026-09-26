import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { pendingReports } from '../../../src/orchestration/notification-mailbox';

function seed(store: OrchestrationStore, session: string) {
 const tasks=new TaskService(store),decisions=new DecisionService(store);
 const scope={agentId:'a',agentSessionId:session,source:'api' as const,accountId:'owner',chatId:session,threadKey:'',principalId:'owner'};
 const input=store.acceptInput({scope,text:'Work'}),decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
 const task=tasks.spawn({...input,...decision,principalId:'owner',actionId:'spawn-'+session,execute:true,writeMemory:false},{title:'Fixture',instructions:'Work',targetProfile:'default-worker'});
 const attempt=tasks.claim(task.taskId)!;
 tasks.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'Full result',artifactIds:[]}});
 decisions.finish(decision,'Queued');
 const notification=store.get('SELECT id FROM notifications WHERE task_id=?',task.taskId)!;
 const report=(state:'completed'|'failed'|'interrupted', key='notification:'+notification.id)=>{
  const next=store.acceptInput({scope,text:'Report',ingressKey:key,storeUserMessage:false,capabilities:{execute:false,writeMemory:false}});
  const d=decisions.begin(input.conversationId,'owner',[next.inputId]);
  if(state==='interrupted')decisions.interrupt(d);
  decisions.finish(d,state,state);
  return Number(store.get('SELECT ended_at FROM conversation_decisions WHERE id=?',d.decisionId)!.ended_at);
 };
 return {conversationId:input.conversationId,notificationId:notification.id,report};
}

test('failed report retries survive reopen, back off, and stop after successful delivery',()=>{
 const root=mkdtempSync(join(tmpdir(),'notification-retry-')),file=join(root,'db');
 let store=new OrchestrationStore(file,'a');
 try {
  const f=seed(store,'one'),ended=f.report('failed');
  expect(pendingReports(store,[],[],true,ended+4999)).toHaveLength(0);
  store.close();store=new OrchestrationStore(file,'a');
  const candidate=pendingReports(store,[],[],true,ended+5000)[0];
  expect(candidate.notification_id).toBe(f.notificationId);
  const next=store.acceptInput({scope:{agentId:'a',agentSessionId:'one',source:'api',accountId:'owner',chatId:'one',threadKey:'',principalId:'owner'},text:'Report',storeUserMessage:false,ingressKey:`notification:${candidate.notification_id}:retry:${candidate.previous_seq}`});
  const decisions=new DecisionService(store),d=decisions.begin(f.conversationId,'owner',[next.inputId]);
  decisions.finish(d,'Full result');
  expect(pendingReports(store,[],[],true,ended+600000)).toHaveLength(0);
  expect(store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(1);
 } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
test('explicitly stopped report is not restarted automatically',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try {const f=seed(store,'one'),ended=f.report('interrupted');expect(pendingReports(store,[],[],true,ended+3600000)).toHaveLength(0);}
 finally {store.close();}
});
test('cooling-down and non-scheduled conversations cannot occupy the eligible report page',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try {
  for(let i=0;i<25;i++)seed(store,'old-'+i).report('failed');
  const target=seed(store,'scheduled');
  expect(pendingReports(store,[],[],true)).toHaveLength(1);
  expect(pendingReports(store,[],[target.conversationId],false)[0].notification_id).toBe(target.notificationId);
  expect(pendingReports(store,['scheduled'],[target.conversationId],false)).toHaveLength(0);
 } finally {store.close();}
});


test.each(['failed','interrupted'] as const)('a batch report %s applies retry/stop to every consumed notification', state=>{
 const store=new OrchestrationStore(':memory:','a');
 try {
  const f=seed(store,'one');
  const original=store.get('SELECT * FROM notifications WHERE id=?',f.notificationId)!;
  store.run('INSERT INTO notifications VALUES(?,?,?,?,?,?,?)','another-notification',original.conversation_id,original.task_id,Number(original.task_state_version)+1,original.originating_binding_id,'pending',null);
  const ended=f.report(state);
  expect(pendingReports(store,[],[],true,ended+4999)).toHaveLength(0);
  expect(pendingReports(store,[],[],true,ended+5000)).toHaveLength(state==='failed'?1:0);
 }finally{store.close();}
});


test('a prolonged report outage backs off to one hour across restart without consuming its result',()=>{
 const root=mkdtempSync(join(tmpdir(),'notification-long-outage-')),file=join(root,'db');
 let store=new OrchestrationStore(file,'a');
 try {
  const f=seed(store,'one');let ended=0;
  for(let i=0;i<12;i++)ended=f.report('failed',`notification:${f.notificationId}:retry:${i}`);
  expect(pendingReports(store,[],[],true,ended+300000)).toHaveLength(0);
  store.close();store=new OrchestrationStore(file,'a');
  expect(pendingReports(store,[],[],true,ended+3599999)).toHaveLength(0);
  expect(pendingReports(store,[],[],true,ended+3600000)[0].notification_id).toBe(f.notificationId);
  expect(store.get('SELECT status FROM notifications WHERE id=?',f.notificationId)?.status).toBe('pending');
  // An explicit user request can recover immediately; it is not gated by report cooldown.
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'one',source:'api',accountId:'owner',chatId:'one',threadKey:'',principalId:'owner'},text:'Try again'});
  const decisions=new DecisionService(store),decision=decisions.begin(f.conversationId,'owner',[input.inputId]);
  decisions.finish(decision,'Full result');
  expect(pendingReports(store,[],[],true,ended+7200000)).toHaveLength(0);
  expect(store.get('SELECT status FROM notifications WHERE id=?',f.notificationId)?.status).toBe('handled');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('agent control wakes for each settled step even with next-user-turn reporting policy',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try {
  const f=seed(store,'control');const row=store.get('SELECT task_id FROM notifications WHERE id=?',f.notificationId)!;
  const task=store.task(String(row.task_id))!;
  store.transaction(()=>{task.state='waiting_input';task.gatewayTarget={adapter:'browser',sessionId:'tab',name:'Browser'};task.browserReport={contractVersion:1,status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1};store.saveTask(task,task.stateVersion);store.run('UPDATE notifications SET task_state_version=? WHERE id=?',task.stateVersion,f.notificationId);});
  expect(pendingReports(store,[],[],false).map(r=>r.notification_id)).toContain(f.notificationId);
  store.transaction(()=>{task.automationController='user';store.saveTask(task,task.stateVersion);store.run('UPDATE notifications SET task_state_version=? WHERE id=?',task.stateVersion,f.notificationId);});
  expect(pendingReports(store,[],[],false)).toHaveLength(0);
  expect(pendingReports(store,[],[],true)).toHaveLength(0);
 }finally{store.close();}
});

test('direct control stays silent until a confirmed user disconnect, then reports once',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try {
  const f=seed(store,'disconnect');const row=store.get('SELECT task_id FROM notifications WHERE id=?',f.notificationId)!;
  const task=store.task(String(row.task_id))!;
  store.transaction(()=>{task.automationController='user';task.state='cancel_requested';task.cancellation={requestedBy:'user',requestedAt:Date.now()};store.saveTask(task,task.stateVersion);store.run('UPDATE notifications SET task_state_version=? WHERE id=?',task.stateVersion,f.notificationId);});
  expect(pendingReports(store,[],[],true)).toHaveLength(0);
  store.transaction(()=>{task.state='cancelled';store.saveTask(task,task.stateVersion);});
  expect(pendingReports(store,[],[],true)).toHaveLength(0); // stale progress does not wake the agent
  store.run('UPDATE notifications SET task_state_version=? WHERE id=?',task.stateVersion,f.notificationId);
  expect(pendingReports(store,[],[],false).map(r=>r.notification_id)).toEqual([f.notificationId]);
  store.run("UPDATE notifications SET status='handled' WHERE id=?",f.notificationId);
  expect(pendingReports(store,[],[],true)).toHaveLength(0);
 }finally{store.close();}
});
