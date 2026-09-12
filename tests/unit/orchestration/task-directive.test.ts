import { normalizeTaskRevisions, taskDirective } from '../../../src/orchestration/tasks/task-directive';
import { TaskRevision } from '../../../src/orchestration/types';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
const initial:TaskRevision={taskId:'t',revision:1,instructions:'Keep position. Do not push yet.',contextRefs:[],mode:'when_ready',originatingInputId:'one'};
test('legacy answers are separated without destroying original instructions, explicit updates replace the old brief',()=>{
 const second={...initial,revision:2,instructions:initial.instructions+'\n\nAnswer to q1: Move below. Push approved.',originatingInputId:'two'};
 const third={...second,revision:3,instructions:second.instructions+'\n\nAnswer to q2: Refer to input two.',originatingInputId:'three'};
 const normalized=normalizeTaskRevisions([initial,second,third]);
 expect(normalized.instructions).toBe(initial.instructions);
 expect(normalized.answers).toEqual([{questionId:'q1',text:'Move below. Push approved.',inputId:'two'},{questionId:'q2',text:'Refer to input two.',inputId:'three'}]);
 expect(normalizeTaskRevisions([initial,second,third,{...initial,revision:4,instructions:'New complete brief'}]).answers).toBeUndefined();
});
test('answers persist separately and worker receives prior user approval, not only the later status question',()=>{
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),decisions=new DecisionService(store);
 const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'owner',chatId:'c',threadKey:'',principalId:'owner'};
 try {
  const input=store.acceptInput({scope,text:'Move below and push.'}),decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
  const ctx={...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'};
  const task=tasks.spawn(ctx,{title:'Reorder',instructions:initial.instructions,targetProfile:'default-worker'}),attempt=tasks.claim(task.taskId)!;
  tasks.started(attempt.attemptId,attempt.generation);
  const question=tasks.requestInput(attempt.attemptId,attempt.generation,'Confirm moving?');
  decisions.finish(decision,'Working');
  const followup=store.acceptInput({scope,text:'Why is it stuck?'}),next=decisions.begin(followup.conversationId,'owner',[followup.inputId]);
  tasks.answer({...ctx,...followup,...next,actionId:'answer'},task.taskId,question.pendingQuestion!.questionId,'Move below; approval is in '+input.inputId);
  const revision=tasks.revision(task.taskId,2);
  expect(revision.instructions).toBe(initial.instructions);
  expect(revision.answers?.[0].inputId).toBe(followup.inputId);
  store.acceptInput({scope:{...scope,agentSessionId:'other',chatId:'other'},text:'Secret other conversation'});
  store.acceptInput({scope,text:'Future instruction must not appear'});
  const prompt=taskDirective(store,input.conversationId,revision);
  expect(prompt).toContain('Move below and push.');expect(prompt).toContain('Why is it stuck?');
  expect(prompt).not.toContain('Secret other conversation');expect(prompt).not.toContain('Future instruction');
  expect(prompt.indexOf('Latest answer')).toBeLessThan(prompt.indexOf('Initial/current task brief'));
  expect(prompt).toContain('not a verbatim user quote');
 }finally{store.close();}
});
