import {randomUUID} from 'node:crypto';
import {historyCommand,newTabCommand,textEntryRequested} from '../../../src/automation/direct-command';
import {planBrowserCommand} from '../../../src/automation/browser-command';
import {shortcutCommand} from '../../../src/automation/computer-command';
import {directCommandSpeech} from '../../../src/automation/command-speech';
import {destructiveText} from '../../../src/automation/computer-safety';
import {runBrowserUse,type BrowserUseDependencies,type Observation} from '../../../src/automation/browser-use';
import {JevError} from '../../../src/jev/types';
import type {BrowserTaskReport} from '../../../src/jev/browser-contract';
import type {ComputerTaskReport,TaskSnapshot} from '../../../src/orchestration/types';
import {acceptsDirectCommand} from '../../../src/orchestration/tasks/automation-session';

// Sessions b01a566f (Remote Browser, YouTube) and a4b9ee81 (Computer Use).

describe('back and new-tab wording as spoken', () => {
 test.each(['ย้อนกลับไปหน้าก่อนหน้า','ย้อนกลับไปหน้าก่อนหน้าครับ','กลับไปหน้าก่อนหน้า','ย้อนกลับ ไป หน้าก่อนหน้า','ย้อนไปหน้าที่แล้ว','go back to the previous page'])('%s is Back',command=>{
  expect(historyCommand(command)).toBe('back');
  expect(planBrowserCommand(command)).toEqual({kind:'history',direction:'back'});
 });
 test('wording that only mentions a page is not Back',()=>{
  expect(historyCommand('ย้อนกลับไปหน้าก่อนหน้าแล้วกดเล่น')).toBeUndefined();
  expect(historyCommand('หน้าก่อนหน้ามีอะไร')).toBeUndefined();
 });
 test.each(['เปิดแท็บ Google ใหม่','เปิด แท็กใหม่','เปิดแท็กใหม่','เปิดแท็บ ใหม่'])('%s asks for a new tab on Remote Browser',command=>{
  expect(planBrowserCommand(command)).toEqual({kind:'new_tab'});
 });
 test('Computer Use presses Cmd+T only for a bare new tab, also as STT hears it',()=>{
  expect(shortcutCommand('เปิด แท็กใหม่')).toMatchObject({shortcut:'cmd+t',standard:'tab:new'});
  expect(newTabCommand('เปิดแท็บ Google ใหม่')).toEqual({site:'google'});
  expect(shortcutCommand('เปิดแท็บ Google ใหม่')).toBeUndefined();
 });
});

describe('spoken outcome', () => {
 const browserReport=(reason:string):BrowserTaskReport=>({contractVersion:1,status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0,commandOutcome:{done:false,reason,...(reason==='NEW_TAB_OUT_OF_SCOPE'?{action:{kind:'new_tab'}}:{})}} as BrowserTaskReport);
 const computerReport=(reason:string):ComputerTaskReport=>({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0,phase:'terminal',trace:[{phase:'waiting',reason,sequence:1,round:1,at:1,revision:2,steps:0,evaluations:0}]});
 test('a new tab outside the approved tab says to name the site, in Thai',()=>{
  expect(directCommandSpeech({browserReport:browserReport('NEW_TAB_OUT_OF_SCOPE')},'เปิดแท็บใหม่')?.spoken).toBe('เปิดแท็บใหม่ไม่ได้ บอกชื่อเว็บแทน');
 });
 test('a shortcut with GetPod in front says to bring the browser forward',()=>{
  expect(directCommandSpeech({computerReport:computerReport('SHORTCUT_UNAVAILABLE')},'เปิดแท็บใหม่')?.spoken).toBe('ใช้คำสั่งนี้กับแอปที่อยู่หน้าสุดไม่ได้ เอาเบราว์เซอร์ขึ้นมาไว้หน้าสุดก่อน');
 });
 test('"Go." in a Thai conversation is answered in Thai',()=>{
  expect(directCommandSpeech({computerReport:computerReport('NO_SUPPORTED_ACTION')},'Go.')?.spoken).toBe('Could not find Go on the screen.');
  expect(directCommandSpeech({computerReport:computerReport('NO_SUPPORTED_ACTION')},'Go.',{thai:true})?.spoken).toBe('ไม่เจอปุ่ม Go บนหน้าจอ');
 });
 test('"say it again" is never spoken once the task has ended',()=>{
  const report:ComputerTaskReport={status:'blocked',reason:'JEV_INVALID_RESPONSE',steps:0,evaluations:0,phase:'terminal'};
  expect(directCommandSpeech({computerReport:report},'คริยา')?.spoken).toBe('ยังไม่ได้ทำ คริยา ลองพูดใหม่อีกครั้ง');
  const ended=directCommandSpeech({computerReport:report},'คริยา',{ended:true})!;
  expect(ended.spoken).toBe('ยังไม่ได้ทำ คริยา และงานนี้หยุดไปแล้ว ต้องเริ่มงานใหม่');
  expect(ended.spoken).not.toContain('ลองพูดใหม่');
 });
});

// Session 4d9ee168: a blank tab failed START_URL_REQUIRED, then the voice said
// "task ended, start a new one" although the same task took the next commands.
describe('blank Remote Browser tab', () => {
 test('START_URL_REQUIRED tells the user to name the site, in Thai',()=>{
  const report={contractVersion:1,status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0,commandOutcome:{done:false,reason:'START_URL_REQUIRED'}} as BrowserTaskReport;
  expect(directCommandSpeech({browserReport:report},'เลื่อนลง')?.spoken).toBe('แท็บยังว่าง บอกชื่อเว็บก่อน เช่น เข้า google.com');
 });
 test('a failed round that still takes commands is not spoken as ended',()=>{
  const browserReport={contractVersion:1,status:'blocked',reason:'START_URL_REQUIRED',steps:0,evaluations:0} as BrowserTaskReport;
  const task={state:'failed',automationController:'user',gatewayTarget:{adapter:'browser',sessionId:'b',name:'B'},browserReport,updatedAt:Date.now()} as unknown as TaskSnapshot;
  expect(acceptsDirectCommand(task)).toBe(true);
  expect(acceptsDirectCommand({...task,state:'cancelled'})).toBe(false);
  expect(acceptsDirectCommand({...task,browserReport:{...browserReport,reason:'OUTCOME_UNKNOWN'}})).toBe(false);
 });
});

describe('a step that only checks the page is not high-impact', () => {
 test.each(['confirm the page has loaded','Confirm that the page is loaded','verify the video is visible','ยืนยันว่าหน้าโหลดแล้ว'])('%s',step=>expect(destructiveText(step)).toBe(false));
 test.each(['confirm order','confirm','กดยืนยัน','confirm the payment','ยืนยันการโอน'])('%s stays high-impact',step=>expect(destructiveText(step)).toBe(true));
});

describe('Remote Browser direct commands', () => {
 const scope={device_id:'device',grant_id:'grant',tab_id:'tab'};
 const page:Observation={protocol_version:1,generation:'g1',url:'https://www.youtube.com/',title:'YouTube',text:'YouTube',
  elements:[{ref:'s1',label:'ค้นหา',tag:'input',role:'combobox',operations:['TYPE_TEXT'],in_viewport:true},{ref:'v1',label:'First video',tag:'a',role:'link',operations:['CLICK'],in_viewport:true}],
  scroll:{up:false,down:true},truncated:{text:false,elements:false},navigation:{can_go_back:true,can_go_forward:false}} as Observation;
 function extension(){
  const calls:string[]=[];
  const call:BrowserUseDependencies['call']=async(name)=>{
   calls.push(name);
   if(name==='browser_task_acquire')return {state:'completed',result:{protocol_version:1,lease_token:randomUUID()}};
   if(name.startsWith('browser_task_'))return {state:'completed',result:{}};
   if(name==='page_observe')return structuredClone(page);
   return {state:'completed',result:{observation:{...structuredClone(page),generation:'g2'}}};
  };
  return {call,mutations:()=>calls.filter(n=>n.startsWith('page_')&&n!=='page_observe')};
 }
 const pick=(operation:string):BrowserUseDependencies['evaluate']=>async request=>({model:'jev',answers:Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
  const ids=Object.keys(q.criteria),choice=key==='operation'?operation:ids[0];
  return [key,{choice,confidence:0.95,probabilities:Object.fromEntries(ids.map(id=>[id,id===choice?1:0]))}];
 }))});
 const run=(goal:string,deps:Partial<BrowserUseDependencies>)=>{
  const b=extension();
  return runBrowserUse({contractVersion:1,goal,scope,command:true,yieldAfterAction:true} as never,{call:b.call,evaluate:pick('TYPE_TEXT'),...deps} as BrowserUseDependencies,new AbortController().signal).then(result=>({result,b}));
 };
 // The video's own audio, heard as a command (seq 4, 14:42:04).
 const transcript='วันนี้เราจะมาดูวิธีทำอาหารง่ายๆ ที่บ้านกันนะครับ เริ่มจากเตรียมวัตถุดิบให้พร้อม แล้วก็ตั้งกระทะให้ร้อนก่อน';
 test('a stray transcript is never typed into a field',async()=>{
  const resolveFieldText=jest.fn(async()=>({text:transcript}));
  const {result,b}=await run(transcript,{resolveFieldText} as never);
  expect(b.mutations()).toEqual([]);
  expect(resolveFieldText).not.toHaveBeenCalled();
  expect(result).toMatchObject({status:'needs_verification',reason:'COMMAND_WAITING_INPUT',commandOutcome:{done:false,reason:'TEXT_ENTRY_NOT_REQUESTED'}});
 });
 test('an explicit พิมพ์ still types',async()=>{
  expect(textEntryRequested('พิมพ์ แมว')).toBe(true);
  const {b}=await run('พิมพ์ แมว',{});
  expect(b.mutations()).toEqual(['page_type']);
 });
 test.each(['INVALID_RESPONSE','DEADLINE_EXCEEDED'] as const)('Jev %s is Not done for this command only',async code=>{
  const {result,b}=await run('เปิดคลิปแรก',{evaluate:async()=>{throw new JevError(code,'provider prose',{validationReason:'DISTRIBUTION_SUM'});}});
  expect(b.mutations()).toEqual([]);
  expect(result).toMatchObject({status:'needs_verification',reason:'COMMAND_WAITING_INPUT',commandOutcome:{done:false,reason:code}});
 });
 test('a quota failure still stops the task',async()=>{
  const {result}=await run('เปิดคลิปแรก',{evaluate:async()=>{throw new JevError('QUOTA_EXCEEDED','provider prose');}});
  expect(result.status).toBe('failed');
 });
});
