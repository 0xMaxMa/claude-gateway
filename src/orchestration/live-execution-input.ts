import {AcceptInput, OrchestrationStore} from './store';
import {DecisionService} from './decisions';
import {TaskService} from './tasks/service';
import {ExecutionCapabilities, OrchestrationError, TaskSnapshot} from './types';

/** Explicit client routing; never infer a target from model text or another session. */
export function liveExecutionInput(store:OrchestrationStore,tasks:TaskService,decisions:DecisionService,input:AcceptInput,capabilities:ExecutionCapabilities) {
  const target=input.metadata?.executionTaskId;
  if(!target)return undefined;
  return store.compose(()=>{
    const receipt=store.acceptInput({...input,capabilities});
    const previous=store.get(`SELECT r.id,r.generated_text FROM assistant_responses r JOIN conversation_decisions d ON d.id=r.decision_id WHERE d.kind='notice' AND EXISTS(SELECT 1 FROM json_each(d.input_ids_json) WHERE value=?)`,receipt.inputId);
    if(previous)return {inputId:receipt.inputId,responseId:String(previous.id),text:String(previous.generated_text),reused:true};
    let task:TaskSnapshot|undefined;
    let text:string;
    try{
      if(!capabilities.execute||input.scope.source!=='api')throw new OrchestrationError('ACCESS_DENIED');
      if(input.attachmentIds?.length)throw new OrchestrationError('INVALID_INPUT');
      const current=store.task(target);
      if(!current||current.agentSessionId!==input.scope.agentSessionId||current.conversationId!==receipt.conversationId)throw new OrchestrationError('ACCESS_DENIED');
      task=tasks.controlByUser(receipt.conversationId,input.scope.principalId,target,{id:receipt.inputId,action:'revise',expectedRevision:current.revision,text:input.text});
      text='Correction received. I will apply it after the current action settles, then continue from the current screen.';
    }catch(error){
      if(!(error instanceof OrchestrationError))throw error;
      text=error.code==='STATE_CONFLICT'?'This task is stopped and cannot apply this correction safely. Choose Agent conversation in Text and voice destination to inspect its status and discuss the next step. No browser action or new task was started.':'The correction could not be applied. Check the selected task and send text without attachments. No new action was started.';
    }
    store.completeInputReceipt(receipt);
    const responseId=decisions.notice(receipt.conversationId,text,true,receipt.inputId);
    return {inputId:receipt.inputId,responseId,text,task};
  });
}
