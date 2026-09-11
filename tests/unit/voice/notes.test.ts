import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { transcribeVoiceNote } from '../../../src/voice/notes';
import { normalizeLineEvent } from '../../../src/api/line-webhook-router';

test('uploaded voice notes use batch STT multipart and retain Thai transcripts', async () => {
  const previous = process.env.ELEVENLABS_API_KEY, root = mkdtempSync(join(tmpdir(), 'voice-note-'));
  process.env.ELEVENLABS_API_KEY = 'fixture-only';
  try {
    const path = join(root, 'voice.ogg'); writeFileSync(path, Buffer.from('OggSfixture'));
    const fetcher = jest.fn(async (_url, init) => {
      expect(init.headers).toEqual({ 'xi-api-key': 'fixture-only' });
      expect(init.body.get('model_id')).toBe('scribe_v2');
      expect(init.body.get('language_code')).toBe('th');
      expect(init.body.get('file').name).toBe('voice.ogg');
      return new Response(JSON.stringify({ text: 'ช่วยรีวิวโค้ดให้หน่อย' }), { status: 200 });
    });
    await expect(transcribeVoiceNote(path, { provider: 'elevenlabs', model: 'scribe_v2', language: 'th' }, fetcher as any)).resolves.toBe('ช่วยรีวิวโค้ดให้หน่อย');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    await expect(transcribeVoiceNote(path, { provider: 'elevenlabs', model: 'scribe_v2' }, (async () => new Response('{}', { status: 429 })) as any)).rejects.toThrow('STT_PROVIDER_ERROR_HTTP_429');
    await expect(transcribeVoiceNote(path, { provider: 'elevenlabs', model: 'scribe_v2' }, (async () => new Response('{"text":""}')) as any)).rejects.toThrow('VOICE_NOTE_NO_TRANSCRIPT');
    delete process.env.ELEVENLABS_API_KEY;
    await expect(transcribeVoiceNote(path, { provider: 'elevenlabs', model: 'scribe_v2' }, fetcher as any)).rejects.toThrow('STT_CREDENTIALS_MISSING');
  } finally { if (previous === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = previous; rmSync(root, { recursive: true, force: true }); }
});

test('LINE audio normalization preserves sender and provider message binding', () => {
  const result = normalizeLineEvent({ type: 'message', message: { type: 'audio', id: 'audio1', duration: 1500 }, source: { type: 'user', userId: 'u1' }, timestamp: 1, replyToken: 'reply' } as any);
  expect(result).toMatchObject({ content: '(voice message)', meta: { media_type: 'audio', attachment_kind: 'voice', message_id: 'audio1', chat_id: 'u1', user_id: 'u1' } });
});

test.each(['elevenlabs', 'gemini', 'paxalabs'])('%s voice notes preserve provider HTTP diagnostics', async provider => {
  const root = mkdtempSync(join(tmpdir(), 'note-provider-errors-'));
  const keys = ['ELEVENLABS_API_KEY', 'GEMINI_API_KEY', 'PAXALABS_API_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = 'fixture';
  try {
    const path = join(root, 'voice.ogg'); writeFileSync(path, Buffer.from('OggSfixture'));
    for (const status of [402, 429, 503]) {
      const request = jest.fn(async () => new Response(JSON.stringify({ error: 'private upstream message' }), { status }));
      await expect(transcribeVoiceNote(path, { provider, model: 'fixture', language: 'th' }, request)).rejects.toMatchObject({ code: expect.stringContaining(`_PROVIDER_ERROR_HTTP_${status}`) });
      expect(request).toHaveBeenCalledTimes(1);
    }
    await expect(transcribeVoiceNote(path, { provider, model: 'fixture' }, async () => { throw new Error('private network details'); })).rejects.toMatchObject({ code: 'PROVIDER_CONNECTION_FAILED' });
  } finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    rmSync(root, { recursive: true, force: true });
  }
});
