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

test('agentStepRunEnded and its SQL twin agree on every state/report/control combination',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const query=db.prepare(`SELECT ${agentStepRunEndedSql('t')} AS ended FROM (SELECT ? AS state,? AS snapshot_json) t`);
  let ended=0;
  for(const automationController of ['agent','user'] as const)
   for(const revision of [1,2])
    for(const state of ['waiting_input','running','completed'] as const)
     for(const activeAttemptId of [undefined,'a'])
      for(const phase of [undefined,'paused','applied'])
       for(const reason of [undefined,'COMMAND_WAITING_INPUT','THINKING_WAITING_INPUT'])
        for(const stopReason of [undefined,'ALL_STEPS_DONE','STEP_NO_EFFECT','STEP_NOT_EXECUTED']){
         const task={automationController,revision,state,...(activeAttemptId?{activeAttemptId}:{}),
          ...(phase?{executionControl:{id:'c',action:'pause',revision:2,phase,requestedAt:0}}:{}),
          ...(reason?{computerReport:{status:'needs_input',reason,steps:1,evaluations:0,...(stopReason?{stepRun:{total:2,completed:2,stopReason,remaining:[]}}:{})}}:{})} as unknown as TaskSnapshot;
         // Never NULL: the mailbox negates it, and NOT(NULL) would suppress nothing.
         const value=(query.get(state,JSON.stringify(task)) as {ended:number|null}).ended;
         expect([0,1]).toContain(value);const sql=value===1;
         expect({task,sql}).toEqual({task,sql:agentStepRunEnded(task)});
         if(sql)ended++;
        }
  // User-controlled revision 1, waiting, no attempt, not paused (2 phases), COMMAND_WAITING_INPUT, 2 stop reasons.
  expect(ended).toBe(4);
 }finally{db.close();}
});
