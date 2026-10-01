import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('../../../src/automation/computer-use',()=>({runComputerUse:jest.fn(async()=>({status:'succeeded',steps:0}))}));
const {runComputerUse}=require('../../../src/automation/computer-use');
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

test.each(['pointer_hit_other_window','private text must not enter diagnostics',undefined])('tool failures preserve bounded native phase %s without misreporting account blocks',async(nativePhase)=>{
 const root=mkdtempSync(join(tmpdir(),'computer-errors-'));
 const callTool=jest.fn(async({name}:any)=>({isError:name!=='computer_request_access',content:[{type:'text',text:JSON.stringify(name==='computer_request_access'?{state:'approved'}:{error:'ACCESSIBILITY_PERMISSION_REQUIRED',phase:nativePhase})}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{await expect(deps.call('computer_observe',{},new AbortController().signal)).rejects.toThrow('ACCESSIBILITY_PERMISSION_REQUIRED');return {status:'blocked',reason:'NO_SUPPORTED_ACTION',steps:0};});
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'request','Inspect');let outcome:any;for(let i=0;i<50;i++){outcome=await adapter.inspect(task,'request');if(typeof outcome==='object')break;await new Promise(r=>setImmediate(r));}expect(callTool).toHaveBeenCalledWith(expect.objectContaining({name:'computer_observe',arguments:expect.objectContaining({app_query:'Inspect'})}),undefined,expect.anything());expect(outcome.failure.code).toBe('COMPUTER_NO_SUPPORTED_ACTION');expect(outcome.failure.message).toContain('does not indicate an account restriction');const errors=(await adapter.diagnostics({...task,gatewayDispatch:{requestId:'request'}})).toolErrors;expect(errors).toEqual([expect.objectContaining({tool:'computer_observe',code:'ACCESSIBILITY_PERMISSION_REQUIRED'})]);expect(errors[0].nativePhase).toBe(nativePhase==='pointer_hit_other_window'?nativePhase:undefined);}finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
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
 try{await adapter.submit(task,'r','Search Bangkok',[],false,plan);for(let i=0;i<20;i++){if(typeof await adapter.inspect(task,'r')==='object')break;await new Promise(setImmediate);}expect(adapter.promptEvidence(task)?.screenshot?.data).toBe(screenshotFails?undefined:image.data);expect(adapter.promptEvidence(task)?.screenshotError).toBe(screenshotFails?'COMPUTER_SCREENSHOT_UNAVAILABLE':undefined);expect(adapter.promptEvidence({...task,revision:2})).toBeUndefined();expect(adapter.promptEvidence({...task,state:'cancelled',revision:2,gatewayDispatch:{requestId:'later-without-image'}})?.screenshot?.data).toBe(screenshotFails?undefined:image.data);expect(adapter.promptEvidence({...task,state:'cancelled',taskId:'other'})?.screenshot).toBeUndefined();allowed=false;expect(()=>adapter.promptEvidence(task)).toThrow('ACCESS_DENIED');}finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('configured desktop field reasoning uses loop prompts while exact parent answers bypass it',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-thinking-config-'));const originalFetch=global.fetch;process.env.DESKTOP_THINKING_TEST_KEY='fixture';
 const fetcher=jest.fn(async(_url:any,init:any)=>{const body=JSON.parse(init.body);expect(body.messages[0].content).toContain('tool-free reasoning');expect(body.messages[1].content).toContain('Asia/Bangkok');return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"text":"Bangkok"}'}}]}));});global.fetch=fetcher as any;
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool:async()=>({content:[{type:'text',text:'{"state":"approved"}'}]})} as any));
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{expect(deps.decideAction).toBeUndefined();const req={application:'Maps',control:{label:'Search',role:'text'},controls:[{label:'Search',role:'text'}]};expect(await deps.thinking(req,new AbortController().signal)).toEqual({text:'Bangkok'});expect(await deps.thinking({...req,application:'Notes'},new AbortController().signal)).toEqual({text:'saved query'});expect(fetcher).toHaveBeenCalledTimes(1);return {status:'needs_input',reason:'FIELD_TEXT_REQUIRED',steps:0,evaluations:0};});
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,thinking:()=>({baseUrl:'https://model.example/v1',model:'small',apiKeyEnv:'DESKTOP_THINKING_TEST_KEY'}),timezone:()=> 'Asia/Bangkok',evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'r','Search Bangkok',[{questionId:'q',inputId:'i',text:'saved query',computerApplication:'Notes',computerFieldLabel:'Search',computerFieldRole:'text'}]);for(let i=0;i<40;i++){await new Promise(setImmediate);if(typeof await adapter.inspect(task,'r')==='object')break;}expect(fetcher).toHaveBeenCalledTimes(1);}finally{await adapter.close();global.fetch=originalFetch;delete process.env.DESKTOP_THINKING_TEST_KEY;rmSync(root,{recursive:true,force:true});}
});

test.each(['agent','user',undefined])('%s control yields after its allowed UI slice',async controller=>{
 const root=mkdtempSync(join(tmpdir(),'computer-multistep-'));let stage=0;const mutations:any[]=[];
 runComputerUse.mockImplementationOnce(jest.requireActual('../../../src/automation/computer-use').runComputerUse);
 const callTool=jest.fn(async({name,arguments:args}:any)=>{
  let body:any={};
  if(name==='computer_request_access')body={state:'approved'};
  if(name==='computer_acquire')body={lease_token:'lease'};
  if(name==='computer_observe')body={generation:String(stage),application:stage?'maps':'browser',apps:[{id:'maps',name:'Maps'},{id:'browser',name:'Browser'}],truncated:false,controls:[{ref:'search',label:stage?'Search Maps':'Address',role:'AXTextField',actions:['type'],focused:true,value:stage>=2?'Palm View':''}],text:stage===3?['Palm View results']:[]};
  if(name==='computer_action'){mutations.push(args);stage++;body={state:'completed'};}
  return {content:[{type:'text',text:JSON.stringify(body)}]};
 });
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const evaluate=jest.fn(async(_task:any,req:any)=>{const selected=['open:maps','type:search','key:enter','DONE'][stage];const kind=selected.split(':')[0];return {answers:Object.fromEntries(Object.entries(req.questions).filter(([name])=>name!=='completion').map(([name,q]:any)=>{const choice=name==='action'?(req.questions.target_open?kind:selected):name==='target_'+kind?selected:name==='submit'?'NONE':'BLOCKED';return [name,{choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))}];}))};});
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate,needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:controller,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'r','Search Palm View in Maps',undefined,false,[{application:'maps',label:'Search Maps',text:'Palm View'}]);let outcome:any;for(let i=0;i<100;i++){outcome=await adapter.inspect(task,'r');if(typeof outcome==='object')break;await new Promise(setImmediate);}expect(outcome.type).toBe('paused');if(controller==='agent'||controller==='user'){expect(mutations.map(x=>x.kind)).toEqual(['open']);expect(outcome.computerReport).toMatchObject({steps:1,status:'needs_input',reason:'COMMAND_WAITING_INPUT'});}else{expect(mutations.map(x=>x.kind)).toEqual(['open','type','key']);expect(mutations[1].text).toBe('Palm View');expect(mutations[2].key).toBe('enter');expect(outcome.computerReport).toMatchObject({steps:3,status:controller==='user'?'needs_input':'needs_verification',reason:controller==='user'?'COMMAND_WAITING_INPUT':'COMPLETION_CANDIDATE'});}}finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('unknown desktop result with quiesced continuation becomes quiet idle, never completion or replay',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-quiet-'));
 const callTool=jest.fn(async({name}:any)=>({content:[{type:'text',text:JSON.stringify(name==='computer_request_access'?{state:'approved'}:{state:'unknown',continuation_ready:true})}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{expect(deps.decideAction).toBeUndefined();await deps.beforeMutation('op',{});await deps.call('computer_action',{operation_id:'op'},new AbortController().signal);deps.progress({phase:'reconciling',operationId:'op',steps:0,evaluations:1});return {status:'needs_reconciliation',reason:'OUTCOME_UNKNOWN',steps:0,evaluations:1};});
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:jest.fn()});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'r','Search');let outcome:any;for(let i=0;i<30;i++){outcome=await adapter.inspect(task,'r');if(typeof outcome==='object')break;await new Promise(setImmediate);}expect(outcome).toMatchObject({type:'paused',computerReport:{reason:'COMMAND_WAITING_INPUT'}});expect(outcome.result).toBeUndefined();expect(callTool.mock.calls.filter(([a])=>a.name==='computer_action')).toHaveLength(1);}finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

for(const confirmed of [true,false])test(`disconnect settles unknown action only after remote revocation: ${confirmed}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-disconnect-'));
 const callTool=jest.fn(async({name}:any)=>({content:[{type:'text',text:JSON.stringify(name==='computer_request_access'?{state:'approved'}:{state:confirmed?'stopped':'unknown'})}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{await deps.beforeMutation('old-operation',{});return {status:'needs_reconciliation',reason:'OUTCOME_UNKNOWN',steps:1};});
 const options={agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{device_id:'device',grant_id:'grant'}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true};
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 const adapter=new ComputerTaskAdapter(options);
 try{
  await adapter.submit(task,'r','Search');await adapter.close();
  task.cancellation={requestedBy:'user',requestedAt:Date.now()};
  const recovered=await adapter.recover(task,'r');
  expect(recovered?.state).toBe(confirmed?'cancelled':undefined);
  expect(callTool).toHaveBeenCalledWith(expect.objectContaining({name:'computer_end_session',arguments:{device_id:'device',grant_id:'grant'}}),undefined,expect.anything());
  expect(callTool.mock.calls.some(c=>c[0].name==='computer_action')).toBe(false);
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('a user-controlled screenshot blocker preserves its error rather than quiet idle or a field question',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-stale-'));const needsInput=jest.fn();
 const callTool=jest.fn(async({name}:any)=>({isError:name==='computer_screenshot',content:[{type:'text',text:JSON.stringify(name==='computer_request_access'?{state:'approved'}:{error:'STALE_OBSERVATION'})}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{
  expect(await deps.snapshot({generation:'g'},new AbortController().signal)).toEqual({error:'STALE_OBSERVATION'});
  return {status:'blocked',reason:'COMPUTER_SCREENSHOT_STALE',steps:0,evaluations:0};
 });
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'r','Search');let outcome:any;for(let i=0;i<30;i++){outcome=await adapter.inspect(task,'r');if(typeof outcome==='object')break;await new Promise(setImmediate);}
 expect(outcome).toMatchObject({type:'failed',failure:{code:'COMPUTER_SCREENSHOT_STALE'},computerReport:{status:'blocked',reason:'COMPUTER_SCREENSHOT_STALE',steps:0}});expect(needsInput).not.toHaveBeenCalled();expect(callTool.mock.calls.some(([a])=>a.name==='computer_action')).toBe(false);
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test.each(['thinking'])('provider failure in %s is not converted to a missing-input pause',async method=>{
 const root=mkdtempSync(join(tmpdir(),'computer-provider-'));const needsInput=jest.fn();
 const callTool=jest.fn(async({name}:any)=>({content:[{type:'text',text:JSON.stringify(name==='computer_request_access'?{state:'approved'}:{generation:'g',mimeType:'image/jpeg',data:'/9j/aA==',capturedAt:Date.now()})}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const fetcher=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:429}));
 const env=process.env.TEST_THINKING_PROVIDER_KEY;process.env.TEST_THINKING_PROVIDER_KEY='fixture-only';
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{
  const signal=new AbortController().signal;await deps.snapshot({generation:'g'},signal);
  let error:any;try{await deps[method]({goal:'Inspect',state:{generation:'g'},actions:{WAIT:'Wait'},control:{label:'Field',role:'text'},application:'fixture'},signal);}catch(e){error=e;}
  expect(error?.message).toBe('THINKING_HTTP_429');
  return {status:'blocked',reason:error?.message,steps:0,evaluations:0};
 });
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput,thinking:()=>({api:'openai-chat',baseUrl:'https://provider.example/v1',model:'fixture',apiKeyEnv:'TEST_THINKING_PROVIDER_KEY'})});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'r','Inspect');let outcome:any;for(let i=0;i<30;i++){outcome=await adapter.inspect(task,'r');if(typeof outcome==='object')break;await new Promise(setImmediate);}
 expect(outcome).toMatchObject({type:'failed',computerReport:{status:'blocked',reason:'THINKING_HTTP_429'}});expect(needsInput).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(1);
 }finally{await adapter.close();fetcher.mockRestore();if(env===undefined)delete process.env.TEST_THINKING_PROVIDER_KEY;else process.env.TEST_THINKING_PROVIDER_KEY=env;rmSync(root,{recursive:true,force:true});}
});

test('previous desktop evidence is separate from the next command passed to Jev',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-command-context-'));
 const callTool=jest.fn(async()=>({content:[{type:'text',text:'{"state":"approved"}'}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{deps.observation({application:'browser',windowTitle:'Old title',focusedControl:{label:'Search',role:'AXComboBox'}});return {status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0};});
 let next:any;
 runComputerUse.mockImplementationOnce(async(input:any)=>{next=input;return {status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0};});
 try{
  await adapter.submit(task,'one','Focus Search');
  for(let i=0;i<50;i++){if(typeof await adapter.inspect(task,'one')==='object')break;await new Promise(setImmediate);}
  const updated={...task,revision:2};await adapter.submit(updated,'two','Type milk');
  for(let i=0;i<50;i++){if(typeof await adapter.inspect(updated,'two')==='object')break;await new Promise(setImmediate);}
  expect(next.goal).toBe('Type milk');expect(next.interactionContext).toContain('Old title');expect(next.interactionContext).toContain('\"previousCommand\":\"Focus Search\"');expect(next.interactionContext).toContain('current command overrides');
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});


test.each(['agent','user',undefined])('controller %s determines whether a confirmed UI operation yields to its parent',async controller=>{
 const root=mkdtempSync(join(tmpdir(),'computer-control-slice-'));
 const callTool=jest.fn(async()=>({content:[{type:'text',text:'{"state":"approved"}'}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:controller,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 let input:any;
 runComputerUse.mockImplementationOnce(async(value:any)=>{input=value;return {status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1};});
 try{
  await adapter.submit(task,'r','Press Tab once');let outcome:any;
  for(let i=0;i<50;i++){outcome=await adapter.inspect(task,'r');if(typeof outcome==='object')break;await new Promise(setImmediate);}
  expect(input.yieldAfterAction).toBe(controller==='agent');
  expect(outcome).toMatchObject({type:'paused',computerReport:{reason:'COMMAND_WAITING_INPUT',steps:1}});
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});


test.each([false,true])('owner approval status reflects an actual pending request=%s',async pending=>{
 const root=mkdtempSync(join(tmpdir(),'computer-consent-progress-')),progress=jest.fn();let calls=0;
 const callTool=jest.fn(async({arguments:args}:any)=>{expect(args.wait_ms).toBe(calls++===0?0:15000);return {content:[{type:'text',text:JSON.stringify({state:pending&&calls===1?'pending':'approved'})}]};});
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true,progress});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{
  await adapter.submit(task,'request','Open Notes');for(let i=0;i<50;i++){if(typeof await adapter.inspect(task,'request')==='object')break;await new Promise(setImmediate);}
  expect(progress.mock.calls.filter(c=>c[1].reason==='OWNER_APPROVAL_REQUIRED')).toHaveLength(pending?1:0);
  expect(callTool).toHaveBeenCalledTimes(pending?2:1);
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('an unanswered access prompt times out and says so instead of implying a denial',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-access-timeout-'));runComputerUse.mockClear();
 const callTool=jest.fn(async()=>({content:[{type:'text',text:'{"state":"pending"}'}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true,accessWaitMs:0});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'r','Open Notes');let outcome:any;for(let i=0;i<50;i++){outcome=await adapter.inspect(task,'r');if(typeof outcome==='object')break;await new Promise(setImmediate);}
  expect(outcome).toMatchObject({type:'failed',failure:{code:'COMPUTER_ACCESS_TIMEOUT'},computerReport:{reason:'COMPUTER_ACCESS_TIMEOUT',steps:0}});
  expect(outcome.failure.message).toContain('not a denial');expect(runComputerUse).not.toHaveBeenCalled();
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test.each(['CONTROL_DENIED','OBSERVATION_DENIED','DEVICE_OFFLINE','CONSENT_REQUIRED'])('relay rejection %s keeps its cause code for the controller',async code=>{
 const root=mkdtempSync(join(tmpdir(),'computer-reject-'));
 const callTool=jest.fn(async({name}:any)=>name==='computer_request_access'?{content:[{type:'text',text:'{"state":"approved"}'}]}:{isError:true,content:[{type:'text',text:JSON.stringify({error:code})}]});
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 let seen='';
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{await deps.call('computer_action',{operation_id:'00000000-0000-4000-8000-000000000000'},new AbortController().signal).catch((e:Error)=>{seen=e.message;});return {status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0};});
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'r','Open Notes');for(let i=0;i<50;i++){if(typeof await adapter.inspect(task,'r')==='object')break;await new Promise(setImmediate);}expect(seen).toBe(code);}
 finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

test('app_query sent to the helper is capped at 4000 characters without splitting a character',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-app-query-'));
 const callTool=jest.fn(async({name}:any)=>({content:[{type:'text',text:name==='computer_request_access'?'{"state":"approved"}':'{}'}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{await deps.call('computer_observe',{},new AbortController().signal);return {status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0};});
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 const goal='ค'.repeat(3999)+'😀'+'ข'.repeat(6000);
 try{await adapter.submit(task,'r',goal);for(let i=0;i<50;i++){if(typeof await adapter.inspect(task,'r')==='object')break;await new Promise(setImmediate);}
  const sent=(callTool.mock.calls as any[]).find(([c])=>c.name==='computer_observe')[0].arguments.app_query as string;
  expect([...sent]).toHaveLength(4000);expect(sent.endsWith('😀')).toBe(true);expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(sent)).toBe(false);
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});
