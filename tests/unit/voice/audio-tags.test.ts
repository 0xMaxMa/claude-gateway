import { ElevenLabsTts, isElevenLabsDialogueModel } from '../../../src/voice/providers/elevenlabs-tts';
import { ttsProvider } from '../../../src/voice/providers/registry';
import { audioTagFreePrefix, stripAudioTags, withoutAudioTags } from '../../../src/voice/audio-tags';
import { voicePreviewLanguages, VOICE_PREVIEW_TEXT } from '../../../src/voice/preview';
import { GeminiTts } from '../../../src/voice/providers/gemini';
import { OpenRouterTts } from '../../../src/voice/providers/openrouter';
import { PCM16 } from '../../../src/voice/types';

async function collect(chunks: string[]): Promise<string> {
  let text = '';
  for await (const chunk of withoutAudioTags((async function* () { yield* chunks; })())) text += chunk;
  return text;
}

test('streamed reply text loses audio tags split across chunks and keeps its word breaks', async () => {
  expect(await collect(['Sure [laughs]', ' okay'])).toBe('Sure okay');
  expect(await collect(['Sure [lau', 'ghs]. Fine'])).toBe('Sure. Fine');
  expect(await collect(['ได้เลย[whis', 'pers]ค่ะ'])).toBe('ได้เลยค่ะ');
  expect(await collect(['Sure ', '[laughs] okay'])).toBe('Sure okay');
  expect(await collect(['use items[0] here'])).toBe('use items[0] here');
  expect(await collect(['[laughs]'])).toBe('');
});

test('stripped tags keep the word break between two words and none before punctuation', () => {
  expect(stripAudioTags('ได้เลยค่ะ [whispers] เดี๋ยวดูให้นะคะ [Sighs]').trim()).toBe('ได้เลยค่ะ เดี๋ยวดูให้นะคะ');
  expect(stripAudioTags('Sure thing [laughs]. ok[sighs], fine')).toBe('Sure thing. ok, fine');
  expect(stripAudioTags('ได้เลย[laughs]ค่ะ')).toBe('ได้เลยค่ะ');
  expect(stripAudioTags('ok[sighs] fine, [pause] ไปต่อ[clears throat]ค่ะ')).toBe('ok fine, ไปต่อค่ะ');
});

test('streamed text loses tags exactly as the whole text does, wherever the chunks split', async () => {
  expect(await collect(['word', ' ', '[laughs].'])).toBe('word.');
  for (const text of ['word [laughs]. ok[sighs] fine, [pause] next', 'Sure [laughs] okay [whispers] secret', 'ได้เลย [laughs] ค่ะ [sighs].']) {
    const whole = stripAudioTags(text).trim();
    expect((await collect([...text])).trim()).toBe(whole);
    for (let at = 1; at < text.length; at++) expect((await collect([text.slice(0, at), text.slice(at)])).trim()).toBe(whole);
  }
});

test('only the ElevenLabs dialogue models are listed for the Text-to-Dialogue socket', () => {
  for (const model of ['eleven_v3_conversational', 'eleven_v3', 'eleven_v4_turbo', 'eleven_v4']) expect(isElevenLabsDialogueModel(model)).toBe(true);
  for (const model of ['eleven_v4_flash', 'eleven_v3_preview', 'eleven_v4x', 'eleven_flash_v2_5']) expect(isElevenLabsDialogueModel(model)).toBe(false);
});

test('ElevenLabs v4 offers every preview language, matching its published language list', () => {
  for (const model of ['eleven_v4_turbo', 'eleven_v4']) expect(voicePreviewLanguages('elevenlabs', model)).toEqual(Object.keys(VOICE_PREVIEW_TEXT));
});

describe('structured spoken_text audio tags at the TTS layer', () => {
  const texts: string[] = [];
  let stream: jest.SpyInstance, file: jest.SpyInstance;
  beforeEach(() => {
    texts.length = 0;
    stream = jest.spyOn(ElevenLabsTts.prototype, 'synthesize').mockImplementation(async function* (options) {
      for await (const text of options.text) texts.push(text);
    });
    file = jest.spyOn(ElevenLabsTts.prototype, 'synthesizeFile').mockImplementation(async options => {
      texts.push(options.text);
      return { bytes: Buffer.from('mp3'), mime: 'audio/mpeg', name: 'reply.mp3' };
    });
  });
  afterEach(() => { stream.mockRestore(); file.mockRestore(); });
  const speak = async (model: string) => {
    const tts = ttsProvider({ provider: 'elevenlabs', model });
    for await (const _ of tts.synthesize({ text: (async function* () { yield '[laughs] Sure, '; yield 'okay [whispers] secret'; })(), voiceId: 'v', outputFormat: PCM16, signal: new AbortController().signal })) { /* drain */ }
    await tts.synthesizeFile!({ text: '[sighs] Fine.', voiceId: 'v', signal: new AbortController().signal });
    return texts.join('|');
  };

  test('are stripped for a model that would read them aloud', async () => {
    expect(await speak('eleven_flash_v2_5')).toBe('Sure,| okay secret|Fine.');
  });

  test('reach the ElevenLabs dialogue models that perform them', async () => {
    expect(await speak('eleven_v3_conversational')).toBe('[laughs] Sure, |okay [whispers] secret|[sighs] Fine.');
  });
});

test('Gemini 3.1 Flash TTS performs square-bracket tags, natively and through OpenRouter; other Gemini and OpenRouter TTS models do not get them', async () => {
  const texts: string[] = [];
  const spies = [GeminiTts.prototype, OpenRouterTts.prototype].flatMap(prototype => [
    jest.spyOn(prototype, 'synthesize').mockImplementation(async function* (options) { for await (const text of options.text) texts.push(text); }),
    jest.spyOn(prototype, 'synthesizeFile').mockImplementation(async options => { texts.push(options.text); return { bytes: Buffer.from('mp3'), mime: 'audio/mpeg', name: 'reply.mp3' }; }),
  ]);
  const speak = async (provider: string, model: string) => {
    texts.length = 0;
    const tts = ttsProvider({ provider, model });
    for await (const _ of tts.synthesize({ text: (async function* () { yield '[laughs] Sure'; })(), voiceId: 'v', outputFormat: PCM16, signal: new AbortController().signal })) { /* drain */ }
    await tts.synthesizeFile!({ text: '[sighs] Fine.', voiceId: 'v', signal: new AbortController().signal });
    return texts.join('|');
  };
  try {
    expect(await speak('gemini', 'gemini-3.1-flash-tts-preview')).toBe('[laughs] Sure|[sighs] Fine.');
    expect(await speak('upstream:gemini', 'gemini-3.1-flash-tts-preview')).toBe('[laughs] Sure|[sighs] Fine.');
    expect(await speak('openrouter', 'google/gemini-3.1-flash-tts-preview')).toBe('[laughs] Sure|[sighs] Fine.');
    // 2.5 documents no inline tags and 3.8 documents <angle> tags only.
    expect(await speak('upstream:gemini', 'gemini-2.5-pro-preview-tts')).toBe('Sure|Fine.');
    expect(await speak('gemini', 'gemini-3.8-flash-tts')).toBe('Sure|Fine.');
    expect(await speak('openrouter', 'openai/gpt-4o-mini-tts')).toBe('Sure|Fine.');
  } finally { for (const spy of spies) spy.mockRestore(); }
});

test('a tag at the start of a line leaves no stray space, whole or streamed', async () => {
  expect(stripAudioTags('Done.\n[laughs] Next')).toBe('Done.\nNext');
  expect(stripAudioTags('Done.\n\n[sighs] ได้เลยค่ะ')).toBe('Done.\n\nได้เลยค่ะ');
  for (let at = 1; at < 'Done.\n[laughs] Next'.length; at++) {
    const text = 'Done.\n[laughs] Next';
    expect(await collect([text.slice(0, at), text.slice(at)])).toBe('Done.\nNext');
  }
});

test('a markdown link whose text looks like a tag is not a tag', () => {
  expect(stripAudioTags('Read [sad](https://example.com) first')).toBe('Read [sad](https://example.com) first');
});

test('the chat prefix without tags only ever grows, and ends at the whole text without tags', () => {
  for (const text of ['word [laughs]. ok[sighs] fine, [pause] next', 'Sure [laughs] okay [whispers] secret', 'ได้เลย [laughs] ค่ะ [sighs].', 'Read [sad](https://example.com) first', 'use items[0] here']) {
    let shown = '';
    for (let at = 1; at <= text.length; at++) {
      const next = audioTagFreePrefix(text.slice(0, at));
      expect(next.startsWith(shown)).toBe(true);
      expect(next).not.toMatch(/\[(?:laughs|sighs|pause|whispers)\]/);
      shown = next;
    }
    expect(stripAudioTags(text).startsWith(shown)).toBe(true);
  }
});

test('the streamed tag filter releases a stalled source as soon as it is closed', async () => {
  const release = jest.fn(async () => ({ done: true as const, value: undefined }));
  const source: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<string>>(() => {}), return: release }) };
  const iterator = withoutAudioTags(source)[Symbol.asyncIterator]();
  void iterator.next();
  await Promise.race([iterator.return!(), new Promise(resolve => setTimeout(resolve, 50))]);
  expect(release).toHaveBeenCalled();
});

test('the streamed tag filter stops reading its source once it is closed', async () => {
  let resolve!: (result: IteratorResult<string>) => void;
  const next = jest.fn(() => new Promise<IteratorResult<string>>(done => { resolve = done; }));
  const source: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next, return: async () => ({ done: true as const, value: undefined }) }) };
  const iterator = withoutAudioTags(source)[Symbol.asyncIterator]();
  const pending = iterator.next();
  await new Promise(setImmediate);
  await iterator.return!();
  resolve({ done: false, value: 'late text' });
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(next).toHaveBeenCalledTimes(1);
});
