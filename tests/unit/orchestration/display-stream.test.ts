import { partialDisplay } from '../../../src/orchestration/display-stream';
import { EventEmitter } from 'events';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import type { SessionProcess } from '../../../src/session/process';

test.each([
 {display_text:'Hello\n"world" 日本語 🐕',spoken_text:'secret speech'},
 {spoken_text:'do not leak this',display_text:'สวัสดีครับ'},
])('streams only valid display prefixes across arbitrary byte boundaries', object => {
 const json=JSON.stringify(object); let previous='';
 for(let i=0;i<=json.length;i++) {
  const text=partialDisplay(json.slice(0,i));
  expect(object.display_text.startsWith(text)).toBe(true);
  expect(text.startsWith(previous)).toBe(true);previous=text;
 }
 expect(previous).toBe(object.display_text);
});
test('holds split unicode escapes and excludes malformed/internal data',()=>{
 expect(partialDisplay('{"display_text":"a\\uD83D')).toBe('a');
 expect(partialDisplay('{"display_text":"a\\uD83D\\uDC15')).toBe('a🐕');
 expect(partialDisplay('tool result {"display_text":"secret"}')).toBe('');
});
test('StructuredOutput deltas arrive before terminal result; other tool arguments stay private', async()=>{
 const process=Object.assign(new EventEmitter(),{runtimeProfile:{role:'agent',responseSchema:{}},start:async()=>{},sendMessage:()=>{},interrupt:()=>{},stop:async()=>{}}) as unknown as SessionProcess;
 const chunks:string[]=[];
 const turn=startProcessTurn(process,'prompt',1000,()=>{},undefined,[],undefined,chunk=>chunks.push(chunk));
 const emit=(event:unknown)=>process.emit('output',JSON.stringify(event));
 emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'private',name:'Bash'}}});
 emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'secret'}}});
 expect(chunks).toEqual([]);
 emit({type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'output',name:'StructuredOutput'}}});
 emit({type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"display_text":"Hello'}}});
 expect(chunks).toEqual(['{"display_text":"Hello']);
 emit({type:'result',structured_output:{display_text:'Hello world',spoken_text:'Hello'}});
 await expect(turn.result).resolves.toMatchObject({text:JSON.stringify({display_text:'Hello world',spoken_text:'Hello'})});
});
