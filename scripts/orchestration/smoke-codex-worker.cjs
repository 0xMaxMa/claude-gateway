#!/usr/bin/env node
// Opt-in native-binary smoke: local fake Responses API, no model billing or real credentials.
require('ts-node/register/transpile-only');
const {resolveCodexRuntime}=require('../../src/session/codex-runtime');
const {CODEX_RUNTIME_LABEL}=require('../../src/session/codex-container-runtime');
const {CodexProcess} = require('../../src/session/codex-process');
const {mkdir,mkdtemp,writeFile,rm} = require('fs/promises');
const {join} = require('path');
const {homedir} = require('os');
const http = require('http');
const assert = require('assert/strict');
const {once} = require('events');
const {randomUUID} = require('crypto');
const {execFileSync} = require('child_process');
const containerMode = process.argv.includes('--container');
const nativeAuthMode = process.argv.includes('--native-auth');
const originalCodexHome = process.env.CODEX_HOME;
const connectorMode = process.argv.includes('--connector');
if (containerMode && connectorMode) throw new Error('Custom connectors are host-only');
const MCP = String.raw`
const fs=require('fs'),readline=require('readline');
readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result={};
if(q.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
if(q.method==='tools/list')result={tools:[{name:'fixture_echo',description:'Return the supplied value.',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]};
if(q.method==='tools/call'){if(fs.readFileSync(process.env.FIXTURE_TICKET,'utf8')!=='fixture-ticket')throw Error('ticket missing');fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify(q.params)+'\n');result={content:[{type:'text',text:'MCP roundtrip: '+q.params.arguments.value}]};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');});
`;
(async()=>{
  const cache=join(homedir(),'.cache');await mkdir(cache,{recursive:true});const directory=await mkdtemp(join(cache,'gateway-codex-smoke-'));
  let bridge; let createContainer;
  const containerName = containerMode ? 'gateway-codex-smoke-' + randomUUID().slice(0,8) : undefined;
  await mkdir(join(directory,'.codex'));
  await writeFile(join(directory,'.codex','config.toml'),'[mcp_servers.unapproved]\ncommand = "node"\nargs = ["-e", "process.exit(91)"]\n');
  const requests=[];const adapters=[];let sequence=0;let amended=false;let acknowledged=false;let hanging=false;const sockets=new Set();
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url.endsWith('/responses')){res.writeHead(404);return res.end();}
    const body=JSON.parse(raw);requests.push(body);
    if(hanging)return;
    if(sequence>0)await new Promise(resolve=>setTimeout(resolve,75));
    const id='resp_'+(++sequence), messageId='msg_'+sequence;
    const namespace=body.tools?.find(t=>t.type==='namespace'&&t.name===(connectorMode?'mcp__fixture':'mcp__gateway'));
    const toolName=connectorMode?'tool_call':'fixture_echo';
    const tool=namespace?.tools.find(t=>t.name===toolName) ?? body.tools?.find(t=>t.name===(connectorMode?'mcp__fixture__tool_call':'mcp__gateway__fixture_echo'));
    const toolArgs=connectorMode?{name:'fixture_echo',arguments:{value:'hello'}}:{value:'hello'};
    const output=sequence===1&&tool?[{type:'function_call',id:'fc_1',call_id:'call_fixture_1',name:tool.name,...(namespace?{namespace:namespace.name}:{}),arguments:JSON.stringify(toolArgs)}]:[{type:'message',id:messageId,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'Canonical fixture result '+sequence,annotations:[]}]}];
    const response={id,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'gpt-test',output,usage:{input_tokens:100,input_tokens_details:{cached_tokens:40,cache_write_tokens:20},output_tokens:20,output_tokens_details:{reasoning_tokens:5},total_tokens:120}};
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    const emit=(type,payload)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...payload})+'\n\n');
    emit('response.created',{response:{...response,status:'in_progress',output:[]}});
    for(const [index,item] of output.entries()){
      emit('response.output_item.added',{output_index:index,item:item.type==='message'?{...item,status:'in_progress',content:[]}:item});
      if(item.type==='message'){
        emit('response.content_part.added',{item_id:item.id,output_index:index,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
        emit('response.output_text.delta',{item_id:item.id,output_index:index,content_index:0,delta:item.content[0].text});
        emit('response.output_text.done',{item_id:item.id,output_index:index,content_index:0,text:item.content[0].text});
        emit('response.content_part.done',{item_id:item.id,output_index:index,content_index:0,part:item.content[0]});
      }
      emit('response.output_item.done',{output_index:index,item});
    }
    emit('response.completed',{response});res.end();
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  try {
  server.listen(0,containerMode?'0.0.0.0':'127.0.0.1');await once(server,'listening');
  process.env.GATEWAY_CODEX_SMOKE_KEY='fake-local-key';
  const mcp=join(directory,'mcp.json'), calls=join(directory,'calls.jsonl');
  await writeFile(join(directory,'mcp.cjs'),MCP);await writeFile(join(directory,'ticket'),'fixture-ticket');
  await writeFile(mcp,JSON.stringify({mcpServers:{gateway:{command:process.execPath,args:[join(directory,'mcp.cjs')],env:{FIXTURE_TICKET:join(directory,'ticket'),FIXTURE_CALLS:calls}}}}));
  if(containerMode){
    const socket=join(directory,'fixture.sock');
    bridge=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;await require('fs/promises').appendFile(calls,body+'\n');res.end(JSON.stringify({text:'MCP roundtrip: hello'}));});
    bridge.listen(socket);await once(bridge,'listening');
    const ticket=join(directory,'container-ticket.json');await writeFile(ticket,JSON.stringify({socket,token:'fixture-ticket',tools:[{name:'fixture_echo',description:'Return supplied value.',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]}));
    await writeFile(mcp,JSON.stringify({mcpServers:{gateway:{command:'unused',args:[],env:{GATEWAY_ORCHESTRATION_TICKET_FILE:ticket}}}}));
    const installerHome=homedir();
    const runtime=resolveCodexRuntime();
    assert(!runtime.containerError,runtime.containerError);
    createContainer=()=>execFileSync('docker',['run','-d','--name',containerName,'--cap-drop','ALL','--security-opt','no-new-privileges','--add-host','host.docker.internal:host-gateway','--label',`${CODEX_RUNTIME_LABEL}=${runtime.fingerprint}`,...runtime.mounts.flatMap(m=>['--mount',`type=bind,src=${m.source},dst=${m.target},readonly`]),'--mount',`type=bind,src=${directory},dst=/workspace`,'--mount',`type=bind,src=${process.execPath},dst=/usr/bin/node,readonly`,process.env.GATEWAY_CODEX_SMOKE_IMAGE || 'debian:stable-slim','node','-e',`const fs=require('fs');fs.mkdirSync(${JSON.stringify(installerHome)},{recursive:true,mode:511});fs.chmodSync(${JSON.stringify(installerHome)},511);setInterval(()=>{},10000);`],{stdio:'pipe'});
  }
  if(createContainer)createContainer();
  const options={agent:{workspace:directory,...(containerMode?{type:'app-agent',container:containerName}:{})},gateway:{gateway:{}},profile:{role:'worker',mcpConfigPath:mcp,overlay:'Use fixture_echo once, then return a brief result.',hostExecution:!containerMode,containerExecution:containerMode},sessionId:'fixture-logical-session',stateDirectory:join(directory,'state'),config:{model:'gpt-test',baseUrl:`http://${containerMode?'host.docker.internal':'127.0.0.1'}:${server.address().port}/v1`,apiKeyEnv:'GATEWAY_CODEX_SMOKE_KEY'}};
  if(nativeAuthMode){
    const home=join(directory,'native-auth');await mkdir(home,{mode:0o700});
    await writeFile(join(home,'config.toml'), 'model_provider="fixture"\ncli_auth_credentials_store="file"\n[model_providers.fixture]\nname="Fixture"\nwire_api="responses"\nrequires_openai_auth=true\nbase_url='+JSON.stringify(options.config.baseUrl)+'\n',{mode:0o600});
    execFileSync(resolveCodexRuntime().executable,['login','--with-api-key'],{env:{...process.env,CODEX_HOME:home},input:process.env.GATEWAY_CODEX_SMOKE_KEY,stdio:['pipe','pipe','pipe'],timeout:10000});
    process.env.CODEX_HOME=home;delete options.config.baseUrl;delete options.config.apiKeyEnv;
  }
  if(connectorMode) options.gateway.gateway.customConnectors={fixture:{label:'Fixture connector',secretNames:[],credentialOwner:'none',config:{command:process.execPath,args:[join(directory,'mcp.cjs')],env:{FIXTURE_TICKET:join(directory,'ticket'),FIXTURE_CALLS:calls}}}};
  options.checkpoint=async()=>{if(amended)return;amended=true;return {text:'Apply the native checkpoint revision before finishing.',kind:'assignment',acknowledge:()=>{acknowledged=true;}};};
  async function run(){
    const adapter=new CodexProcess(options);adapters.push(adapter);const events=[];
    const result=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Smoke turn timed out')),45000);adapter.on('startup-error',e=>{clearTimeout(timeout);reject(e);});adapter.on('output',line=>{const e=JSON.parse(line);events.push(e);if(e.type==='result'){clearTimeout(timeout);e.is_error?reject(new Error(e.result)):resolve(e);}});});
    try { await adapter.start();adapter.sendMessage('Complete the fixture request.'); } catch(error) { adapter.emit('startup-error',error); }
    const terminal=await result;await adapter.stop();return {terminal,events};
  }
    const first=await run();assert.match(first.terminal.result,/Canonical fixture result/);
    const {readFile}=require('fs/promises');assert.match(await readFile(calls,'utf8'),/hello/);
    assert(first.events.some(e=>e.type==='assistant'&&e.message.content.some(b=>b.name===(connectorMode?'mcp__fixture__tool_call':'mcp__gateway__fixture_echo'))),'native MCP tool was not observed');
    assert(acknowledged,'native steering was not acknowledged');assert(requests.some(r=>JSON.stringify(r.input).includes('native checkpoint revision')),'native revision never reached Responses input');
    assert.equal(first.terminal.usage.input_tokens,sequence*40);assert.equal(first.terminal.usage.cache_read_input_tokens,sequence*40);assert.equal(first.terminal.usage.cache_creation_input_tokens,sequence*20);assert.equal(first.terminal.usage.output_tokens,sequence*20);
    const resumed=await run();assert.equal(resumed.terminal.usage.input_tokens,40);assert.equal(resumed.terminal.usage.cache_read_input_tokens,40);assert.equal(resumed.terminal.usage.cache_creation_input_tokens,20);assert.equal(resumed.terminal.usage.output_tokens,20);
    assert(requests[requests.length-1].input.some(i=>i.type==='function_call_output'),'resumed transcript lost MCP history');
    if(containerMode){
      execFileSync('docker',['rm','-f',containerName],{stdio:'pipe'});createContainer();
      const recreated=await run();
      assert.match(recreated.terminal.result,/Canonical fixture result/);
      assert(recreated.events.some(e=>e.subtype==='native_session_reset'),'recreated container must reset missing native session');
      assert(!requests[requests.length-1].input.some(i=>i.type==='function_call_output'),'new container must not claim missing native history was resumed');
      assert.equal(recreated.terminal.usage.input_tokens,40);
    }
    hanging=true;const cancelled=new CodexProcess({...options,sessionId:'cancel-fixture'});adapters.push(cancelled);await cancelled.start();cancelled.sendMessage('Wait for cancellation.');
    const deadline=Date.now()+10000;const before=requests.length;while(requests.length===before&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    await cancelled.stop();assert(cancelled.managedGroupStopped,'cancelled native process group survived');
    console.log('PASS native Codex '+(containerMode?'container':connectorMode?'host custom connector':'host')+': local Responses, MCP ticket roundtrip, canonical summary, nonzero cache-write usage, explicit resume, recreation recovery, mid-turn revision, cancellation');
  }finally{
    await Promise.allSettled(adapters.map(a=>a.stop()));for(const socket of sockets)socket.destroy();server.close();bridge?.close();if(containerName){try{execFileSync('docker',['rm','-f',containerName],{stdio:'pipe'});}catch{}}delete process.env.GATEWAY_CODEX_SMOKE_KEY;if(originalCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=originalCodexHome;await rm(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
