import {evaluateComputerChoices} from '../../../src/automation/computer-choice-ids';
const request={requestId:'correlation',state:{goal:'Multiply the current result'},questions:{action:{type:'choice' as const,instructions:'Choose the next action',criteria:{'open:com.apple.calculator':'Open Calculator','press:c7':'Press Multiply',WAIT:'Wait'}},completion:{type:'choice' as const,instructions:'Is the goal satisfied?',criteria:{SATISFIED:'Yes',REQUIRED_STEP:'No'}}}};
const answer=(choice:string,probabilities:Record<string,number>)=>({type:'choice',choice,confidence:.95,probabilities});
const response=()=>({answers:{action:answer('1',{'0':.01,'1':.98,'2':.01}),completion:answer('1',{'0':.01,'1':.99})}});
test('only choice IDs change on the wire; each question decodes to its own original IDs',async()=>{
 const before=structuredClone(request);
 const evaluate=jest.fn(async wire=>{
  expect(wire.state).toBe(request.state);expect(wire.requestId).toBe(request.requestId);
  expect(wire.questions.action.criteria).toEqual({'0':'Open Calculator','1':'Press Multiply','2':'Wait'});
  expect(wire.questions.completion.criteria).toEqual({'0':'Yes','1':'No'});
  return response();
 });
 const result=await evaluateComputerChoices(request,evaluate);
 expect(result.answers.action).toEqual(answer('press:c7',{'open:com.apple.calculator':.01,'press:c7':.98,WAIT:.01}));
 expect(result.answers.completion).toEqual(answer('REQUIRED_STEP',{SATISFIED:.01,REQUIRED_STEP:.99}));
 expect(request).toEqual(before);expect(evaluate).toHaveBeenCalledTimes(1);
});
test.each(['internal-id','leading-zero','missing-probability','extra-question','missing-question'])('rejects a malformed provider answer: %s',async mode=>{
 const value:any=response();
 if(mode==='internal-id')value.answers.action.choice='press:c7';
 if(mode==='leading-zero')value.answers.action.choice='01';
 if(mode==='missing-probability')delete value.answers.action.probabilities['2'];
 if(mode==='extra-question')value.answers.injected=value.answers.action;
 if(mode==='missing-question')delete value.answers.completion;
 await expect(evaluateComputerChoices(request,async()=>value)).rejects.toThrow('INVALID_DECISION');
});
test('provider failures are not retried or replaced by a fabricated decision',async()=>{
 const error=Error('PROVIDER_UNAVAILABLE'),evaluate=jest.fn(async()=>{throw error;});
 await expect(evaluateComputerChoices(request,evaluate)).rejects.toBe(error);expect(evaluate).toHaveBeenCalledTimes(1);
});
