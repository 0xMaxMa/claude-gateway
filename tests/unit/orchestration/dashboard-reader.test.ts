import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { recordTokenTurn } from '../../../src/orchestration/token-ledger';
import { DashboardReader } from '../../../src/orchestration/dashboard-reader';

const usage = (n:number) => ({inputTokens:n,cacheCreationTokens:0,cacheReadTokens:0,outputTokens:0,totalTokens:n});
test('isolated reader preserves historical sessions, exact attempt totals, ownership and restart data', async()=>{
 const root=mkdtempSync(join(tmpdir(),'dashboard-reader-')),file=join(root,'db');
 const store=new OrchestrationStore(file,'a'),reader=new DashboardReader(join(process.cwd(),'dist/orchestration/dashboard-reader-worker.js'));
 try {
  const scope={agentId:'a',agentSessionId:'session',source:'api' as const,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
  const input=store.acceptInput({scope,text:'work'}),decisions=new DecisionService(store),d=decisions.begin(input.conversationId,'owner',[input.inputId]);
  const service=new TaskService(store),task=service.spawn({...input,...d,principalId:'owner',actionId:'one',execute:true,writeMemory:false},{title:'Task <script>',instructions:'assignment',targetProfile:'default-worker'});
  const attempt=service.claim(task.taskId)!;
  service.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'result',artifactIds:[]}});
  decisions.finish(d,'done');
  recordTokenTurn(store,{id:d.decisionId,sessionId:'session',role:'agent',category:'input',startedAt:1,toolIds:[],inputTokens:10,totalTokens:10,usage:usage(10),loadedTools:['task_spawn'],usedTools:['task_spawn']});
  recordTokenTurn(store,{id:attempt.attemptId,taskId:task.taskId,sessionId:'session',role:'worker',category:'worker',startedAt:2,toolIds:[],inputTokens:20,totalTokens:20,usage:usage(20),loadedTools:['Read','Bash'],usedTools:['Read']});
  // A partial stream update replaces the same turn instead of counting it twice.
  recordTokenTurn(store,{id:attempt.attemptId,taskId:task.taskId,sessionId:'session',role:'worker',category:'worker',startedAt:2,toolIds:[],inputTokens:30,totalTokens:30,usage:usage(30),loadedTools:['Read','Bash'],usedTools:['Read']});
  for(let i=0;i<27;i++)store.acceptInput({scope:{...scope,agentSessionId:'old-'+i},text:'old'});
  const one=await reader.read('summary',file,{offset:0});const two=await reader.read('summary',file,{offset:25});
  expect(one.pagination.total).toBe(28);expect(one.sessions).toHaveLength(25);expect(two.sessions).toHaveLength(3);
  const session=[...one.sessions,...two.sessions].find(s=>s.sessionId==='session');
  expect(session.status).toBe('idle');
  expect((await reader.read('report',file,{sessionId:'session',probe:'fresh'})).activityStatus).toBe('idle');
  store.run('UPDATE conversation_decisions SET ended_at=? WHERE id=?',Date.now()-3601000,d.decisionId);
  expect((await reader.read('report',file,{sessionId:'session',probe:'expired'})).activityStatus).toBe('stopped');
  expect((await reader.read('session',file,{sessionId:'session',probe:'expired'})).activityStatus).toBe('stopped');
  store.run("UPDATE conversation_decisions SET state='running' WHERE id=?",d.decisionId);
  expect((await reader.read('report',file,{sessionId:'session',probe:'busy'})).activityStatus).toBe('thinking');
  store.run("UPDATE conversation_decisions SET state='completed',ended_at=? WHERE id=?",Date.now(),d.decisionId);
  expect(session.tokenSummary).toEqual({agentTokens:10,workerTokens:30,totalTokens:40});
  expect(session.tasks[0].tokenSummary).toEqual({totalTokens:30,allAttemptsTokens:30});
  expect(session.tasks[0].loadedTools).toEqual(['Bash','Read']);expect(session.tasks[0].usedTools).toEqual(['Read']);
  expect(one.sessions.find((s:any)=>s.sessionId.startsWith('old-')).tokenSummary.totalTokens).toBeNull();
  expect(await reader.read('task',file,{taskId:task.taskId,sessionId:'wrong'})).toBeUndefined();
  const detail=await reader.read('task',file,{taskId:task.taskId,sessionId:'session'});
  expect(detail.attempts[0].attemptId).toBe(attempt.attemptId);expect(detail.snapshot.result.summary).toBe('result');
  const report=await reader.read('report',file,{sessionId:'session'});expect(report.totals.totalTokens).toBe(40);expect(report.turns.find((t:any)=>t.id===attempt.attemptId).responseText).toBe('result');
  const current=await reader.read('report',file,{sessionId:'session',since:2});
  expect(current.turns.map((t:any)=>t.id)).toEqual([attempt.attemptId]);expect(current.totals.totalTokens).toBe(30);expect(current.pagination.total).toBe(1);
  expect(report.turns[0].id).toBe(attempt.attemptId);
  const future=await reader.read('summary',file,{since:Date.now()+1000});expect(future.sessions).toHaveLength(0);expect(future.pagination.total).toBe(0);expect(future.counts.tasks).toEqual([]);
  expect(future.recentWork).toEqual([expect.objectContaining({taskId:task.taskId,sessionId:'session'})]);
  expect(two.recentWork).toEqual(one.recentWork);
  expect(await reader.read('report',file,{sessionId:'missing'})).toBeUndefined();
  expect(store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(1);
  // Existing ledgers remain readable before projection initialization, and a
  // partially populated projection must not hide historical turns either.
  store.run('DELETE FROM token_turn_metrics WHERE id=?',attempt.attemptId);
  const partial=await reader.read('summary',file,{offset:25,probe:'partial'});
  const combined=[...partial.sessions,...(await reader.read('summary',file,{offset:0,probe:'partial'})).sessions].find(s=>s.sessionId==='session');
  expect(combined.tasks[0].tokenSummary.allAttemptsTokens).toBe(30);
  store.run('DROP TABLE token_turn_metrics');
  const legacy=[...(await reader.read('summary',file,{offset:25,probe:'legacy'})).sessions,...(await reader.read('summary',file,{offset:0,probe:'legacy'})).sessions].find(s=>s.sessionId==='session');
  expect(legacy.tasks[0].tokenSummary.allAttemptsTokens).toBe(30);
  expect((await reader.read('session',file,{sessionId:'session'})).tasks[0].taskId).toBe(task.taskId);
 }finally{await reader.close();store.close();rmSync(root,{recursive:true,force:true});}
});

// The assignment text only ever exists in task_revisions — reading it off the task
// snapshot yields undefined for every task, which is what made the drawer claim
// "No assignment recorded" for tasks that had a perfectly good brief.
test('task detail exposes the effective assignment from task_revisions, normalized and with an honest empty case', async()=>{
 const root=mkdtempSync(join(tmpdir(),'dashboard-instructions-')),file=join(root,'db');
 const store=new OrchestrationStore(file,'a'),reader=new DashboardReader(join(process.cwd(),'dist/orchestration/dashboard-reader-worker.js'));
 try {
  const scope={agentId:'a',agentSessionId:'session',source:'api' as const,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
  const input=store.acceptInput({scope,text:'work'}),decisions=new DecisionService(store),d=decisions.begin(input.conversationId,'owner',[input.inputId]);
  const service=new TaskService(store);
  const context={...input,...d,principalId:'owner',execute:true,writeMemory:false};
  const task=service.spawn({...context,actionId:'spawn-one'},{title:'Instructed task',instructions:'Fix the drawer <script>alert(1)</script>',targetProfile:'default-worker'});
  expect(store.get('SELECT snapshot_json FROM tasks WHERE id=?',task.taskId)!.snapshot_json).not.toContain('"instructions"');

  const single=await reader.read('task',file,{taskId:task.taskId,sessionId:'session',probe:'single'});
  expect(single.instructions).toBe('Fix the drawer <script>alert(1)</script>');

  // revision > 1: an append-only answer row must resolve to the effective brief the
  // worker received, not the prior instructions with the answer text concatenated on.
  service.update({...context,actionId:'update-one'},task.taskId,1,'Fix the drawer <script>alert(1)</script>\n\nAnswer to q1: use the revisions table','when_ready');
  expect(store.get('SELECT COUNT(*) n FROM task_revisions WHERE task_id=?',task.taskId)!.n).toBe(2);
  const amended=await reader.read('task',file,{taskId:task.taskId,sessionId:'session',probe:'amended'});
  expect(amended.instructions).toBe('Fix the drawer <script>alert(1)</script>');
  expect(amended.snapshot.revision).toBe(2);

  // No revisions at all: report absence instead of inventing text.
  store.run('DELETE FROM task_revisions WHERE task_id=?',task.taskId);
  const empty=await reader.read('task',file,{taskId:task.taskId,sessionId:'session',probe:'empty'});
  expect(empty.instructions).toBeUndefined();
 }finally{await reader.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('compaction reader is read-only and separates bounded summaries from detail items',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dashboard-compaction-')),file=join(root,'db');
 const store=new OrchestrationStore(file,'a'),reader=new DashboardReader(join(process.cwd(),'dist/orchestration/dashboard-reader-worker.js'));
 try{
  expect(await reader.read('compaction',file,{agentId:'a'})).toEqual([]);
  expect(store.get("SELECT name FROM sqlite_master WHERE name='session_compaction_runs'")).toBeUndefined();
  store.run('CREATE TABLE session_compaction_runs(id TEXT PRIMARY KEY,started_at INTEGER,ended_at INTEGER,status TEXT,config_json TEXT)');
  store.run('CREATE TABLE session_compaction_items(run_id TEXT,session_id TEXT,payload_json TEXT,PRIMARY KEY(run_id,session_id))');
  store.transaction(()=>{
   for(let i=0;i<101;i++)store.run('INSERT INTO session_compaction_runs VALUES(?,?,?,?,?)','run-'+i,i,null,'completed','{}');
   for(let i=0;i<1001;i++)store.run('INSERT INTO session_compaction_items VALUES(?,?,?)','run-100','session-'+i,JSON.stringify({sessionId:'session-'+i,status:'completed',afterTokens:null}));
  });
  const runs=await reader.read('compaction',file,{agentId:'a'});
  expect(runs).toHaveLength(100);expect(runs[0]).toMatchObject({id:'run-100',itemCount:1001,completedSessions:1001});expect(runs[0].items).toBeUndefined();
  const detail=await reader.read('compaction',file,{agentId:'a',runId:'run-100'});expect(detail.items).toHaveLength(1000);expect(detail.itemCount).toBe(1001);expect(detail.items[0].afterTokens).toBeNull();
  expect(await reader.read('compaction',file,{agentId:'a',runId:'missing'})).toBeUndefined();
 }finally{await reader.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('Gateway-managed tasks retain target type across summary, session and request details without invented worker usage',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dashboard-gateway-task-')),file=join(root,'db');
 const store=new OrchestrationStore(file,'operator'),reader=new DashboardReader(join(process.cwd(),'dist/orchestration/dashboard-reader-worker.js'));
 try{
  const input=store.acceptInput({scope:{agentId:'operator',agentSessionId:'session',source:'api',accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'},text:'inspect'});
  const d=new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]);const service=new TaskService(store);
  const gatewayTarget={adapter:'safemode',sessionId:'11111111-1111-4111-8111-111111111111',name:'diagnostic'};
  const task=service.spawn({...input,...d,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'}, {title:'Inspect',instructions:'Inspect only',targetProfile:'gateway-managed',gatewayTarget});
  const attempt=service.claim(task.taskId)!;
  const summary=await reader.read('summary',file,{});
  expect(summary.sessions[0].tasks[0]).toMatchObject({executionType:'gateway-managed',gatewayTarget,tokenSummary:{totalTokens:null}});
  expect(summary.recentWork[0].gatewayTarget).toEqual(gatewayTarget);
  expect((await reader.read('session',file,{sessionId:'session'})).tasks[0].gatewayTarget).toEqual(gatewayTarget);
  const detail=await reader.read('task',file,{sessionId:'session',taskId:task.taskId,since:Date.now()-60000});
  expect(detail.attempts[0]).toMatchObject({attemptId:attempt.attemptId,executionType:'gateway-managed',sessionId:gatewayTarget.sessionId,metrics:null});
  expect((await reader.read('report',file,{sessionId:'session'})).turns.filter((t:any)=>t.role==='worker')).toEqual([]);
 }finally{await reader.close();store.close();rmSync(root,{recursive:true,force:true});}
});
