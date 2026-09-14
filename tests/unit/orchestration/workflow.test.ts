import {parseWorkflow,advanceWorkflow,WorkflowCheckpoint} from '../../../src/orchestration/workflow';
const checkpoint:WorkflowCheckpoint={phase:'review',evidenceVersion:'v1',nextAction:'Resolve F1',checks:[{id:'behavior',outcome:'passed',evidenceVersion:'v1'}],findings:[{id:'F1',status:'open',summary:'Wrong entry path'}],review:{id:'r1',kind:'full'}};
test('versioned checkpoints preserve findings and flag an unexplained full-review restart',()=>{
 const first=advanceWorkflow(undefined,checkpoint,'a');
 expect(advanceWorkflow(first,checkpoint,'a')).toBe(first);
 const next=advanceWorkflow(first,{...checkpoint,evidenceVersion:'v2',review:{id:'r2',kind:'full'}},'a');
 expect(next.version).toBe(2);expect(next.warning).toContain('Verify');
 expect(next.checkpoint.findings[0].id).toBe('F1');
 const targeted=advanceWorkflow(next,{...checkpoint,evidenceVersion:'v2',review:{id:'r3',kind:'targeted'}},'a');
 expect(targeted.warning).toBeUndefined();
 const requested=advanceWorkflow(targeted,{...checkpoint,review:{id:'r4',kind:'full',reason:'User explicitly requested a new independent review'}},'a');
 expect(requested.warning).toBeUndefined();
});
test('checkpoint input is bounded, optional for legacy workers, and cannot add authority',()=>{
 expect(parseWorkflow(undefined)).toBeUndefined();expect(parseWorkflow(checkpoint)).toEqual(checkpoint);
 for(const bad of [{...checkpoint,execute:true},{...checkpoint,checks:Array(31).fill(checkpoint.checks[0])},{...checkpoint,phase:'x'.repeat(1025)},{...checkpoint,findings:[{id:'f',status:'whatever',summary:'x'}]}])
  expect(()=>parseWorkflow(bad)).toThrow('INVALID_WORKFLOW_CHECKPOINT');
});
