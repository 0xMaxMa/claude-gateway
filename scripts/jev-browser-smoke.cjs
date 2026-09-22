#!/usr/bin/env node
/** Optional integration harness. The caller supplies an approved real browser fixture,
 * installed runner public entrypoint, and evaluation callback. No vendor or browser is
 * bundled, no keys are logged, and no paid call occurs without an injected evaluator.
 * Require this module from the browser project's isolated extension/MCP fixture.
 */
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
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
 const controller=new GatewayTaskController(tasks,new Map([['browser',adapter]]));
 try{
  const task=tasks.spawn(context,{title:'Browser integration fixture',instructions:options.goal,targetProfile:'gateway-managed',gatewayTarget:adapter.resolve({adapter:'browser',session_id:binding.id},context)});
  const until=Date.now()+75000;
  while(Date.now()<until){
   await controller.tick();let current=store.task(task.taskId);
   if(current.state==='needs_reconciliation' && options.parentVerify){
    const proof=await adapter.evidence(current,true);
    const evidence=await options.parentVerify(proof);
    if(typeof evidence==='string' && evidence.trim())current=tasks.verifyBrowser({...context,actionId:'verify-browser'},current.taskId,current.revision,proof.requestId,proof.evidenceId,evidence,()=>adapter.verifyEvidence(current,proof.requestId,proof.evidenceId));
   }
   if(['completed','failed','needs_reconciliation','waiting_input','cancelled'].includes(current.state))return {state:current.state,result:current.result,failure:current.failure,browserReport:current.browserReport};
   await new Promise(r=>setTimeout(r,20));
  }
  throw Error('Gateway browser task did not settle');
 }finally{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}
}
module.exports={runGatewayBrowserFixture};
if(require.main===module){console.error('Import runGatewayBrowserFixture from an isolated real-browser fixture; see the Jev integration guide.');process.exitCode=1;}
