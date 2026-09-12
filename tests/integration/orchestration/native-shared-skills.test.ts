import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {SessionProcess} from '../../../src/session/process';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {DecisionService} from '../../../src/orchestration/decisions';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {TaskBridge} from '../../../src/orchestration/bridge';
import {TaskWorkspaces} from '../../../src/orchestration/tasks/workspace';
import {ClaudeWorkerDriver} from '../../../src/orchestration/tasks/driver';
import * as discovery from '../../../src/orchestration/cli-skills';
import {AgentConfig,GatewayConfig} from '../../../src/types';
import {loadSkills} from '../../../src/skills/loader';
import {resolveSkill} from '../../../src/orchestration/skills';

test.each(['native','shared'] as const)('%s skill traverses admission and worker invocation with correct provenance',async kind=>{
 const root=mkdtempSync(join(tmpdir(),'skill-execution-')),workspace=join(root,'workspace'),shared=join(root,'shared');
 mkdirSync(workspace);writeFileSync(join(workspace,'CLAUDE.md'),'Fixture identity');
 mkdirSync(join(shared,'shared-review'),{recursive:true});writeFileSync(join(shared,'shared-review','SKILL.md'),'---\nname: shared-review\ndescription: Fixture review\n---\nRead resource.txt and report.');writeFileSync(join(shared,'shared-review','resource.txt'),'SHARED_RESOURCE');
 const registry=loadSkills({workspaceDir:workspace,sharedSkillsDir:shared});registry.cliSkills=[{name:'code-review',description:'Native review',aliases:['review']}];
 const skill=resolveSkill(kind==='native'?'/code-review low':'/shared-review fixture','api',registry)!;
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),bridge=new TaskBridge(tasks);
 const agent={id:'a',workspace,description:'fixture',env:'',claude:{model:'fixture',extraFlags:[]},orchestration:{tasks:{workspaceMode:'host'}}} as AgentConfig;
 const gateway={gateway:{headless:true,timezone:'UTC',logDir:join(root,'logs')},agents:[agent]} as GatewayConfig;
 const name=kind==='native'?'code-review':'orchestration-task:shared-review';
 const probe=jest.spyOn(discovery,'discoverCliSkills').mockResolvedValue(registry.cliSkills);
 jest.spyOn(SessionProcess.prototype,'start').mockImplementation(async()=>{});
 jest.spyOn(SessionProcess.prototype,'sendMessage').mockImplementation(function(this:SessionProcess,prompt:string){
  expect(prompt).toContain(`CLI skill name is ${name}`);
  this.emit('output',JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'skill-call',name:'Skill',input:{skill:name,args:'low'}}]}}));
  this.emit('output',JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'skill-call',content:'Skill loaded'}]}}));
  this.emit('output',JSON.stringify({type:'result',result:'SKILL_DONE'}));
 });
 jest.spyOn(SessionProcess.prototype,'stop').mockImplementation(async function(this:SessionProcess){this.managedGroupStopped=true;});
 try{
  await bridge.start();const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',principalId:'u',chatId:'s',threadKey:''},text:'Review'});
  const decision=new DecisionService(store).begin(input.conversationId,'u',[input.inputId]);
  const task=tasks.spawn({...input,...decision,principalId:'u',actionId:'spawn',execute:true,writeMemory:false},{title:'Review',instructions:'Invoke the requested skill',targetProfile:'skill-worker',skill});
  const attempt=tasks.claim(task.taskId)!;
  const driver=new ClaudeWorkerDriver(agent,gateway,tasks,bridge,new TaskWorkspaces(store,workspace,join(root,'resources')),join(root,'private'));
  const handle=await driver.start(store.task(task.taskId)!,attempt,true);await handle.accepted;
  expect(await handle.result).toMatchObject({type:'completed',result:{summary:'SKILL_DONE'}});
  expect(store.get("SELECT COUNT(*) n FROM conversation_events WHERE type='task.skill_invoked'")?.n).toBe(1);
  const plugin=join(root,'private',attempt.attemptId,'skill-plugin');
  if(kind==='native'){expect(probe).toHaveBeenCalledWith(agent,workspace);expect(existsSync(plugin)).toBe(false);}
  else{expect(probe).not.toHaveBeenCalled();expect(readFileSync(join(plugin,'skills','shared-review','resource.txt'),'utf8')).toBe('SHARED_RESOURCE');}
 }finally{jest.restoreAllMocks();await bridge.close();store.close();rmSync(root,{recursive:true,force:true});}
});
