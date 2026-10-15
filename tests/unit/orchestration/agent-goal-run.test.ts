import {DatabaseSync} from 'node:sqlite';
import {agentGoalRun,agentGoalRunSql,agentStepRunEnded,agentStepRunEndedSql} from '../../../src/orchestration/tasks/automation-session';
import type {TaskSnapshot} from '../../../src/orchestration/types';

// The computer adapter (sessionStart) and the notification mailbox (the goal run's
// end) read the same predicate: one in TypeScript, one in SQL. They must agree.
test('agentGoalRun and its SQL twin agree on every controller/revision/command combination',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const query=db.prepare(`SELECT ${agentGoalRunSql('t')} AS goal FROM (SELECT ? AS snapshot_json) t`);
  let goalRuns=0;
  for(const automationController of [undefined,'agent','user'] as const)
   for(const revision of [1,2,3])
    for(const executionRevision of [undefined,1,2,3]){
     const task={automationController,revision,...(executionRevision===undefined?{}:{executionControl:{id:'c',action:'revise',revision:executionRevision,phase:'applied',requestedAt:0}})} as unknown as TaskSnapshot;
     const sql=Number((query.get(JSON.stringify(task)) as {goal:number}).goal)===1;
     expect({task,sql}).toEqual({task,sql:agentGoalRun(task)});
     if(sql)goalRuns++;
    }
  // Revision 1, user-controlled, with no or a non-first-revision command.
  expect(goalRuns).toBe(3);
 }finally{db.close();}
});

test('agentStepRunEnded and its SQL twin agree on every state/report/question/control combination',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const query=db.prepare(`SELECT ${agentStepRunEndedSql('t')} AS ended FROM (SELECT ? AS state,? AS snapshot_json) t`);
  let ended=0;
  // Questions the owner answers, recorded on the task or its report.
  const questions={none:{},pending:{task:{pendingQuestion:{questionId:'q',text:'?',revision:1}}},field:{report:{fieldRequest:{label:'Name',reason:'missing'}}},
   confirm:{report:{lastAction:{kind:'press',label:'Delete',blocked:true,confirm:true}}},declined:{report:{lastAction:{kind:'press',label:'Delete',blocked:true,confirm:false}}}} as const;
  for(const automationController of ['agent','user'] as const)
   for(const revision of [1,2])
    for(const state of ['waiting_input','running','completed'] as const)
     for(const activeAttemptId of [undefined,'a'])
      for(const phase of [undefined,'paused','applied'])
       for(const surface of ['computerReport','browserReport'] as const)
        for(const reason of [undefined,'COMMAND_WAITING_INPUT','THINKING_WAITING_INPUT'])
         for(const stopReason of [undefined,'ALL_STEPS_DONE','STEP_NO_EFFECT','STEP_NOT_EXECUTED','OUTCOME_UNKNOWN'])
          for(const [question,ask] of Object.entries(questions) as [string,{task?:object;report?:object}][]){
           // A browser lastAction never carries a confirmation; its question lives elsewhere.
           if(surface==='browserReport'&&question==='confirm')continue;
           const task={automationController,revision,state,...(activeAttemptId?{activeAttemptId}:{}),...ask.task,
            ...(phase?{executionControl:{id:'c',action:'pause',revision:2,phase,requestedAt:0}}:{}),
            ...(reason?{[surface]:{status:'needs_input',reason,steps:1,evaluations:0,...ask.report,...(stopReason?{stepRun:{total:2,completed:1,stopReason,remaining:[]}}:{})}}:{})} as unknown as TaskSnapshot;
           // Never NULL: the mailbox negates it, and NOT(NULL) would suppress nothing.
           const value=(query.get(state,JSON.stringify(task)) as {ended:number|null}).ended;
           expect([0,1]).toContain(value);const sql=value===1;
           expect({task,sql}).toEqual({task,sql:agentStepRunEnded(task)});
           if(sql)ended++;
          }
  // User-controlled revision 1, waiting, no attempt, not paused (2 phases), 2 surfaces,
  // COMMAND_WAITING_INPUT, 4 stop reasons, no question or a declined one (2).
  expect(ended).toBe(2*2*4*2);
 }finally{db.close();}
});
