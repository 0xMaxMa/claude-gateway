import {compactMeasurements,readCompactMeasurements,compactionTotals} from '../../../src/orchestration/compact-measurements';
import {mkdtempSync,writeFileSync,rmSync} from 'fs';
import {join} from 'path';import {tmpdir} from 'os';
test('accepts only native finite token metadata, not result prose',()=>{
 expect(compactMeasurements({type:'system',subtype:'compact_boundary',compactMetadata:{preTokens:600000,postTokens:4000}})).toEqual({beforeTokens:600000,afterTokens:4000});
 expect(compactMeasurements({type:'result',preTokens:600000,postTokens:4000})).toBeNull();
 expect(compactMeasurements({type:'system',subtype:'compact_boundary',compact_metadata:{pre_tokens:600000,post_tokens:-1}})).toEqual({beforeTokens:600000,afterTokens:null});
});
test('reads existing compact boundaries only inside the audited time interval',async()=>{
 const root=mkdtempSync(join(tmpdir(),'compact-metadata-')),file=join(root,'transcript.jsonl');
 const event=(at:number,postTokens:number)=>JSON.stringify({type:'system',subtype:'compact_boundary',timestamp:new Date(at).toISOString(),compactMetadata:{preTokens:600000,postTokens}});
 try{writeFileSync(file,'x'.repeat(1100000)+'\n'+event(1000,1)+'\n'+event(2000,4000)+'\n'+event(4000,2)+'\n');
 expect(await readCompactMeasurements(file,1500,3000)).toEqual({beforeTokens:600000,afterTokens:4000});
 expect(await readCompactMeasurements(file,5000,6000)).toBeNull();expect(await readCompactMeasurements(join(root,'missing'),0,9000)).toBeNull();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('totals exclude skipped sessions and do not fabricate unknown savings',()=>{
 const items:Array<{status:string;beforeTokens:number;afterTokens:number|null;contextWindow?:number}>=[{status:'completed',beforeTokens:600000,afterTokens:4000,contextWindow:1000000},{status:'skipped',beforeTokens:40000,afterTokens:null}];
 expect(compactionTotals(items)).toMatchObject({beforeTokens:600000,afterTokens:4000,contextWindow:1000000,measuredSessions:1,measuredReduction:596000});
 items.push({status:'completed',beforeTokens:300000,afterTokens:null,contextWindow:1000000});
 expect(compactionTotals(items)).toMatchObject({beforeTokens:900000,afterTokens:null,measuredSessions:1,measuredReduction:596000});
});
