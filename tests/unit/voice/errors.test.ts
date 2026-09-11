import { describeVoiceError, providerHttpError, providerVoiceError, voiceProviderRequest } from '../../../src/voice/errors';

test.each([[402,'payment',false],[401,'authentication',false],[403,'permission',false],[429,'quota_or_rate_limit',false],[503,'unavailable',true],[504,'timeout',true],[400,'invalid_request',false]])('classifies HTTP %s without guessing', (status, category, retryable) => {
  expect(describeVoiceError(providerVoiceError('STT', status as number))).toMatchObject({ category, retryable, httpStatus: status });
});
test('provider codes distinguish quota from rate limits and never expose response text', async () => {
  for (const [code,category,retryable] of [['insufficient_quota','quota',false],['rate_limit_exceeded','rate_limit',true]] as const) {
    const error = await providerHttpError('VOICE', new Response(JSON.stringify({error:{code,message:'secret API key sk-test'}}),{status:429}));
    expect(describeVoiceError(error)).toMatchObject({category,retryable});
    expect(JSON.stringify(describeVoiceError(error))).not.toContain('sk-test');
  }
});
test('unknown and oversized provider bodies preserve only HTTP status', async () => {
  for (const text of ['not json secret', 'x'.repeat(20000), JSON.stringify({error:{code:'unknown_secret_token'}})]) {
    expect(describeVoiceError(await providerHttpError('TTS',new Response(text,{status:402})))).toMatchObject({category:'payment',retryable:false});
  }
  expect(describeVoiceError('future secret message')).toMatchObject({category:'unknown',retryable:false});
  expect(describeVoiceError('future secret message').message).not.toContain('secret');
});
test('network, timeout and cancellation remain distinct',async()=>{
  const request = jest.fn(async()=>{throw Error('private url and credentials');}) as unknown as typeof fetch;
  await expect(voiceProviderRequest('https://provider.test',{},request)).rejects.toThrow('PROVIDER_CONNECTION_FAILED');
  const controller=new AbortController(); controller.abort(new DOMException('timeout','TimeoutError'));
  await expect(voiceProviderRequest('https://provider.test',{signal:controller.signal},request)).rejects.toThrow('PROVIDER_TIMEOUT');
});

test('prototype property names remain unknown provider codes', () => {
  for (const code of ['__proto__','constructor','toString']) expect(describeVoiceError(providerVoiceError('STT',402,{error:code}))).toMatchObject({category:'payment'});
});
test('WebSocket handshake billing failures keep their HTTP status', async () => {
  const {createServer} = await import('http');
  const {openProviderSocket} = await import('../../../src/voice/providers/socket');
  const server = createServer((_req,res)=>{res.writeHead(402);res.end('private details');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address() as {port:number};
    await expect(openProviderSocket(`ws://127.0.0.1:${address.port}`,{},AbortSignal.timeout(5000))).rejects.toThrow('VOICE_PROVIDER_ERROR_HTTP_402');
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

test('daily quota needs structured per-day evidence, not a generic RESOURCE_EXHAUSTED or retry delay', () => {
  const payload = (quotaId: string) => ({ error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '19s' }] } });
  expect(describeVoiceError(providerVoiceError('TTS', 429, payload('GenerateRequestsPerDayPerProjectPerModel-FreeTier')))).toMatchObject({ category: 'daily_quota', retryable: false });
  expect(describeVoiceError(providerVoiceError('TTS', 429, payload('GenerateRequestsPerMinutePerProject')))).toMatchObject({ category: 'quota_or_rate_limit' });
  expect(describeVoiceError(providerVoiceError('TTS', 429, { error: { status: 'RESOURCE_EXHAUSTED' } }))).toMatchObject({ category: 'quota_or_rate_limit' });
});
