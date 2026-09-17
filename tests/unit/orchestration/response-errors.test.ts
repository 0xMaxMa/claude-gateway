import { responseFailureMessage } from '../../../src/orchestration/response-errors';
import { OrchestrationError } from '../../../src/orchestration/types';
import { EventEmitter } from 'events';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import type { SessionProcess } from '../../../src/session/process';

test.each(['PROCESS_EXITED','PROCESS_START_FAILED','CLAUDE_BINARY_NOT_FOUND','PROCESS_PERMISSION_DENIED','RESPONSE_TOO_LARGE','RESPONSE_PERSISTENCE_FAILED','CAPACITY_EXCEEDED','CONFLICT','ORCHESTRATION_CLOSING','PROFILE_INVENTORY_MISMATCH','ENOSPC','EACCES','SQLITE_BUSY'])('%s remains actionable without disclosing internals', code => {
 const text=responseFailureMessage(Object.assign(new Error('private /srv/workspace/secret sk-secret-value'),{code}));
 expect(text).toContain(code);
 expect(text).not.toMatch(/private|sk-secret|response could not be completed/);
});
test.each(['startup','first_response','idle','total'])('timeout retains %s phase across surfaces', phase=>{
 expect(responseFailureMessage(Object.assign(new OrchestrationError('TIMEOUT'),{timeout:{phase}}))).toContain(phase==='startup'?'starting':phase==='first_response'?'begin responding':phase==='idle'?'progress':'time limit');
});
test('new internal codes remain visible, arbitrary error messages do not',()=>{
 expect(responseFailureMessage(new OrchestrationError('FUTURE_INTERNAL_CODE','sk-secret'))).toContain('FUTURE_INTERNAL_CODE');
 expect(responseFailureMessage(new Error('private sk-secret'))).toContain('GATEWAY_INTERNAL_ERROR');
 expect(responseFailureMessage(new Error('private sk-secret'))).not.toContain('sk-secret');
});
test('legacy command errors retain their safe text only on legacy callbacks',()=>{
 expect(responseFailureMessage(new Error('Not enough messages'),true)).toBe('Not enough messages');
 expect(responseFailureMessage(new Error('Bearer private-token'),true)).not.toContain('private-token');
});
test('subprocess spawn failure rejects immediately and removes startup listeners',async()=>{
 const p=new EventEmitter() as SessionProcess;
 Object.assign(p,{start:async()=>{p.emit('startup-error',Object.assign(new Error('missing'),{code:'CLAUDE_BINARY_NOT_FOUND'}));},stop:jest.fn(async()=>{}),sendMessage:jest.fn()});
 const turn=startProcessTurn(p,'hello',60000);
 await expect(turn.result).rejects.toMatchObject({code:'CLAUDE_BINARY_NOT_FOUND'});
 await expect(turn.accepted).rejects.toMatchObject({code:'CLAUDE_BINARY_NOT_FOUND'});
 expect(p.sendMessage).not.toHaveBeenCalled();
 expect(p.listenerCount('startup-error')).toBe(0);
});

test.each([['error_max_turns','MODEL_MAX_TURNS'],['error_max_budget_usd','MODEL_BUDGET_EXCEEDED'],['error_max_structured_output_retries','MODEL_OUTPUT_INVALID']])('CLI terminal subtype %s remains actionable',async(subtype,code)=>{
 const p=new EventEmitter() as SessionProcess;
 Object.assign(p,{start:async()=>{},stop:jest.fn(async()=>{}),sendMessage:()=>p.emit('output',JSON.stringify({type:'result',is_error:true,subtype,errors:['private details']}))});
 const failure=await startProcessTurn(p,'hi',1000).result.catch(error=>error);
 expect(failure.code).toBe(code);expect(responseFailureMessage(failure)).toContain(code);
});
