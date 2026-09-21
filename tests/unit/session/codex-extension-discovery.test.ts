import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { inspectCodexExtensions } from '../../../src/session/codex-extension-discovery';
import { mergeCodexExtensions, WorkerExtensions } from '../../../src/session/worker-extensions';

let root: string, bin: string;
beforeEach(() => {
 root=mkdtempSync(join(tmpdir(),'codex-extension-discovery-'));
 bin=join(root,'codex');
 writeFileSync(bin, `#!${process.execPath}
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(q.id===undefined)return;
 let result={};
 const fail=()=>process.stdout.write(JSON.stringify({id:q.id,error:{code:-32603,message:'private-provider-secret'}})+'\\n');
 if(q.method==='config/read') {if(process.env.FAIL_CONFIG)return fail();result={config:{mcp_servers:{healthy:{command:'fixture'}}}};}
 if(q.method==='skills/list')result={data:[{skills:[{name:'native',path:'/fixture/native/SKILL.md',enabled:true}]}]};
 if(q.method==='plugin/installed'){
  if(process.env.FAIL_LIST)return fail();
  result={marketplaces:[{name:'fixture',plugins:['broken','healthy'].map(name=>({id:name+'@fixture',name,version:'1',enabled:true,installed:true}))}]};
 }
 if(q.method==='plugin/read'){
  if(q.params.pluginName==='broken')return fail();
  result={plugin:{skills:[{name:'healthy',path:'/fixture/healthy/SKILL.md',enabled:true}]}};
 }
 process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
});`,{mode:0o700});
});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
test('one unreadable plugin preserves native MCP, ordinary skills and other plugins', async()=>{
 const result=await inspectCodexExtensions(bin,root,{HOME:root});
 expect(result.config.mcp_servers.healthy.command).toBe('fixture');
 expect(result.skills.map(s=>s.name)).toEqual(['native','healthy']);
 expect(result.pluginIds).toEqual(['healthy@fixture']);
 expect(result.notices).toHaveLength(1);
 expect(JSON.stringify(result)).not.toContain('private-provider-secret');
 const merged: WorkerExtensions={skills:[],servers:{},notices:[]};
 mergeCodexExtensions(merged,result,{HOME:root});
 expect(merged.servers.codex__healthy).toBeDefined();
 expect(merged.notices).toEqual(result.notices);
});
test('unavailable plugin inventory preserves the successful native config and skill listing', async()=>{
 const result=await inspectCodexExtensions(bin,root,{HOME:root,FAIL_LIST:'1'});
 expect(result.skills.map(s=>s.name)).toEqual(['native']);
 expect(result.config.mcp_servers.healthy).toBeDefined();
 expect(result.pluginIds).toEqual([]);
 expect(result.notices).toHaveLength(1);
});
test('failed core config discovery still fails closed without native diagnostics', async()=>{
 await expect(inspectCodexExtensions(bin,root,{HOME:root,FAIL_CONFIG:'1'})).rejects.toThrow('CODEX_EXTENSION_DISCOVERY_UNAVAILABLE');
});
test('native extension probe strips explicit and inherited Jev credentials but preserves CLI auth', async () => {
 const {validateJevConfig}=await import('../../../src/jev/validation');
 validateJevConfig({enabled:true,provider:'typesafe',model:'jev',apiKeyEnv:'PRIVATE_EXTENSION_JEV_TOKEN'});
 const original=await import('fs').then(fs=>fs.readFileSync(bin,'utf8'));
 writeFileSync(bin,original.replace("require('readline')", "if(process.env.TYPESAFE_API_KEY||process.env.JEV_API_KEY||process.env.PRIVATE_EXTENSION_JEV_TOKEN||process.env.OPENAI_API_KEY!=='native-auth')process.exit(47);require('readline')"),{mode:0o700});
 const result=await inspectCodexExtensions(bin,root,{HOME:root,TYPESAFE_API_KEY:'a',JEV_API_KEY:'b',PRIVATE_EXTENSION_JEV_TOKEN:'c',OPENAI_API_KEY:'native-auth'});
 expect(result.skills.map(s=>s.name)).toContain('native');
});
