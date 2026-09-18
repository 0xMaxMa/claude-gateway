import { MutationAttempt, retryableMutation, unresolvedMutations } from '../../../src/orchestration/mutation-recovery';
const failed: MutationAttempt = {actionId:'first',tool:'task_spawn',args:{title:'Merge approved PR',continue_task_id:'previous-task',instructions:'Verify and merge',target_profile:'default-worker',skill_name:'fixture'},committed:false,errorCode:'INVALID_INPUT'};
const retry: MutationAttempt = {actionId:'second',tool:'task_spawn',args:{title:'Merge approved PR',continue_task_id:'previous-task',instructions:'Verify checks then squash merge',target_profile:'default-worker'},committed:true};
test('a corrected continuation clears its earlier validation failure only',()=>{
 expect(unresolvedMutations([failed,retry])).toBe(true);
 expect(unresolvedMutations([failed,{...retry,args:{...retry.args,retry_of:failed.actionId}}])).toBe(false);
 expect(unresolvedMutations([failed,{...retry,args:{...retry.args,continue_task_id:'different-task'}}])).toBe(true);
 expect(unresolvedMutations([failed,{...retry,args:{...retry.args,title:'Other work'}}])).toBe(true);
});
test('new work requires an identical brief; success before failure is not recovery',()=>{
 const first={...failed,args:{title:'Check',instructions:'First brief'}};
 expect(unresolvedMutations([first,{...retry,args:{title:'Check',instructions:'Other brief'}}])).toBe(true);
 expect(unresolvedMutations([first,{...retry,args:first.args}])).toBe(false);
 expect(unresolvedMutations([retry,failed])).toBe(true);
});
test.each([{title:'',instructions:'Inspect'}, {title:'Inspect',instructions:''}, {}])('explicit retries recover invalid assignment fields: %j',args=>{
 const rejected={...failed,args};
 const corrected={...retry,args:{title:'Inspect',instructions:'Inspect the requested item',retry_of:failed.actionId}};
 expect(unresolvedMutations([rejected,corrected])).toBe(false);
 expect(unresolvedMutations([rejected,{...corrected,args:{...corrected.args,retry_of:undefined}}])).toBe(true);
 expect(unresolvedMutations([rejected,{...corrected,args:{...corrected.args,retry_of:'other'}}])).toBe(true);
 expect(unresolvedMutations([rejected,{...corrected,committed:false}])).toBe(true);
});
test.each(['ACCESS_DENIED','ACTION_CONFLICT',undefined])('never clears unknown or authorization/replay errors: %s',errorCode=>{
 expect(unresolvedMutations([{...failed,errorCode},retry])).toBe(true);
});
test('partial failures, same-action conflicts and non-spawn failures stay visible',()=>{
 expect(unresolvedMutations([failed,retry,{...failed,actionId:'third',args:{title:'Other',instructions:'Other'}}])).toBe(true);
 expect(unresolvedMutations([failed,{...retry,actionId:failed.actionId}])).toBe(true);
 expect(unresolvedMutations([{...failed,tool:'task_update'},retry])).toBe(true);
 expect(unresolvedMutations([failed,{...retry,committed:false}])).toBe(true);
});

 test('explicit retry references cannot resolve another action or an unsafe failure',()=>{
  expect(unresolvedMutations([failed,{...retry,args:{...retry.args,retry_of:'unknown'}}])).toBe(true);
  expect(unresolvedMutations([{...failed,errorCode:'ACCESS_DENIED'},{...retry,args:{...retry.args,retry_of:failed.actionId}}])).toBe(true);
 });
test('a corrected update revision resolves only the same task and instruction',()=>{
 const first:MutationAttempt={actionId:'update-1',tool:'task_update',args:{task_id:'task-a',instruction:'Inspect again',mode:'when_ready',expected_revision:1},committed:false,errorCode:'REVISION_CONFLICT'};
 const next:MutationAttempt={...first,actionId:'update-2',committed:true,args:{...first.args,expected_revision:2}};
 expect(retryableMutation(first.tool,first.errorCode)).toBe(true);
 expect(unresolvedMutations([first,next])).toBe(false);
 expect(unresolvedMutations([first,{...next,args:{...next.args,instruction:'Unrelated'}}])).toBe(true);
 expect(unresolvedMutations([first,{...next,args:{...next.args,instruction:'Corrected brief',retry_of:first.actionId}}])).toBe(false);
 expect(unresolvedMutations([first,{...next,args:{...next.args,task_id:'task-b',retry_of:first.actionId}}])).toBe(true);
 expect(unresolvedMutations([{...first,errorCode:'ACCESS_DENIED'},next])).toBe(true);
 expect(unresolvedMutations([first,{...next,committed:false}])).toBe(true);
});

const wrongSpawn: MutationAttempt = {
 actionId: 'wrong-spawn', tool: 'task_spawn',
 args: {continue_task_id: 'task-a', instructions: 'Revise the existing assignment'},
 intendedUpdateTaskId: 'task-a', errorCode: 'INTAKE_TASK_MISMATCH', committed: false,
};
const correctedUpdate: MutationAttempt = {
 actionId: 'correct-update', tool: 'task_update', committed: true,
 args: {task_id: 'task-a', instruction: 'Complete revised assignment', mode: 'when_ready'},
};
test('a committed update recovers a continuation mistakenly spawned during update intake', () => {
 expect(unresolvedMutations([wrongSpawn, correctedUpdate])).toBe(false);
});
test('cross-tool recovery requires the captured intake target and matching predecessor', () => {
 for (const first of [
  {...wrongSpawn, intendedUpdateTaskId: undefined},
  {...wrongSpawn, intendedUpdateTaskId: 'task-b'},
  {...wrongSpawn, args: {}},
  {...wrongSpawn, args: {continue_task_id: 'task-b'}},
  {...wrongSpawn, errorCode: 'ACCESS_DENIED'},
  {...wrongSpawn, errorCode: 'INVALID_INPUT'},
 ]) expect(unresolvedMutations([first, correctedUpdate])).toBe(true);
});
test('failed, earlier, unrelated or same-action updates cannot recover a rejected spawn', () => {
 expect(unresolvedMutations([correctedUpdate, wrongSpawn])).toBe(true);
 for (const next of [
  {...correctedUpdate, committed: false},
  {...correctedUpdate, actionId: wrongSpawn.actionId},
  {...correctedUpdate, tool: 'task_answer'},
  {...correctedUpdate, args: {...correctedUpdate.args, task_id: 'task-b'}},
 ]) expect(unresolvedMutations([wrongSpawn, next])).toBe(true);
 expect(unresolvedMutations([wrongSpawn, correctedUpdate, failed])).toBe(true);
});
