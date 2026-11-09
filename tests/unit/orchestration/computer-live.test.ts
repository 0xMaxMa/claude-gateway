import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerLiveRuns,automationWait,computerActionLabel,computerLiveView} from '../../../src/orchestration/computer-live';
import {ComputerTaskAdapter} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('../../../src/automation/computer-use',()=>({runComputerUse:jest.fn()}));
jest.mock('../../../src/automation/computer-steps',()=>({...jest.requireActual('../../../src/automation/computer-steps'),runComputerSteps:jest.fn()}));
const {runComputerUse}=require('../../../src/automation/computer-use');
const {runComputerSteps}=require('../../../src/automation/computer-steps');

const GRANT='7d3f1a52-0b6e-4c7a-9f1e-2a4b6c8d0e12';
const event=(phase:string,extra:Record<string,unknown>={})=>({sequence:1,round:1,at:0,revision:1,steps:0,evaluations:0,phase,...extra}) as any;

describe('computer live runs (the device overlay label)',()=>{
 test('goal runs name the action; the step counts actions',()=>{
  expect(computerActionLabel(event('acting',{action:'open',appId:'com.spotify.client'}))).toBe('Opening com.spotify.client');
  expect(computerActionLabel(event('acting',{action:'open',appId:'Spotify'}))).toBe('Opening Spotify');
  expect(computerActionLabel(event('acting',{action:'press',role:'button',application:'com.google.Chrome'}))).toBe('Clicking a button in Chrome');
  expect(computerActionLabel(event('acted',{action:'type',application:'chrome.exe'}))).toBe('Typing in chrome');
  expect(computerActionLabel(event('observing',{application:'com.google.Chrome'}))).toBe('Looking at Chrome');
  expect(computerActionLabel(event('evaluating'))).toBe('Deciding the next step');
  let now=1000;const live=new ComputerLiveRuns(()=>now);
  live.start(GRANT,'t','r1');
  now=2000;live.progress(GRANT,'r1',event('acting',{action:'open',appId:'Spotify',steps:1}));
  expect(live.get(GRANT)).toEqual({taskId:'t',requestId:'r1',updatedAt:2000,phase:'acting',label:'Opening Spotify',step:2,total:undefined});
  live.progress(GRANT,'r1',event('decided',{steps:2}));
  expect(live.get(GRANT)).toMatchObject({phase:'thinking',label:'Deciding the next step',step:3});
 });

 test('a step list shows the user\'s own step, 1-based, with the total',()=>{
  const live=new ComputerLiveRuns(()=>5);live.start(GRANT,'t','r1');
  live.progress(GRANT,'r1',event('acting',{round:2,action:'press'}),['open Chrome','open Spotify in Chrome','play a song']);
  expect(live.get(GRANT)).toMatchObject({label:'open Spotify in Chrome',step:2,total:3,phase:'acting'});
  // An out-of-range round (the terminal event after the last step) stays on the last step.
  live.progress(GRANT,'r1',event('terminal',{round:4}),['open Chrome','open Spotify in Chrome','play a song']);
  expect(live.get(GRANT)).toMatchObject({label:'play a song',step:3,total:3});
 });

 test('labels are one bounded line',()=>{
  const live=new ComputerLiveRuns();live.start(GRANT,'t','r1');
  live.progress(GRANT,'r1',event('acting',{round:1}),['  open\n'+'x'.repeat(300)]);
  const label=live.get(GRANT)!.label;
  expect(label.length).toBe(120);expect(label.startsWith('open x')).toBe(true);expect(label.endsWith('…')).toBe(true);
 });

 test('a late event of an earlier round never overwrites the current round',()=>{
  const live=new ComputerLiveRuns();
  live.start(GRANT,'t','r1');live.start(GRANT,'t','r2');
  live.progress(GRANT,'r1',event('acting',{action:'open',appId:'Old'}));
  expect(live.get(GRANT)).toMatchObject({requestId:'r2',label:'Starting'});
  live.awaitingAccess(GRANT,'r2');
  expect(live.get(GRANT)).toMatchObject({phase:'waiting_for_user',label:'Approve access in the GetPod app'});
 });

 test('the task state decides waiting and ended',()=>{
  const run={taskId:'t',requestId:'r',updatedAt:9,phase:'acting' as const,label:'Opening Spotify',step:2};
  const view=(task:Record<string,unknown>)=>computerLiveView(run,{taskId:'t',state:'running',...task} as any);
  expect(view({})).toEqual({taskId:'t',phase:'acting',label:'Opening Spotify',step:2,updatedAt:9});
  for(const state of ['completed','failed','cancelled'])expect(view({state}).phase).toBe('ended');
  // Nobody is deciding about a settled round any more: it is the user's turn, whoever controls it.
  expect(view({state:'waiting_input',automationController:'agent'})).toMatchObject({phase:'waiting_for_user',reason:'next_command',label:'Ready for your next command'});
  expect(view({state:'waiting_input',automationController:'user'})).toMatchObject({phase:'waiting_for_user',reason:'next_command'});
  expect(view({state:'waiting_input',automationController:'agent',pendingQuestion:{questionId:'q',text:'Which song?',revision:1}})).toMatchObject({phase:'waiting_for_user',reason:'question',label:'Answer the question in GetPod'});
  expect(view({state:'needs_reconciliation'})).toMatchObject({phase:'waiting_for_user',reason:'check'});
 });

 // Pod-jinawong r8: between the rounds of every agent goal run (b0ba459d, 16542265 and three more) the overlay said
 // "Finished this round · Waiting for you" for the 6-35 s the woken agent took to send the next command.
 test('between rounds the agent is deciding: thinking, never waiting for the user',()=>{
  const run={taskId:'t',requestId:'r',updatedAt:9,phase:'acting' as const,label:'Finished this round',step:2};
  const view=(task:Record<string,unknown>,deciding:boolean)=>computerLiveView(run,{taskId:'t',agentSessionId:'s1',state:'waiting_input',automationController:'user',...task} as any,Date.now(),deciding);
  expect(view({},true)).toEqual({taskId:'t',sessionId:'s1',phase:'thinking',label:'Deciding the next step',step:2,updatedAt:9});
  expect(view({state:'needs_reconciliation'},true)).toMatchObject({phase:'thinking'});
  // A step list keeps the user's own step while the agent decides.
  expect(computerLiveView({...run,label:'open Spotify in Chrome',total:3},{taskId:'t',state:'waiting_input',automationController:'user'} as any,Date.now(),true)).toMatchObject({phase:'thinking',label:'open Spotify in Chrome',step:2,total:3});
  // The agent ended its turn without a next command: now it is the user's turn.
  expect(view({},false)).toMatchObject({phase:'waiting_for_user',reason:'next_command',sessionId:'s1'});
  // A real wait stays one while the agent is busy (for example asking the question in chat).
  expect(view({pendingQuestion:{questionId:'q',text:'Which song?',revision:1}},true)).toMatchObject({phase:'waiting_for_user',reason:'question'});
  expect(view({computerReport:{status:'needs_input',reason:'FIELD_TEXT_REQUIRED',steps:0,fieldRequest:{label:'Search',reason:'missing'}}},true)).toMatchObject({phase:'waiting_for_user',reason:'question'});
  expect(view({computerReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,lastAction:{kind:'press',label:'Delete',confirm:true}}},true)).toMatchObject({phase:'waiting_for_user',reason:'confirmation',label:'Confirm the next step in GetPod'});
  expect(view({executionControl:{phase:'paused'}},true)).toMatchObject({phase:'waiting_for_user',reason:'paused'});
  // The access prompt while the round runs.
  expect(computerLiveView({...run,phase:'waiting_for_user',label:'Approve access in the GetPod app'},{taskId:'t',state:'running'} as any)).toMatchObject({phase:'waiting_for_user',reason:'access'});
 });

 test('automationWait: nothing for a running or finished task',()=>{
  for(const state of ['running','queued','completed','failed','cancelled'])expect(automationWait({state} as any,false)).toBeUndefined();
  expect(automationWait({state:'waiting_input'} as any,true)).toEqual({for:'agent'});
  expect(automationWait({state:'waiting_input'} as any,false)).toEqual({for:'user',reason:'next_command'});
 });

 // r11: who the round waits for, so the app pops its chat only on a real wait (wincu.8 pops for question, confirmation, continue).
 test('a self-paused goal round waits for the user to continue; the agent asking the user is a question',()=>{
  const run={taskId:'t',requestId:'r',updatedAt:9,phase:'acting' as const,label:'Finished this round',step:2};
  const view=(task:Record<string,unknown>,deciding=false,asked=false)=>computerLiveView(run,{taskId:'t',agentSessionId:'s1',state:'waiting_input',automationController:'user',...task} as any,Date.now(),deciding,asked);
  for(const reason of ['NO_PROGRESS','ROUND_TIME_LIMIT'])
   expect(view({computerReport:{status:'needs_input',reason,steps:6}},true)).toMatchObject({phase:'waiting_for_user',reason:'continue',label:'Paused: reply in GetPod to continue',sessionId:'s1'});
  // Pod-jinawong r10, tasks f40127bd and 457a4930: the agent asked "shall I go on?" (follow_up asks_user) and nothing popped.
  expect(view({},false,true)).toMatchObject({phase:'waiting_for_user',reason:'question',label:'Answer the question in GetPod'});
  expect(view({},true,true)).toMatchObject({phase:'thinking'});
  expect(view({},false,false)).toMatchObject({phase:'waiting_for_user',reason:'next_command'});
  expect(automationWait({state:'waiting_input'} as any,false,true)).toEqual({for:'user',reason:'question'});
 });
 // Pod-jinawong r10, task 457a4930: right after a round that ended on a withheld screen the app popped GetPod (protected)
 // in front of TradingView. Without a session id no app opens the chat; the overlay still says the user is waited for.
 test('after a round that ended on a withheld screen, the view names no chat to pop',()=>{
  const run={taskId:'t',requestId:'r',updatedAt:9,phase:'acting' as const,label:'Finished this round'};
  const view=computerLiveView(run,{taskId:'t',agentSessionId:'s1',state:'waiting_input',automationController:'user',computerReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,screenWithheld:true}} as any,Date.now(),false,true);
  expect(view).toMatchObject({phase:'waiting_for_user',reason:'question'});expect(view.sessionId).toBeUndefined();
 });

// Pod-jinawong, task 2f65b7cf: the session expired at 30 min but the task stayed waiting_input, so the overlay waited for the user forever.
 test('a closed or expired automation session is ended, not waiting for the user',()=>{
  const run={taskId:'t',requestId:'r',updatedAt:9,phase:'acting' as const,label:'Opening Spotify'};
  const now=10_000_000,idle={taskId:'t',state:'waiting_input',automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'s',name:'Computer Use · Mac'},updatedAt:now-1000};
  const view=(task:Record<string,unknown>)=>computerLiveView(run,{...idle,...task} as any,now).phase;
  expect(view({automationSession:{status:'idle',idleTimeoutMs:1_800_000,idleSince:now-1000}})).toBe('waiting_for_user');
  expect(view({automationSession:{status:'closed',idleTimeoutMs:1_800_000,idleSince:now-1_900_000,closedAt:now-100_000,closedReason:'idle_timeout'}})).toBe('ended');
  // Expired by time before any save recorded it.
  expect(view({automationSession:{status:'idle',idleTimeoutMs:1_800_000,idleSince:now-1_800_000}})).toBe('ended');
  expect(view({automationSession:{status:'closed',idleTimeoutMs:1_800_000,closedReason:'agent'}})).toBe('ended');
 });

 test('a submitted round records its progress under the relay grant it runs on',async()=>{
  const root=mkdtempSync(join(tmpdir(),'computer-live-'));
  const callTool=jest.fn(async()=>({content:[{type:'text',text:'{"state":"approved"}'}]}));
  jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
  let seen:any;
  runComputerSteps.mockImplementation(async(_input:any,deps:any)=>{
   deps.progress({...event('acting',{round:2,action:'open',appId:'Spotify'})});
   seen=adapter.live.get(GRANT);
   return {status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:0,stepRun:{total:2,completed:2,stopReason:'ALL_STEPS_DONE',remaining:[]}};
  });
  const connectors={get:()=>({connectorId:'c',scope:{device_id:'2b1c0d9e-8f7a-4b6c-9d5e-1f2a3b4c5d6e',grant_id:GRANT}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
  const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true,stepMode:()=>true});
  const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:'agent',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
  try{
   await adapter.submit(task,'request','open Chrome, open Spotify',[],false,[]);
   for(let i=0;i<50&&typeof await adapter.inspect(task,'request')!=='object';i++)await new Promise(r=>setImmediate(r));
   expect(runComputerUse).not.toHaveBeenCalled();
   expect(seen).toMatchObject({taskId:'t',requestId:'request',phase:'acting',label:'open Spotify',step:2,total:2});
  }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
 });
});
