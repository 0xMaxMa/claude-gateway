import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('../../../src/automation/computer-use',()=>({runComputerUse:jest.fn(async()=>({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0}))}));
jest.mock('../../../src/automation/computer-steps',()=>({
 ...jest.requireActual('../../../src/automation/computer-steps'),
 runComputerSteps:jest.fn(async()=>({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:3,evaluations:2,stepRun:{total:2,completed:2,stopReason:'ALL_STEPS_DONE',remaining:[]}})),
}));
const {runComputerUse}=require('../../../src/automation/computer-use');
const {runComputerSteps}=require('../../../src/automation/computer-steps');

async function submit(goal:string,stepMode:boolean|undefined,preparedInputs:any[]=[],userText?:string){
 const root=mkdtempSync(join(tmpdir(),'computer-steps-'));
 runComputerUse.mockClear();runComputerSteps.mockClear();
 const callTool=jest.fn(async()=>({content:[{type:'text',text:'{"state":"approved"}'}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const connectors={get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true,...(stepMode===undefined?{}:{stepMode:()=>stepMode}),...(userText===undefined?{}:{userSteps:()=>userText})});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:'agent',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{
  await adapter.submit(task,'request',goal,[],false,preparedInputs);
  let outcome:any;for(let i=0;i<50;i++){outcome=await adapter.inspect(task,'request');if(typeof outcome==='object')break;await new Promise(r=>setImmediate(r));}
  return outcome;
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
}

test('an explicit step list uses the step runner only when the feature is enabled',async()=>{
 const outcome=await submit('เปิด tab ใหม่, scroll ลงมา',true);
 expect(runComputerSteps).toHaveBeenCalledTimes(1);expect(runComputerUse).not.toHaveBeenCalled();
 expect(runComputerSteps.mock.calls[0][0]).toEqual({steps:['เปิด tab ใหม่','scroll ลงมา'],revision:1});
 expect(outcome.type).toBe('paused');
 expect(outcome.computerReport.stepRun).toEqual({total:2,completed:2,stopReason:'ALL_STEPS_DONE',remaining:[]});
 expect(outcome.computerReport.reason).toBe('COMMAND_WAITING_INPUT');
});

test('a delegated prompt wrapping a numbered list runs only the listed steps',async()=>{
 // Goal shape observed in E2E: preamble, header, numbered list, trailing pacing note.
 await submit('คุณกำลังควบคุม Mac ของผู้ใช้ผ่าน Computer Use \n\nขั้นตอนที่ต้องทำทีละขั้น:\n1. เปิด Chrome แล้วเปิด tab ใหม่ (Cmd+T)\n2. ไปที่ google.com\n3. ค้นหาคำว่า "getpod"\n4. คลิก link แรกที่ปรากฏ\n5. Scroll ลงมาในหน้านั้น\n\nเริ่มจากขั้นตอนที่ 1 ก่อน: เปิด Chrome และกด Cmd+T เพื่อเปิด tab ใหม่',true);
 expect(runComputerSteps.mock.calls[0][0].steps).toEqual(['เปิด Chrome แล้วเปิด tab ใหม่ (Cmd+T)','ไปที่ google.com','ค้นหาคำว่า "getpod"','คลิก link แรกที่ปรากฏ','Scroll ลงมาในหน้านั้น']);
});

test.each([
 ['disabled by default','เปิด tab ใหม่, scroll ลงมา',undefined,[]],
 ['explicitly disabled','เปิด tab ใหม่, scroll ลงมา',false,[]],
 ['single command','scroll ลงมา',true,[]],
 ['agent-prepared field values','เปิด tab ใหม่, scroll ลงมา',true,[{application:'com.google.Chrome',label:'Search',text:'from agent'}]],
])('%s keeps the normal one-command path',async(_name,goal,stepMode,prepared)=>{
 await submit(goal,stepMode,prepared);
 expect(runComputerSteps).not.toHaveBeenCalled();expect(runComputerUse).toHaveBeenCalledTimes(1);
});

test('computerSteps is a recognised Jev feature flag',()=>{
 const {validateJevConfig}=require('../../../src/jev/validation');
 expect(()=>validateJevConfig({features:{computerSteps:{enabled:true}}})).not.toThrow();
 expect(()=>validateJevConfig({features:{computerSteps:{enabled:'yes'}}})).toThrow();
 // L7: only implemented features are accepted; the unused reserved flags are gone.
 for(const flag of ['computerTasks','browserTasks','browserSteps'])expect(()=>validateJevConfig({features:{[flag]:{enabled:true}}})).not.toThrow();
 for(const flag of ['skillRouting','progressFiltering','conversationIntake'])expect(()=>validateJevConfig({features:{[flag]:{enabled:true}}})).toThrow();
});

test('E2E-3: the user\'s own step list is used verbatim instead of the agent\'s rewritten goal',async()=>{
 // Recorded: the user typed a one-line list; the agent delegated a rewritten,
 // merged list ("เปิด Chrome แล้วกด Cmd+T ...", "(ไม่ใช่ ad)") plus pacing text.
 const user='ทำตามขั้นตอนนี้ทีละขั้น: เปิด tab ใหม่, เข้า google.com, ค้น getpod, เข้า link แรก, scroll ลงมา';
 const agent='ควบคุม Mac ของผู้ใช้ผ่าน Computer Use ทำขั้นตอนต่อไปนี้ทีละขั้น:\n\n1. เปิด Chrome แล้วกด Cmd+T เพื่อเปิด tab ใหม่\n2. คลิก address bar แล้วพิมพ์ google.com กด Enter\n3. พิมพ์ "getpod" ใน search box แล้วกด Enter\n4. คลิก link แรกในผลการค้นหา (ไม่ใช่ ad)\n5. Scroll ลงมาในหน้านั้น\n\nทำทีละขั้นตอน รอให้แต่ละขั้นสำเร็จก่อนไปขั้นถัดไป';
 await submit(agent,true,[],user);
 expect(runComputerSteps.mock.calls[0][0].steps).toEqual(['เปิด tab ใหม่','เข้า google.com','ค้น getpod','เข้า link แรก','scroll ลงมา']);
 // Without a list in the user's message the agent goal remains the fallback.
 await submit('เปิด tab ใหม่, scroll ลงมา',true,[],'ช่วยหน่อย');
 expect(runComputerSteps.mock.calls[0][0].steps).toEqual(['เปิด tab ใหม่','scroll ลงมา']);
});

test('P1-8: "zoom อีก" after "zoom" reaches Jev verbatim, with the previous command and action as context',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-repeat-'));runComputerUse.mockClear();
 const callTool=jest.fn(async()=>({content:[{type:'text',text:'{"state":"approved"}'}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const connectors={get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const settle=async(task:any,request:string)=>{for(let i=0;i<50;i++){if(typeof await adapter.inspect(task,request)==='object')return;await new Promise(r=>setImmediate(r));}};
 try{
  runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{deps.observation({generation:'g',application:'com.apple.Maps',controls:[],apps:[],truncated:false});return {status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,lastAction:{kind:'press',label:'Zoom in',role:'AXButton'}};});
  const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
  await adapter.submit(task,'r1','zoom');await settle(task,'r1');
  await adapter.submit({...task,revision:2},'r2','zoom อีก');await settle({...task,revision:2},'r2');
  const second=runComputerUse.mock.calls[1][0];
  expect(second.goal).toBe('zoom อีก');
  expect(second.interactionContext).toContain('"previousCommand":"zoom"');
  expect(second.interactionContext).toContain('do it again, in any language, means the previous command');
  expect(second.interactionContext).toContain('"previousAction":{"kind":"press","label":"Zoom in","role":"AXButton"}');
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});
