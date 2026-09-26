import {computerContinuationContext} from '../../../src/orchestration/gateway-tasks/computer-context';
test('continuation carries target and completed key without replayable refs or private values',()=>{
 const note=computerContinuationContext({observedAt:123,state:{application:'Chrome',windowTitle:'Facebook',focusedControl:{ref:'stale-ref',label:'Address',role:'AXTextField',value:'private value'},text:['private page']}},[{phase:'acting',action:'type'},{phase:'acted',action:'key',key:'enter',outcome:'completed'}]);
 expect(note).toContain('Facebook');expect(note).toContain('enter');
 expect(note).not.toContain('stale-ref');expect(note).not.toContain('private');expect(note).not.toContain('"action":"type"');
});
test('sensitive focus is omitted and absent context stays absent',()=>{
 expect(computerContinuationContext(undefined)).toBe('');
 expect(computerContinuationContext({observedAt:1,state:{focusedControl:{sensitive:true,label:'secret'}}})).not.toContain('secret');
});
