import { OrchestrationError } from './types';

export interface WorkflowCheckpoint {
  phase: string;
  evidenceVersion: string;
  nextAction: string;
  checks: Array<{ id: string; outcome: string; evidenceVersion: string }>;
  findings: Array<{ id: string; status: 'open' | 'resolved' | 'dismissed'; summary: string }>;
  review?: { id: string; kind: 'full' | 'targeted'; reason?: string };
}
export interface TaskWorkflow {
  version: number; observedAt: number; attemptId: string;
  checkpoint: WorkflowCheckpoint;
  reviews: Array<{ id: string; evidenceVersion: string; kind: string }>;
  warning?: string;
}
const text = {type:'string',maxLength:1024};
export const WORKFLOW_SCHEMA = {
  type:'object',additionalProperties:false,
  properties:{
    phase:text,evidenceVersion:text,nextAction:text,
    checks:{type:'array',maxItems:30,items:{type:'object',additionalProperties:false,properties:{id:text,outcome:text,evidenceVersion:text},required:['id','outcome','evidenceVersion']}},
    findings:{type:'array',maxItems:30,items:{type:'object',additionalProperties:false,properties:{id:text,status:{type:'string',enum:['open','resolved','dismissed']},summary:text},required:['id','status','summary']}},
    review:{type:'object',additionalProperties:false,properties:{id:text,kind:{type:'string',enum:['full','targeted']},reason:text},required:['id','kind']},
  },required:['phase','evidenceVersion','nextAction','checks','findings'],
};
export function parseWorkflow(value: unknown): WorkflowCheckpoint | undefined {
  if(value===undefined)return undefined;
  const bad=()=>{throw new OrchestrationError('INVALID_WORKFLOW_CHECKPOINT');};
  const obj=(v:unknown,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))bad();return v as Record<string,unknown>;};
  const str=(v:unknown)=>{if(typeof v!=='string'||v.length>1024)bad();};
  const v=obj(value,['phase','evidenceVersion','nextAction','checks','findings','review']);
  for(const k of ['phase','evidenceVersion','nextAction'])str(v[k]);
  for(const key of ['checks','findings']){
    const items=v[key];if(!Array.isArray(items)||items.length>30)bad();
    for(const item of items as unknown[]){
      const fields=key==='checks'?['id','outcome','evidenceVersion']:['id','status','summary'];
      const row=obj(item,fields);for(const f of fields)str(row[f]);
      if(key==='findings'&&!['open','resolved','dismissed'].includes(String(row.status)))bad();
    }
  }
  if(v.review!==undefined){const r=obj(v.review,['id','kind','reason']);str(r.id);if(!['full','targeted'].includes(String(r.kind)))bad();if(r.reason!==undefined)str(r.reason);}
  if(JSON.stringify(v).length>16384)bad();
  return v as unknown as WorkflowCheckpoint;
}
export function advanceWorkflow(previous:TaskWorkflow|undefined,checkpoint:WorkflowCheckpoint,attemptId:string):TaskWorkflow {
  if(previous?.attemptId===attemptId&&JSON.stringify(previous.checkpoint)===JSON.stringify(checkpoint))return previous;
  const reviews=[...(previous?.reviews??[])],review=checkpoint.review;
  let warning:string|undefined;
  if(review&&!reviews.some(r=>r.id===review.id&&r.evidenceVersion===checkpoint.evidenceVersion)){
    if(review.kind==='full'&&reviews.some(r=>r.kind==='full')&&!review.reason?.trim())
      warning='A full review already exists. Verify the changed evidence and unresolved findings; do not restart the full workflow merely because a fix was applied. State the new risk or explicit user request if another full review is necessary.';
    reviews.push({id:review.id,kind:review.kind,evidenceVersion:checkpoint.evidenceVersion});
  }
  return {version:(previous?.version??0)+1,observedAt:Date.now(),attemptId,checkpoint,reviews:reviews.slice(-24),warning};
}
export const WORKER_WORKFLOW_RULES = `Work to a verifiable stopping condition, not repeated reassurance. Follow the requested skill's actual steps; do not add a second/native/full review merely because this is delegated work. Track completed verification against the evidence version (commit/tree/document revision), open findings by stable ID, and the next necessary action. Use task_report_progress with checkpoint at phase changes, after a review, after resolving findings, and before finalization; use ordinary text progress for short tasks. This is internal bookkeeping, not a request to message the user each time.
For a defect, trace the user's actual entry path and test the integration that fails before adding extra defensive layers. A missing helper/export is not proof of the original behavior regression. Check contradictory review findings against reachable code before changing anything. A completed full review is followed by fixes and targeted verification of affected behavior; another full review needs new substantial risk or an explicit user request, not just "one final check". Keep unresolved findings visible; do not suppress real defects to finish faster.
Choose checks appropriate to the work and machine capacity. Reuse successful checks only for unchanged relevant evidence. Batch related fixes and formatting before commit/push to avoid repeated full-suite hooks. Never bypass required checks, security boundaries or user approvals. Once required work and verification are complete, return the result with evidence and remaining limitations; optional polish or an advisory checkpoint must not restart completed phases. Advisory guidance is fallible: prefer newer direct evidence over stale claims that an earlier fix was already proven. These rules apply equally to native subagents you delegate to.`;
export const AGENT_WORKFLOW_RULES = `Preserve the user's requested workflow without adding review rounds or widening its scope. A requested skill owns its procedure; do not append a mandatory second/native review unless the user or the actual skill requires it. Supervise from the latest task_status checkpoint (phase, evidenceVersion, checks and findings), not old progress prose or tool names. Worker checkpoints are reports, not independently verified facts. If evidence is missing or superseded, ask for a fresh checkpoint rather than declaring an old fix correct or forbidding relevant investigation. Advice should name the changed evidence, unresolved finding or concrete next step; do not repeatedly say finish/open PR/run review when those steps are already complete. Do not mistake an idle tool sample for a stall or a browser command from an earlier phase for current work. Keep user updates separate from internal supervision.`;
