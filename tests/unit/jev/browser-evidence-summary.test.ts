import {summarizeBrowserEvidence} from '../../../src/jev/browser-evidence-summary';
test('large evidence keeps proof IDs and bounded useful values without raw trace duplication',()=>{
 const evidence:any={requestId:'request',evidenceId:'proof',executionState:'ended',recordedAt:1,trace:{events:Array.from({length:1000},()=>({phase:'effect'}))},fresh:{observedAt:2,observation:{url:'https://example.test',text:'x'.repeat(24000),elements:Array.from({length:150},(_,i)=>({ref:String(i),label:'Name',value:'expected',context:'y'.repeat(800)}))}}};
 const result=summarizeBrowserEvidence(evidence);
 expect(result.evidenceId).toBe('proof');expect(result.requestId).toBe('request');expect(result.page?.elements[0].value).toBe('expected');expect(result.page?.elements).toHaveLength(25);expect(result.trace?.events).toHaveLength(8);expect(JSON.stringify(result).length).toBeLessThan(15000);
});
