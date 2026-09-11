import {OrchestrationStore} from '../../../src/orchestration/store';
import {DecisionService} from '../../../src/orchestration/decisions';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {responseHasVoiceOrigin,voiceReplyAllowed} from '../../../src/orchestration/voice-reply-policy';

test('on/off/auto policy and legacy preferences remain compatible',()=>{
 const s=new OrchestrationStore(':memory:','a');try{
  expect(s.telegramVoiceMode('c')).toBe('off');
  s.run('INSERT INTO telegram_voice_preferences VALUES(?,?)','c',1);
  expect(s.telegramVoiceMode('c')).toBe('on');
  s.setTelegramVoiceMode('c','auto');expect(s.telegramVoiceMode('c')).toBe('auto');
  expect(s.get('SELECT enabled FROM telegram_voice_preferences WHERE chat_id=?','c')?.enabled).toBe(0);
  expect(voiceReplyAllowed('auto',true)).toBe(true);expect(voiceReplyAllowed('auto',false)).toBe(false);
  expect(voiceReplyAllowed('on',false)).toBe(true);expect(voiceReplyAllowed('off',true)).toBe(false);
  s.setTelegramVoice('c',true);expect(s.telegramVoiceMode('c')).toBe('on');
  s.setTelegramVoice('c',false);expect(s.telegramVoiceMode('c')).toBe('off');
  expect(()=>s.setTelegramVoiceMode('c','bad' as never)).toThrow('INVALID_VOICE_MODE');
 }finally{s.close();}
});

test.each([['voice_note','text',false],['text','voice_note',true],['text','text',false]] as const)('task result follows its latest instruction across %s → %s', (first,second,expected)=>{
 const s=new OrchestrationStore(':memory:','a'), decisions=new DecisionService(s), tasks=new TaskService(s,{tasks:{workspaceMode:'host'}});
 const scope={agentId:'a',agentSessionId:'s',source:'telegram' as const,accountId:'bot',principalId:'p',chatId:'c',threadKey:''};
 const step=(modality:'voice_note'|'text',prior?:string)=>{
  const i=s.acceptInput({scope,text:'do work',modality});const d=decisions.begin(i.conversationId,'p',[i.inputId]);
  expect(responseHasVoiceOrigin(s,d.responseId!)).toBe(modality==='voice_note');
  const t=tasks.spawn({...i,...d,principalId:'p',execute:true,writeMemory:false,actionId:i.inputId},{title:'step',instructions:'work',targetProfile:'default-worker',continueTaskId:prior});
  decisions.finish(d,'Queued');return t;
 };
 try{
  const a=step(first),b=step(second,a.taskId);
  // Complete both before the report decision, with persisted notification origins.
  for(const t of [a,b]){const attempt=tasks.claim(t.taskId)!;tasks.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'Done',artifactIds:[]}});}
  // Report only the second task to exercise traversal, not the first notification.
  s.run("UPDATE notifications SET status='handled' WHERE task_id=?",a.taskId);
  const i=s.acceptInput({scope,text:'Report',modality:'text',storeUserMessage:false});const d=decisions.begin(i.conversationId,'p',[i.inputId]);
  expect(responseHasVoiceOrigin(s,d.responseId!)).toBe(expected);
  expect(responseHasVoiceOrigin(s,'missing')).toBe(false);
 }finally{s.close();}
});

test.each(['telegram','discord','line','slack'] as const)('%s: text after voice does not inherit pending voice task audio', source => {
 const s=new OrchestrationStore(':memory:','a'), decisions=new DecisionService(s), tasks=new TaskService(s,{tasks:{workspaceMode:'host'}});
 const scope={agentId:'a',agentSessionId:'s',source,accountId:'bot',principalId:'p',chatId:'c',threadKey:''};
 try {
  const voice=s.acceptInput({scope,text:'do work',modality:'voice_note'});
  const first=decisions.begin(voice.conversationId,'p',[voice.inputId]);
  expect(responseHasVoiceOrigin(s,first.responseId!)).toBe(true);
  const task=tasks.spawn({...voice,...first,principalId:'p',execute:true,writeMemory:false,actionId:voice.inputId},
   {title:'step',instructions:'work',targetProfile:'default-worker'});
  decisions.finish(first,'Working');
  const attempt=tasks.claim(task.taskId)!;
  tasks.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'Done',artifactIds:[]}});
  const text=s.acceptInput({scope,text:'what next?',modality:'text'});
  const next=decisions.begin(text.conversationId,'p',[text.inputId]);
  expect(s.all('SELECT task_id FROM notifications WHERE decision_id=?',next.decisionId)).toHaveLength(1);
  expect(responseHasVoiceOrigin(s,next.responseId!)).toBe(false);
  decisions.finish(next,'Next');
  const again=s.acceptInput({scope,text:'another question',modality:'text'});
  const last=decisions.begin(again.conversationId,'p',[again.inputId]);
  expect(responseHasVoiceOrigin(s,last.responseId!)).toBe(false);
 } finally {s.close();}
});

test('a background result for a voice task still receives audio without a new user turn', () => {
 const s=new OrchestrationStore(':memory:','a'), decisions=new DecisionService(s), tasks=new TaskService(s,{tasks:{workspaceMode:'host'}});
 const scope={agentId:'a',agentSessionId:'s',source:'telegram' as const,accountId:'bot',principalId:'p',chatId:'c',threadKey:''};
 try {
  const i=s.acceptInput({scope,text:'do work',modality:'voice_note'}), d=decisions.begin(i.conversationId,'p',[i.inputId]);
  const task=tasks.spawn({...i,...d,principalId:'p',execute:true,writeMemory:false,actionId:i.inputId},{title:'step',instructions:'work',targetProfile:'default-worker'});
  decisions.finish(d,'Working');
  const attempt=tasks.claim(task.taskId)!;tasks.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'Done',artifactIds:[]}});
  const report=s.acceptInput({scope,text:'Report',storeUserMessage:false});
  const reply=decisions.begin(report.conversationId,'p',[report.inputId]);
  expect(responseHasVoiceOrigin(s,reply.responseId!)).toBe(true);
 } finally {s.close();}
});
