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
  expect(session.tokenSummary).toEqual({agentTokens:10,workerTokens:30,totalTokens:40});
  expect(session.tasks[0].tokenSummary).toEqual({totalTokens:30,allAttemptsTokens:30});
  expect(session.tasks[0].loadedTools).toEqual(['Bash','Read']);expect(session.tasks[0].usedTools).toEqual(['Read']);
  expect(one.sessions.find((s:any)=>s.sessionId.startsWith('old-')).tokenSummary.totalTokens).toBeNull();
  expect(await reader.read('task',file,{taskId:task.taskId,sessionId:'wrong'})).toBeUndefined();
  const detail=await reader.read('task',file,{taskId:task.taskId,sessionId:'session'});
  expect(detail.attempts[0].attemptId).toBe(attempt.attemptId);expect(detail.snapshot.result.summary).toBe('result');
  const report=await reader.read('report',file,{sessionId:'session'});expect(report.totals.totalTokens).toBe(40);expect(report.turns[1].responseText).toBe('result');
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
