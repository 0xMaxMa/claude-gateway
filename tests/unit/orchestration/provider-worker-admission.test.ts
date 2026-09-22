import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { WorkerScheduler } from '../../../src/orchestration/tasks/scheduler';
import { ProviderAdmissionStore, PROVIDER_ADMISSION_DEFAULTS as policy } from '../../../src/orchestration/provider-admission';
import type { WorkerOutcome } from '../../../src/orchestration/types';

function queuedTask() {
  const store = new OrchestrationStore(':memory:', 'agent'), tasks = new TaskService(store), decisions = new DecisionService(store);
  const input = store.acceptInput({scope:{agentId:'agent',agentSessionId:'session',source:'api',accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'},text:'Work'});
  const decision = decisions.begin(input.conversationId,'owner',[input.inputId]);
  const task = tasks.spawn({...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'}, {title:'Work',instructions:'Work',targetProfile:'default-worker'});
  decisions.finish(decision,'Queued');
  return {store,tasks,task};
}

test('first real worker output releases a recovery probe while the task remains active', async () => {
  const f = queuedTask(); let now = 0;
  const gate = new ProviderAdmissionStore(':memory:', () => now);
  for(let i=0;i<3;i++) gate.settle(gate.acquire('route',policy).permit!,{reason:'server'},policy);
  now = policy.initialCooldownMs;
  let ready!:()=>void, finish!:(outcome:WorkerOutcome)=>void;
  const scheduler = new WorkerScheduler(f.tasks,{start:async()=>({accepted:Promise.resolve(),
    providerReady:new Promise<void>(resolve=>{ready=resolve;}),result:new Promise<WorkerOutcome>(resolve=>{finish=resolve;}),stop:async()=>{finish({type:'stopped'});}})},undefined,new Map(),{
      acquire:()=>gate.acquire('route',policy),renew:p=>gate.renew(p,policy),release:p=>gate.release(p),settle:(p,r)=>{gate.settle(p,r,policy);},
    });
  try {
    await scheduler.tick(); await new Promise(setImmediate);
    expect(gate.inspect('route',policy)?.nextRetryAt).toBe(now+policy.probeLeaseMs);
    ready(); await new Promise(setImmediate);
    expect(f.store.task(f.task.taskId)?.state).toBe('running');
    expect(gate.inspect('route',policy)?.nextRetryAt).toBe(now+policy.recoverySpacingMs);
    now+=policy.recoverySpacingMs;
    expect(gate.acquire('route',policy).permit?.probe).toBeDefined();
  } finally {await scheduler.close();gate.close();f.store.close();}
});

test('admission storage exceptions release reserved process capacity before claim',async()=>{
  const f=queuedTask(),release=jest.fn(),start=jest.fn();
  const scheduler=new WorkerScheduler(f.tasks,{reserve:()=>release,start},undefined,new Map(),{
    acquire:()=>{throw new Error('fixture storage busy');},renew:()=>{},release:()=>{},settle:()=>{},
  });
  try {
    await expect(scheduler.tick()).rejects.toThrow('fixture storage busy');
    expect(release).toHaveBeenCalledTimes(1);expect(start).not.toHaveBeenCalled();
    expect(f.store.all('SELECT * FROM task_attempts')).toHaveLength(0);
  }finally{await scheduler.close();f.store.close();}
});

test('provider lease release failure cannot strand a completed task or its capacity',async()=>{
  const f=queuedTask(),release=jest.fn(),workspaceRelease=jest.fn(async()=>{}),report=jest.fn();
  const scheduler=new WorkerScheduler(f.tasks,{reserve:()=>release,release:workspaceRelease,start:async()=>({
    accepted:Promise.resolve(),result:Promise.resolve({type:'completed' as const,result:{summary:'Done',artifactIds:[]}}),stop:async()=>{},
  })},report,new Map(),{acquire:()=>({permit:{scope:'route',generation:0}}),renew:()=>{},release:()=>{throw new Error('fixture storage busy');},settle:()=>{}});
  try {
    await scheduler.tick();await new Promise(setImmediate);
    expect(f.store.task(f.task.taskId)?.state).toBe('completed');
    expect(release).toHaveBeenCalledTimes(1);expect(workspaceRelease).toHaveBeenCalledTimes(1);
    expect((scheduler as any).active.size).toBe(0);expect((scheduler as any).starting.size).toBe(0);
    expect(report).toHaveBeenCalled();
  }finally{await scheduler.close();f.store.close();}
});

