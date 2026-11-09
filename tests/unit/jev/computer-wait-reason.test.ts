import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
import {agentHandoffRequested} from '../../../src/automation/command-speech';
import {computerOutcomeText} from '../../../src/automation/computer-outcome';
import recorded from '../../fixtures/computer/parked-rounds-059a5cac-2aefd7a9.json';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('../../../src/automation/computer-use',()=>({...jest.requireActual('../../../src/automation/computer-use'),runComputerUse:jest.fn()}));
const {runComputerUse}=require('../../../src/automation/computer-use');

// Pod-jinawong 2.1.12, task 059a5cac rev 5: the user's "ยังไม่เล่นเลย" ran as a direct command, the model answered DONE on a
// screen it could not confirm (needs_verification COMPLETION_CANDIDATE, 0 actions), and the adapter rewrote that to
// COMMAND_WAITING_INPUT with no wait on the trace: agentHandoffRequested had no reason to hand it on, the agent never heard
// the user, and the round log said only COMMAND_WAITING_INPUT.
type Round=typeof recorded.rounds['059a5cac.rev5'];
async function settle(round:Round,status:string,reason:string){
 const root=mkdtempSync(join(tmpdir(),'computer-wait-reason-'));
 const callTool=jest.fn(async({name}:any)=>({content:[{type:'text',text:JSON.stringify(name==='computer_request_access'?{state:'approved'}:name==='computer_acquire'?{lease_token:'lease'}:{})}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 // The recorded progress up to the round's own end; the terminal event is the loop's result.
 const events=round.trace.filter(e=>e.phase!=='terminal');
 runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{for(const e of events)deps.progress?.(e);
  return {status,reason,revision:round.revision,steps:round.report.steps,evaluations:round.report.evaluations,trace:{events,truncated:false}};});
 const info=jest.spyOn(console,'info').mockImplementation(()=>{});
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:{get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})} as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:round.revision,automationController:'user',
  executionControl:{id:'u',action:'revise',revision:round.revision,phase:'applied',requestedAt:1},gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{
  await adapter.submit(task,'r',round.command);let outcome:any;
  for(let i=0;i<100;i++){outcome=await adapter.inspect(task,'r');if(typeof outcome==='object')break;await new Promise(setImmediate);}
  const line=info.mock.calls.map(c=>String(c[0])).find(l=>l.includes('"computer_round"'));
  return {outcome,log:line?JSON.parse(line):undefined};
 }finally{info.mockRestore();await adapter.close();rmSync(root,{recursive:true,force:true});}
}

test('059a5cac rev 5 replay: a 0-action COMPLETION_CANDIDATE keeps its reason as a wait, so the user\'s words reach the agent',async()=>{
 const round=recorded.rounds['059a5cac.rev5'];
 expect(round.trace.at(-1)).toMatchObject({phase:'terminal',status:'needs_verification',reason:'COMPLETION_CANDIDATE'});
 expect(round.trace.some(e=>e.phase==='waiting')).toBe(false);
 const {outcome,log}=await settle(round,'needs_verification','COMPLETION_CANDIDATE');
 expect(outcome.type).toBe('paused');
 expect(outcome.computerReport).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0});
 expect(outcome.computerReport.trace.at(-1)).toMatchObject({phase:'waiting',reason:'COMPLETION_CANDIDATE',revision:5,steps:0});
 // The user's own command that ran nothing is handed to the agent (one turn, one command), not dropped.
 expect(agentHandoffRequested(outcome)).toBe(true);
 expect(computerOutcomeText(outcome.computerReport)).toBe('Not done: the goal may be done, but it was not confirmed. Send the next command.');
 expect(log).toMatchObject({event:'computer_round',endReason:'COMMAND_WAITING_INPUT',waitReason:'COMPLETION_CANDIDATE',outcome:'paused'});
});

test('059a5cac rev 3 replay: the round log names the unusable decision under COMMAND_WAITING_INPUT',async()=>{
 const round=recorded.rounds['059a5cac.rev3'] as unknown as Round;
 const {outcome,log}=await settle(round,'needs_input','COMMAND_WAITING_INPUT');
 expect(outcome.computerReport).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:4});
 expect(log).toMatchObject({endReason:'COMMAND_WAITING_INPUT',waitReason:'JEV_INVALID_RESPONSE',validationReason:'ANSWER_KEYS',actions:4});
 // Not a 0-action command: no hand-off; the round parks for the agent instead (computer-parked-round-wake.test.ts).
 expect(agentHandoffRequested(outcome)).toBe(false);
});
