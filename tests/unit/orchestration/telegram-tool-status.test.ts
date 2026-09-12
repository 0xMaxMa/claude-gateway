import { TelegramToolStatus, telegramToolDetail } from '../../../src/orchestration/telegram-tool-status';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import type { AgentConfig } from '../../../src/types';

function fixture() {
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),decisions=new DecisionService(store);
 const request=jest.fn(async(_url:string|URL|Request,_init?:RequestInit)=>new Response(JSON.stringify({ok:true,result:{message_id:71}})));
 let enabled=true;
 const status=new TelegramToolStatus(store,()=>({telegram:{botToken:'fixture-token'}} as AgentConfig),()=>enabled,request);
 const add=(chat='123',thread='99',session=chat)=>{
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:session,source:'telegram',accountId:'bot',chatId:chat,threadKey:thread,principalId:'owner'},text:'review'});
  const decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
  const task=tasks.spawn({...input,...decision,principalId:'owner',actionId:'spawn:'+input.inputId,execute:true,writeMemory:false},{title:'Review PR',instructions:'review',targetProfile:'default-worker'});
  decisions.finish(decision,'Queued');
  const tool=(type='tool_use',is_error=false)=>store.transaction(()=>store.appendEvent(input.conversationId,'tool.activity',{id:'call',name:'Bash',input:type==='tool_use'?{command:'npm test'}:undefined,type,is_error,role:'worker',taskId:task.taskId},task.taskId));
  return {input,task,tool};
 };
 return {store,tasks,request,status,add,disable:()=>{enabled=false;}};
}
afterEach(()=>jest.useRealTimers());
test('Worker tools remain visible after Agent acknowledgement and edit one message through completion',async()=>{
 jest.useFakeTimers();const f=fixture();
 try{
  const {input,task,tool}=f.add();tool();await f.status.tick();
  expect(f.request).toHaveBeenCalledTimes(1);
  let [url,init]=f.request.mock.calls[0];let body=JSON.parse(String(init?.body));
  expect(String(url)).toContain('/sendMessage');expect(body).toMatchObject({chat_id:'123',message_thread_id:99,disable_notification:true});
  expect(body.text).toBe('💻 Running: npm test\n(elapsed: 0s)');
  expect(body.text).not.toContain(task.taskId.slice(0,8));expect(body.text).not.toContain('Tool activity');
  tool('tool_result');await f.status.tick();expect(f.request).toHaveBeenCalledTimes(1);
  f.store.transaction(()=>f.store.appendEvent(input.conversationId,'tool.activity',{id:'next',name:'Read',input:{file_path:'/repo/src/app.ts'},type:'tool_use',role:'worker',taskId:task.taskId},task.taskId));
  await jest.advanceTimersByTimeAsync(4001);await f.status.tick();
  expect(String(f.request.mock.calls[1][0])).toContain('/editMessageText');
  expect(JSON.parse(String(f.request.mock.calls[1][1]?.body))).toMatchObject({message_id:71,text:'☑️ : 💻 Running: npm test\n🕐 : 📖 Reading: src/app.ts\n(elapsed: 4s)'});
  f.store.run("UPDATE tasks SET state='completed' WHERE id=?",task.taskId);
  await jest.advanceTimersByTimeAsync(4001);await f.status.tick();
  expect(String(f.request.mock.calls[2][0])).toContain('/deleteMessage');
  expect(JSON.parse(String(f.request.mock.calls[2][1]?.body))).toEqual({chat_id:'123',message_id:71});
  await jest.advanceTimersByTimeAsync(4001);await f.status.tick();expect(f.request).toHaveBeenCalledTimes(3);
 }finally{f.status.close();f.store.close();}
});
test('chat/topic destinations are isolated, disabled mode sends nothing, and secrets are masked',async()=>{
 const f=fixture();const old=process.env.TEST_API_KEY;process.env.TEST_API_KEY='super-private-test-key';
 try{
  const a=f.add('123','1'),b=f.add('456','2');a.tool();
  f.store.transaction(()=>f.store.appendEvent(b.input.conversationId,'tool.activity',{id:'secret',name:'Bash',input:{command:'echo super-private-test-key'},type:'tool_use',role:'worker',taskId:b.task.taskId},b.task.taskId));
  await f.status.tick();expect(f.request).toHaveBeenCalledTimes(2);
  const bodies=f.request.mock.calls.map(([,init])=>JSON.parse(String(init?.body)));
  expect(bodies).toEqual(expect.arrayContaining([expect.objectContaining({chat_id:'123',message_thread_id:1}),expect.objectContaining({chat_id:'456',message_thread_id:2})]));
  expect(JSON.stringify(bodies)).not.toContain('super-private-test-key');
  f.disable();a.tool('tool_result',true);await f.status.tick();expect(f.request).toHaveBeenCalledTimes(2);
 }finally{f.status.close();f.store.close();if(old===undefined)delete process.env.TEST_API_KEY;else process.env.TEST_API_KEY=old;}
});
test('rate limiting honors retry_after without mutating task state',async()=>{
 jest.useFakeTimers();const f=fixture();
 try{
  const {task,tool}=f.add();tool();
  f.request.mockResolvedValueOnce(new Response(JSON.stringify({ok:false,parameters:{retry_after:20}}),{status:429}));
  await f.status.tick();await jest.advanceTimersByTimeAsync(5000);await f.status.tick();expect(f.request).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(16000);await f.status.tick();expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.store.task(task.taskId)?.state).toBe('queued');
 }finally{f.status.close();f.store.close();}
});
test('startup does not replay inactive historical tool logs',async()=>{
 jest.useFakeTimers();const f=fixture();
 try{
  const {task,tool}=f.add();tool();f.store.run("UPDATE tasks SET state='completed' WHERE id=?",task.taskId);
  await jest.advanceTimersByTimeAsync(20000);
  const restarted=new TelegramToolStatus(f.store,()=>({telegram:{botToken:'fixture'}} as AgentConfig),()=>true,f.request);
  await restarted.tick();expect(f.request).not.toHaveBeenCalled();restarted.close();
 }finally{f.status.close();f.store.close();}
});

test('managed tool labels hide raw MCP names and retain legacy Bash descriptions',()=>{
 expect(telegramToolDetail('mcp__gateway__task_spawn',{title:'Review PR'})).toBe('🔥 Review PR');
 expect(telegramToolDetail('Skill',{skill:'orchestration-task:review'})).toBe('📚 Using skill: review');
 expect(telegramToolDetail('Bash',{description:'Run tests',command:'npm test'})).toBe('💻 Running: Run tests');
});

test('legacy layout keeps four history entries, refreshes elapsed and deletes on waiting_input',async()=>{
 jest.useFakeTimers();const f=fixture();
 try {
  const {input,task}=f.add();
  for(let i=0;i<7;i++)f.store.transaction(()=>f.store.appendEvent(input.conversationId,'tool.activity',{id:`call-${i}`,name:'Bash',input:{description:`Step ${i}`},type:'tool_use',role:'worker',taskId:task.taskId},task.taskId));
  await f.status.tick();
  const text=JSON.parse(String(f.request.mock.calls[0][1]?.body)).text;
  expect(text).toBe([2,3,4,5].map(i=>`☑️ : 💻 Running: Step ${i}`).concat(['🕐 : 💻 Running: Step 6','(elapsed: 0s)']).join('\n'));
  await jest.advanceTimersByTimeAsync(10000);await f.status.tick();
  expect(JSON.parse(String(f.request.mock.calls[1][1]?.body)).text).toContain('(elapsed: 10s)');
  f.store.run("UPDATE tasks SET state='waiting_input' WHERE id=?",task.taskId);
  await jest.advanceTimersByTimeAsync(4001);await f.status.tick();
  expect(String(f.request.mock.calls[2][0])).toContain('/deleteMessage');
 }finally{f.status.close();f.store.close();}
});

function newerMessages(f:ReturnType<typeof fixture>, count:number, thread='99') {
 for(let i=0;i<count;i++) f.store.acceptInput({scope:{agentId:'a',agentSessionId:'123',source:'telegram',accountId:'bot',chatId:'123',threadKey:thread,principalId:'owner'},text:`message ${i}`});
}
test('moves after six newer messages and 30 seconds, sending before deleting the old status',async()=>{
 jest.useFakeTimers();const f=fixture();
 try{
  f.add().tool();await f.status.tick();
  await jest.advanceTimersByTimeAsync(1);newerMessages(f,6,'other-topic');
  await jest.advanceTimersByTimeAsync(30000);await f.status.tick();
  expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('/sendMessage'))).toHaveLength(1);
  newerMessages(f,5);await jest.advanceTimersByTimeAsync(10001);await f.status.tick();
  expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('/sendMessage'))).toHaveLength(1);
  newerMessages(f,1);await jest.advanceTimersByTimeAsync(4001);
  f.request.mockResolvedValueOnce(new Response(JSON.stringify({ok:true,result:{message_id:99}})));
  await f.status.tick();
  expect(f.request.mock.calls.slice(-2).map(([url])=>String(url).split('/').pop())).toEqual(['sendMessage','deleteMessage']);
  expect(JSON.parse(String(f.request.mock.calls.at(-2)?.[1]?.body))).toMatchObject({chat_id:'123',message_thread_id:99,disable_notification:true});
  expect(JSON.parse(String(f.request.mock.calls.at(-1)?.[1]?.body))).toMatchObject({message_id:71});
  await jest.advanceTimersByTimeAsync(1);newerMessages(f,6);
  await jest.advanceTimersByTimeAsync(10001);await f.status.tick();
  expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('/sendMessage'))).toHaveLength(2);
 }finally{f.status.close();f.store.close();}
});
test('failed replacement keeps the old status; failed deletion retries only the old ID',async()=>{
 jest.useFakeTimers();const f=fixture();
 try{
  const {task}=f.add();await jest.advanceTimersByTimeAsync(5001);await f.status.tick();
  await jest.advanceTimersByTimeAsync(1);newerMessages(f,6);await jest.advanceTimersByTimeAsync(30001);
  f.request.mockResolvedValueOnce(new Response(JSON.stringify({ok:false}),{status:500}));await f.status.tick();
  expect(f.request.mock.calls.some(([url])=>String(url).endsWith('/deleteMessage'))).toBe(false);
  await jest.advanceTimersByTimeAsync(30001);
  f.request.mockResolvedValueOnce(new Response(JSON.stringify({ok:true,result:{message_id:99}})));
  f.request.mockResolvedValueOnce(new Response(JSON.stringify({ok:false}),{status:500}));await f.status.tick();
  const sends=f.request.mock.calls.filter(([url])=>String(url).endsWith('/sendMessage')).length;
  f.store.run("UPDATE tasks SET state='completed' WHERE id=?",task.taskId);
  await jest.advanceTimersByTimeAsync(10001);await f.status.tick();
  expect(f.request.mock.calls.slice(-2).map(([,init])=>JSON.parse(String(init?.body)).message_id)).toEqual([71,99]);
  expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('/sendMessage'))).toHaveLength(sends);
 }finally{f.status.close();f.store.close();}
});
test('counts delivered replies but excludes synthetic inputs from relocation',async()=>{
 jest.useFakeTimers();const f=fixture();
 try{
  const {input}=f.add();await jest.advanceTimersByTimeAsync(5001);await f.status.tick();
  await jest.advanceTimersByTimeAsync(1);newerMessages(f,4);
  const binding=f.store.get('SELECT id FROM conversation_bindings WHERE conversation_id=?',input.conversationId)!.id;
  for(let i=0;i<5;i++)f.store.acceptInput({scope:{agentId:'a',agentSessionId:'123',source:'telegram',accountId:'bot',chatId:'123',threadKey:'99',principalId:'owner'},text:'internal report',storeUserMessage:false});
  await jest.advanceTimersByTimeAsync(30001);await f.status.tick();
  expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('/sendMessage'))).toHaveLength(1);
  for(let i=0;i<2;i++)f.store.run("INSERT INTO deliveries(id,binding_id,modality,state,provider_message_id,updated_at) VALUES(?,?,'text','delivered',?,?)",`delivery-${i}`,binding,String(80+i),Date.now());
  await jest.advanceTimersByTimeAsync(10001);f.request.mockResolvedValueOnce(new Response(JSON.stringify({ok:true,result:{message_id:99}})));await f.status.tick();
  expect(f.request.mock.calls.slice(-2).map(([url])=>String(url).split('/').pop())).toEqual(['sendMessage','deleteMessage']);
 }finally{f.status.close();f.store.close();}
});
