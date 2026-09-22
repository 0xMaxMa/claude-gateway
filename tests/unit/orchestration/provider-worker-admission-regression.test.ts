import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { WorkerScheduler } from '../../../src/orchestration/tasks/scheduler';
import { ProviderAdmissionStore, PROVIDER_ADMISSION_DEFAULTS as policy } from '../../../src/orchestration/provider-admission';

test('provider cooldown withholds queued workers before claim without starving independent routes', async () => {
  const store = new OrchestrationStore(':memory:', 'agent');
  const gate = new ProviderAdmissionStore(':memory:');
  const tasks = new TaskService(store), decisions = new DecisionService(store);
  const created: string[] = [];
  for (const session of ['down', 'healthy']) {
    const input = store.acceptInput({scope:{agentId:'agent',agentSessionId:session,source:'api',accountId:'owner',chatId:session,threadKey:'',principalId:'owner'},text:'Work'});
    const decision = decisions.begin(input.conversationId,'owner',[input.inputId]);
    const task = tasks.spawn({...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:session}, {title:'Work',instructions:'Work',targetProfile:'default-worker'});
    created.push(task.taskId); decisions.finish(decision,'Queued');
  }
  for (let i=0;i<3;i++) gate.settle(gate.acquire('down',policy).permit!,{reason:'server'},policy);
  const started: string[] = [];
  const commands = store.all('SELECT * FROM task_commands');
  // Keep this constructor call compatible with pre-fix code for the behavioral
  // regression proof: the old scheduler ignores the fifth argument and starts both.
  const scheduler: WorkerScheduler = new (WorkerScheduler as any)(tasks, {
    start:async (task: {taskId:string}) => {
      started.push(task.taskId);
      let finish!: (value: {type:'stopped'})=>void;
      return {accepted:Promise.resolve(),result:new Promise(resolve=>{finish=resolve;}),stop:async()=>{finish({type:'stopped'});}};
    },
  }, undefined, new Map(), {
    acquire:(task:{agentSessionId:string})=>gate.acquire(task.agentSessionId,policy),
    renew:(permit:any)=>gate.renew(permit,policy),
    settle:(permit:any,result:any)=>gate.settle(permit,result,policy),
    release:(permit:any)=>gate.release(permit),
  });
  try {
    await scheduler.tick();
    expect(started).toEqual([created[1]]);
    expect(store.task(created[0])).toMatchObject({state:'queued',revision:1});
    expect(store.all('SELECT * FROM task_attempts WHERE task_id=?',created[0])).toHaveLength(0);
    expect(store.all('SELECT * FROM task_commands')).toEqual(commands);
  } finally {await scheduler.close();gate.close();store.close();}
});
