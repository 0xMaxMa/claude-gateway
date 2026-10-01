import {normalizeCommand} from '../automation/direct-command';
import {automationSession} from './tasks/automation-session';
import {AcceptInput, OrchestrationStore} from './store';
import {TaskService} from './tasks/service';
import {ExecutionCapabilities, OrchestrationError, TaskSnapshot} from './types';

export interface LiveControlReceipt {inputId:string;taskId?:string;status:'applied'|'needs_agent';code?:string;revision?:number}
export function liveControlReceipt(store:OrchestrationStore,inputId:string):LiveControlReceipt|undefined {
  const row=store.get("SELECT payload_json FROM conversation_events WHERE type='input.execution_control' AND json_extract(payload_json,'$.payload.inputId')=? ORDER BY seq DESC LIMIT 1",inputId);
  return row?JSON.parse(String(row.payload_json)).payload:undefined;
}
/** A voice command and its typed echo arrive within this window (observed 0.25–1.7s). */
export const VOICE_ECHO_WINDOW_MS=2000;
/**
 * The GetPod web client posts each live-voice transcript again as a typed
 * message (sessions b01a566f, a4b9ee81), so every voice command ran twice.
 * Only that pair is one command: the same words for the same task within the
 * window, one copy spoken and the other a plain typed message. Repeating a
 * command in the same modality, or after the window, still runs it again.
 */
function voiceEcho(store:OrchestrationStore,conversationId:string,taskId:string,inputId:string):boolean {
  const current=store.get('SELECT modality,text,created_at,ingress_json FROM conversation_inputs WHERE id=?',inputId)!;
  const previous=store.get(`SELECT i.modality,i.text,i.created_at,i.ingress_json FROM conversation_events e JOIN conversation_inputs i ON i.id=json_extract(e.payload_json,'$.payload.inputId')
    WHERE e.conversation_id=? AND e.type='input.execution_control' AND json_extract(e.payload_json,'$.payload.taskId')=? AND json_extract(e.payload_json,'$.payload.status')='applied'
    AND json_type(e.payload_json,'$.payload.code') IS NULL AND i.id<>? ORDER BY e.seq DESC LIMIT 1`,conversationId,taskId,inputId);
  if(!previous||Number(current.created_at)-Number(previous.created_at)>VOICE_ECHO_WINDOW_MS)return false;
  const spoken=[current,previous].filter(row=>row.modality==='live_voice');
  const typed=[current,previous].filter(row=>row.modality==='text');
  // The echo is a plain message: no image/video options or other prompt context.
  if(spoken.length!==1||typed.length!==1||JSON.parse(String(typed[0].ingress_json)).metadata?.promptContext)return false;
  return normalizeCommand(String(current.text))===normalizeCommand(String(previous.text));
}
/**
 * Jev judged the user's applied direct command a question about what is shown
 * (READ_REQUEST), or gave up on it (AGENT_HANDOFF: BLOCKED or UNCLEAR); nothing
 * ran. The same input becomes a normal user turn with a needs_agent receipt, so
 * the agent answers it (or sends one command for it), during user control too,
 * and history records it. Applies once, only to that task's applied receipt.
 */
export type DirectHandoffCode='READ_REQUEST'|'AGENT_HANDOFF';
export function handDirectCommandToAgent(store:OrchestrationStore,task:TaskSnapshot,inputId:string,revision:number,code:DirectHandoffCode):boolean {
  return store.transaction(()=>{
    const input=store.get('SELECT conversation_id,principal_id,status FROM conversation_inputs WHERE id=?',inputId);
    if(!input||input.conversation_id!==task.conversationId||input.principal_id!==task.ownerPrincipalId||input.status!=='handled')return false;
    const receipt=liveControlReceipt(store,inputId);
    if(receipt?.taskId!==task.taskId||receipt.status!=='applied'||receipt.code)return false;
    store.appendEvent(task.conversationId,'input.execution_control',{inputId,taskId:task.taskId,status:'needs_agent',code,revision} satisfies LiveControlReceipt,task.taskId);
    store.run("UPDATE conversation_inputs SET status='accepted',store_user_message=1 WHERE id=?",inputId);
    store.run("UPDATE history_operations SET state='pending',updated_at=? WHERE operation_id=? AND input_id=?",Date.now(),`input:${inputId}`,inputId);
    return true;
  });
}
/** Apply explicitly targeted control without conversational inference. */
export function liveExecutionInput(store:OrchestrationStore,tasks:TaskService,input:AcceptInput,capabilities:ExecutionCapabilities,maxPending=100):(LiveControlReceipt & {task?:TaskSnapshot;reused:boolean})|undefined {
  const target=input.metadata?.executionTaskId;
  if(!target)return undefined;
  return store.compose(()=>{
    const receipt=store.acceptInput({...input,storeUserMessage:false,capabilities},maxPending);
    const previous=liveControlReceipt(store,receipt.inputId);
    if(previous)return {...previous,reused:true};
    let task:TaskSnapshot|undefined;
    let control:LiveControlReceipt={inputId:receipt.inputId,status:'needs_agent'};
    try{
      if(!capabilities.execute||input.scope.source!=='api')throw new OrchestrationError('ACCESS_DENIED');
      const current=store.task(target);
      if(!current||current.agentSessionId!==input.scope.agentSessionId||current.conversationId!==receipt.conversationId||current.ownerPrincipalId!==input.scope.principalId)throw new OrchestrationError('ACCESS_DENIED');
      control.taskId=target;
      const session=automationSession(current);
      if(session?.status==='closed')throw new OrchestrationError('AUTOMATION_SESSION_CLOSED');
      // Explicit task destination resumes the same session with a fresh command.
      // Unknown mutations remain fenced by controlByUser.
      if(input.attachmentIds?.length)throw new OrchestrationError('INVALID_INPUT');
      if(voiceEcho(store,receipt.conversationId,target,receipt.inputId)){
        // Acknowledged like an applied command, but the task is not revised again.
        control={...control,status:'applied',code:'DUPLICATE_VOICE_ECHO',revision:current.revision};
        store.appendEvent(receipt.conversationId,'input.execution_control',control,control.taskId);
        store.completeInputReceipt(receipt);
        return {...control,reused:false};
      }
      task=tasks.controlByUser(receipt.conversationId,input.scope.principalId,target,{id:receipt.inputId,action:'revise',expectedRevision:current.revision,text:input.text});
      control={...control,status:'applied',revision:task.revision};
    }catch(error){
      if(!(error instanceof OrchestrationError))throw error;
      control.code=error.code;
    }
    store.appendEvent(receipt.conversationId,'input.execution_control',control,control.taskId);
    // Applied commands are acknowledged by the task state. Anything else stays a
    // pending user message so the agent gets a turn and history records it.
    if(control.status==='applied')store.completeInputReceipt(receipt);
    else store.run('UPDATE conversation_inputs SET store_user_message=1 WHERE id=?',receipt.inputId);
    return {...control,task,reused:false};
  });
}
