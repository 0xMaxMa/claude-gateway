import type { BrowserExecutionContext, BrowserExecutionResult, BrowserProgress } from '../../jev/browser-contract';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { JevRequest, JevResult } from '../../jev/types';
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
  run: (context: BrowserExecutionContext) => Promise<BrowserExecutionResult>;
}
interface Receipt {taskId:string;requestId:string;principalId:string;conversationId:string;status:'running'|'ended';outcome?:WorkerOutcome;browserResult?:BrowserExecutionResult}
export class BrowserTaskAdapter implements GatewayTaskAdapter {
  readonly name='browser';
  private readonly running=new Map<string,{controller:AbortController;done:Promise<void>}>();
  constructor(private readonly options:{agentId:string;root:string;allowed:()=>boolean;bindings:()=>BrowserTaskBinding[];
    evaluate:(task:TaskSnapshot,request:JevRequest,signal:AbortSignal,authorized:()=>boolean)=>Promise<JevResult>;
    onProgress?:(task:TaskSnapshot,progress:BrowserProgress)=>void;
    allowedTask?:(task:TaskSnapshot)=>boolean;
    onNeedsInput?:(task:TaskSnapshot,question:string)=>boolean}){}
  private binding(id:string,principalId:string,conversationId:string,requireEnabled=true):BrowserTaskBinding {
    if(requireEnabled&&!this.options.allowed())throw new OrchestrationError('BROWSER_NOT_ALLOWED');
    const binding=this.options.bindings().find(b=>b.version===1&&b.id===id&&b.principalId===principalId&&b.conversationId===conversationId);
    if(!binding)throw new OrchestrationError('BROWSER_TARGET_NOT_AVAILABLE');
    return binding;
  }
  discover(query='',offset=0,context?:CommandContext):unknown {
    if(!this.options.allowed()||!context)throw new OrchestrationError('BROWSER_NOT_ALLOWED');
    if(!Number.isSafeInteger(offset)||offset<0||typeof query!=='string')throw new OrchestrationError('INVALID_INPUT');
    const bindings=this.options.bindings().filter(b=>b.version===1&&b.principalId===context.principalId&&b.conversationId===context.conversationId&&`${b.id} ${b.name}`.toLowerCase().includes(query.toLowerCase()));
    return {targets:bindings.slice(offset,offset+25).map(b=>({adapter:'browser',session_id:b.id,name:b.name,version:1})),next_offset:offset+25<bindings.length?offset+25:null};
  }
  resolve(input:Record<string,unknown>,context?:CommandContext):GatewayTaskTarget {
    if(!context||Object.keys(input).some(k=>!['adapter','session_id'].includes(k))||typeof input.session_id!=='string')throw new OrchestrationError('INVALID_GATEWAY_TARGET');
    const binding=this.binding(input.session_id,context.principalId,context.conversationId);
    return {adapter:'browser',sessionId:binding.id,name:binding.name};
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
    writeFileSync(temp,JSON.stringify(receipt),{mode:0o600,flag:'wx'});renameSync(temp,file);
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
    this.write(task,requestId,{taskId:task.taskId,requestId,principalId:task.ownerPrincipalId,conversationId:task.conversationId,status:'running'});
    const controller=new AbortController();
    const authorized=()=>{try{return this.options.allowedTask?.(task)!==false && this.binding(binding.id,task.ownerPrincipalId,task.conversationId)===binding;}catch{return false;}};
    // The installed browser package owns execution; gateway owns the request lifetime.
    const execution = boundedExecution(controller,authorized,()=> Promise.resolve().then(() => binding.run({goal:instructions,fields,signal:controller.signal,authorized,
      evaluate:(request,signal)=>{if(!authorized())throw new OrchestrationError('BROWSER_NOT_ALLOWED');return this.options.evaluate(task,request,signal,authorized);},
      progress:event=>this.options.onProgress?.(task,event),
    })));
    const done=execution.then(result=>{
      validateBrowserResult(result);
      let outcome:WorkerOutcome;
      const uncertain = result.lastAction?.outcome === 'unknown';
      if(result.status==='succeeded' && !authorized())throw new OrchestrationError('BROWSER_NOT_ALLOWED');
      if(result.status==='succeeded' && !uncertain)outcome={type:'completed',result:{summary:`Browser goal independently verified. ${result.steps} actions, ${result.evaluations} evaluations.`,artifactIds:[]}};
      else outcome={type:uncertain?'unknown':result.status==='cancelled'?'stopped':result.status==='failed'?'failed':'unknown',failure:{code:'BROWSER_'+result.reason.toUpperCase(),message:'Browser work stopped: '+result.reason+'. '+result.steps+' actions, '+result.evaluations+' evaluations. '+(result.reason==='FIELD_TEXT_REQUIRED'?'Ask the user for the missing field value; no value was invented.':'Verify the browser state before continuing.'),observedAt:Date.now()}};
      const {observation:_,...browserReport}=result;
      outcome.browserReport=browserReport;
      this.write(task,requestId,{taskId:task.taskId,requestId,principalId:task.ownerPrincipalId,conversationId:task.conversationId,status:'ended',outcome,browserResult:result});
    }).catch(()=>{
      this.write(task,requestId,{taskId:task.taskId,requestId,principalId:task.ownerPrincipalId,conversationId:task.conversationId,status:'ended',outcome:{type:'unknown',failure:{code:'BROWSER_OUTCOME_UNKNOWN',message:'Browser request outcome could not be recorded. Inspect before retrying.',observedAt:Date.now()}}});
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
      if(receipt.browserResult?.reason==='FIELD_TEXT_REQUIRED' && receipt.browserResult.lastAction?.outcome!=='unknown' &&
        this.options.allowed() && this.options.onNeedsInput?.(task,'Browser work needs a field value'+(receipt.browserResult.fieldRequest ? ' for '+JSON.stringify(receipt.browserResult.fieldRequest.label) : '')+'. Please provide the exact text to enter, or ask the parent agent to inspect the page.')) return {type:'paused',browserReport:receipt.outcome.browserReport};
      return receipt.outcome;
    }
    if(this.running.has(this.key(task,requestId)))return 'running';
    return {type:'unknown',failure:{code:'BROWSER_EXECUTION_INTERRUPTED',message:'Browser execution was interrupted. Its actions were not replayed. Verify current browser state before continuing.',observedAt:Date.now()}};
  }
  async cancel(task:TaskSnapshot,requestId:string):Promise<void>{this.assertTask(task);this.running.get(this.key(task,requestId))?.controller.abort();}
  async close():Promise<void>{const runs=[...this.running.values()];runs.forEach(r=>r.controller.abort());await Promise.allSettled(runs.map(r=>r.done));}
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
