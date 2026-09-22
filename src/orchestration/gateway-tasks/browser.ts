import { parentVerifiableBrowserResult } from '../../jev/browser-contract';
import type { BrowserExecutionContext, BrowserExecutionResult, BrowserProgress, BrowserEvidence, BrowserMutationCheckpoint } from '../../jev/browser-contract';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from 'fs';
import { join } from 'path';
import { JevError, JevRequest, JevResult } from '../../jev/types';
import { CommandContext, GatewayTaskTarget, OrchestrationError, TaskSnapshot, TaskRevision, WorkerOutcome } from '../types';
import { GatewayTaskAdapter } from './controller';

/** Registered by trusted host integration, never by a model-supplied URL or command.
 * Transport v1 must enforce ownership, grants and atomic revision fences itself.
 * Targets are private to one principal AND conversation, including shared agents. */
export interface BrowserTaskBinding {
  version: 1;
  id: string;
  name: string;
  principalId: string;
  conversationId: string;
  inspect?: (result:Partial<BrowserExecutionResult>|undefined,signal:AbortSignal,authorized:()=>boolean)=>Promise<NonNullable<BrowserEvidence['fresh']>>;
  run: (context: BrowserExecutionContext) => Promise<BrowserExecutionResult>;
}
interface Receipt {taskId:string;requestId:string;principalId:string;conversationId:string;status:'running'|'ended';lastDispatchedMutation?:BrowserMutationCheckpoint;recordedAt?:number;inspection?:{id:string;at:number};outcome?:WorkerOutcome;browserResult?:BrowserExecutionResult}
export class BrowserTaskAdapter implements GatewayTaskAdapter {
  readonly name='browser';
  private readonly running=new Map<string,{controller:AbortController;done:Promise<void>}>();
  constructor(private readonly options:{agentId:string;root:string;allowed:()=>boolean;bindings:()=>BrowserTaskBinding[];
    refreshBindings?:(context:CommandContext)=>Promise<void>;
    evaluate:(task:TaskSnapshot,request:JevRequest,signal:AbortSignal,authorized:()=>boolean)=>Promise<JevResult>;
    onProgress?:(task:TaskSnapshot,progress:BrowserProgress)=>void;
    allowedTask?:(task:TaskSnapshot)=>boolean;
    allowedEvidence?:(task:TaskSnapshot)=>boolean;
    onNeedsInput?:(task:TaskSnapshot,question:string)=>boolean}){}
  private binding(id:string,principalId:string,conversationId:string,requireEnabled=true):BrowserTaskBinding {
    if(requireEnabled&&!this.options.allowed())throw new OrchestrationError('BROWSER_NOT_ALLOWED');
    const binding=this.options.bindings().find(b=>b.version===1&&b.id===id&&b.principalId===principalId&&b.conversationId===conversationId);
    if(!binding)throw new OrchestrationError('BROWSER_TARGET_NOT_AVAILABLE');
    return binding;
  }
  async discover(query='',offset=0,context?:CommandContext):Promise<unknown> {
    if(!this.options.allowed()||!context)throw new OrchestrationError('BROWSER_NOT_ALLOWED');
    if(!Number.isSafeInteger(offset)||offset<0||typeof query!=='string')throw new OrchestrationError('INVALID_INPUT');
    await this.options.refreshBindings?.(context);
    if(!this.options.allowed())throw new OrchestrationError('BROWSER_NOT_ALLOWED');
    const bindings=this.options.bindings().filter(b=>b.version===1&&b.principalId===context.principalId&&b.conversationId===context.conversationId&&`${b.id} ${b.name}`.toLowerCase().includes(query.toLowerCase()));
    return {scope:'browser',instruction:'Use task_spawn with target_profile=gateway-managed and gateway_target={adapter:browser,session_id:<target ID>}. For opening a website, include start_url with the user-requested HTTP(S) URL. Browser targets are supported; do not use safemode or a direct MCP worker.',hint:bindings.length ? undefined : 'No approved browser tab is ready. Approve the access request in the browser extension, then discover again. Do not fall back to direct browser tools.',targets:bindings.slice(offset,offset+25).map(b=>({adapter:'browser',session_id:b.id,name:b.name,version:1})),next_offset:offset+25<bindings.length?offset+25:null};
  }
  resolve(input:Record<string,unknown>,context?:CommandContext):GatewayTaskTarget {
    if(!context||Object.keys(input).some(k=>!['adapter','session_id','start_url'].includes(k))||typeof input.session_id!=='string')throw new OrchestrationError('INVALID_GATEWAY_TARGET');
    const binding=this.binding(input.session_id,context.principalId,context.conversationId);
    let startUrl:string|undefined;
    if(input.start_url!==undefined){try{if(typeof input.start_url!=='string'||input.start_url.length>8192)throw Error();const u=new URL(input.start_url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error();startUrl=u.href;}catch{throw new OrchestrationError('INVALID_BROWSER_START_URL');}}
    return {adapter:'browser',sessionId:binding.id,name:binding.name,...(startUrl?{startUrl}:{})};
  }
  private assertTask(task:TaskSnapshot):void {
    if(task.agentId!==this.options.agentId||task.gatewayTarget?.adapter!=='browser')throw new OrchestrationError('BROWSER_TARGET_NOT_AVAILABLE');
  }
  private key(task:TaskSnapshot,requestId:string):string {return JSON.stringify([task.taskId,requestId,task.ownerPrincipalId,task.conversationId]);}
  private file(task:TaskSnapshot,requestId:string):string {
    this.assertTask(task);
    const hash=createHash('sha256').update(JSON.stringify([this.options.agentId,task.taskId,requestId])).digest('hex');
    return join(this.options.root,hash+'.json');
  }
  private read(task:TaskSnapshot,requestId:string):Receipt|undefined {
    try{const receipt=JSON.parse(readFileSync(this.file(task,requestId),'utf8')) as Receipt;if(receipt.principalId!==task.ownerPrincipalId||receipt.conversationId!==task.conversationId)throw new OrchestrationError('BROWSER_RECEIPT_MISMATCH');return receipt;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  }
  private write(task:TaskSnapshot,requestId:string,receipt:Receipt):void {
    mkdirSync(this.options.root,{recursive:true,mode:0o700});
    const file=this.file(task,requestId),temp=file+'.'+randomUUID();
    try {
      const fd=openSync(temp,'wx',0o600);
      try { writeFileSync(fd,JSON.stringify(receipt));fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp,file);const directory=openSync(this.options.root,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
    }
    finally { try{unlinkSync(temp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;} }
  }
  validateInput(instructions:string,answers:TaskRevision['answers']=[]):void {
    if(typeof instructions!=='string'||!instructions.trim()||instructions.length>8000)throw new OrchestrationError('INVALID_BROWSER_GOAL');
    if((answers??[]).some(a=>a.browserFieldLabel&&a.text.length>2000))throw new OrchestrationError('BROWSER_FIELD_VALUE_TOO_LONG');
  }
  async submit(task:TaskSnapshot,requestId:string,instructions:string,answers:TaskRevision['answers']=[]):Promise<void> {
    this.assertTask(task);
    this.validateInput(instructions,answers);
    const binding=this.binding(task.gatewayTarget!.sessionId,task.ownerPrincipalId,task.conversationId);
    if(this.read(task,requestId))throw new OrchestrationError('BROWSER_REQUEST_ALREADY_SUBMITTED');
    const values=new Map<string,string>();
    for(const answer of answers??[])if(answer.browserFieldLabel){if(answer.text.length>2000)throw new OrchestrationError('BROWSER_FIELD_VALUE_TOO_LONG');values.set(answer.browserFieldLabel,answer.text);}
    const fields=[...values].map(([label,text])=>({label,text}));
    // Durable receipt precedes any side effect; restart never replays this request.
    this.write(task,requestId,{recordedAt:Date.now(),taskId:task.taskId,requestId,principalId:task.ownerPrincipalId,conversationId:task.conversationId,status:'running'});
    const controller=new AbortController();
    const authorized=()=>{try{return this.options.allowedTask?.(task)!==false && this.binding(binding.id,task.ownerPrincipalId,task.conversationId)===binding;}catch{return false;}};
    // The installed browser package owns execution; gateway owns the request lifetime.
    let providerFailure:BrowserExecutionResult['providerFailure'];
    const execution = boundedExecution(controller,authorized,()=> Promise.resolve().then(() => binding.run({goal:instructions,startUrl:answers?.length || task.appliedRevision>0 ?undefined:task.gatewayTarget?.startUrl,fields,signal:controller.signal,authorized,
      evaluate:async(request,signal)=>{if(!authorized())throw new OrchestrationError('BROWSER_NOT_ALLOWED');try{return await this.options.evaluate(task,request,signal,authorized);}catch(e){if(e instanceof JevError)providerFailure={code:e.code,...e.metadata};throw e;}},
      beforeMutation:(operationId,operation)=>{
        controller.signal.throwIfAborted();
        if(!authorized())throw new OrchestrationError('ACCESS_DENIED');
        if(!/^[0-9a-f-]{36}$/i.test(operationId) || !['page_click','page_type','page_select','page_scroll','tab_navigate'].includes(operation))throw new OrchestrationError('INVALID_BROWSER_OPERATION');
        const receipt=this.read(task,requestId);
        if(!receipt || receipt.status!=='running')throw new OrchestrationError('BROWSER_REQUEST_ENDED');
        receipt.lastDispatchedMutation={operationId,operation,recordedAt:Date.now()};
        // Persist before handing the command to MCP. A failed write prevents dispatch.
        try{this.write(task,requestId,receipt);}catch(e){controller.abort();throw e;}
      },
      progress:event=>this.options.onProgress?.(task,event),
    })));
    const done=execution.then(result=>{
      validateBrowserResult(result);
      if(providerFailure)result={...result,providerFailure};
      let outcome:WorkerOutcome;
      const dispatched=this.read(task,requestId)?.lastDispatchedMutation;
      if(dispatched && result.lastAction?.operationId!==dispatched.operationId) {
        result={...result,status:'needs_verification',reason:'OUTCOME_UNKNOWN',lastAction:{operationId:dispatched.operationId,operation:dispatched.operation,outcome:'unknown'}};
      }
      const uncertain = result.lastAction?.outcome === 'unknown';
      if(result.status==='succeeded' && !authorized())throw new OrchestrationError('BROWSER_NOT_ALLOWED');
      if(result.status==='succeeded' && !uncertain)outcome={type:'completed',result:{summary:`Browser goal independently verified. ${result.steps} actions, ${result.evaluations} evaluations.`,artifactIds:[]}};
      else outcome={type:uncertain?'unknown':result.status==='cancelled'?'stopped':result.status==='failed'||knownBrowserStop(result,dispatched)?'failed':'unknown',failure:{code:'BROWSER_'+result.reason.toUpperCase(),message:'Browser work stopped: '+result.reason+'. '+result.steps+' actions, '+result.evaluations+' evaluations. '+(result.reason==='FIELD_TEXT_REQUIRED'?'Use established user facts to answer the missing field; ask the user only if the value is unknown.':'Verify the browser state before continuing.'),observedAt:Date.now()}};
      if(outcome.type!=='completed' && outcome.failure && providerFailure)outcome.failure.message+=`${providerFailure.validationReason?' Validation: '+providerFailure.validationReason+'.':''}${providerFailure.resetAt?' Resets at '+providerFailure.resetAt+'.':''}${providerFailure.retryAfter?' Retry after '+providerFailure.retryAfter+'.':''}`;
      const {observation:_,...browserReport}=result;
      outcome.browserReport=browserReport;
      this.write(task,requestId,{recordedAt:Date.now(),taskId:task.taskId,requestId,principalId:task.ownerPrincipalId,conversationId:task.conversationId,status:'ended',lastDispatchedMutation:this.read(task,requestId)?.lastDispatchedMutation,outcome,browserResult:result});
    }).catch(()=>{
      this.write(task,requestId,{recordedAt:Date.now(),taskId:task.taskId,requestId,principalId:task.ownerPrincipalId,conversationId:task.conversationId,status:'ended',lastDispatchedMutation:this.read(task,requestId)?.lastDispatchedMutation,outcome:{type:'unknown',failure:{code:'BROWSER_OUTCOME_UNKNOWN',message:'Browser request outcome could not be recorded. Inspect before retrying.',observedAt:Date.now()}}});
    }).finally(()=>this.running.delete(this.key(task,requestId)));
    this.running.set(this.key(task,requestId),{controller,done});
    // A filesystem failure cannot become an unhandled rejection; receipt stays uncertain.
    void done.catch(()=>{});
  }
  async inspect(task:TaskSnapshot,requestId:string):Promise<WorkerOutcome|'running'|'pending'> {
    this.assertTask(task);const receipt=this.read(task,requestId);
    if(!receipt)return 'pending';
    if(receipt.taskId!==task.taskId||receipt.requestId!==requestId)throw new OrchestrationError('BROWSER_RECEIPT_MISMATCH');
    if(receipt.status==='ended'&&receipt.outcome) {
      // Older receipts classified known runner stops as uncertain. Only normalize
      // with durable proof that the final dispatched mutation was confirmed.
      // Unknown actions and provider outcomes still require reconciliation.
      if(receipt.outcome.type==='unknown' && knownBrowserStop(receipt.browserResult,receipt.lastDispatchedMutation)) return {...receipt.outcome,type:'failed'};
      if(receipt.browserResult?.reason==='FIELD_TEXT_REQUIRED' && receipt.browserResult.lastAction?.outcome!=='unknown' &&
        this.options.allowed() && this.options.onNeedsInput?.(task,'Browser work needs a field value'+(receipt.browserResult.fieldRequest ? ' for '+JSON.stringify(receipt.browserResult.fieldRequest.label) : '')+'. The parent agent should answer from established user instructions when possible; ask the user only if the value is unknown or requires a new decision.')) return {type:'paused',browserReport:receipt.outcome.browserReport};
      return receipt.outcome;
    }
    if(this.running.has(this.key(task,requestId)))return 'running';
    return {type:'unknown',failure:{code:'BROWSER_EXECUTION_INTERRUPTED',message:'Browser execution was interrupted. Its actions were not replayed. Verify current browser state before continuing.',observedAt:Date.now()}};
  }
  async evidence(task:TaskSnapshot,refresh=false,signal?:AbortSignal):Promise<BrowserEvidence> {
    this.assertTask(task);
    if(this.options.allowedEvidence?.(task)===false)throw new OrchestrationError('ACCESS_DENIED');
    const binding=this.binding(task.gatewayTarget!.sessionId,task.ownerPrincipalId,task.conversationId);
    const requestId=task.gatewayDispatch?.requestId;
    if(!requestId)throw new OrchestrationError('BROWSER_EVIDENCE_UNAVAILABLE');
    const receipt=this.read(task,requestId);
    if(!receipt || receipt.taskId!==task.taskId || receipt.requestId!==requestId || this.running.has(this.key(task,requestId)))throw new OrchestrationError('BROWSER_EVIDENCE_UNAVAILABLE');
    const evidence:BrowserEvidence={requestId,recordedAt:receipt.recordedAt??0,result:receipt.browserResult,lastDispatchedMutation:receipt.lastDispatchedMutation,executionState:receipt.status==='ended'?'ended':'interrupted'};
    if(refresh){
      if(!binding.inspect)throw new OrchestrationError('BROWSER_INSPECTION_UNAVAILABLE');
      const authorized=()=>{try{return this.options.allowedEvidence?.(task)!==false && this.binding(binding.id,task.ownerPrincipalId,task.conversationId)===binding;}catch{return false;}};
      const inspectionResult=receipt.lastDispatchedMutation && (!receipt.browserResult?.lastAction || receipt.browserResult.lastAction.operationId!==receipt.lastDispatchedMutation.operationId)
        ? {lastAction:{...receipt.lastDispatchedMutation,outcome:'unknown' as const}} : receipt.browserResult;
      try {
        evidence.fresh=await binding.inspect(inspectionResult,signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),authorized);
      } catch(error) {
        if(error instanceof OrchestrationError)throw error;
        // Do not collapse an unavailable browser into a malformed agent request,
        // and never forward arbitrary MCP/provider text into the conversation.
        const code=error instanceof Error ? error.message : '';
        const known=['BROWSER_INSPECTION_FAILED','BROWSER_INSPECTION_DENIED','BROWSER_EVIDENCE_INVALID','BROWSER_EVIDENCE_TOO_LARGE','ACCESS_DENIED'];
        throw new OrchestrationError(known.includes(code)?code:'BROWSER_INSPECTION_UNAVAILABLE',
          'Fresh browser inspection could not complete. Check the connector, extension readiness and granted tab before continuing; no browser action was dispatched by this inspection.');
      }
      signal?.throwIfAborted();
      if(!authorized())throw new OrchestrationError('ACCESS_DENIED');
      evidence.evidenceId=randomUUID();
      // Store only proof of a fresh scoped read, not another copy of the page.
      receipt.inspection={id:evidence.evidenceId,at:Date.now()};this.write(task,requestId,receipt);
    }
    return evidence;
  }
  verifyEvidence(task:TaskSnapshot,requestId:string,evidenceId:string):void {
    this.assertTask(task);if(this.options.allowedEvidence?.(task)===false)throw new OrchestrationError('ACCESS_DENIED');this.binding(task.gatewayTarget!.sessionId,task.ownerPrincipalId,task.conversationId);
    if(task.gatewayDispatch?.requestId!==requestId || this.running.has(this.key(task,requestId)))throw new OrchestrationError('STALE_BROWSER_EVIDENCE');
    const receipt=this.read(task,requestId), result=receipt?.browserResult;
    if(receipt?.status!=='ended' || !receipt.inspection || receipt.inspection.id!==evidenceId || Date.now()-receipt.inspection.at>300000 || !parentVerifiableBrowserResult(result))throw new OrchestrationError('BROWSER_VERIFICATION_UNAVAILABLE');
  }
  async cancel(task:TaskSnapshot,requestId:string):Promise<void>{
    this.assertTask(task);
    const running=this.running.get(this.key(task,requestId));
    if(running){running.controller.abort();return;}
    const receipt=this.read(task,requestId), result=receipt?.browserResult;
    // Explicit cancellation may release a finished, blocked request whose last
    // mutation is durably confirmed. Never infer safety from an action count.
    if(receipt?.status==='ended' && result?.status==='blocked' && result.reason==='OBSERVATION_TRUNCATED' && !result.providerFailure &&
      result.lastAction?.outcome!=='unknown' &&
      (!receipt.lastDispatchedMutation || (result.lastAction?.operationId===receipt.lastDispatchedMutation.operationId && result.lastAction.outcome==='confirmed'))) {
      receipt.outcome={type:'stopped',browserReport:receipt.outcome?.browserReport};
      this.write(task,requestId,receipt);
    }
  }
  async close():Promise<void>{const runs=[...this.running.values()];runs.forEach(r=>r.controller.abort());await Promise.allSettled(runs.map(r=>r.done));}
}

function knownBrowserStop(result:BrowserExecutionResult|undefined,dispatched:BrowserMutationCheckpoint|undefined):boolean {
  // A blocked runner has ended. A budget/confidence reason does not imply an
  // in-flight browser action. Keep only genuinely unknown actions or provider
  // outcomes fenced; field requests retain their existing input lifecycle.
  if(result?.status!=='blocked' || result.reason==='OUTCOME_UNKNOWN' || result.reason==='FIELD_TEXT_REQUIRED' || result.providerFailure || result.lastAction?.outcome==='unknown')return false;
  if(result.reason==='START_URL_REQUIRED')return result.steps===0 && result.evaluations===0 && !result.lastAction && !result.lastConfirmedAction && !dispatched;
  return !dispatched || (result.lastAction?.operationId===dispatched.operationId && ['confirmed','not_executed'].includes(result.lastAction.outcome));
}

function validateBrowserResult(result: BrowserExecutionResult): void {
  if (!result || Object.keys(result).some(k=>!['status','reason','steps','evaluations','staleRetries','textCalls','lastAction','observation','contractVersion','fieldRequest','lastEvaluation','lastConfirmedAction'].includes(k)) || !['succeeded','blocked','cancelled','failed','needs_verification'].includes(result.status) || (result.status==='succeeded' && result.reason!=='VERIFIED') || typeof result.reason !== 'string' || !/^[A-Z][A-Z0-9_]{0,100}$/.test(result.reason) || ![result.steps,result.evaluations].every(n=>Number.isSafeInteger(n)&&n>=0) ||
    (result.lastAction && (!['confirmed','unknown','not_executed'].includes(result.lastAction.outcome) || typeof result.lastAction.operationId !== 'string' || typeof result.lastAction.operation !== 'string')) ||
    (result.fieldRequest && (typeof result.fieldRequest.label!=='string' || result.fieldRequest.label.length>250 || typeof result.fieldRequest.ref!=='string' || result.fieldRequest.ref.length>100 || !['missing','ambiguous'].includes(result.fieldRequest.reason))) || Buffer.byteLength(JSON.stringify(result))>1048576) throw Error('INVALID_BROWSER_RESULT');
}

/** Bound third-party runners, including ignored cancellation. Late results never rewrite receipts. */
function boundedExecution<T>(controller:AbortController,authorized:()=>boolean,run:()=>Promise<T>):Promise<T> {
  return new Promise((resolve,reject)=>{
    let grace:ReturnType<typeof setTimeout>|undefined;
    let settled=false;
    const cleanup=()=>{clearTimeout(timer);clearInterval(fence);clearTimeout(grace);controller.signal.removeEventListener('abort',abort);};
    const finish=(error:unknown,value?:T)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve(value!);};
    const abort=()=>{grace??=setTimeout(()=>finish(Error('BROWSER_CANCEL_UNCONFIRMED')),5000);};
    const timer=setTimeout(()=>controller.abort(),610000);
    const fence=setInterval(()=>{if(!authorized())controller.abort();},250);
    controller.signal.addEventListener('abort',abort,{once:true});
    if(controller.signal.aborted)abort();
    Promise.resolve().then(()=>{controller.signal.throwIfAborted();if(!authorized())throw Error('ACCESS_DENIED');return run();}).then(v=>finish(undefined,v),e=>finish(e));
  });
}
