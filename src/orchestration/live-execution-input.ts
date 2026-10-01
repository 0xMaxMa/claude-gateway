import {automationSession} from './tasks/automation-session';
import {AcceptInput, OrchestrationStore} from './store';
import {TaskService} from './tasks/service';
import {ExecutionCapabilities, OrchestrationError, TaskSnapshot} from './types';

export interface LiveControlReceipt {inputId:string;taskId?:string;status:'applied'|'needs_agent';code?:string;revision?:number}
export function liveControlReceipt(store:OrchestrationStore,inputId:string):LiveControlReceipt|undefined {
  const row=store.get("SELECT payload_json FROM conversation_events WHERE type='input.execution_control' AND json_extract(payload_json,'$.payload.inputId')=? ORDER BY seq DESC LIMIT 1",inputId);
  return row?JSON.parse(String(row.payload_json)).payload:undefined;
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
