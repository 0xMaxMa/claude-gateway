#!/usr/bin/env node
/** Isolated automation scenarios: real gateway task lifecycle + installed runner.
 * No browser/network calls by default. Optional trusted adapters enable live
 * parent/Jev inference against ONLY the synthetic pages below, never real sites.
 * node scripts/jev-automation-fixtures.cjs /absolute/path/browser-adapter.js
 * JEV_FIXTURE_INFERENCE=/absolute/path/adapter.mjs enables {evaluate,parent}.
 */
const assert=require('node:assert/strict');
const fs=require('node:fs');const {tmpdir}=require('node:os');const {join}=require('node:path');const {randomUUID}=require('node:crypto');const {pathToFileURL}=require('node:url');
const {OrchestrationStore}=require('../dist/orchestration/store');
const {DecisionService}=require('../dist/orchestration/decisions');
const {TaskService}=require('../dist/orchestration/tasks/service');
const {TaskQuestions}=require('../dist/orchestration/task-questions');
const {BrowserTaskAdapter}=require('../dist/orchestration/gateway-tasks/browser');
const {GatewayTaskController}=require('../dist/orchestration/gateway-tasks/controller');
const {validateJevResponse}=require('../dist/jev/validation');
const scenarios=[
 {name:'flights',goal:'Search Google for the cheapest one-way Chiang Mai to Osaka flights this week for 2 adults and 3 children. User follow-up: ages 10, 8, 6. Fixture date is 2026-09-22; week ends 2026-09-27. Do not book.',field:'Flight search query',value:'Chiang Mai Osaka one way 2 adults 3 children ages 10 8 6 2026-09-22 2026-09-27 cheapest',required:['Osaka','Chiang Mai','2','3','10','8','6'],result:'Fixture verified search: Chiang Mai to Osaka, one way, 2 adults, 3 children ages 10/8/6, 22–27 September 2026. Google Flights results by departure date: Sep 22 THB 31000; Sep 23 THB 28000; Sep 24 THB 25000; Sep 25 THB 29000; Sep 26 THB 30000; Sep 27 THB 32000. Each fare is total for all five passengers, taxes included, CNX to KIX, one-way, same passenger criteria. Lowest fare Sep 24 THB 25000. No booking.'},
 {name:'shopping',goal:'Open Shopee and search for an iPhone 18 Pro Max phone case. Do not buy or add to cart.',field:'Product search',value:'iPhone 18 Pro Max case',required:['18','Pro','Max'],result:'Fixture search results: iPhone 18 Pro Max compatible case THB 199. Excluded iPhone 18 Pro case (different size). No purchase or cart change.'},
 {name:'chatgpt',goal:'Open ChatGPT and ask it to find recent crypto news with dates and source links. Report its answer as attributed information, not independently verified news.',field:'Message ChatGPT',value:'Find recent crypto news with dates and source links.',required:['crypto','news'],result:'Fixture ChatGPT response: sample crypto news, dated 2026-09-22 with source https://news.example.test/crypto. Attributed to ChatGPT; not independently verified.'}
];
async function runScenario(runner,scenario,fault,inference){
 const root=fs.mkdtempSync(join(tmpdir(),'automation-fixture-'));const store=new OrchestrationStore(join(root,'db'),'fixture');const tasks=new TaskService(store);const decisions=new DecisionService(store);
 const scope={agentId:'fixture',agentSessionId:'fixture-session',source:'api',accountId:'owner',principalId:'owner',chatId:'fixture-chat',threadKey:''};
 const accepted=store.acceptInput({scope,text:scenario.goal,capabilities:{execute:true,writeMemory:false}});let decision=decisions.begin(accepted.conversationId,'owner',[accepted.inputId]);
 const context={...accepted,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'};
 const delivered=[];const questions=new TaskQuestions(store,tasks,decisions,(_id,_binding,text)=>delivered.push(text),()=>{},()=>60000);
 const page={protocol_version:1,generation:'g0',url:scenario.name==='flights'?'https://www.google.com/travel/flights':scenario.name==='shopping'?'https://shopee.co.th/search':'https://chatgpt.com/c/fixture',title:scenario.name,text:'Search form. No results yet.',viewport_text:'Search form. No results yet.',elements:[{ref:'query',label:scenario.field,tag:'input',value:'',operations:['TYPE_TEXT']},{ref:'submit',label:'Submit search',tag:'button',operations:['CLICK']}],scroll:{up:false,down:false},truncated:{text:false,elements:false}};
 let sequence=0,evals=0,mutations=0,submitted=false,usedFault=false,answers=0,replans=0;const operations=new Set();
 const clone=()=>structuredClone(page);
 const evaluate=async request=>{
  evals++;assert(evals<=30,'inference budget');
  if(inference?.evaluate)return inference.evaluate(request,new AbortController().signal);
  let op=submitted?'DONE':page.elements[0].value?'CLICK':'TYPE_TEXT';if(fault==='premature-done'&&!usedFault){op='DONE';usedFault=true;}
  const low=fault==='low-confidence'&&!usedFault;if(low)usedFault=true;
  const result={model:'fixture-jev',usage:{input_tokens:1,output_tokens:1},answers:Object.fromEntries(Object.entries(request.questions).map(([id,q])=>{
   const keys=Object.keys(q.criteria),choice=id==='operation'?op:keys[0];return [id,{type:'choice',choice,confidence:low?.2:.95,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?1:0]))}];
  }))};return validateJevResponse(result,request,'fixture-jev',request.requestId);
 };
 const call=async(name,args)=>{
  if(name==='browser_task_acquire')return {state:'completed',result:{protocol_version:1,lease_token:randomUUID()}};
  if(name.startsWith('browser_task_'))return {state:'completed',result:{}};
  if(name==='page_observe')return clone();
  assert(['page_type','page_click'].includes(name),'unexpected browser mutation '+name);
  assert(!operations.has(args.operation_id),'mutation replay');operations.add(args.operation_id);
  if(fault==='stale'&&!usedFault){usedFault=true;page.generation='g'+(++sequence);return {error:'STALE_OBSERVATION',action_executed:false};}
  mutations++;
  if(name==='page_type')page.elements[0].value=args.text;
  if(name==='page_click'){
   for(const value of scenario.required)assert(page.elements[0].value.toLowerCase().includes(value.toLowerCase()),'missing search requirement '+value);
   submitted=true;page.text=page.viewport_text=scenario.result;
  }
  page.generation='g'+(++sequence);
  if(fault==='unknown'&&!usedFault){usedFault=true;return {state:'unknown'};}
  return {state:'completed',result:{ok:true,observation:clone()}};
 };
 const binding={version:1,id:'fixture-tab',name:'Mock browser',principalId:'owner',conversationId:accepted.conversationId,
  inspect:async()=>({observedAt:Date.now(),observation:clone()}),
  run:c=>runner.runBrowserTask({operationConfidence:0.8,targetConfidence:0.8,goal:c.goal,scope:{device_id:'fixture-device',grant_id:'fixture-grant',tab_id:'fixture-tab'},fields:c.fields??[],maxSteps:10,maxEvaluations:15,timeoutMs:30000},{call,evaluate:r=>c.evaluate(r,c.signal)},c.signal)};
 const adapter=new BrowserTaskAdapter({agentId:'fixture',root:join(root,'receipts'),allowed:()=>true,bindings:()=>[binding],evaluate:(_task,r)=>evaluate(r),onNeedsInput:(t,q)=>{const a=store.attempt(t.activeAttemptId);if(store.task(t.taskId).state==='starting')tasks.started(a.attemptId,a.generation);tasks.requestInput(a.attemptId,a.generation,q);return true;}});
 const controller=new GatewayTaskController(tasks,new Map([['browser',adapter]]));let task;
 const parent=async(input)=>inference?.parent ? inference.parent({goal:scenario.goal,...input}) : input.kind==='field'?{answer:scenario.value}:input.kind==='replan'?{guidance:'Fill the search query first, submit once, then inspect matching results; preserve all original requirements.'}:{verified:submitted,evidence:scenario.result};
 try{
  task=tasks.spawn(context,{title:scenario.name,instructions:scenario.goal,targetProfile:'gateway-managed',gatewayTarget:{adapter:'browser',sessionId:'fixture-tab',name:'Mock browser'}});decisions.finish(decision,'Working');
  for(let turn=0;turn<12;turn++){
   for(let tick=0;tick<1000;tick++){await controller.tick();await new Promise(r=>setTimeout(r,5));task=store.task(task.taskId);if(['waiting_input','failed','needs_reconciliation','completed'].includes(task.state))break;}
   if(task.state==='completed')break;
   if(fault==='unknown'&&mutations>0){assert.equal(task.state,'needs_reconciliation');assert.equal(mutations,1);break;}
   assert(['waiting_input','failed','needs_reconciliation'].includes(task.state),'execution did not settle');
   questions.tick();const input=store.acceptInput({scope,text:'Review pending browser work',storeUserMessage:false,ingressKey:(task.state==='waiting_input'?'question-review:':'notification:')+randomUUID(),capabilities:{execute:false,writeMemory:false}});
   decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
   const ctx={...input,...decision,principalId:'owner',execute:false,writeMemory:false,actionId:'parent-'+turn,...(task.state==='waiting_input'?{questionReviewIds:questions.context(input.conversationId,'owner').map(q=>q.questionId)}:{})};
   if(task.state==='waiting_input'){
    // Runtime question reviews deliberately do not consume unrelated notifications.
    store.run("UPDATE notifications SET status='pending',decision_id=NULL WHERE decision_id=? AND status='assigned'",decision.decisionId);
    const reply=await parent({kind:'field',question:task.pendingQuestion.text,page:clone()});assert.equal(typeof reply.answer,'string');
    tasks.answer(ctx,task.taskId,task.pendingQuestion.questionId,reply.answer);answers++;
   }else if(task.state==='failed'){
    assert(['LOW_OPERATION_CONFIDENCE','LOW_TARGET_CONFIDENCE'].includes(task.browserReport.reason),task.failure?.code);
    const proof=await adapter.evidence(task,true);const verification=await parent({kind:'verify',page:proof.fresh.observation});
    if(verification.verified)tasks.verifyBrowser(ctx,task.taskId,task.revision,proof.requestId,proof.evidenceId,verification.evidence,()=>adapter.verifyEvidence(task,proof.requestId,proof.evidenceId));
    else {const reply=await parent({kind:'replan',page:proof.fresh.observation,verification:verification.evidence});assert.equal(typeof reply.guidance,'string');tasks.update(ctx,task.taskId,task.revision,reply.guidance,'when_ready');replans++;}
   }else{
    const proof=await adapter.evidence(task,true);const reply=await parent({kind:'verify',page:proof.fresh.observation});assert.equal(typeof reply.verified,'boolean');assert.equal(typeof reply.evidence,'string');
    if(reply.verified)tasks.verifyBrowser(ctx,task.taskId,task.revision,proof.requestId,proof.evidenceId,reply.evidence,()=>adapter.verifyEvidence(task,proof.requestId,proof.evidenceId));
    else {const plan=await parent({kind:'replan',page:proof.fresh.observation,verification:reply.evidence});tasks.update(ctx,task.taskId,task.revision,plan.guidance,'when_ready');replans++;}
   }
   decisions.finish(decision,'');
  }
  task=store.task(task.taskId);assert.equal(task.state,fault==='unknown'?'needs_reconciliation':'completed');assert.equal(delivered.length,0,'asked user for known facts');assert.equal(store.all('SELECT id FROM tasks').length,1,'spawned duplicate task');
  return {scenario:scenario.name,fault,parent:inference?.parent?'live':'scripted',jev:inference?.evaluate?'live':'scripted',status:task.state,answers,replans,evaluations:evals,mutations,userQuestions:delivered.length};
 }finally{await controller.close();await adapter.close();store.close();fs.rmSync(root,{recursive:true,force:true});}
}
(async()=>{
 assert(process.argv[2],'Pass installed runner entrypoint');const runner=await import(pathToFileURL(process.argv[2]).href);
 const inference=process.env.JEV_FIXTURE_INFERENCE?await import(pathToFileURL(process.env.JEV_FIXTURE_INFERENCE).href):undefined;
 for(const scenario of scenarios)for(const fault of inference?['none']:['none','low-confidence','stale','premature-done','unknown'])console.log(JSON.stringify(await runScenario(runner,scenario,fault,inference)));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
