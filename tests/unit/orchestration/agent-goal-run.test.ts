import {DatabaseSync} from 'node:sqlite';
import {agentGoalRun,agentGoalRunSql} from '../../../src/orchestration/tasks/automation-session';
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
