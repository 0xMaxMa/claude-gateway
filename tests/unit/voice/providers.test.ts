import { BoundedQueue } from '../../../src/voice/queue';
import { PCM16 } from '../../../src/voice/types';
import { ElevenLabsStt } from '../../../src/voice/providers/elevenlabs-stt';
import { DeepgramStt } from '../../../src/voice/providers/deepgram-stt';
import { ElevenLabsTts } from '../../../src/voice/providers/elevenlabs-tts';
import { CartesiaTts } from '../../../src/voice/providers/cartesia-tts';
import { SocketFactory } from '../../../src/voice/providers/socket';

function socketFixture() {
  const messages = new BoundedQueue<Record<string, any>>(65536, value => JSON.stringify(value).length);
  const send = jest.fn(async (_value: unknown) => {}), audio = jest.fn(async (_value: Uint8Array) => {});
  const close = jest.fn(() => messages.close());
  const connect = jest.fn(async (_url: string, _headers: Record<string, string>, _signal: AbortSignal) => ({ messages, send, audio, close })) as jest.MockedFunction<SocketFactory>;
  return { messages, send, audio, close, connect };
}

test.each(['elevenlabs', 'deepgram'])('%s normalizes transcript and explicit commit acknowledgment', async provider => {
  const fixture = socketFixture(), signal = new AbortController().signal;
  const stt = provider === 'elevenlabs' ? new ElevenLabsStt('fixture', undefined, fixture.connect) : new DeepgramStt('fixture', 'nova-3', fixture.connect);
  const session = await stt.open({ format: PCM16, signal });
  await session.pushAudio(Buffer.alloc(320)); await session.commitSegment('commit-1');
  const events = session.events[Symbol.asyncIterator]();
  if (provider === 'elevenlabs') {
    fixture.messages.push({ message_type: 'partial_transcript', text: 'ลอง' });
    fixture.messages.push({ message_type: 'committed_transcript', text: 'ลองทดสอบ' });
    expect(fixture.send).toHaveBeenLastCalledWith(expect.objectContaining({ commit: true }));
  } else {
    fixture.messages.push({ type: 'Results', start: 0, is_final: false, channel: { alternatives: [{ transcript: 'ลอง' }] } });
    fixture.messages.push({ type: 'Results', start: 0, is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: 'ลองทดสอบ' }] } });
    expect(fixture.send).toHaveBeenLastCalledWith({ type: 'Finalize' });
    expect(fixture.audio).toHaveBeenCalledTimes(1);
  }
  expect((await events.next()).value).toMatchObject({ type: 'partial', text: 'ลอง' });
  expect((await events.next()).value).toMatchObject({ type: 'segment_final', text: 'ลองทดสอบ' });
  expect((await events.next()).value).toEqual({ type: 'commit_done', commitId: 'commit-1' });
  expect(fixture.connect.mock.calls[0][0]).not.toContain('fixture');
  await session.close(); expect(fixture.close).toHaveBeenCalled();
});

test.each(['elevenlabs', 'cartesia'])('%s exposes neutral PCM chunks and closes the provider connection', async provider => {
  const fixture = socketFixture(), signal = new AbortController().signal;
  const tts = provider === 'elevenlabs' ? new ElevenLabsTts('fixture', undefined, fixture.connect) : new CartesiaTts('fixture', 'sonic-3', fixture.connect);
  async function* text() { yield 'hello'; }
  const iterator = tts.synthesize({ text: text(), voiceId: 'voice', outputFormat: PCM16, signal })[Symbol.asyncIterator]();
  const first = iterator.next();
  fixture.messages.push(provider === 'elevenlabs' ? { audio: Buffer.alloc(320).toString('base64') } : { type: 'chunk', data: Buffer.alloc(320).toString('base64') });
  expect((await first).value).toMatchObject({ format: PCM16, chunkSeq: 0 });
  fixture.messages.push(provider === 'elevenlabs' ? { is_final: true } : { type: 'done' });
  expect((await iterator.next()).done).toBe(true);
  expect(fixture.close).toHaveBeenCalledTimes(1);
  if (provider === 'elevenlabs') {
    expect(new URL(fixture.connect.mock.calls[0][0]).searchParams.get('seed')).toBe('42');
    expect(fixture.send).toHaveBeenCalledWith({ voices: ['voice'], voice_settings: { stability: 1 } });
  }
});

test('provider closing without a terminal event is not a successful synthesis', async () => {
  const fixture = socketFixture();
  async function* text() { yield 'hello'; }
  const iterator = new ElevenLabsTts('fixture', undefined, fixture.connect).synthesize({ text: text(), voiceId: 'voice', outputFormat: PCM16, signal: new AbortController().signal })[Symbol.asyncIterator]();
  const result = iterator.next(); fixture.messages.close();
  await expect(result).rejects.toMatchObject({ code: 'TTS_INCOMPLETE' });
});

test('ElevenLabs keeps idle STT alive with silence without committing, and stops on close', async () => {
  jest.useFakeTimers();
  const fixture = socketFixture();
  const session = await new ElevenLabsStt('fixture', undefined, fixture.connect).open({ format: PCM16, signal: new AbortController().signal });
  try {
    await jest.advanceTimersByTimeAsync(20000);
    expect(fixture.send).toHaveBeenCalledTimes(4);
    for (const [message] of fixture.send.mock.calls) {
      expect(message).toEqual({ message_type: 'input_audio_chunk', audio_base_64: Buffer.alloc(3200).toString('base64'), sample_rate: 16000 });
    }
    await session.close();
    await jest.advanceTimersByTimeAsync(10000);
    expect(fixture.send).toHaveBeenCalledTimes(4);
  } finally { await session.close(); jest.useRealTimers(); }
});

test('ElevenLabs generates a complete MP3 voice file using the selected voice', async () => {
  const fixture = socketFixture();
  const result = new ElevenLabsTts('fixture', undefined, fixture.connect).synthesizeFile({ text: 'こんにちは', voiceId: 'chosen', signal: new AbortController().signal });
  fixture.messages.push({ audio: Buffer.from('mp3-part').toString('base64') });
  fixture.messages.push({ is_final: true });
  expect(await result).toEqual({ bytes: Buffer.from('mp3-part'), mime: 'audio/mpeg', name: 'reply.mp3' });
  expect(new URL(fixture.connect.mock.calls[0][0]).searchParams.get('output_format')).toBe('mp3_44100_128');
  expect(fixture.send).toHaveBeenCalledWith({ inputs: [{ text: 'こんにちは', voice_id: 'chosen' }] });
  expect(fixture.close).toHaveBeenCalledTimes(1);
});

test('ElevenLabs refuses an empty voice file even with a terminal receipt', async () => {
  const fixture = socketFixture();
  const result = new ElevenLabsTts('fixture', undefined, fixture.connect).synthesizeFile({ text: 'hello', voiceId: 'chosen', signal: new AbortController().signal });
  fixture.messages.push({ is_final: true });
  await expect(result).rejects.toMatchObject({ code: 'TTS_INCOMPLETE' });
});

test('Cartesia voice-file synthesis pins provider model/voice and preserves spoken language',async()=>{
 const request=jest.fn(async()=>new Response(Buffer.from('mp3-fixture')));
 const tts=new CartesiaTts('fixture','sonic-3',undefined,request);
 const audio=await tts.synthesizeFile({text:'こんにちは',voiceId:'selected',signal:new AbortController().signal});
 expect(Buffer.from(audio.bytes).toString()).toBe('mp3-fixture');expect(audio.mime).toBe('audio/mpeg');
 const options=(request.mock.calls as unknown as Array<[string,RequestInit]>)[0][1];
 expect(JSON.parse(String(options.body))).toMatchObject({model_id:'sonic-3',transcript:'こんにちは',voice:'selected',output_format:{container:'mp3'}});
});

test('ElevenLabs classic models use the selected voice stream and flush the final text', async () => {
  const fixture = socketFixture();
  const result = new ElevenLabsTts('fixture', 'eleven_flash_v2_5', fixture.connect).synthesizeFile({
    text: 'こんにちは', voiceId: 'selected-voice', signal: new AbortController().signal,
  });
  fixture.messages.push({ audio: Buffer.from('classic-audio').toString('base64') });
  fixture.messages.push({ isFinal: true });
  expect((await result).bytes).toEqual(Buffer.from('classic-audio'));
  const url = new URL(fixture.connect.mock.calls[0][0]);
  expect(url.pathname).toBe('/v1/text-to-speech/selected-voice/stream-input');
  expect(url.searchParams.get('model_id')).toBe('eleven_flash_v2_5');
  expect(fixture.send.mock.calls.map(([message]) => message)).toEqual([
    { text: ' ', voice_settings: { stability: 0.5 }, generation_config: { chunk_length_schedule: [50, 120, 160, 290] } },
    { text: 'こんにちは', try_trigger_generation: true },
    { text: '' },
  ]);
  expect(fixture.close).toHaveBeenCalledTimes(1);
});
