import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
// The real Computer Use loop; a test may script one run's tool calls instead (see `script`).
jest.mock('../../../src/automation/computer-use',()=>{const actual=jest.requireActual('../../../src/automation/computer-use');return {...actual,runComputerUse:jest.fn(actual.runComputerUse)};});
const {runComputerUse}=require('../../../src/automation/computer-use');

// Pod-jinawong 2.0.20: the frontmost app was protected, the observe call failed with
// APPLICATION_PROTECTED, and the stop message said only COMPUTER_TOOL_FAILED.
// The stop message names the device errors behind a stop (PR #592). Only the device
// transport is faked: the adapter's tool wrapper records each error it returns.
const notes={application:'com.apple.Notes',windowTitle:'Notes',truncated:false,apps:[{id:'com.apple.Notes',name:'Notes'}],
 controls:[{ref:'c8',role:'AXButton',label:'New Note',actions:['press']}]};
type Reply={isError?:boolean;body:Record<string,unknown>};
const OK:Record<string,Reply>={computer_request_access:{body:{state:'approved'}},computer_acquire:{body:{lease_token:'lease'}},computer_observe:{body:{...notes,generation:'g'}},computer_action:{body:{state:'completed'}}};
/** A device answering each tool from its queue, then OK; and a Jev that picks `plan` in order, then BLOCKED. */
async function run(replies:Record<string,Reply[]>,plan:string[]=[]){
 const root=mkdtempSync(join(tmpdir(),'computer-tool-errors-'));
 const callTool=jest.fn(async({name}:any)=>{
  const reply=replies[name]?.shift()??OK[name]??{body:{}};
  return {...(reply.isError?{isError:true}:{}),content:[{type:'text',text:JSON.stringify(reply.body)}]};
 });
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 let asked=0;
 const evaluate=jest.fn(async(_t:any,req:any)=>{const pick=plan[asked++]??'BLOCKED',kind=pick.split(':')[0];return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q]:[string,any])=>{
  const keys=Object.keys(q.criteria),want=name==='action'?(keys.includes(pick)?pick:kind):name==='completion'?'REQUIRED_STEP':'BLOCKED',chosen=keys.includes(want)?want:keys[0];
  return [name,{choice:chosen,confidence:0.95,probabilities:Object.fromEntries(keys.map(k=>[k,k===chosen?0.95:0.05/(keys.length-1||1)]))}];}))};});
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate,needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{
  await adapter.submit(task,'r','make a new note');let outcome:any;
  for(let i=0;i<500&&typeof outcome!=='object';i++){outcome=await adapter.inspect(task,'r');if(typeof outcome!=='object')await new Promise(r=>setTimeout(r,2));}
  const {toolErrors}=await adapter.diagnostics({...task,gatewayDispatch:{requestId:'r'}});
  return {outcome,toolErrors};
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
}
const notExecuted=(error:string):Reply=>({body:{state:'not_executed',error}});
const failed=(error:string,reason?:string):Reply=>({isError:true,body:{error,...(reason?{reason}:{})}});
/** One run's device calls in order through the adapter's real tool wrapper; device errors are expected and caught. */
const script=(calls:string[],reason:string)=>runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{
 for(const name of calls)await deps.call(name,{},new AbortController().signal).catch(()=>undefined);
 return {status:'blocked',reason,revision:1,steps:0,evaluations:0,trace:{events:[],truncated:false}};
});
const PROTECTED_NOTE='a protected app (such as GetPod, System Settings or a password manager) was frontmost';

test('an error a later call of the same tool got past is not named: the real loop retried a stale action',async()=>{
 const {outcome,toolErrors}=await run({computer_action:[notExecuted('STALE_OBSERVATION'),OK.computer_action,notExecuted('UNSUPPORTED_ACTION')]},['press:c8','press:c8','press:c8']);
 expect(outcome.failure.code).toBe('COMPUTER_UNSUPPORTED_ACTION');
 expect(outcome.failure.message).toContain(' Device tool errors (most recent first): computer_action UNSUPPORTED_ACTION. ');
 expect(outcome.failure.message).not.toContain('STALE_OBSERVATION');
 // The full history stays in the recorded evidence, marked as recovered.
 expect(toolErrors.map((e:any)=>[e.code,e.recovered??false])).toEqual([['STALE_OBSERVATION',true],['UNSUPPORTED_ACTION',false]]);
});

test('a recovered APPLICATION_PROTECTED is not presented as the cause of a later stop',async()=>{
 script(['computer_observe','computer_observe'],'NO_SUPPORTED_ACTION');
 const {outcome}=await run({computer_observe:[failed('APPLICATION_PROTECTED','FRONTMOST_PROTECTED')]});
 expect(outcome.failure.code).toBe('COMPUTER_NO_SUPPORTED_ACTION');
 expect(outcome.failure.message).not.toContain('APPLICATION_PROTECTED');
 expect(outcome.failure.message).not.toContain('Device tool errors');
});

test('APPLICATION_PROTECTED is a known code: the real loop stops with it, and the message explains it',async()=>{
 const {outcome}=await run({computer_observe:[failed('APPLICATION_PROTECTED','FRONTMOST_PROTECTED')]});
 expect(outcome.failure.code).toBe('COMPUTER_APPLICATION_PROTECTED');
 expect(outcome.failure.message).toContain('Computer work stopped: APPLICATION_PROTECTED. Device tool errors (most recent first): computer_observe APPLICATION_PROTECTED (FRONTMOST_PROTECTED).');
 expect(outcome.failure.message).toContain(PROTECTED_NOTE);
});

test('the named errors are the last five distinct ones, most recent first, so the stopping error is kept',async()=>{
 // A, B..F, then A again: the stop. First-seen order would drop A.
 script(['computer_observe',...'BCDEF'.split('').map(()=>'computer_action'),'computer_observe'],'COMPUTER_TOOL_FAILED');
 const {outcome}=await run({computer_observe:[failed('APPLICATION_PROTECTED'),failed('APPLICATION_PROTECTED')],
  computer_action:'BCDEF'.split('').map(c=>notExecuted('ERROR_'+c))});
 expect(outcome.failure.message).toContain(' Device tool errors (most recent first): computer_observe APPLICATION_PROTECTED, computer_action ERROR_F, computer_action ERROR_E, computer_action ERROR_D, computer_action ERROR_C. ');
 expect(outcome.failure.message).toContain(PROTECTED_NOTE);
});

test('the protected-app explanation follows the named errors, not older ones outside them',async()=>{
 script(['computer_observe',...'BCDEF'.split('').map(()=>'computer_action')],'COMPUTER_TOOL_FAILED');
 const {outcome}=await run({computer_observe:[failed('APPLICATION_PROTECTED')],computer_action:'BCDEF'.split('').map(c=>notExecuted('ERROR_'+c))});
 expect(outcome.failure.message).toContain(' Device tool errors (most recent first): computer_action ERROR_F, computer_action ERROR_E, computer_action ERROR_D, computer_action ERROR_C, computer_action ERROR_B. ');
 expect(outcome.failure.message).not.toContain('APPLICATION_PROTECTED');
});

test('device codes and reasons with digits are kept; anything else is still dropped',async()=>{
 script(['computer_observe','computer_action'],'COMPUTER_TOOL_FAILED');
 const {outcome,toolErrors}=await run({computer_observe:[failed('NATIVE_ERROR_2','AX_CODE_25205')],computer_action:[{body:{state:'not_executed',error:'see /Users/me; rm -rf'}}]});
 expect(outcome.failure.message).toContain(' Device tool errors (most recent first): computer_observe NATIVE_ERROR_2 (AX_CODE_25205). ');
 expect(toolErrors).toHaveLength(1);
 expect(JSON.stringify(outcome)).not.toContain('/Users/me');
});
