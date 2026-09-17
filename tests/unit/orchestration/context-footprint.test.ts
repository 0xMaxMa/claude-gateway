import {mkdtempSync,writeFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {contextFootprint,referenceTokens} from '../../../src/orchestration/context-footprint';
test('counts generated sections separately from raw files and labels schemas without double counting',()=>{
 const dir=mkdtempSync(join(tmpdir(),'footprint-'));
 try{
  writeFileSync(join(dir,'AGENTS.md'),'Long source '.repeat(100));
  writeFileSync(join(dir,'CLAUDE.md'),'--- AGENT IDENTITY ---\nShort identity\n\n--- USER PROFILE ---\nภาษาไทย\n');
  const result=contextFootprint(dir,false);
  expect(result.rows.find(r=>r.name==='↳ AGENTS.md')?.tokens).toBe(referenceTokens('Short identity\n\n'));
  expect(result.rows.find(r=>r.name==='USER.md · source file')?.tokens).toBeNull();
  expect(result.rows.find(r=>r.name.startsWith('Agent gateway tool'))?.tokens).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain('Short identity');
  expect(referenceTokens('<|endoftext|> ภาษาไทย')).toBeGreaterThan(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('does not inspect host files for container-only agents',()=>{
 expect(contextFootprint(undefined,false).rows).toEqual([]);
});
test('reuses the cached snapshot for the same workspace+semanticIntake key within 30s',()=>{
 const dir=mkdtempSync(join(tmpdir(),'footprint-cache-'));
 try{
  writeFileSync(join(dir,'AGENTS.md'),'first version');
  const first=contextFootprint(dir,false);
  writeFileSync(join(dir,'AGENTS.md'),'second version, much longer than the first one');
  const second=contextFootprint(dir,false);
  expect(second).toBe(first); // same object identity: served from cache, not re-read
  expect(second.rows.find(r=>r.name==='AGENTS.md · source file')?.tokens).toBe(first.rows.find(r=>r.name==='AGENTS.md · source file')?.tokens);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('skips reading a source file larger than 1MB, reporting it as unmeasured rather than throwing',()=>{
 const dir=mkdtempSync(join(tmpdir(),'footprint-large-'));
 try{
  writeFileSync(join(dir,'MEMORY.md'),'x'.repeat(1024*1024+1));
  const result=contextFootprint(dir,false);
  const row=result.rows.find(r=>r.name==='MEMORY.md · source file');
  expect(row?.tokens).toBeNull();
  expect(row?.characters).toBeNull();
  expect(row?.hasContent).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('conversation_intake schema is counted only when semanticIntake is enabled',()=>{
 const dirA=mkdtempSync(join(tmpdir(),'footprint-intake-a-'));
 const dirB=mkdtempSync(join(tmpdir(),'footprint-intake-b-'));
 try{
  const withIntake=contextFootprint(dirA,true).rows.find(r=>r.name.startsWith('Agent gateway tool'))!;
  const withoutIntake=contextFootprint(dirB,false).rows.find(r=>r.name.startsWith('Agent gateway tool'))!;
  expect(withIntake.name).not.toBe(withoutIntake.name); // row label embeds the schema count, so it differs by exactly one tool
  expect(withIntake.tokens!).toBeGreaterThan(withoutIntake.tokens!);
 }finally{rmSync(dirA,{recursive:true,force:true});rmSync(dirB,{recursive:true,force:true});}
});
