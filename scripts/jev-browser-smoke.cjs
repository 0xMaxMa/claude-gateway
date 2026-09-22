#!/usr/bin/env node
/** Optional integration harness. The caller supplies an approved real browser fixture,
 * installed runner public entrypoint, and evaluation callback. No vendor or browser is
 * bundled, no keys are logged, and no paid call occurs without an injected evaluator.
 * Require this module from the browser project's isolated extension/MCP fixture.
 */
const {mkdtempSync,mkdirSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {execFile}=require('node:child_process');
const {TaskBridge}=require('../dist/orchestration/bridge');
const {TaskFiles}=require('../dist/orchestration/task-files');
const assert=require('node:assert/strict');
const {OrchestrationStore}=require('../dist/orchestration/store');
const {DecisionService}=require('../dist/orchestration/decisions');
const {TaskService}=require('../dist/orchestration/tasks/service');
const {GatewayTaskController}=require('../dist/orchestration/gateway-tasks/controller');
const {BrowserTaskAdapter}=require('../dist/orchestration/gateway-tasks/browser');
const {executeBrowserModule,inspectBrowser}=require('../dist/jev/browser-connector');
async function runGatewayBrowserFixture(options){
 const root=mkdtempSync(join(tmpdir(),'gateway-browser-e2e-'));
 const store=new OrchestrationStore(join(root,'tasks.db'),'fixture-agent'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'fixture-agent',agentSessionId:'fixture-session',source:'api',accountId:'fixture-user',chatId:'fixture-chat',threadKey:'',principalId:'fixture-user'},text:options.goal});
 const decision=new DecisionService(store).begin(accepted.conversationId,'fixture-user',[accepted.inputId]);
 const context={...accepted,...decision,principalId:'fixture-user',execute:true,writeMemory:false,actionId:'spawn-browser'};
 const connector={id:'fixture-browser',name:'Fixture',agentId:'fixture-agent',principalId:'fixture-user',conversationId:accepted.conversationId,endpoint:options.endpoint,apiKeyFile:options.credentialFile,scope:options.scope,fields:options.fields,budget:{timeoutMs:60000,maxSteps:10,maxEvaluations:12}};
 const binding={version:1,id:'fixture-browser',name:'Isolated fixture',principalId:'fixture-user',conversationId:accepted.conversationId,
  run:c=>executeBrowserModule(options.runnerModule,connector,c),inspect:(result,signal,authorized)=>inspectBrowser(connector,result,signal,authorized)};
 const adapter=new BrowserTaskAdapter({agentId:'fixture-agent',root:join(root,'receipts'),allowed:()=>true,bindings:()=>[binding],evaluate:(_task,request,signal)=>options.evaluate(request,signal)});
 const adapters=new Map([['browser',adapter]]),controller=new GatewayTaskController(tasks,adapters);
 let bridge,callAgent;
 try{
 if(options.containerImage){
  const workspace=join(root,'workspace');mkdirSync(workspace);
  bridge=new TaskBridge(tasks,new TaskFiles(store,root),undefined,undefined,{agent:{id:'fixture-agent',workspace},spool:join(root,'spool')},undefined,adapters);
  bridge.browserEnabled=()=>true;await bridge.start();
  const issue=(name,principalId)=>{const directory=join(workspace,name);bridge.issue({role:'agent',context:{...context,principalId}},directory,workspace);return join(directory,'ticket.json');};
  const owner=issue('owner','fixture-user'),foreign=issue('foreign','foreign-user');let sequence=0;
  callAgent=(tool,args,ticket=owner)=>new Promise((resolve,reject)=>{
   const code=`const fs=require('node:fs'),http=require('node:http');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const x=JSON.parse(input),t=JSON.parse(fs.readFileSync(x.ticket));const r=http.request({socketPath:t.socket,path:'/call',method:'POST',headers:{Authorization:'Bearer '+t.token}},res=>res.pipe(process.stdout));r.on('error',()=>process.exit(1));r.end(JSON.stringify(x.command));});`;
   const child=execFile('docker',['run','--rm','-i','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',String(process.getuid()),'-v',workspace+':'+workspace+':ro','--entrypoint','node',options.containerImage,'-e',code],{timeout:45000,maxBuffer:1048576},(error,stdout)=>{if(error)return reject(Error('Container bridge fixture failed'));try{resolve(JSON.parse(stdout));}catch(e){reject(e);}});
   child.stdin.end(JSON.stringify({ticket,command:{tool,args,action_id:'container-'+ ++sequence}}));
  });
  assert((await callAgent('capabilities_list',{scope:'browser'})).targets.length===1);
  assert((await callAgent('capabilities_list',{scope:'browser'},foreign)).error);
  assert((await callAgent('capabilities_list',{scope:'safemode'})).error);
 }
  const task=callAgent ? await callAgent('task_spawn',{title:'Browser integration fixture',instructions:options.goal,target_profile:'gateway-managed',gateway_target:{adapter:'browser',session_id:binding.id,...(options.startUrl?{start_url:options.startUrl}:{})}}) : tasks.spawn(context,{title:'Browser integration fixture',instructions:options.goal,targetProfile:'gateway-managed',gatewayTarget:adapter.resolve({adapter:'browser',session_id:binding.id,...(options.startUrl?{start_url:options.startUrl}:{})},context)});
  assert(task.taskId,'Container must create a real gateway-managed task');
  const until=Date.now()+75000;
  while(Date.now()<until){
   await controller.tick();let current=store.task(task.taskId);
   if(current.state==='needs_reconciliation' && options.parentVerify){
    assert.equal(current.browserReport?.status,'needs_verification',JSON.stringify({failure:current.failure,browserReport:current.browserReport}));
    assert.notEqual(current.browserReport?.lastAction?.outcome,'unknown',JSON.stringify(current.browserReport));
    const proof=callAgent ? (await callAgent('task_status',{task_id:current.taskId,browser_evidence:'fresh'})).browserEvidence : await adapter.evidence(current,true);
    const evidence=await options.parentVerify(proof);
    if(typeof evidence==='string' && evidence.trim())current=callAgent ? await callAgent('task_update',{task_id:current.taskId,expected_revision:current.revision,mode:'verify_browser',expected_request_id:proof.requestId,evidence_id:proof.evidenceId,instruction:evidence}) : tasks.verifyBrowser({...context,actionId:'verify-browser'},current.taskId,current.revision,proof.requestId,proof.evidenceId,evidence,()=>adapter.verifyEvidence(current,proof.requestId,proof.evidenceId));
   }
   if(['completed','failed','needs_reconciliation','waiting_input','cancelled'].includes(current.state))return {containerBridge:Boolean(callAgent),state:current.state,result:current.result,failure:current.failure,browserReport:current.browserReport};
   await new Promise(r=>setTimeout(r,20));
  }
  throw Error('Gateway browser task did not settle');
 }finally{if(bridge)await bridge.close();await controller.close();store.close();rmSync(root,{recursive:true,force:true});}
}
module.exports={runGatewayBrowserFixture};
if(require.main===module){console.error('Import runGatewayBrowserFixture from an isolated real-browser fixture; see the Jev integration guide.');process.exitCode=1;}
