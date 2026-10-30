import {computerProgressLabel} from '../../../src/orchestration/computer-progress-label';
import type {ComputerTaskReport} from '../../../src/orchestration/types';

// Shaped as gateway-tasks/computer.ts reports progress: status stays 'running' and the outcome rides on the
// terminal trace event, with its reason copied to the report.
const terminal=(status:string,reason:string,steps:number,evaluations:number):ComputerTaskReport=>({status:'running',reason,steps,evaluations,phase:'terminal',
 trace:[{sequence:1,round:1,at:1,revision:1,steps,evaluations,phase:'acted'},{sequence:2,round:1,at:2,revision:1,steps,evaluations,phase:'terminal',status:status as any,reason}]});

test('a blocked goal names the outcome and reason instead of the terminal phase',()=>{
 expect(computerProgressLabel(terminal('blocked','APPLICATION_PROTECTED',0,0))).toBe('Computer Use: blocked · APPLICATION_PROTECTED · 0 actions.');
});

test('a successful goal reads done with its action and evaluation counts',()=>{
 expect(computerProgressLabel(terminal('succeeded','GOAL_COMPLETE',5,2))).toBe('Computer Use: done · 5 actions · 2 evaluations.');
});

test.each([
 ['needs_input','COMMAND_WAITING_INPUT','Computer Use: needs input · COMMAND_WAITING_INPUT · 3 actions.'],
 ['needs_verification','DONE_UNVERIFIED','Computer Use: needs verification · DONE_UNVERIFIED · 3 actions.'],
 ['cancelled','CANCELLED','Computer Use: cancelled · CANCELLED · 3 actions.'],
 ['needs_reconciliation','OUTCOME_UNKNOWN','Computer Use: needs reconciliation · OUTCOME_UNKNOWN · 3 actions.'],
])('terminal outcome %s is named',(status,reason,label)=>{
 expect(computerProgressLabel(terminal(status,reason,3,1))).toBe(label);
});

test('a report that already carries its outcome uses it',()=>{
 expect(computerProgressLabel({status:'blocked',reason:'COMPUTER_ACCESS_DENIED',steps:0,evaluations:0,phase:'terminal'})).toBe('Computer Use: blocked · COMPUTER_ACCESS_DENIED · 0 actions.');
});

test('a terminal report without a known outcome never shows the phase name',()=>{
 const label=computerProgressLabel({status:'running',reason:'terminal',steps:1,phase:'terminal'});
 expect(label).toBe('Computer Use: ended · 1 actions.');
 expect(label).not.toContain('terminal');
});

test('non-terminal phases keep the existing label',()=>{
 expect(computerProgressLabel({status:'running',reason:'acting',steps:2,evaluations:1,phase:'acting'})).toBe('Computer Use: acting · 2 actions · 1 evaluations.');
 expect(computerProgressLabel({status:'waiting_access',reason:'OWNER_APPROVAL_REQUIRED',steps:0,evaluations:0,phase:'awaiting_access'})).toBe('Computer Use: awaiting_access · 0 actions · 0 evaluations.');
});
