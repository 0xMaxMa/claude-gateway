#!/usr/bin/env node
// Measure native CLI context metadata with a local Responses fixture, without model billing.
// This does NOT certify that an upstream provider accepts requests of that size.
require('ts-node/register/transpile-only');
const {CodexProcess}=require('../../src/session/codex-process');
const {resolveCodexRuntime}=require('../../src/session/codex-runtime');
const {resolveWorkerHarness}=require('../../src/orchestration/worker-harness');
const fs=require('fs/promises'),path=require('path'),os=require('os'),http=require('http');
const {execFileSync}=require('child_process'),{once}=require('events');
const args=process.argv.slice(2);
function option(name){const i=args.indexOf(name);return i<0?undefined:args[i+1];}
(async()=>{
 const runtime=resolveCodexRuntime();
 const catalog=option('--catalog-json')?JSON.parse(await fs.readFile(option('--catalog-json'),'utf8')).models:JSON.parse(execFileSync(runtime.executable,['debug','models','--bundled'],{encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024})).models;
 const supplied=option('--models-json')?JSON.parse(await fs.readFile(option('--models-json'),'utf8')):[];
 const selected=new Map([...catalog.filter(m=>m.slug.includes('gpt')).map(m=>[m.slug,{id:m.slug}]),...supplied.map(m=>[m.id,m])]);
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gateway-context-audit-'));
 const previous=process.env.GATEWAY_CONTEXT_AUDIT_KEY;
 process.env.GATEWAY_CONTEXT_AUDIT_KEY='local-fixture-only';
 const sockets=new Set(),adapters=new Set(),rows=[];
 const server=http.createServer(async(req,res)=>{
  try{
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4*1024*1024)throw Error('Fixture request too large');}
   const body=JSON.parse(raw),id='resp_fixture',item={type:'message',id:'msg_fixture',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'Context audit fixture complete.',annotations:[]}]};
   const response={id,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:body.model,output:[item],usage:{input_tokens:100,input_tokens_details:{cached_tokens:0},output_tokens:5,total_tokens:105}};
   res.writeHead(200,{'content-type':'text/event-stream'});
   const emit=(type,payload)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...payload})+'\n\n');
   emit('response.created',{response:{...response,status:'in_progress',output:[]}});
   emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});
   emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
   emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});
   emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:item.content[0].text});
   emit('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});
   emit('response.output_item.done',{output_index:0,item});
   emit('response.completed',{response});res.end();
  }catch(error){res.destroy(error);}
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  await fs.writeFile(path.join(directory,'mcp.json'),'{"mcpServers":{}}');
  let index=0;
  async function runNext(){
   while(index<selected.size){
    const record=[...selected.values()][index++],model=record.workerModel||record.id.replace(/\[(?:1m|200k)\]$/i,'');
    const row={selection:record.id,nativeModel:model,advertisedGatewayWindow:record.contextWindow??null,requested:1000000};
    const known=catalog.find(m=>m.slug===model);
    row.catalog=known?{default:known.context_window,max:known.max_context_window,usablePercent:known.effective_context_window_percent}:null;
    row.autoHarness=resolveWorkerHarness({workers:{harness:'auto'}},{gateway:{models:record.workerHarness?[record]:[]}},record.id).harness;
    const adapter=new CodexProcess({agent:{workspace:directory},gateway:{gateway:{}},profile:{role:'worker',hostExecution:true,connectorsAllowed:false,mcpConfigPath:path.join(directory,'mcp.json'),overlay:'Local metadata audit. Return one short message.'},sessionId:'audit-'+index,stateDirectory:directory,
      config:{model,contextWindow:1000000,bin:runtime.executable,baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',apiKeyEnv:'GATEWAY_CONTEXT_AUDIT_KEY'}});
    adapters.add(adapter);
    const originalEvent=adapter.event.bind(adapter);
    adapter.event=function(event){if(event.method==='thread/tokenUsage/updated')row.observedUsable=event.params?.tokenUsage?.modelContextWindow??null;return originalEvent(event);};
    const originalRequest=adapter.request.bind(adapter);
    adapter.request=async function(method,params){const result=await originalRequest(method,params);if(method==='config/read')row.effectiveConfiguredWindow=result.config?.model_context_window;return result;};
    let timer;
    try{
     const complete=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Native audit timed out')),30000);adapter.on('startup-error',reject);adapter.on('output',line=>{const e=JSON.parse(line);if(e.contextWindow)row.context=e.contextWindow;if(e.type==='result')e.is_error?reject(Error(e.result)):resolve();});});
     await adapter.start();
     if(option('--catalog-json')){
       const filename=path.join(adapter.home,'config.toml');
       const config=await fs.readFile(filename,'utf8');
       await fs.writeFile(filename,'model_catalog_json = '+JSON.stringify(path.resolve(option('--catalog-json')))+'\n'+config,{mode:0o600});
     }
     adapter.sendMessage('Return a short audit completion.');await complete;
     row.status=typeof row.observedUsable==='number'?'measured':'missing-native-measurement';
    }catch(error){row.status='error';row.error=error.message;}
    finally{clearTimeout(timer);await adapter.stop();adapters.delete(adapter);}
    rows.push(row);console.log(JSON.stringify(row));
   }
  }
  await Promise.all([runNext(),runNext()]);
  const report={measuredAt:new Date().toISOString(),version:execFileSync(runtime.executable,['--version'],{encoding:'utf8'}).trim(),catalogSource:option('--catalog-json')?'explicit snapshot':'bundled',method:'Real CodexProcess/app-server; explicit 1M request; local fake Responses API; observe native modelContextWindow. No upstream capacity/inference certification.',rows:rows.sort((a,b)=>a.selection.localeCompare(b.selection))};
  if(option('--output'))await fs.writeFile(option('--output'),JSON.stringify(report,null,2)+'\n');
  if(rows.some(row=>row.status!=='measured'))process.exitCode=1;
 }finally{
  await Promise.allSettled([...adapters].map(a=>a.stop()));
  for(const socket of sockets)socket.destroy();server.close();
  if(previous===undefined)delete process.env.GATEWAY_CONTEXT_AUDIT_KEY;else process.env.GATEWAY_CONTEXT_AUDIT_KEY=previous;
  await fs.rm(directory,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
