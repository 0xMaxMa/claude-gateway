import { BoundedQueue } from '../../../src/voice/queue';
import { PCM16 } from '../../../src/voice/types';
import { ElevenLabsStt } from '../../../src/voice/providers/elevenlabs-stt';
import { sttProvider } from '../../../src/voice/providers/registry';
import { SocketFactory } from '../../../src/voice/providers/socket';
import { ORCHESTRATION_DEFAULTS, AGENT_VOICE_DEFAULTS, resolveOrchestrationConfig } from '../../../src/orchestration/config';
import { generateVoiceCallPage } from '../../../src/ui/voice-call-ui';
import { VOICE_CALL_VAD, createVoiceCallVad } from '../../../src/ui/voice-call-client';

// Every provider socket the registry opens, by URL.
const opened: string[] = [];
jest.mock('../../../src/voice/providers/socket', () => ({
  openProviderSocket: async (url: string) => {
    opened.push(url);
    return { messages: new BoundedQueue<Record<string, unknown>>(1024, () => 1), send: async () => {}, audio: async () => {}, close: () => {} };
  },
}));
jest.mock('../../../src/config/claude-settings', () => ({ claudeSettingsEnv: () => ({ ANTHROPIC_BASE_URL: 'https://relay.test', ANTHROPIC_AUTH_TOKEN: 'relay-token' }) }));
jest.mock('../../../src/voice/managed-quota', () => ({ requireManagedVoiceCredit: async () => {} }));

const open = async (stt: { open: ElevenLabsStt['open'] }) => {
  const session = await stt.open({ format: PCM16, language: 'th', signal: new AbortController().signal });
  await session.close();
  return new URL(opened[opened.length - 1]);
};

beforeEach(() => { opened.length = 0; process.env.ELEVENLABS_API_KEY = 'direct-key'; });

describe('ElevenLabs background-audio filter', () => {
  const fixtureConnect = (): SocketFactory => async url => {
    opened.push(url);
    return { messages: new BoundedQueue<Record<string, unknown>>(1024, () => 1), send: async () => {}, audio: async () => {}, close: () => {} };
  };

  test('enabled adds filter_background_audio=true and keeps every existing param', async () => {
    const url = await open(new ElevenLabsStt('key', 'scribe_v2_realtime', fixtureConnect(), 'elevenlabs', { filterBackgroundAudio: true }));
    expect(url.searchParams.get('filter_background_audio')).toBe('true');
    expect(Object.fromEntries(url.searchParams)).toEqual({ model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', commit_strategy: 'manual', include_timestamps: 'false', language_code: 'th', filter_background_audio: 'true' });
  });

  test('disabled or omitted leaves the URL byte-identical to before', async () => {
    const before = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=manual&include_timestamps=false&language_code=th';
    expect((await open(new ElevenLabsStt('key', 'scribe_v2_realtime', fixtureConnect()))).toString()).toBe(before);
    expect((await open(new ElevenLabsStt('key', 'scribe_v2_realtime', fixtureConnect(), 'elevenlabs', { filterBackgroundAudio: false }))).toString()).toBe(before);
  });

  test.each(['elevenlabs', 'upstream:elevenlabs', 'managed:elevenlabs'])('the registry passes the flag to %s, through the relay URL as well', async provider => {
    const on = await open(sttProvider({ provider, model: 'scribe_v2_realtime', filterBackgroundAudio: true }));
    expect(on.searchParams.get('filter_background_audio')).toBe('true');
    if (provider !== 'elevenlabs') expect(on.host).toBe('relay.test');
    const off = await open(sttProvider({ provider, model: 'scribe_v2_realtime', filterBackgroundAudio: false }));
    expect(off.searchParams.has('filter_background_audio')).toBe(false);
  });

  test('other providers ignore the flag', async () => {
    process.env.DEEPGRAM_API_KEY = 'deepgram-key';
    const url = await open(sttProvider({ provider: 'deepgram', model: 'nova-3', filterBackgroundAudio: true }));
    expect(url.toString()).not.toContain('filter_background_audio');
  });
});

describe('voice config', () => {
  const voice = (extra: Record<string, unknown>) => ({ ...ORCHESTRATION_DEFAULTS.voice, ...extra });

  test('defaults: the filter is off and the VAD equals the browser constants', () => {
    for (const resolved of [resolveOrchestrationConfig().voice, resolveOrchestrationConfig(undefined, { enabled: false }).voice]) {
      expect(resolved.stt.filterBackgroundAudio).toBe(false);
      expect(resolved.live.vad).toEqual(VOICE_CALL_VAD);
    }
    expect(AGENT_VOICE_DEFAULTS.stt.filterBackgroundAudio).toBe(false);
  });

  test('filterBackgroundAudio is accepted as a boolean; a misspelling or wrong type is still rejected', () => {
    expect(resolveOrchestrationConfig(undefined, voice({ stt: { provider: 'elevenlabs', model: 'scribe_v2_realtime', filterBackgroundAudio: true } })).voice.stt.filterBackgroundAudio).toBe(true);
    expect(() => resolveOrchestrationConfig(undefined, voice({ stt: { filterBackgroundAudo: true } }))).toThrow('Unknown field voice.stt.filterBackgroundAudo');
    expect(() => resolveOrchestrationConfig(undefined, voice({ stt: { filterBackgroundAudio: 'yes' } }))).toThrow('voice.stt.filterBackgroundAudio');
  });

  test('a partial VAD override merges over the defaults and keeps the other live settings', () => {
    const resolved = resolveOrchestrationConfig(undefined, voice({ live: { fastAck: false, vad: { minLevel: 0.03, ratio: 4.5, startMs: 200 } } })).voice;
    expect(resolved.live.vad).toEqual({ ...VOICE_CALL_VAD, minLevel: 0.03, ratio: 4.5, startMs: 200 });
    expect(resolved.live).toMatchObject({ fastAck: false, fastAckAfterMs: ORCHESTRATION_DEFAULTS.voice.live.fastAckAfterMs });
  });

  test.each([
    ['minLevel', -0.01], ['minLevel', Number.NaN], ['minLevel', 2], ['ratio', -1], ['ratio', Number.POSITIVE_INFINITY], ['noiseAdapt', 1.5],
    ['initialNoise', '0.004'], ['startMs', 0], ['startMs', 12.5], ['bargeInMs', -1], ['typo', 1],
  ])('an invalid VAD value %s=%p fails validation', (key, value) => {
    expect(() => resolveOrchestrationConfig(undefined, voice({ live: { vad: { [key]: value } } }))).toThrow(/INVALID_CONFIG|voice\.live\.vad/);
  });
});

describe('call page VAD', () => {
  const cfg = (html: string) => JSON.parse(/var CFG = (\{.*?\});/.exec(html)![1].replace(/\\u003c/g, '<'));
  const page = (vad?: Partial<typeof VOICE_CALL_VAD>) => generateVoiceCallPage({ pairingId: 'a'.repeat(36), agentId: 'agent', basePath: '/gateway', maxUtteranceMs: 60000, vad });

  test('without overrides the page embeds the current constants', () => {
    expect(cfg(page()).vad).toEqual(VOICE_CALL_VAD);
  });

  test('an override changes only the overridden fields', () => {
    expect(cfg(page({ minLevel: 0.05 })).vad).toEqual({ ...VOICE_CALL_VAD, minLevel: 0.05 });
  });

  test('a raised minLevel and ratio ignore a level the defaults start on', () => {
    const level = 0.02, chunks = 10;
    const run = (vad: typeof VOICE_CALL_VAD) => { const step = createVoiceCallVad(vad); return Array.from({ length: chunks }, () => step(level, 40)); };
    expect(run(VOICE_CALL_VAD)).toContain('start');
    expect(run({ ...VOICE_CALL_VAD, minLevel: 0.03, ratio: 8 })).not.toContain('start');
  });
});
