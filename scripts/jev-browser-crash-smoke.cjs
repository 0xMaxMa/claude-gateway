#!/usr/bin/env node
/** Opt-in SIGKILL fixture. The caller owns an isolated real browser and supplies
 * a deterministic evaluator. No provider, browser package or credentials bundled.
 * This kills the production adapter/transport child, not a user's gateway daemon.
 */
const {fork}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
const {BrowserTaskAdapter}=require('../dist/orchestration/gateway-tasks/browser');
const {executeBrowserModule,inspectBrowser}=require('../dist/jev/browser-connector');
function adapter(options,root,evaluate){
 const connector={id:'fixture',name:'Crash fixture',agentId:'fixture-agent',principalId:'fixture-user',conversationId:'fixture-chat',endpoint:options.endpoint,apiKeyFile:options.credentialFile,scope:options.scope,budget:{timeoutMs:90000,maxSteps:2,maxEvaluations:3}};
 const binding={version:1,id:'fixture',name:'Crash fixture',principalId:'fixture-user',conversationId:'fixture-chat',run:c=>executeBrowserModule(options.adapterModule,connector,c),inspect:(result,signal,authorized)=>inspectBrowser(connector,result,signal,authorized)};
 return new BrowserTaskAdapter({agentId:'fixture-agent',root,allowed:()=>true,bindings:()=>[binding],evaluate:(_task,request,signal)=>evaluate(request,signal)});
}
const task={agentId:'fixture-agent',taskId:'crash-fixture',ownerPrincipalId:'fixture-user',conversationId:'fixture-chat',gatewayTarget:{adapter:'browser',sessionId:'fixture'},gatewayDispatch:{requestId:'crash-request',submittedAt:0}};
async function runGatewayBrowserCrashFixture(options){
 const root=mkdtempSync(join(tmpdir(),'gateway-browser-crash-'));
 const child=fork(__filename,['--child'],{stdio:['ignore','ignore','pipe','ipc']});
 let a;
 try{
  const effect=new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(Error('Mutation did not finish in crash fixture')),45000);
   child.once('exit',()=>{clearTimeout(timeout);reject(Error('Child exited before crash boundary'));});
   child.on('message',async message=>{
    if(message.type==='evaluate'){
     try {child.send({type:'evaluation',value:await options.evaluate(message.request,new AbortController().signal)});}catch{clearTimeout(timeout);reject(Error('Fixture evaluation failed'));}
    }else if(message.type==='mutated'){clearTimeout(timeout);resolve(message.operationId);}
    else if(message.type==='error'){clearTimeout(timeout);reject(Error(message.message));}
   });
  });
  child.send({type:'start',options:{endpoint:options.endpoint,credentialFile:options.credentialFile,scope:options.scope,adapterModule:options.adapterModule,goal:options.goal},root});
  const operationId=await effect;
  await options.assertEffect();
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  a=adapter(options,root,()=>{throw Error('Recovery must not evaluate');});
  assert.equal((await a.inspect(task,'crash-request')).type,'unknown');
  const recorded=await a.evidence(task);
  assert.equal(recorded.executionState,'interrupted');
  assert.equal(recorded.lastDispatchedMutation.operationId,operationId);
  await assert.rejects(a.submit(task,'crash-request',options.goal),/BROWSER_REQUEST_ALREADY_SUBMITTED/);
  // A killed process cannot release its tab lease. Wait for the real relay's lease expiry.
  await new Promise(resolve=>setTimeout(resolve,61000));
  const fresh=await a.evidence(task,true);
  assert.equal(fresh.fresh.operationStatus?.id,operationId,'Recovery must inspect the exact recorded operation');
  assert.equal(fresh.fresh.operationStatus.state,'completed');
  assert.throws(()=>a.verifyEvidence(task,'crash-request',fresh.evidenceId),/BROWSER_VERIFICATION_UNAVAILABLE/);
  await options.assertEffect();
  return {executionState:fresh.executionState,operationId,operationStatus:fresh.fresh.operationStatus,noReplay:true};
 }finally{child.kill('SIGKILL');if(a)await a.close();rmSync(root,{recursive:true,force:true});}
}
module.exports={runGatewayBrowserCrashFixture};
if(process.argv.includes('--child')){
 process.once('message',async message=>{
  try{
   const original=global.fetch;
   global.fetch=async(input,init)=>{
    const response=await original(input,init);
    let body;try{body=JSON.parse(init?.body);}catch{}
    if(body?.method==='tools/call' && ['page_click','page_type','page_select','page_scroll'].includes(body.params?.name)){
     // Browser effect + response exist, but neither acknowledgement nor terminal receipt reaches the adapter.
     await response.clone().text();
     process.send({type:'mutated',operationId:body.params.arguments.operation_id});
     return new Promise(()=>{});
    }
    return response;
   };
   const evaluate=request=>new Promise(resolve=>{
    const receive=m=>{if(m.type==='evaluation'){process.off('message',receive);resolve(m.value);}};
    process.on('message',receive);process.send({type:'evaluate',request});
   });
   await adapter(message.options,message.root,evaluate).submit(task,'crash-request',message.options.goal);
  }catch(e){process.send({type:'error',message:e.message});}
 });
}
