/* Optional real Chromium/extension/MCP fixture. No private page data is logged. */
const assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,rmSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {OrchestrationStore}=require('../dist/orchestration/store');
const {DecisionService}=require('../dist/orchestration/decisions');
const {TaskService}=require('../dist/orchestration/tasks/service');
const {GatewayTaskController}=require('../dist/orchestration/gateway-tasks/controller');
const {BrowserTaskAdapter}=require('../dist/orchestration/gateway-tasks/browser');
const {executeBrowserModule,inspectBrowser}=require('../dist/jev/browser-connector');
const {liveExecutionInput}=require('../dist/orchestration/live-execution-input');
exports.run=async({page,scope,endpoint,token})=>{
 const root=mkdtempSync(join(tmpdir(),'live-browser-control-'));
 const store=new OrchestrationStore(join(root,'db'),'fixture'),tasks=new TaskService(store),decisions=new DecisionService(store);
 const principal='fixture-user',sessionId=randomUUID(),ingress={agentId:'fixture',agentSessionId:sessionId,source:'api',accountId:principal,chatId:sessionId,threadKey:'',principalId:principal};
 const capabilities={execute:true,writeMemory:false};
 const accepted=store.acceptInput({scope:ingress,text:'Fill fixture',capabilities}),decision=decisions.begin(accepted.conversationId,principal,[accepted.inputId]);
 const command={...accepted,...decision,principalId:principal,...capabilities,actionId:'spawn'};
 let evaluating=false,first=true,evaluations=0;
 const credentials=JSON.parse(readFileSync(process.env.LIVE_JEV_CREDENTIAL_FILE,'utf8'));
 const credentialFile=join(root,'controller.key');writeFileSync(credentialFile,token,{mode:0o600});
 const modulePath=join(root,'loop.mjs');
 writeFileSync(modulePath,`export * from ${JSON.stringify(pathToFileURL(require.resolve('@0xmaxma/jev-loop/browser-use')).href)}; export async function resolveFieldText(){return {text:'Manchester'};}`);
 const config={id:'fixture',name:'Fixture',agentId:'fixture',principalId:principal,conversationId:accepted.conversationId,endpoint,apiKeyFile:credentialFile,scope,budget:{maxSteps:4,maxEvaluations:6,timeoutMs:60000}};
 const binding={version:1,id:'fixture',name:'Fixture',principalId:principal,conversationId:accepted.conversationId,run:context=>executeBrowserModule(modulePath,config,context),inspect:(result,signal,authorized)=>inspectBrowser(config,result,signal,authorized)};
 const adapter=new BrowserTaskAdapter({agentId:'fixture',root:join(root,'receipts'),allowed:()=>true,bindings:()=>[binding],evaluate:async(_task,request,signal)=>{
  if(first){first=false;evaluating=true;return new Promise(()=>{});}
  evaluations++;
  const response=await fetch(process.env.LIVE_JEV_URL,{method:'POST',headers:{Authorization:'Bearer '+credentials.key,'Content-Type':'application/json'},body:JSON.stringify({...request,agentId:credentials.agentId}),signal});
  if(!response.ok)throw Error('LIVE_JEV_HTTP_'+response.status);
  return response.json();
 }});
 const controller=new GatewayTaskController(tasks,new Map([['browser',adapter]]));
 const pump=async(predicate,ms=65000)=>{const start=Date.now();while(!predicate()){assert(Date.now()-start<ms,'Fixture timeout');await controller.tick();await new Promise(r=>setTimeout(r,20));}};
 try{
  await page.locator('input[aria-label="Name"]').fill('');
  const task=tasks.spawn(command,{title:'Live correction fixture',instructions:'Set the Name field to London. Do not click Increment or submit anything.',targetProfile:'gateway-managed',gatewayTarget:adapter.resolve({adapter:'browser',session_id:'fixture'},command)});
  await pump(()=>evaluating);
  const started=Date.now();
  const paused=tasks.controlByUser(accepted.conversationId,principal,task.taskId,{id:randomUUID(),action:'pause',expectedRevision:1});controller.signalControl(paused);
  await pump(()=>store.task(task.taskId).executionControl?.phase==='paused',3000);
  const interruptMs=Date.now()-started;
  assert.equal(await page.locator('input[aria-label="Name"]').inputValue(),'');
  const input={scope:ingress,text:'Set the Name field to Manchester instead of London. Do not submit.',modality:'live_voice',ingressKey:randomUUID(),metadata:{executionTaskId:task.taskId}};
  const revised=liveExecutionInput(store,tasks,decisions,input,capabilities);assert(revised.task);controller.signalControl(revised.task);
  const retry=liveExecutionInput(store,tasks,decisions,input,capabilities);assert.equal(retry.responseId,revised.responseId);
  await pump(()=>['completed','failed','needs_reconciliation'].includes(store.task(task.taskId).state));
  const final=store.task(task.taskId);
  assert.equal(await page.locator('input[aria-label="Name"]').inputValue(),'Manchester',JSON.stringify(final.browserReport));
  assert.equal(final.revision,3);assert.equal(final.browserReport.reason,'COMPLETION_CANDIDATE');
  const proof=await adapter.evidence(final,true);
  assert.equal(proof.fresh.observation.elements.find(e=>e.label==='Name').value,'Manchester');
  const verified=tasks.verifyBrowser({...command,actionId:'verify'},task.taskId,final.revision,proof.requestId,proof.evidenceId,'Fresh Name field equals Manchester',()=>adapter.verifyEvidence(final,proof.requestId,proof.evidenceId));
  assert.equal(verified.state,'completed');
  const report={parentVerified:true,chromium:true,extension:true,mcp:true,liveJev:true,interruptMs,taskId:task.taskId,revision:final.revision,appliedOnce:true,field:'Manchester',evaluations,state:verified.state,reason:verified.browserReport.reason};
  writeFileSync(process.env.LIVE_CONTROL_REPORT||'/tmp/jev-live-control-browser-report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
 }finally{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}
};
