import { createHash, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { BrowserTransport, BrowserRunnerBudget, BrowserRunnerProgress, runBrowserTask } from '../../jev/browser-runner';
import { JevRequest, JevResult } from '../../jev/types';
import { CommandContext, GatewayTaskTarget, OrchestrationError, TaskSnapshot, WorkerOutcome } from '../types';
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
  transport: BrowserTransport;
  fieldValues?: Record<string,string>;
  budget?: BrowserRunnerBudget;
}
interface Receipt {taskId:string;requestId:string;principalId:string;conversationId:string;status:'running'|'ended';outcome?:WorkerOutcome}
export class BrowserTaskAdapter implements GatewayTaskAdapter {
  readonly name='browser';
  private readonly running=new Map<string,{controller:AbortController;done:Promise<void>}>();
  constructor(private readonly options:{agentId:string;root:string;allowed:()=>boolean;bindings:()=>BrowserTaskBinding[];
    evaluate:(task:TaskSnapshot,request:JevRequest,signal:AbortSignal)=>Promise<JevResult>;
    onProgress?:(task:TaskSnapshot,progress:BrowserRunnerProgress)=>void}){}
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
  async submit(task:TaskSnapshot,requestId:string,instructions:string):Promise<void> {
    this.assertTask(task);
    const binding=this.binding(task.gatewayTarget!.sessionId,task.ownerPrincipalId,task.conversationId);
    if(this.read(task,requestId))throw new OrchestrationError('BROWSER_REQUEST_ALREADY_SUBMITTED');
    // Durable receipt precedes any side effect; restart never replays this request.
    this.write(task,requestId,{taskId:task.taskId,requestId,principalId:task.ownerPrincipalId,conversationId:task.conversationId,status:'running'});
    const controller=new AbortController();
    const authorized=()=>{try{return this.binding(binding.id,task.ownerPrincipalId,task.conversationId)===binding;}catch{return false;}};
    const transport:BrowserTransport={
      observe:s=>binding.transport.observe(s),
      checkAccess:async(o,a,s)=>authorized()&&await binding.transport.checkAccess(o,a,s),
      execute:(input,s)=>{if(!authorized())throw new OrchestrationError('BROWSER_NOT_ALLOWED');return binding.transport.execute(input,s);},
      verifyCompletion:async(o,s)=>{if(!authorized())throw new OrchestrationError('BROWSER_NOT_ALLOWED');const result=await binding.transport.verifyCompletion(o,s);if(!authorized()||!await binding.transport.checkAccess(o,undefined,s))throw new OrchestrationError('BROWSER_NOT_ALLOWED');return result;}
    };
    const done=runBrowserTask({goal:instructions,transport,onProgress:progress=>this.options.onProgress?.(task,progress),fieldValues:binding.fieldValues,budget:binding.budget,signal:controller.signal,
      evaluate:(request,signal)=>{if(!authorized())throw new OrchestrationError('BROWSER_NOT_ALLOWED');return this.options.evaluate(task,request,signal);}
    }).then(result=>{
      let outcome:WorkerOutcome;
      if(result.status==='completed')outcome={type:'completed',result:{summary:`Verified browser goal completed. ${result.evidence??''}`.trim(),artifactIds:[]}};
      else outcome={type:result.status==='cancelled'?'stopped':result.status==='failed'?'failed':'unknown',failure:{code:'BROWSER_'+result.reason.toUpperCase(),message:result.status==='waiting_input'?'Browser work needs an explicit field value. No field text was invented.':'Browser work stopped: '+result.reason+'. Verify the browser state before continuing.',observedAt:Date.now()}};
      this.write(task,requestId,{taskId:task.taskId,requestId,principalId:task.ownerPrincipalId,conversationId:task.conversationId,status:'ended',outcome});
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
    if(receipt.status==='ended'&&receipt.outcome)return receipt.outcome;
    if(this.running.has(this.key(task,requestId)))return 'running';
    return {type:'unknown',failure:{code:'BROWSER_EXECUTION_INTERRUPTED',message:'Browser execution was interrupted. Its actions were not replayed. Verify current browser state before continuing.',observedAt:Date.now()}};
  }
  async cancel(task:TaskSnapshot,requestId:string):Promise<void>{this.assertTask(task);this.running.get(this.key(task,requestId))?.controller.abort();}
  async close():Promise<void>{const runs=[...this.running.values()];runs.forEach(r=>r.controller.abort());await Promise.allSettled(runs.map(r=>r.done));}
}
