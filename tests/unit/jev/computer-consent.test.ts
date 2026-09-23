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
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,thinking:()=>undefined,evaluate:jest.fn(),needsInput:()=>true});
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
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,thinking:()=>undefined,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{await adapter.submit(task,'request','Inspect');let outcome:any;for(let i=0;i<50;i++){outcome=await adapter.inspect(task,'request');if(typeof outcome==='object')break;await new Promise(r=>setImmediate(r));}expect(outcome.failure.code).toBe('COMPUTER_NO_SUPPORTED_ACTION');expect(outcome.failure.message).toContain('does not indicate an account restriction');}finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});
