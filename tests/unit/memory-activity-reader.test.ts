import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readMemoryActivity,activitySummary } from '../../src/api/memory-activity';
test('combines memory proposals with compaction audit without losing acceptance indexes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'memory-activity-')),workspace=join(root,'custom-workspace'),dir=join(workspace,'.dreaming');mkdirSync(dir,{recursive:true});
 try{
 const ts=Date.parse('2026-09-17T03:00:00Z');
 writeFileSync(join(dir,'DREAMS.md'),'## 2026-09-17T03:00:00.000Z — proposed (propose)\n\nKeep durable knowledge\n\n_tokens: 20, sessions: 1_\n');
 writeFileSync(join(dir,'promotions.jsonl'),[0,1].map(index=>JSON.stringify({ts,op:'add',file:'MEMORY.md',content:'<script>'+index,reason:'remember'})).join('\n'));
 writeFileSync(join(dir,'accepted.jsonl'),JSON.stringify({ts,index:0}));
 const data=await readMemoryActivity(new Map([['agent',{workspacePath:workspace,sessionCompactionReport:async()=>({runs:[{id:'compact',startedAt:ts+1,status:'completed',items:[]}],schedule:{enabled:true}})}]]),root);
 expect(data.runs.map(r=>r.kind)).toEqual(['session_compaction','memory_dream']);
 const dream=data.runs[1];expect(dream.pendingProposals).toBe(1);expect(dream.proposals[1].index).toBe(1);expect(dream.proposals[1].content).toBe('<script>1');expect(activitySummary(dream).proposals).toBeUndefined();
 expect(data.unavailable).toEqual([]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('missing audit and optional runner method give an empty report',async()=>{
 const data=await readMemoryActivity(new Map([['agent',{}]]),join(tmpdir(),'no-memory-audit-here'));expect(data.runs).toEqual([]);expect(data.agents).toEqual(['agent']);expect(data.unavailable).toEqual([]);
});
