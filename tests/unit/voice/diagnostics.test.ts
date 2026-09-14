import { voiceTrace, tracedAudio } from '../../../src/voice/diagnostics';
import { voiceProviderRequest } from '../../../src/voice/errors';

test('concurrent requests keep operation IDs separate and never log request secrets', async () => {
  const events: any[] = [];
  const request = jest.fn(async () => new Response('{}')) as unknown as typeof fetch;
  const stt = voiceTrace('stt', e => events.push(e), { utteranceId: 'u' });
  const tts = voiceTrace('tts', e => events.push(e), { responseId: 'r' });
  async function* audio() {
    await voiceProviderRequest('https://secret.test?key=private', { headers: { Authorization: 'secret' }, body: 'private speech' }, request);
    yield 1;
  }
  await Promise.all([
    stt.run(() => voiceProviderRequest('https://secret.test', {}, request)),
    (async () => { for await (const chunk of tracedAudio(audio(), tts)) expect(chunk).toBe(1); })(),
  ]);
  expect(events).toHaveLength(4);
  for (const operation of ['stt', 'tts']) {
    const group = events.filter(e => e.operation === operation);
    expect(group.map(e => e.phase)).toEqual(['provider_request_started', 'provider_headers_received']);
    expect(new Set(group.map(e => e.operationId)).size).toBe(1);
    expect(group[1].httpStatus).toBe(200);
  }
  expect(events[0].operationId).not.toBe(events.find(e => e.operation === 'tts').operationId);
  expect(JSON.stringify(events)).not.toMatch(/secret|private/);
});

test('diagnostic sink failures never fail requests and cancelled iteration closes its source', async () => {
  const trace = voiceTrace('tts', () => { throw new Error('logger down'); });
  trace.emit('synthesis_started');
  let closed = false;
  async function* source() { try { yield 1; yield 2; } finally { closed = true; } }
  for await (const _ of tracedAudio(source(), trace)) break;
  expect(closed).toBe(true);
});
