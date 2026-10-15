import { ElevenLabsTts, isElevenLabsDialogueModel } from '../../../src/voice/providers/elevenlabs-tts';
import { ttsProvider } from '../../../src/voice/providers/registry';
import { withoutAudioTags } from '../../../src/voice/audio-tags';
import { voicePreviewLanguages, VOICE_PREVIEW_TEXT } from '../../../src/voice/preview';
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
    expect(await speak('eleven_flash_v2_5')).toBe('Sure, |okay secret|Fine.');
  });

  test('reach the ElevenLabs dialogue models that perform them', async () => {
    expect(await speak('eleven_v3_conversational')).toBe('[laughs] Sure, |okay [whispers] secret|[sighs] Fine.');
  });
});
