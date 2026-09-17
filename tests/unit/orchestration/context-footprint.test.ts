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
