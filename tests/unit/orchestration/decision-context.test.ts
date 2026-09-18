import { committedCommandContext, communicatedProgressContext } from '../../../src/orchestration/decision-context';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { skillCatalog } from '../../../src/orchestration/skills';
import type { SkillRegistry } from '../../../src/skills/loader';

test('receipt context retains mutation evidence without repeating old task payloads or altering durable results', () => {
  const store = new OrchestrationStore(':memory:', 'a');
  try {
    const input = store.acceptInput({scope:{agentId:'a',agentSessionId:'chat',source:'api',accountId:'owner',principalId:'owner',chatId:'chat',threadKey:''},text:'authorized work'});
    const decision = new DecisionService(store).begin(input.conversationId, 'owner', [input.inputId]);
    const tasks = new TaskService(store);
    const task = tasks.spawn({...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn-1'}, {title:'work',instructions:'do work',targetProfile:'default-worker'});
    const result = {summary:'Complete business feedback_id=business-7 evidence: ' + 'full report '.repeat(2000),artifactIds:['file-1']};
    const raw = JSON.stringify({...task,result,latestProgress:{text:'old details '.repeat(300)},workflow:{evidence:'old evidence'},pendingQuestion:{questionId:'q1',text:'Approve?',revision:1}});
    store.run('UPDATE task_commands SET receipt_json=? WHERE action_id=?',raw,'spawn-1');
    const context = committedCommandContext(store,input.conversationId);
    expect(context[0]).toMatchObject({actionId:'spawn-1',decisionId:decision.decisionId,command:'spawn',receipt:{taskId:task.taskId,stateVersion:1,pendingQuestion:{questionId:'q1'},details:{tool:'task_status',task_id:task.taskId}}});
    expect(context[0].receipt.result).toBeUndefined();
    expect(context[0].receipt.latestProgress).toBeUndefined();
    expect(JSON.stringify(context).length).toBeLessThan(raw.length / 4);
    expect(store.get('SELECT receipt_json FROM task_commands WHERE action_id=?','spawn-1')!.receipt_json).toBe(raw);
    expect(JSON.parse(String(store.get('SELECT receipt_json FROM task_commands WHERE action_id=?','spawn-1')!.receipt_json)).result).toEqual(result);
  } finally { store.close(); }
});

test('old report excerpts are bounded without mutating full reports or system policy', () => {
  expect(communicatedProgressContext([])).toBe('');
  const messages=['Completed first phase','Evidence '+ 'unchanged '.repeat(2000)];
  expect(communicatedProgressContext(messages).length).toBeLessThan(6200);
  expect(communicatedProgressContext(messages)).toContain('middle omitted');
  expect(messages[1]).toHaveLength(('Evidence '+ 'unchanged '.repeat(2000)).length);
});

test('skill catalog ordering is stable across filesystem discovery order without mutating registries', () => {
  const a={userInvocable:true,description:'alpha'}, z={userInvocable:true,description:'zeta'};
  const first={skills:new Map([['z',z],['a',a]]),cliSkills:[{name:'z-native'},{name:'a-native'}]} as unknown as SkillRegistry;
  const second={skills:new Map([['a',a],['z',z]]),cliSkills:[{name:'a-native'},{name:'z-native'}]} as unknown as SkillRegistry;
  expect(skillCatalog(first)).toBe(skillCatalog(second));
  expect(first.cliSkills![0].name).toBe('z-native');
});
