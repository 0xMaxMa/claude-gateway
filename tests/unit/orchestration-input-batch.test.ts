import { OrchestrationStore, AcceptInput } from '../../src/orchestration/store';
import { inputBatch, batchableInput } from '../../src/orchestration/input-batch';
import { resolveOrchestrationConfig } from '../../src/orchestration/config';
import { resolveSkill } from '../../src/orchestration/skills';
const scope={agentId:'a',agentSessionId:'s',source:'telegram' as const,accountId:'bot',chatId:'chat',threadKey:'',principalId:'p'};
const base:AcceptInput={scope,text:'first fragment',capabilities:{execute:true,writeMemory:false}};

test.each([
  {storeUserMessage:false}, {modality:'live_voice' as const}, {modality:'voice_note' as const},
  {skill:{name:'fixture-skill',args:'',content:'',filePath:'/fixture/SKILL.md'}}, {requestId:'request'}, {scope:{...scope,source:'api' as const}},
  {metadata:{executionTaskId:'task'}},
])('controls and independently scoped requests bypass batching: %j',change=>{
  expect(batchableInput({...base,...change})).toBe(false);
});

test.each([
  {model:'different-model'}, {capabilities:{execute:false,writeMemory:false}},
  {scope:{...scope,principalId:'other'}}, {metadata:{repliedMessageId:'other-message'}}, {skill:{name:'fixture-skill',args:'',content:'',filePath:'/fixture/SKILL.md'}},
])('a boundary stops the batch without swallowing the next request: %j',change=>{
  const store=new OrchestrationStore(':memory:','a');
  try{
    const first=store.acceptInput(base);
    if ('scope' in change) store.run("INSERT INTO conversation_members VALUES(?,?,'member')",first.conversationId,'other');
    store.acceptInput({...base,text:'second',...change});
    const row=store.get('SELECT * FROM conversation_inputs WHERE id=?',first.inputId)!;
    expect(inputBatch(store,row,1500,8000).inputIds).toEqual([first.inputId]);
  }finally{store.close();}
});

test('quiet timer extends for new fragments, with a bounded maximum from first ingress',()=>{
  const store=new OrchestrationStore(':memory:','a');
  try{
    const a=store.acceptInput(base),b=store.acceptInput({...base,text:'second'});
    store.run('UPDATE conversation_inputs SET created_at=1000 WHERE id=?',a.inputId);
    store.run('UPDATE conversation_inputs SET created_at=2000 WHERE id=?',b.inputId);
    const row=store.get('SELECT * FROM conversation_inputs WHERE id=?',a.inputId)!;
    expect(inputBatch(store,row,1500,8000).readyAt).toBe(3500);
    store.run('UPDATE conversation_inputs SET created_at=8800 WHERE id=?',b.inputId);
    expect(inputBatch(store,row,1500,8000).readyAt).toBe(9000);
    expect(inputBatch(store,row,0,8000).inputIds).toEqual([a.inputId]);
  }finally{store.close();}
});

test('batch configuration supports disabling and rejects an unbounded or contradictory wait',()=>{
  expect(resolveOrchestrationConfig({conversation:{inputDebounceMs:0}}).conversation.inputDebounceMs).toBe(0);
  expect(()=>resolveOrchestrationConfig({conversation:{inputDebounceMs:9000,inputMaxWaitMs:8000}})).toThrow();
  expect(()=>resolveOrchestrationConfig({conversation:{inputMaxWaitMs:30001}})).toThrow();
});

test('a burst stays within the worker context-reference limit without dropping later inputs',()=>{
  const store=new OrchestrationStore(':memory:','a');
  try{
    const first=store.acceptInput(base);
    for(let i=0;i<70;i++)store.acceptInput({...base,text:`fragment ${i}`});
    const batch=inputBatch(store,store.get('SELECT * FROM conversation_inputs WHERE id=?',first.inputId)!,1500,8000);
    expect(batch.inputIds).toHaveLength(64);
    expect(store.get("SELECT count(*) n FROM conversation_inputs WHERE status='accepted'")!.n).toBe(71);
  }finally{store.close();}
});

test.each(['telegram','discord','line','slack','whatsapp','whatsapp_cloud','wechat'] as const)('every chat channel batches human text: %s',source=>{
  expect(batchableInput({...base,scope:{...scope,source}})).toBe(true);
});

test('text that merely starts with a slash is ordinary user text, not a command',()=>{
  // Builtin commands are answered before the mailbox and skills are tagged at ingress.
  expect(batchableInput({...base,text:'/home/user/app.log check this file'})).toBe(true);
  const store=new OrchestrationStore(':memory:','a');
  try{
    const first=store.acceptInput(base),second=store.acceptInput({...base,text:'/home/user/app.log too'});
    expect(inputBatch(store,store.get('SELECT * FROM conversation_inputs WHERE id=?',first.inputId)!,1500,8000).inputIds).toEqual([first.inputId,second.inputId]);
  }finally{store.close();}
});

test('in-flight inputs are re-admitted so a running batch can be compared with the next one',()=>{
  const store=new OrchestrationStore(':memory:','a');
  try{
    const a=store.acceptInput(base),b=store.acceptInput({...base,text:'second'});
    store.run("UPDATE conversation_inputs SET status='assigned'");
    const row=store.get('SELECT * FROM conversation_inputs WHERE id=?',a.inputId)!;
    expect(inputBatch(store,row,1500,8000).inputIds).toEqual([a.inputId]);
    expect(inputBatch(store,row,1500,8000,[a.inputId,b.inputId]).inputIds).toEqual([a.inputId,b.inputId]);
    const c=store.acceptInput({...base,text:'third'});
    expect(inputBatch(store,row,1500,8000,[a.inputId,b.inputId]).inputIds).toEqual([a.inputId,b.inputId,c.inputId]);
  }finally{store.close();}
});

test('a skill-shaped command unresolved at ingress stays alone so the turn can still resolve it',()=>{
  // e.g. received while the CLI skill list refreshes, or the skill was installed after receipt.
  expect(batchableInput({...base,text:'/review-pr 567'})).toBe(false);
  expect(batchableInput({...base,text:'/review-pr@my_bot 567'})).toBe(false);
  const registry={skills:new Map(),cliSkills:[{name:'review-pr',description:'Review a PR'}]};
  const store=new OrchestrationStore(':memory:','a');
  try{
    const chat=store.acceptInput(base);
    const command=store.acceptInput({...base,text:'/review-pr 567'});
    store.acceptInput({...base,text:'focus on the batching change'});
    const row=(id:string)=>store.get('SELECT * FROM conversation_inputs WHERE id=?',id)!;
    // A chat burst ends before the command instead of absorbing it.
    expect(inputBatch(store,row(chat.inputId),1500,8000).inputIds).toEqual([chat.inputId]);
    const batch=inputBatch(store,row(command.inputId),1500,8000);
    expect(batch.inputIds).toEqual([command.inputId]);
    expect(resolveSkill(batch.input.text,'telegram',registry)?.name).toBe('review-pr');
  }finally{store.close();}
});
