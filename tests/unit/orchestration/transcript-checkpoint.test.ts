import { mkdtemp, writeFile, readFile, appendFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkpointTranscript, rollbackUnansweredTranscript } from '../../../src/orchestration/transcript-checkpoint';

const line = (row: unknown) => JSON.stringify(row)+'\n';
let dir: string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'transcript-checkpoint-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
test('repeated unanswered retries do not grow the resumed context; diagnostic archives retain each attempt',async()=>{
 const path=join(dir,'session.jsonl'),original=line({type:'assistant',message:{model:'model',content:[{type:'text',text:'Earlier answer'}]}});
 await writeFile(path,original);
 for(let i=0;i<3;i++) {
  const checkpoint=(await checkpointTranscript(path))!;
  await appendFile(path,line({type:'user',message:{content:[{type:'text',text:'Full pending report'}]}})+line({type:'assistant',isApiErrorMessage:true,message:{content:[{type:'text',text:'Provider error'}]}}));
  expect(await rollbackUnansweredTranscript(checkpoint)).toBe(true);
  expect(await readFile(path,'utf8')).toBe(original);
 }
 expect((await readdir(dir)).filter(p=>p.includes('failed-turn'))).toHaveLength(3);
});
test.each([
 {type:'assistant',message:{model:'real',content:[{type:'text',text:'Partial response'}]}},
 {type:'user',message:{content:[{type:'tool_result',content:'Task created'}]}},
 {type:'system',subtype:'compact_boundary'},
 {type:'unknown-record'},
])('never rewinds real progress or unknown transcript records: %j',async row=>{
 const path=join(dir,'session.jsonl');await writeFile(path,line({type:'user',message:{content:'old'}}));
 const checkpoint=(await checkpointTranscript(path))!;
 await appendFile(path,line({type:'user',message:{content:'new'}})+line(row));
 const before=await readFile(path,'utf8');
 expect(await rollbackUnansweredTranscript(checkpoint)).toBe(false);
 expect(await readFile(path,'utf8')).toBe(before);
});
