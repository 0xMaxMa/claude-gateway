import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerLiveRuns,computerActionLabel,computerLiveView} from '../../../src/orchestration/computer-live';
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
  expect(view({state:'waiting_input',automationController:'agent'}).phase).toBe('thinking');
  expect(view({state:'waiting_input',automationController:'user'}).phase).toBe('waiting_for_user');
  expect(view({state:'waiting_input',automationController:'agent',pendingQuestion:{questionId:'q',text:'Which song?',revision:1}}).phase).toBe('waiting_for_user');
  expect(view({state:'needs_reconciliation'}).phase).toBe('waiting_for_user');
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
