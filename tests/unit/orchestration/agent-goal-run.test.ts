import {DatabaseSync} from 'node:sqlite';
import {agentGoalRun,agentGoalRunSql,agentGoalRunParked,agentGoalRunParkedSql,agentRound,agentRoundEnded,agentRoundSql,parkedRoundCapped,PARKED_WAKE_LIMIT} from '../../../src/orchestration/tasks/automation-session';
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

test('agentGoalRunParked and its SQL twin agree on every state/report/question/control combination',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const query=db.prepare(`SELECT ${agentGoalRunParkedSql('t')} AS ended FROM (SELECT ? AS state,? AS snapshot_json) t`);
  let ended=0;
  // Questions the owner answers, recorded on the task or its report.
  const questions={none:{},pending:{task:{pendingQuestion:{questionId:'q',text:'?',revision:1}}},field:{report:{fieldRequest:{label:'Name',reason:'missing'}}},
   confirm:{report:{lastAction:{kind:'press',label:'Delete',blocked:true,confirm:true}}},
   askedInTrace:{report:{trace:[{phase:'waiting',reason:'CONFIRMATION_REQUIRED',sequence:1,round:1,at:1,revision:1,steps:1,evaluations:1}]}},
   browserConfirm:{report:{commandOutcome:{done:false,reason:'CONFIRMATION_REQUIRED'}}},declined:{report:{lastAction:{kind:'press',label:'Delete',blocked:true,confirm:false}}}} as const;
  for(const automationController of ['agent','user'] as const)
   for(const revision of [1,2])
    for(const state of ['waiting_input','running','completed'] as const)
     for(const activeAttemptId of [undefined,'a'])
      for(const phase of [undefined,'paused','applied'])
       for(const surface of ['computerReport','browserReport'] as const)
        for(const reason of [undefined,'COMMAND_WAITING_INPUT','THINKING_WAITING_INPUT','COMPLETION_CANDIDATE','VERIFICATION_FAILED','FIELD_TEXT_REQUIRED','GOAL_REACHED'])
         for(const stopReason of [undefined,'ALL_STEPS_DONE','STEP_NO_EFFECT','STEP_NOT_EXECUTED','OUTCOME_UNKNOWN'])
          for(const [question,ask] of Object.entries(questions) as [string,{task?:object;report?:object}][]){
           // A browser lastAction never carries a confirmation; its question lives elsewhere.
           if(surface==='browserReport'&&['confirm','askedInTrace'].includes(question))continue;
           if(surface==='computerReport'&&question==='browserConfirm')continue;
           const task={automationController,revision,state,...(activeAttemptId?{activeAttemptId}:{}),...ask.task,
            ...(phase?{executionControl:{id:'c',action:'pause',revision:2,phase,requestedAt:0}}:{}),
            ...(reason?{[surface]:{status:'needs_input',reason,steps:1,evaluations:0,...ask.report,...(stopReason?{stepRun:{total:2,completed:1,stopReason,remaining:[]}}:{})}}:{})} as unknown as TaskSnapshot;
           // Never NULL: the mailbox negates it, and NOT(NULL) would suppress nothing.
           const value=(query.get(state,JSON.stringify(task)) as {ended:number|null}).ended;
           expect([0,1]).toContain(value);const sql=value===1;
           expect({task,sql}).toEqual({task,sql:agentGoalRunParked(task)});
           if(sql)ended++;
          }
  // User-controlled revision 1, waiting, no attempt, not paused (2 phases), 2 surfaces,
  // a waiting-for-command reason (4), with or without a step run (5), no question or a
  // declined one (2). Pod 2.0.21 (fa17f432): a goal loop without a step run counts too.
  expect(ended).toBe(2*2*4*5*2);
 }finally{db.close();}
});

// Pod-jinawong 2.1.12 (tasks 059a5cac rev 3, 2aefd7a9 rev 2): a computer round the agent commanded after revision 1 (its
// command for a hand-off or a parked round, or a run resumed by an answer) parks for the agent too, up to its command cap.
test('agentGoalRunParked and its SQL twin agree on later computer rounds, hand-offs, answers and the command cap',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const query=db.prepare(`SELECT ${agentGoalRunParkedSql('t')} AS parked FROM (SELECT ? AS state,? AS snapshot_json) t`);
  const counts={parked:0,capped:0};
  for(const adapter of ['computer','browser'] as const)
   for(const automationController of ['agent','user'] as const)
    for(const revision of [1,2,3])
     for(const control of ['none','user','handoff','older'] as const)
      for(const agentCommands of [undefined,1,PARKED_WAKE_LIMIT-1,PARKED_WAKE_LIMIT])
       for(const reason of ['COMMAND_WAITING_INPUT','FIELD_TEXT_REQUIRED']){
        const executionControl=control==='none'?undefined:{id:'c',action:'revise',revision:control==='older'?revision-1:revision,phase:'applied',requestedAt:0,...(control==='handoff'?{agentHandoff:true}:{})};
        const task={automationController,revision,state:'waiting_input',gatewayTarget:{adapter,sessionId:'s',name:'n'},...(executionControl?{executionControl}:{}),
         ...(agentCommands===undefined?{}:{agentCommands}),[adapter==='computer'?'computerReport':'browserReport']:{status:'needs_input',reason,steps:1,evaluations:1}} as unknown as TaskSnapshot;
        const value=(query.get('waiting_input',JSON.stringify(task)) as {parked:number|null}).parked;
        expect([0,1]).toContain(value);
        expect({task,sql:value===1}).toEqual({task,sql:agentGoalRunParked(task)});
        if(value===1)counts.parked++;
        if(parkedRoundCapped(task)){counts.capped++;expect(agentGoalRunParked(task)).toBe(false);expect(agentRound(task)).toBe(true);}
       }
  // User-controlled, a waiting-for-command reason, below the cap (3 of 4 counts). Revision 1 as before, on both surfaces:
  // no command of revision 1 (none, older). Later revisions, computer only: none, older (an answer) and handoff.
  expect(counts.parked).toBe((2*2+3*2)*3);
  expect(counts.capped).toBe(2*2+3*2);
 }finally{db.close();}
});

// Pod-jinawong r14, task f3042fe1 rev 5: the agent's handoff command failed and its notification stayed pending, since
// only revision 1 counted as the agent's own run. agentRoundEnded (any agentRound, ended) wakes it to report.
test('agentRoundEnded and its SQL twin (agentRoundSql) agree on every state, surface, controller, revision and command',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const query=db.prepare(`SELECT (state IN ('completed','failed','needs_reconciliation') AND ${agentRoundSql('t')}) AS ended FROM (SELECT ? AS state,? AS snapshot_json) t`);
  let ended=0;
  for(const adapter of ['computer','browser'] as const)
   for(const automationController of ['agent','user'] as const)
    for(const revision of [1,2,5])
     for(const control of ['none','user','handoff','older'] as const)
      for(const state of ['completed','failed','needs_reconciliation','cancelled','waiting_input','running'] as const){
       const executionControl=control==='none'?undefined:{id:'c',action:'revise',revision:control==='older'?revision-1:revision,phase:'applied',requestedAt:0,...(control==='handoff'?{agentHandoff:true}:{})};
       const task={automationController,revision,state,gatewayTarget:{adapter,sessionId:'s',name:'n'},...(executionControl?{executionControl}:{})} as unknown as TaskSnapshot;
       const value=Number((query.get(state,JSON.stringify(task)) as {ended:number|null}).ended);
       expect({task,sql:value===1}).toEqual({task,sql:agentRoundEnded(task)});
       if(value===1)ended++;
      }
  // User-controlled and ended (3 states). Revision 1 on both surfaces without a command of revision 1 (none, older);
  // later revisions on a computer: none, older (an answer run) and the agent's handoff command. The user's own never.
  expect(ended).toBe((2*2+2*3)*3);
  expect(agentRoundEnded({automationController:'user',revision:5,state:'failed',gatewayTarget:{adapter:'computer',sessionId:'s',name:'n'},executionControl:{id:'c',action:'revise',revision:5,phase:'applied',requestedAt:0}} as unknown as TaskSnapshot)).toBe(false);
 }finally{db.close();}
});
