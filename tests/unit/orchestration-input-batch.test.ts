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

describe('client-split long messages without semantic intake (#593)',()=>{
  const long=(n:number)=>'x'.repeat(n);
  const at=(store:OrchestrationStore,id:string,ms:number)=>store.run('UPDATE conversation_inputs SET created_at=? WHERE id=?',ms,id);
  const row=(store:OrchestrationStore,id:string)=>store.get('SELECT * FROM conversation_inputs WHERE id=?',id)!;

  test('a near-limit part and its continuation 200 ms later form one batch after the quiet window',()=>{
    const store=new OrchestrationStore(':memory:','a');
    try{
      const a=store.acceptInput({...base,text:long(4064)}),b=store.acceptInput({...base,text:long(277)});
      at(store,a.inputId,1000);at(store,b.inputId,1200);
      const batch=inputBatch(store,row(store,a.inputId),1500,8000,[],true);
      expect(batch.inputIds).toEqual([a.inputId,b.inputId]);
      // The short final part ends the message, so nothing more is awaited.
      expect(batch.readyAt).toBe(0);
      expect(batch.input.text).toContain(long(277));
    }finally{store.close();}
  });

  test('a lone near-limit part waits for a continuation, bounded by the maximum wait',()=>{
    const store=new OrchestrationStore(':memory:','a');
    try{
      const a=store.acceptInput({...base,text:long(4090)});
      at(store,a.inputId,1000);
      expect(inputBatch(store,row(store,a.inputId),1500,8000,[],true).readyAt).toBe(2500);
      const b=store.acceptInput({...base,text:long(4019)});at(store,b.inputId,2400);
      expect(inputBatch(store,row(store,a.inputId),1500,8000,[],true).readyAt).toBe(3900);
      expect(inputBatch(store,row(store,a.inputId),1500,2000,[],true).readyAt).toBe(3000);
    }finally{store.close();}
  });

  test('short messages are never delayed or merged',()=>{
    const store=new OrchestrationStore(':memory:','a');
    try{
      const a=store.acceptInput(base),b=store.acceptInput({...base,text:'second'});
      at(store,a.inputId,1000);at(store,b.inputId,1100);
      const batch=inputBatch(store,row(store,a.inputId),1500,8000,[],true);
      expect(batch.inputIds).toEqual([a.inputId]);
      expect(batch.readyAt).toBe(0);
    }finally{store.close();}
  });

  test('a message long after a near-limit part is not treated as its continuation',()=>{
    const store=new OrchestrationStore(':memory:','a');
    try{
      const a=store.acceptInput({...base,text:long(4000)}),b=store.acceptInput({...base,text:'later'});
      at(store,a.inputId,1000);at(store,b.inputId,60000);
      expect(inputBatch(store,row(store,a.inputId),1500,8000,[],true).inputIds).toEqual([a.inputId]);
    }finally{store.close();}
  });

  test.each([
    ['a skill-shaped command', {text:'/review-pr 567'}],
    ['a recorded voice note', {modality:'voice_note' as const}],
    ['an API request', {requestId:'request'}],
  ])('%s right after a long part is not merged',(_label,change)=>{
    const store=new OrchestrationStore(':memory:','a');
    try{
      const a=store.acceptInput({...base,text:long(4064)}),b=store.acceptInput({...base,text:'short',...change});
      at(store,a.inputId,1000);at(store,b.inputId,1100);
      expect(inputBatch(store,row(store,a.inputId),1500,8000,[],true).inputIds).toEqual([a.inputId]);
    }finally{store.close();}
  });

  test('a reply-first split keeps the reply, but different replies stay apart',()=>{
    const store=new OrchestrationStore(':memory:','a');
    try{
      const replied={repliedMessageId:'m1',repliedText:'quoted',repliedSender:'bot'};
      const a=store.acceptInput({...base,text:long(4064),metadata:replied}),b=store.acceptInput({...base,text:long(277)});
      at(store,a.inputId,1000);at(store,b.inputId,1200);
      const batch=inputBatch(store,row(store,a.inputId),1500,8000,[],true);
      expect(batch.inputIds).toEqual([a.inputId,b.inputId]);
      expect(batch.input.metadata).toMatchObject(replied);
      // Semantic intake keeps its reply boundary unchanged.
      expect(inputBatch(store,row(store,a.inputId),1500,8000).inputIds).toEqual([a.inputId]);
      const c=store.acceptInput({...base,text:long(4064),metadata:replied}),d=store.acceptInput({...base,text:'tail',metadata:{repliedMessageId:'m2'}});
      at(store,c.inputId,5000);at(store,d.inputId,5100);
      expect(inputBatch(store,row(store,c.inputId),1500,8000,[],true).inputIds).toEqual([c.inputId]);
    }finally{store.close();}
  });

  test('a part cut at a paragraph break past half the limit is still a split part',()=>{
    const store=new OrchestrationStore(':memory:','a');
    try{
      // Observed live: 2957 chars, continuation 482 ms later.
      const a=store.acceptInput({...base,text:long(2957)}),b=store.acceptInput({...base,text:long(1814)});
      at(store,a.inputId,1000);at(store,b.inputId,1482);
      expect(inputBatch(store,row(store,a.inputId),1500,8000,[],true).inputIds).toEqual([a.inputId,b.inputId]);
      const c=store.acceptInput({...base,text:long(1900)});at(store,c.inputId,9000);
      expect(inputBatch(store,row(store,c.inputId),1500,8000,[],true).readyAt).toBe(0);
    }finally{store.close();}
  });

  test.each(['line','slack','discord','whatsapp'] as const)('%s does not split messages, so a long one neither waits nor merges',source=>{
    const store=new OrchestrationStore(':memory:','a');
    try{
      const other={...base,scope:{...scope,source}};
      const a=store.acceptInput({...other,text:long(4064)}),b=store.acceptInput({...other,text:'next'});
      at(store,a.inputId,1000);at(store,b.inputId,1200);
      const batch=inputBatch(store,row(store,a.inputId),1500,8000,[],true);
      expect(batch.inputIds).toEqual([a.inputId]);
      expect(batch.readyAt).toBe(0);
    }finally{store.close();}
  });

  test('a same-user row that cannot join ends the wait instead of blocking the session',()=>{
    const store=new OrchestrationStore(':memory:','a');
    try{
      const a=store.acceptInput({...base,text:long(4064)}),b=store.acceptInput({...base,text:'/review-pr 567'});
      at(store,a.inputId,1000);at(store,b.inputId,1100);
      const batch=inputBatch(store,row(store,a.inputId),1500,8000,[],true);
      expect(batch.inputIds).toEqual([a.inputId]);
      expect(batch.readyAt).toBe(0);
    }finally{store.close();}
  });

  test.each([
    ['another group member', (store:OrchestrationStore,conversationId:string)=>{
      store.run("INSERT INTO conversation_members VALUES(?,?,'member')",conversationId,'other');
      return store.acceptInput({...base,scope:{...scope,principalId:'other'},text:'group question'});
    }],
    ['a task report', (store:OrchestrationStore)=>store.acceptInput({...base,text:'Report task progress.',storeUserMessage:false,ingressKey:'notification:n1'})],
  ])('%s between split parts keeps its own turn without breaking the split',(_label,interleave)=>{
    const store=new OrchestrationStore(':memory:','a');
    try{
      const a=store.acceptInput({...base,text:long(3100)});
      const other=interleave(store,a.conversationId);
      const c=store.acceptInput({...base,text:long(1500)});
      at(store,a.inputId,1000);at(store,other.inputId,1100);at(store,c.inputId,1400);
      const batch=inputBatch(store,row(store,a.inputId),1500,8000,[],true);
      expect(batch.inputIds).toEqual([a.inputId,c.inputId]);
      expect(batch.readyAt).toBe(0);
      expect(store.get('SELECT status FROM conversation_inputs WHERE id=?',other.inputId)!.status).toBe('accepted');
    }finally{store.close();}
  });
});
