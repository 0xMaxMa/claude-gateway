import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { CommandContext, TaskAttempt } from '../../../src/orchestration/types';

let store: OrchestrationStore, tasks: TaskService, context: CommandContext, count: number;
beforeEach(() => {
  store = new OrchestrationStore(':memory:', 'a');
  tasks = new TaskService(store, { tasks: { workspaceMode: 'host', maxConcurrentPerAgent: 10, maxConcurrentPerConversation: 10, workerIdleTtlMs: 600000 } }, '/project');
  const input = store.acceptInput({scope:{agentId:'a',agentSessionId:'chat',source:'api',accountId:'owner',principalId:'owner',chatId:'chat',threadKey:''},text:'work'});
  const decision = new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]);
  context = {...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:''}; count=0;
});
afterEach(() => { jest.restoreAllMocks(); store.close(); });
const spawn = (prior?: string) => tasks.spawn({...context,actionId:String(++count)}, {title:'work',instructions:'do the next step',targetProfile:'default-worker',continueTaskId:prior});
const done = (a: TaskAttempt) => tasks.finish(a.attemptId,a.generation,{type:'completed',result:{summary:'finished',artifactIds:[]}});

test('ten busy workers queue the eleventh; independent work reuses a free slot with a fresh session', () => {
 const all=Array.from({length:11},()=>spawn()); const attempts=all.slice(0,10).map(t=>tasks.claim(t.taskId)!);
 expect(new Set(attempts.map(a=>a.workerId)).size).toBe(10);expect(tasks.claim(all[10].taskId)).toBeUndefined();
 done(attempts[3]);const next=tasks.claim(all[10].taskId)!;
 expect(next.workerId).toBe(attempts[3].workerId);expect(next.sessionId).not.toBe(attempts[3].sessionId);expect(next.resumeSession).toBe(false);
});
test('follow-up waits for its workstream then resumes the same worker and CLI session',()=>{
 const first=spawn(),a=tasks.claim(first.taskId)!;tasks.pool.bind(a,'same-config');
 const next=spawn(first.taskId);expect(tasks.claim(next.taskId)).toBeUndefined();done(a);
 const b=tasks.claim(next.taskId)!;expect(b).toMatchObject({workerId:a.workerId,sessionId:a.sessionId,resumeSession:true});
 tasks.pool.bind(b,'same-config');expect(b.sessionId).toBe(a.sessionId);
});
test('idle TTL expires only idle slots; running attempts remain fenced',()=>{
 const first=spawn(),a=tasks.claim(first.taskId)!;done(a);const running=tasks.claim(spawn().taskId)!;
 // Reuse above consumes the first idle slot. Complete another independent slot.
 const other=spawn(),b=tasks.claim(other.taskId)!;done(b);
 const now=Date.now();jest.spyOn(Date,'now').mockReturnValue(now+600001);tasks.pruneWorkers();
 expect(store.get('SELECT id FROM worker_pool WHERE id=?',b.workerId!)).toBeUndefined();
 expect(store.get('SELECT active_task_id FROM worker_pool WHERE id=?',running.workerId!)?.active_task_id).toBe(running.taskId);
});
test('configuration changes reset CLI history; unknown attempts never release their slot',()=>{
 const first=spawn(),a=tasks.claim(first.taskId)!;tasks.pool.bind(a,'old');done(a);
 const b=tasks.claim(spawn(first.taskId).taskId)!;tasks.pool.bind(b,'new');expect(b.resumeSession).toBe(false);expect(b.sessionId).not.toBe(a.sessionId);
 tasks.finish(b.attemptId,b.generation,{type:'unknown'});
 expect(store.get('SELECT active_task_id FROM worker_pool WHERE id=?',b.workerId!)?.active_task_id).toBe(b.taskId);
 expect(tasks.claim(spawn(b.taskId).taskId)).toBeUndefined();
});
test('continuation cannot reference another conversation and capability changes never resume old grants',()=>{
 const first=spawn(),a=tasks.claim(first.taskId)!;done(a);
 context.writeMemory=true;const b=tasks.claim(spawn(first.taskId).taskId)!;expect(b.resumeSession).toBe(false);expect(b.sessionId).not.toBe(a.sessionId);done(b);
 const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'other',source:'api',accountId:'owner',principalId:'owner',chatId:'other',threadKey:''},text:'other'});
 const decision=new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]);context={...context,...input,...decision};
 expect(()=>spawn(first.taskId)).toThrow('ACCESS_DENIED');
 const c=tasks.claim(spawn().taskId)!;expect(c.resumeSession).toBe(false);expect(c.sessionId).not.toBe(b.sessionId);
});
test('expired continuation starts a new worker session and retains explicit predecessor reference',()=>{
 const first=spawn(),a=tasks.claim(first.taskId)!;done(a);
 const now=Date.now();jest.spyOn(Date,'now').mockReturnValue(now+600001);
 const next=spawn(first.taskId),b=tasks.claim(next.taskId)!;
 expect(b.workerId).not.toBe(a.workerId);expect(b.sessionId).not.toBe(a.sessionId);expect(next.continueTaskId).toBe(first.taskId);
});
