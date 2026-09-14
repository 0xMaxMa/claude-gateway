import { replyContext, storedReplyContext } from '../../../src/orchestration/reply-context';
import { taskDirective } from '../../../src/orchestration/tasks/task-directive';
import { OrchestrationStore } from '../../../src/orchestration/store';
test('quote context is explicit data, retains full message, and omits unrelated metadata',()=>{
 const text='getpod-browser deployment '+ 'evidence '.repeat(300);
 const result=replyContext({repliedText:text,repliedMessageId:'6890',repliedSender:'bot',senderId:'private-sender',promptContext:'unrelated'});
 expect(result).toContain(text);expect(result).toContain('6890');expect(result).toContain('not a new instruction');expect(result).not.toContain('private-sender');expect(result).not.toContain('unrelated');
 expect(replyContext({})).toBe('');expect(storedReplyContext('bad json')).toBe('');
});
test('worker receives quote on earlier user reply even when the latest input is a short followup',()=>{
 const store=new OrchestrationStore(':memory:','a');
 const scope={agentId:'a',agentSessionId:'s',source:'telegram' as const,accountId:'a',chatId:'c',threadKey:'',principalId:'u'};
 try{
 const original=store.acceptInput({scope,text:'Where is develop/prod for this?',metadata:{repliedText:'getpod-browser deploy report',repliedMessageId:'6890'}});
 const next=store.acceptInput({scope,text:'Which path?'});
 store.acceptInput({scope:{...scope,agentSessionId:'other',chatId:'other'},text:'other',metadata:{repliedText:'PRIVATE OTHER QUOTE'}});
 const text=taskDirective(store,original.conversationId,{taskId:'t',revision:1,instructions:'Check deployment paths',contextRefs:[],originatingInputId:next.inputId,mode:'when_ready'});
 expect(text).toContain('getpod-browser deploy report');expect(text).toContain('Which path?');expect(text).not.toContain('PRIVATE OTHER QUOTE');
 }finally{store.close();}
});
