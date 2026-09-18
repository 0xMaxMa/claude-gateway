import { MutationAttempt, unresolvedMutations } from '../../../src/orchestration/mutation-recovery';
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
