import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('@0xmaxma/jev-loop/computer-use',()=>({runComputerUse:jest.fn(async()=>({status:'succeeded',steps:0}))}));
const {runComputerUse}=require('@0xmaxma/jev-loop/computer-use');
for(const answer of ['approved','denied','stopped','expired'])test(`request consent at execution, ${answer} gates the runner`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-consent-'));runComputerUse.mockClear();
 const callTool=jest.fn().mockResolvedValueOnce({content:[{type:'text',text:'{"state":"pending"}'}]}).mockResolvedValueOnce({content:[{type:'text',text:JSON.stringify({state:answer})}]});
 jest.mocked(withComputerConnection).mockImplementation(async(_connection,fn)=>fn({callTool} as any));
 const connectors={get:()=>({connectorId:'c',scope:{device_id:'device',grant_id:'grant'}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'request','Open Notes');let outcome:any;for(let i=0;i<50;i++){outcome=await adapter.inspect(task,'request');if(typeof outcome==='object')break;await new Promise(r=>setImmediate(r));}
 expect(callTool).toHaveBeenCalledTimes(2);expect(callTool.mock.calls[0][0]).toMatchObject({name:'computer_request_access',arguments:{device_id:'device',grant_id:'grant',request_id:'request'}});
 expect(runComputerUse).toHaveBeenCalledTimes(answer==='approved'?1:0);expect(outcome.type).toBe(answer==='approved'?'completed':'failed');if(answer!=='approved'){expect(outcome.failure.code).toBe(answer==='denied'?'COMPUTER_ACCESS_DENIED':answer==='stopped'?'COMPUTER_ACCESS_STOPPED':'COMPUTER_ACCESS_UNAVAILABLE');expect(outcome.computerReport.reason).toBe(outcome.failure.code);expect(outcome.failure.message).not.toContain('owner declined');}
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('tool failures preserve a known native reason and unsupported decisions are not account blocks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-errors-'));
 const callTool=jest.fn(async({name}:any)=>({isError:name!=='computer_request_access',content:[{type:'text',text:JSON.stringify(name==='computer_request_access'?{state:'approved'}:{error:'ACCESSIBILITY_PERMISSION_REQUIRED'})}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{await expect(deps.call('computer_observe',{},new AbortController().signal)).rejects.toThrow('ACCESSIBILITY_PERMISSION_REQUIRED');return {status:'blocked',reason:'NO_SUPPORTED_ACTION',steps:0};});
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'request','Inspect');let outcome:any;for(let i=0;i<50;i++){outcome=await adapter.inspect(task,'request');if(typeof outcome==='object')break;await new Promise(r=>setImmediate(r));}expect(outcome.failure.code).toBe('COMPUTER_NO_SUPPORTED_ACTION');expect(outcome.failure.message).toContain('does not indicate an account restriction');}finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('restart refreshes scoped target discovery before consent, without spawning duplicate actions',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-rediscover-'));let discovered=false;
 const connectors={get:jest.fn(()=>{if(!discovered)throw Error('COMPUTER_TARGET_UNAVAILABLE');return {connectorId:'c',scope:{}};}),discover:jest.fn(async(context,allowed)=>{expect(context).toEqual({principalId:'p',conversationId:'c'});expect(allowed()).toBe(true);discovered=true;}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
 const callTool=jest.fn(async()=>({content:[{type:'text',text:'{"state":"denied"}'}]}));jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'r','Inspect');expect(connectors.discover).toHaveBeenCalledTimes(1);expect(connectors.get).toHaveBeenCalledTimes(2);await adapter.close();expect(callTool).toHaveBeenCalledTimes(1);}finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('historical pre-dispatch evidence survives cancellation, but missing receipts alone stay unknown',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-history-'));
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,state:'cancel_requested',activeAttemptId:'attempt',gatewayDispatch:{requestId:'r'},gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 const attempt={attemptId:'attempt',taskId:'t',failure:{code:'GATEWAY_REQUEST_UNCONFIRMED',message:'COMPUTER_TARGET_UNAVAILABLE'}} as any;
 try{expect(await adapter.inspect(task,'r',attempt)).toMatchObject({type:'failed',failure:{code:'GATEWAY_REQUEST_DENIED'}});expect(await adapter.inspect(task,'other',attempt)).toBe('pending');expect(await adapter.inspect(task,'r',{...attempt,taskId:'foreign'})).toBe('pending');expect(await adapter.inspect(task,'r')).toBe('pending');}finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('speech pause interrupts pending consent without starting the loop or denying desktop access',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-pause-'));runComputerUse.mockClear();let started=false;
 const callTool=jest.fn(async(_args:any,_schema:any,{signal}:any)=>{started=true;return await new Promise((_r,reject)=>{signal.addEventListener('abort',()=>reject(Error('REQUEST_CANCELLED')),{once:true});});});
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'r','Open Notes');expect(started).toBe(true);adapter.interrupt(task,'r');let outcome:any;for(let i=0;i<20;i++){outcome=await adapter.inspect(task,'r');if(typeof outcome==='object')break;await new Promise(setImmediate);}expect(outcome.type).toBe('stopped');expect(runComputerUse).not.toHaveBeenCalled();expect(callTool).toHaveBeenCalledTimes(1);}finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('computer round traces survive restart, page by owner and do not clear an unknown mutation fence',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-trace-'));let enabled=true;
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool:async()=>({content:[{type:'text',text:'{"state":"approved"}'}]})} as any));
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{await deps.beforeMutation('operation',{});for(let i=1;i<=45;i++)deps.progress({sequence:i,round:i,at:Date.now(),revision:1,steps:0,evaluations:i,phase:'acting',operationId:'operation'});return {status:'succeeded',reason:'VERIFIED',steps:0};});
 const options={agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>enabled,member:(p:string,c:string)=>p==='p'&&c==='c',active:()=>true,evaluate:jest.fn(),needsInput:()=>true};
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayDispatch:{requestId:'r'},gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 const adapter=new ComputerTaskAdapter(options);
 try{await adapter.submit(task,'r','Inspect');let outcome:any;for(let i=0;i<30;i++){outcome=await adapter.inspect(task,'r');if(typeof outcome==='object')break;await new Promise(setImmediate);}expect(outcome.type).toBe('unknown');await adapter.close();const restarted=new ComputerTaskAdapter(options);expect(await restarted.diagnostics(task,0)).toMatchObject({total:45,nextOffset:40,recordedOnly:true});expect((await restarted.diagnostics(task,40)).events).toHaveLength(5);await expect(restarted.diagnostics({...task,ownerPrincipalId:'other'})).rejects.toThrow('ACCESS_DENIED');enabled=false;await expect(restarted.diagnostics(task)).rejects.toThrow('ACCESS_DENIED');await restarted.close();}finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test.each(['completed','not_executed','unknown','acknowledged','foreign'])('restart recovery accepts only a scoped known receipt: %s',async state=>{
 const root=mkdtempSync(join(tmpdir(),'computer-recover-'));let member=true;
 const callTool=jest.fn(async(args:any)=>({content:[{type:'text',text:JSON.stringify(args.name==='computer_request_access'?{state:'approved'}:{operation_id:state==='foreign'?'other':'operation',state:state==='acknowledged'?'unknown':state,owner_acknowledged:state==='acknowledged'})}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{await deps.beforeMutation('operation',{});return {status:'needs_reconciliation',reason:'OUTCOME_UNKNOWN',steps:1};});
 const options={agentId:'a',root,connectors:{discover:async()=>[],get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>member,active:()=>true,evaluate:jest.fn(),needsInput:()=>true};
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 let adapter=new ComputerTaskAdapter(options);
 try{
  await adapter.submit(task,'r','Open Notes');for(let i=0;i<20;i++){if(typeof await adapter.inspect(task,'r')==='object')break;await new Promise(setImmediate);}await adapter.close();adapter=new ComputerTaskAdapter(options);
  member=false;expect(await adapter.recover(task,'r')).toBeUndefined();member=true;
  const recovery=await adapter.recover(task,'r');
  if(['completed','not_executed'].includes(state))expect(recovery?.state).toBe('queued');else if(state==='acknowledged')expect(recovery?.state).toBe('cancelled');else expect(recovery).toBeUndefined();
  expect(callTool.mock.calls.filter(c=>c[0].name==='computer_action')).toHaveLength(0);
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('computer field callback uses scoped agent answers only and leaves verification to the parent',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-parent-fields-'));
 const callTool=jest.fn(async()=>({content:[{type:'text',text:JSON.stringify({state:'approved'})}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{
  expect(deps.verify).toBeUndefined();
  const req={application:'Notes',windowTitle:'Search',control:{label:'Search',role:'text'},controls:[{label:'Search',role:'text'}]};
  expect(await deps.thinking(req,new AbortController().signal)).toEqual({text:'flight notes'});
  expect(await deps.thinking({...req,application:'Other'},new AbortController().signal)).toEqual({text:null});
  return {status:'needs_input',reason:'FIELD_TEXT_REQUIRED',steps:0,evaluations:0};
 });
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'request','Find notes',[{questionId:'q',inputId:'i',text:'flight notes',computerFieldLabel:'Search',computerFieldRole:'text',computerApplication:'Notes',computerWindowTitle:'Search'}]);for(let i=0;i<30;i++){await new Promise(setImmediate);const outcome=await adapter.inspect(task,'request');if(typeof outcome==='object'){expect(outcome.type).toBe('paused');return;}}throw Error('did not settle');}
 finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test.each([false,true])('prepared values and parent questions survive screenshot failure=%s without helper inference',async(screenshotFails)=>{
 const root=mkdtempSync(join(tmpdir(),'computer-image-'));let allowed=true;
 const state={generation:'g',application:'com.apple.Maps',controls:[{ref:'c0',label:'Search',role:'AXTextField',actions:['type']}],apps:[],truncated:false,screenshotAvailable:true};
 const image={generation:'g',mimeType:'image/jpeg',data:'/9j/AA==',capturedAt:Date.now()};
 const callTool=jest.fn(async(args:any)=>{if(screenshotFails&&args.name==='computer_screenshot')throw Error('capture unavailable');return {content:[{type:'text',text:JSON.stringify(args.name==='computer_request_access'?{state:'approved'}:args.name==='computer_acquire'?{lease_token:'lease'}:image)}]};});
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const plan=[{application:'com.apple.Maps',label:'Search',text:'Bangkok'}];
 runComputerUse.mockImplementationOnce(async(input:any,deps:any)=>{expect(input.preparedInputs).toEqual(plan);await deps.call('computer_acquire',{},new AbortController().signal);deps.observation(state);await deps.snapshot(state,new AbortController().signal);expect(await deps.thinking({application:state.application,control:state.controls[0],controls:state.controls},new AbortController().signal)).toEqual({text:null});return {status:'needs_input',reason:'FIELD_TEXT_REQUIRED',steps:0};});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayDispatch:{requestId:'r'},gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>allowed,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 try{await adapter.submit(task,'r','Search Bangkok',[],false,plan);for(let i=0;i<20;i++){if(typeof await adapter.inspect(task,'r')==='object')break;await new Promise(setImmediate);}expect(adapter.promptEvidence(task)?.screenshot?.data).toBe(screenshotFails?undefined:image.data);expect(adapter.promptEvidence(task)?.screenshotError).toBe(screenshotFails?'COMPUTER_SCREENSHOT_UNAVAILABLE':undefined);expect(adapter.promptEvidence({...task,revision:2})).toBeUndefined();allowed=false;expect(()=>adapter.promptEvidence(task)).toThrow('ACCESS_DENIED');}finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('configured desktop field reasoning uses loop prompts while exact parent answers bypass it',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-thinking-config-'));const originalFetch=global.fetch;process.env.DESKTOP_THINKING_TEST_KEY='fixture';
 const fetcher=jest.fn(async(_url:any,init:any)=>{const body=JSON.parse(init.body);expect(body.messages[0].content).toContain('tool-free reasoning');expect(body.messages[1].content).toContain('Asia/Bangkok');return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"text":"Bangkok"}'}}]}));});global.fetch=fetcher as any;
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool:async()=>({content:[{type:'text',text:'{"state":"approved"}'}]})} as any));
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{const req={application:'Maps',control:{label:'Search',role:'text'},controls:[{label:'Search',role:'text'}]};expect(await deps.thinking(req,new AbortController().signal)).toEqual({text:'Bangkok'});expect(await deps.thinking({...req,application:'Notes'},new AbortController().signal)).toEqual({text:'saved query'});expect(fetcher).toHaveBeenCalledTimes(1);return {status:'needs_input',reason:'FIELD_TEXT_REQUIRED',steps:0,evaluations:0};});
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,thinking:()=>({baseUrl:'https://model.example/v1',model:'small',apiKeyEnv:'DESKTOP_THINKING_TEST_KEY'}),timezone:()=> 'Asia/Bangkok',evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'r','Search Bangkok',[{questionId:'q',inputId:'i',text:'saved query',computerApplication:'Notes',computerFieldLabel:'Search',computerFieldRole:'text'}]);for(let i=0;i<40;i++){await new Promise(setImmediate);if(typeof await adapter.inspect(task,'r')==='object')break;}expect(fetcher).toHaveBeenCalledTimes(1);}finally{await adapter.close();global.fetch=originalFetch;delete process.env.DESKTOP_THINKING_TEST_KEY;rmSync(root,{recursive:true,force:true});}
});
