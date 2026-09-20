// Opt-in local native CLI smoke; no model call, remote provider or real credential.
import { CodexNativeClient } from '../../src/session/codex-native-mcp-client';
import { resolveCodexRuntime } from '../../src/session/codex-runtime';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import assert from 'assert/strict';
const root = await mkdtemp(join(tmpdir(), 'gateway-extension-smoke-'));
const home = join(root, 'codex'); await mkdir(home);
const server = join(root, 'mcp.cjs');
await writeFile(server, String.raw`
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(q.id===undefined)return;let result={};
 if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}};
 if(q.method==='tools/list')result={tools:['echo','disabled'].map(name=>({name,description:'Fixture '+name,inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}))};
 if(q.method==='tools/call')result={content:[{type:'text',text:'echo:'+q.params.arguments.value}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
});`);
await writeFile(join(home, 'config.toml'), `model="gpt-5.6-luna"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nwire_api="responses"\nbase_url="http://127.0.0.1:1/v1"\nenv_key="FIXTURE_CODEX_KEY"\n[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([server])}\ndisabled_tools=["disabled"]\n`);
const client = new CodexNativeClient({ bin: resolveCodexRuntime().executable, cwd: root, home, servers: ['fixture'], env: { FIXTURE_CODEX_KEY: 'local-fixture-not-a-real-key' } });
try {
 const listing = await client.listTools();
 assert(listing.tools.some(tool=>tool.name==='fixture__echo'));
 assert(!listing.tools.some(tool=>tool.name==='fixture__disabled'),'native disabled tools leaked');
 const result = await client.callTool({ name:'fixture__echo',arguments:{value:'ok'} });
 assert.equal(result.content[0].text,'echo:ok');
 await assert.rejects(client.callTool({name:'fixture__disabled',arguments:{value:'denied'}}));
 console.log(JSON.stringify({pass:true,toolCount:listing.tools.length,roundtrip:true,disabledToolDenied:true,modelCalls:0}));
} finally {await client.close();await rm(root,{recursive:true,force:true});}
