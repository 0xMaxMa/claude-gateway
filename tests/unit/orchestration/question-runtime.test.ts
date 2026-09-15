import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';
import { SessionProcess } from '../../../src/session/process';

async function fixture() {
 const root=mkdtempSync(join(tmpdir(),'question-runtime-')),dir=join(root,'a'),workspace=join(dir,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const agent={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]},orchestration:{conversation:{semanticIntake:true}}} as AgentConfig;
 const gateway={gateway:{orchestration:true,headless:true},agents:[agent]} as GatewayConfig;
 const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a'),sid=randomUUID();
 await sessions.ensureApiSession('a','chat',sid);
 const createAgentSession=jest.fn();
 const runtime=await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{createAgentSession,releaseAgentSession:async()=>{}});
 const scope={agentId:'a',agentSessionId:sid,source:'api' as const,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
 const input=runtime.store.acceptInput({scope,text:'Prepare deployment',capabilities:{execute:true,writeMemory:false}}),decision=runtime.decisions.begin(input.conversationId,'owner',[input.inputId]);
 const task=runtime.tasks.spawn({...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'}, {title:'Deploy',instructions:'Ask which target',targetProfile:'default-worker'});
 const attempt=runtime.tasks.claim(task.taskId)!;runtime.tasks.started(attempt.attemptId,attempt.generation);
 runtime.tasks.requestInput(attempt.attemptId,attempt.generation,'Which environment?');runtime.decisions.finish(decision,'Preparing');
 runtime.questionControls.tick();
 const question=runtime.store.task(task.taskId)!.pendingQuestion!;
 return {runtime,scope,question,task,createAgentSession,close:async()=>{await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}};
}

test('explicit answer is saved and streamed once while another model turn is active',async()=>{
 const f=await fixture();
 try{
  const seen=jest.fn();f.runtime.subscribeText(f.scope.agentSessionId,'owner',seen);
  const active=(f.runtime as any).active as Map<string,unknown>;
  active.set(f.scope.agentSessionId,{stopping:false});
  const input={scope:f.scope,text:`/task_question ${f.question.questionId} answer staging`,ingressKey:'answer-message'};
  expect(await f.runtime.send(input,{execute:true,writeMemory:false},{timeoutMs:1000})).toContain('Answer received');
  expect(f.createAgentSession).not.toHaveBeenCalled();
  expect(seen).toHaveBeenCalledTimes(1);
  const submitted=f.runtime.submitInput(input,{execute:true,writeMemory:false});
  expect(await submitted.response).toContain('Answer received');
  expect(seen).toHaveBeenCalledTimes(1);
  expect(f.runtime.tasks.revision(f.task.taskId,2).answers).toHaveLength(1);
  expect(f.runtime.store.get("SELECT COUNT(*) n FROM conversation_inputs WHERE status='accepted'")!.n).toBe(0);
  active.delete(f.scope.agentSessionId);
 }finally{(f.runtime as any).active.clear();await f.close();}
});

test.each(['text','live_voice'] as const)('natural %s answer still goes through model task matching, without new-task acknowledgement gate',async modality=>{
 const f=await fixture();
 try{
  let ticketScope:any;
  const issue=f.runtime.bridge.issue.bind(f.runtime.bridge);
  jest.spyOn(f.runtime.bridge,'issue').mockImplementation((scope,...args)=>{ticketScope=scope;return issue(scope,...args);});
  const newTaskAttempt=jest.fn();
  f.createAgentSession.mockImplementation(async(_id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){
    const emitter=this;
    void(async()=>{
      emitter.emit('output',JSON.stringify({type:'system',subtype:'init',tools:[]}));
      try { await ticketScope.beforeMutation('task_spawn',{task_id:f.task.taskId}); }
      catch(error){newTaskAttempt(error);}
      await ticketScope.beforeMutation('task_answer',{task_id:f.task.taskId,question_id:f.question.questionId,answer:'staging'});
      f.runtime.tasks.answer({...ticketScope.context,actionId:'interpreted-answer'},f.task.taskId,f.question.questionId,'staging');
      emitter.emit('output',JSON.stringify({type:'result',result:'Answer saved.'}));
    })().catch(error=>emitter.emit('error',error));
  }}) as unknown as SessionProcess);
  expect(await f.runtime.send({scope:f.scope,text:'Use staging please',modality},{execute:true,writeMemory:false},{timeoutMs:5000})).toBe('Answer saved.');
  expect(f.createAgentSession).toHaveBeenCalledTimes(1);
  expect(newTaskAttempt).toHaveBeenCalledWith(expect.objectContaining({code:'ACKNOWLEDGEMENT_REQUIRED'}));
  expect(f.runtime.tasks.revision(f.task.taskId,2).answers?.[0].text).toBe('staging');
 }finally{await f.close();}
});
