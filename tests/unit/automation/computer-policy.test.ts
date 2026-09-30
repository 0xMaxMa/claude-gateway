import { observedEffect } from '../../../src/automation/computer-policy';
import type { ComputerState } from '../../../src/automation/computer-use';
const state: ComputerState = {generation:'g1',application:'notes',apps:[],truncated:false,controls:[{ref:'a',role:'field',label:'Note',value:'',actions:['type']}]};
test('generation and unrelated clock labels alone do not demonstrate progress',()=>{
 const after=structuredClone(state);after.generation='g2';after.controls[0].label='12:34';
 expect(observedEffect(state,after,{kind:'press',ref:'a'})).toBe(false);
});
test('typing is progress only when the uniquely matched field has the requested value',()=>{
 const after=structuredClone(state);after.controls[0].value='hello';
 expect(observedEffect(state,after,{kind:'type',ref:'a',text:'hello'})).toBe(true);
 expect(observedEffect(state,after,{kind:'type',ref:'a',text:'different'})).toBe(false);
 after.controls.push({...after.controls[0],ref:'b'});
 expect(observedEffect(state,after,{kind:'type',ref:'a',text:'hello'})).toBe(false);
});
test('opening another application requires the expected foreground application',()=>{
 expect(observedEffect(state,{...state,application:'maps'},{kind:'open',app_id:'maps'})).toBe(true);
 expect(observedEffect(state,{...state,application:'browser'},{kind:'open',app_id:'maps'})).toBe(false);
});
test('accepts valid rounded Jev distributions on the two-percent boundary',()=>{
 const {readChoice}=require('../../../src/automation/computer-policy');
 const criteria={a:'A',b:'B',c:'C',d:'D'};
 for(const p of [{a:.80,b:.06,c:.06,d:.06},{a:.80,b:.08,c:.07,d:.07}]){
  expect(()=>readChoice({choice:'a',confidence:.8,probabilities:p},criteria)).not.toThrow();
 }
 expect(()=>readChoice({choice:'a',confidence:.8,probabilities:{a:.8,b:0,c:0,d:0}},criteria)).toThrow('INVALID_DECISION');
});
test('reopening the active app needs an observed window or content change',()=>{
 expect(observedEffect(state,{...state,generation:'g2'},{kind:'open',app_id:'notes'})).toBe(false);
 expect(observedEffect(state,{...state,windowTitle:'New note'},{kind:'open',app_id:'notes'})).toBe(true);
});


describe('direct command payload choices',()=>{
 const {commandTextCandidates}=require('../../../src/automation/computer-command');
 test('offers exact suffixes across languages without inventing a URL',()=>{
  expect(commandTextCandidates('เข้า yahoo')).toEqual(['yahoo']);
  expect(commandTextCandidates('ค้นหา จองตั๋วเครื่องบิน')).toEqual(['จองตั๋วเครื่องบิน']);
  expect(commandTextCandidates('search train tickets')).toEqual(['train tickets','tickets']);
  expect(commandTextCandidates('écris bonjour monde')).toEqual(['bonjour monde','monde']);
 });
 test('preserves literal punctuation and whitespace; bounds long instructions',()=>{
  expect(commandTextCandidates('type Hello,  world!')).toEqual(['Hello,  world!','world!']);
  expect(commandTextCandidates('พิมพ์ "New  York"')).toEqual(['New  York']);
  expect(commandTextCandidates('one two three four five six seven eight nine')).toEqual([]);
  expect(commandTextCandidates('พิมพ์ค้นหา')).toEqual([]);
 });
});

test('standard commands never reinterpret ambiguous, negated or compound instructions',()=>{
 const {standardComputerCommand}=require('../../../src/automation/computer-command');
 for(const command of ['close','ปิด','do not scroll down','scroll down then click','scroll down in the left sidebar','ปิดแท็บ','__proto__'])expect(standardComputerCommand(command)).toBeUndefined();
 expect(standardComputerCommand('  SCROLL   DOWN ')).toBe('scroll:down');
});
