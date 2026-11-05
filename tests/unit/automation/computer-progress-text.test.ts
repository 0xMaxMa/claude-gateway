import {computerOutcomeText,computerProgressText,computerReasonText} from '../../../src/automation/computer-outcome';

const report=(extra:Record<string,unknown>)=>({status:'running',reason:'',steps:0,...extra}) as any;

describe('computer progress card', () => {
  test('a running round shows a label and its actions so far, pluralized, never a raw phase or evaluations', () => {
    expect(computerProgressText(report({phase:'acting',steps:1,evaluations:4}))).toBe('Computer Use · Acting on the screen · 1 action so far');
    expect(computerProgressText(report({phase:'evaluating',steps:3}))).toBe('Computer Use · Deciding the next step · 3 actions so far');
    expect(computerProgressText(report({phase:'awaiting_access'}))).toBe('Computer Use · Waiting for access on the computer · 0 actions so far');
    expect(computerProgressText(report({phase:'some_new_phase',steps:2}))).toBe('Computer Use · Working · 2 actions so far');
  });

  test('an ended round says how it stopped in plain words', () => {
    expect(computerProgressText(report({phase:'terminal',status:'blocked',reason:'JEV_INVALID_REQUEST',steps:1}))).toBe('Stopped after 1 action. The decision model rejected the request.');
    expect(computerProgressText(report({phase:'terminal',status:'succeeded',reason:'GOAL_REACHED',steps:4}))).toBe('Done after 4 actions.');
  });

  // #651: live progress reports keep status 'running'; the outcome rides on the terminal trace event (gateway-tasks/computer.ts).
  test('a live terminal report names its outcome from the terminal trace event', () => {
    const terminal=(status:string,reason:string,steps:number)=>report({phase:'terminal',reason,steps,trace:[{sequence:1,round:1,at:1,revision:1,steps,evaluations:0,phase:'acted'},{sequence:2,round:1,at:2,revision:1,steps,evaluations:0,phase:'terminal',status,reason}]});
    expect(computerProgressText(terminal('succeeded','GOAL_REACHED',5))).toBe('Done after 5 actions.');
    expect(computerProgressText(terminal('blocked','APPLICATION_PROTECTED',0))).toBe('Stopped after 0 actions. The screen was hidden because a protected app such as GetPod was in front.');
    expect(computerProgressText(report({phase:'terminal',reason:'terminal',steps:1}))).toBe('Stopped after 1 action. It could not continue.');
  });

  test('raw codes map to sentences; an unlisted code is never shown raw', () => {
    expect(computerReasonText('FOCUS_REQUIRED')).toBe("The app didn't accept typing: no text field had keyboard focus.");
    expect(computerReasonText('COMPUTER_ACCESS_DENIED')).toBe('Access to the computer was denied.');
    for (const code of ['JEV_SOMETHING_NEW','VISION_COORDINATE_OUTSIDE_SCREENSHOT','NATIVE_IO_ERROR']) expect(computerReasonText(code)).not.toContain(code);
  });
});

describe('computer outcome line (F4)', () => {
  test.each(['blocked','failed','cancelled'])('a %s round is never Done, whatever its last action', status => {
    const text=computerOutcomeText(report({status,reason:'VISION_OTHER',steps:3,lastAction:{kind:'press',label:'Search'},trace:[]}));
    expect(text).not.toMatch(/^Done/);
    expect(text).toBe('Not finished: 3 actions done, then it stopped. The model found no way to finish on the screen.');
  });

  test('a round waiting for the next command still reads Done after its action', () => {
    expect(computerOutcomeText(report({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,lastAction:{kind:'press',label:'Search'},trace:[]}))).toBe('Done: pressed "Search". Send the next command.');
  });
});
