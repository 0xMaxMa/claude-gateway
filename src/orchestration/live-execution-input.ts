import {automationSession} from './tasks/automation-session';
import {AcceptInput, OrchestrationStore} from './store';
import {TaskService} from './tasks/service';
import {ExecutionCapabilities, OrchestrationError, TaskSnapshot} from './types';

export interface LiveControlReceipt {inputId:string;taskId?:string;status:'applied'|'needs_agent';code?:string;revision?:number}
export function liveControlReceipt(store:OrchestrationStore,inputId:string):LiveControlReceipt|undefined {
  const row=store.get("SELECT payload_json FROM conversation_events WHERE type='input.execution_control' AND json_extract(payload_json,'$.payload.inputId')=? ORDER BY seq DESC LIMIT 1",inputId);
  return row?JSON.parse(String(row.payload_json)).payload:undefined;
}
/** Apply the direct control immediately; leave its canonical input for the agent to answer. */
export function liveExecutionInput(store:OrchestrationStore,tasks:TaskService,input:AcceptInput,capabilities:ExecutionCapabilities,maxPending=100):(LiveControlReceipt & {task?:TaskSnapshot;reused:boolean})|undefined {
  const target=input.metadata?.executionTaskId;
  if(!target)return undefined;
  return store.compose(()=>{
    const receipt=store.acceptInput({...input,capabilities},maxPending);
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
      // Idle input may be a question or a new goal. Let the agent interpret it and
      // update this task; never append a completed goal as instructions to replay.
      if(session?.status==='idle' && ['completed','failed'].includes(current.state))throw new OrchestrationError('AUTOMATION_IDLE');
      if(input.attachmentIds?.length)throw new OrchestrationError('INVALID_INPUT');
      task=tasks.controlByUser(receipt.conversationId,input.scope.principalId,target,{id:receipt.inputId,action:'revise',expectedRevision:current.revision,text:input.text});
      control={...control,status:'applied',revision:task.revision};
    }catch(error){
      if(!(error instanceof OrchestrationError))throw error;
      control.code=error.code;
    }
    store.appendEvent(receipt.conversationId,'input.execution_control',control,control.taskId);
    return {...control,task,reused:false};
  });
}
