import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('@0xmaxma/jev-loop/computer-use',()=>({runComputerUse:jest.fn(async()=>({status:'succeeded',steps:0}))}));
const {runComputerUse}=require('@0xmaxma/jev-loop/computer-use');
for(const answer of ['approved','denied'])test(`request consent at execution, ${answer} gates the runner`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-consent-'));runComputerUse.mockClear();
 const callTool=jest.fn().mockResolvedValueOnce({content:[{type:'text',text:'{"state":"pending"}'}]}).mockResolvedValueOnce({content:[{type:'text',text:JSON.stringify({state:answer})}]});
 jest.mocked(withComputerConnection).mockImplementation(async(_connection,fn)=>fn({callTool} as any));
 const connectors={get:()=>({connectorId:'c',scope:{device_id:'device',grant_id:'grant'}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'request','Open Notes');let outcome:any;for(let i=0;i<50;i++){outcome=await adapter.inspect(task,'request');if(typeof outcome==='object')break;await new Promise(r=>setImmediate(r));}
 expect(callTool).toHaveBeenCalledTimes(2);expect(callTool.mock.calls[0][0]).toMatchObject({name:'computer_request_access',arguments:{device_id:'device',grant_id:'grant'}});
 expect(runComputerUse).toHaveBeenCalledTimes(answer==='approved'?1:0);expect(outcome.type).toBe(answer==='approved'?'completed':'failed');if(answer==='denied')expect(outcome.failure.code).toBe('COMPUTER_ACCESS_DENIED');
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
