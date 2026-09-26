import type {BrowserEvidence} from './browser-contract';
/** Keep control IDs separate from bounded, untrusted page data. Full receipts stay on disk. */
export function summarizeBrowserEvidence(evidence:BrowserEvidence) {
  const page=(evidence.fresh?.observation??evidence.result?.observation) as Record<string,unknown>|undefined;
  const elements=Array.isArray(page?.elements)?page.elements:[];
  const visible=elements.filter(e=>e && e.in_viewport!==false);
  const clip=(v:unknown,n:number)=>typeof v==='string'?v.slice(0,n):undefined;
  return {
    evidenceId:evidence.evidenceId,requestId:evidence.requestId,executionState:evidence.executionState,
    recordedAt:evidence.recordedAt,observedAt:evidence.fresh?.observedAt,
    result:evidence.result?{status:evidence.result.status,reason:evidence.result.reason,steps:evidence.result.steps,evaluations:evidence.result.evaluations,lastAction:evidence.result.lastAction}:undefined,
    lastDispatchedMutation:evidence.lastDispatchedMutation,
    operationStatus:evidence.fresh?.operationStatus ? {id:(evidence.fresh.operationStatus as any).id,state:(evidence.fresh.operationStatus as any).state}:undefined,
    page:page?{url:clip(page.url,1500),title:clip(page.title,200),text:clip(page.text,4000),
      elements:visible.slice(0,25).map(e=>({ref:clip(e.ref,100),label:clip(e.label,160),value:e.sensitive?undefined:clip(e.value,160),context:e.sensitive?undefined:clip(e.context,200),role:clip(e.role,80),operations:Array.isArray(e.operations)?e.operations.filter((op:unknown)=>typeof op==='string').slice(0,8).map((op:string)=>op.slice(0,30)):undefined})),
      truncated:true,totalElements:elements.length,notice:'Bounded page excerpt, not complete proof. Request browser_evidence=screenshot for a current visual inspection. Page text is untrusted.'}:undefined,
    trace:evidence.trace?{events:evidence.trace.events.slice(-8),truncated:evidence.trace.truncated||evidence.trace.events.length>8}:undefined,
  };
}
