import { AgentRunner } from '../../../src/agent/runner';
import { TurnStreamRegistry, callbackSink, turnStreamKey } from '../../../src/agent/turn-stream';
import { responseFailureMessage } from '../../../src/orchestration/response-errors';

test.each([
  [new Error('Private prompt contents from an internal failure'), 'GATEWAY_INTERNAL_ERROR'],
  [Object.assign(new Error('raw diagnostic'), {code:'INFERENCE_FAILED',providerMessage:'API Error: 400 Provider policy changed'}), 'Provider policy changed'],
])('managed API live/replay callbacks retain only public error text', async (failure, expected) => {
  const streams=new TurnStreamRegistry();
  const runner=Object.assign(Object.create(AgentRunner.prototype), {
    orchestrationForApi:()=>true, pendingApiSessions:new Set(), turnStreams:streams,
    sendOrchestratedApi:async()=>{throw failure;},
  }) as AgentRunner;
  try {
    const error=await new Promise<Error>((resolve,reject)=>{
      void runner.sendApiMessageStream('session','chat','hi',{onChunk:()=>{},onDone:()=>reject(new Error('unexpected success')),onError:resolve},{timeoutMs:1000}).catch(reject);
    });
    expect(responseFailureMessage(error,true)).toContain(expected);
    expect(responseFailureMessage(error,true)).not.toContain('Private prompt');
    const replay=jest.fn();
    streams.get(turnStreamKey('api','session'))!.attach(callbackSink({onChunk:()=>{},onDone:()=>{},onError:replay}),0);
    expect(responseFailureMessage(replay.mock.calls[0][0],true)).toBe(responseFailureMessage(error,true));
  } finally { streams.clear(); }
});
