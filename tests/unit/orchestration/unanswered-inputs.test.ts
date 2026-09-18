import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { unansweredInputContext } from '../../../src/orchestration/unanswered-inputs';

test('keeps failed user intent, excludes internal retries and diagnostics, and clears after a successful user reply',()=>{
 const store=new OrchestrationStore(':memory:','a'),decisions=new DecisionService(store);
 const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'u',principalId:'u',chatId:'s',threadKey:''};
 try {
  const failed=store.acceptInput({scope,text:'Please investigate my task'});
  decisions.finish(decisions.begin(failed.conversationId,'u',[failed.inputId]),'Provider error','failed');
  const report=store.acceptInput({scope,text:'Internal full worker report',storeUserMessage:false});
  decisions.finish(decisions.begin(report.conversationId,'u',[report.inputId]),'Timeout error','failed');
  const next=store.acceptInput({scope,text:'Any news?'});
  const context=unansweredInputContext(store,next.conversationId,next.inputId);
  expect(context).toContain('Please investigate my task');
  expect(context).not.toMatch(/Internal full worker report|Provider error|Timeout error|Any news/);
  decisions.finish(decisions.begin(next.conversationId,'u',[next.inputId]),'Here is the status');
  expect(unansweredInputContext(store,next.conversationId,'future')).toBe('');
 } finally {store.close();}
});
