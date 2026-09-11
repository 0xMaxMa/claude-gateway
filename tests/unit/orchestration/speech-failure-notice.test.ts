import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { DeliveryOutbox, channelSender, ChannelSender, speechFailureNotice } from '../../../src/orchestration/delivery';
import { sendChannelSpeech } from '../../../src/orchestration/channel-speech';
import { providerVoiceError } from '../../../src/voice/errors';
import type { AgentConfig } from '../../../src/types';
import type { TtsProvider } from '../../../src/voice/types';

const speech = { provider: 'gemini', model: 'fixture', voiceId: 'Laomedeia', text: 'Hello' };
const dailyQuota = () => providerVoiceError('VOICE', 429, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } });

test.each(['telegram', 'discord', 'line', 'slack'] as const)('%s sends one durable TTS failure notice after text in the same destination', async channel => {
  const root = mkdtempSync(join(tmpdir(), 'speech-notice-')), database = join(root, 'state.db');
  let store = new OrchestrationStore(database, 'a');
  const agent = { id: 'a', telegram: { botToken: 'fixture' }, discord: { botToken: 'fixture' }, line: { channelAccessToken: 'fixture' }, slack: { botToken: 'fixture' } } as AgentConfig;
  const request = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, id: 'receipt', result: { message_id: 42 } })));
  const synthesizeFile = jest.fn(async () => { throw dailyQuota(); });
  const provider = () => ({ synthesizeFile } as unknown as TtsProvider);
  const sender: ChannelSender = (binding, text, id, file, audio, format) => audio
    ? sendChannelSpeech(agent, binding, audio, id, request, provider)
    : channelSender(agent, request)(binding, text, id, file, audio, format);
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    let outbox = new DeliveryOutbox(store, sender);
    const decisions = new DecisionService(store, (r, b, text) => outbox.enqueue(r, b, text));
    const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: channel, accountId: 'account', chatId: '123', threadKey: '456', principalId: 'owner' }, text: 'hello' });
    const receipt = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    // Even if speech is queued first, text must be delivered first.
    store.transaction(() => outbox.enqueueSpeech(receipt.responseId!, input.bindingId, speech));
    decisions.finish(receipt, 'Original answer');
    await outbox.tick();
    expect(synthesizeFile).not.toHaveBeenCalled();
    await outbox.tick();
    const failed = store.get("SELECT id FROM deliveries WHERE modality='speech'")!;
    expect(store.get("SELECT last_error FROM outbox WHERE dedup_key=?", `speech:${receipt.responseId}`)?.last_error).toBe('VOICE_PROVIDER_ERROR_HTTP_429_REASON_DAILY_QUOTA');
    expect(request).toHaveBeenCalledTimes(1);
    // The pending notification survives a real database close and reopen.
    store.close(); store = new OrchestrationStore(database, 'a'); outbox = new DeliveryOutbox(store, sender);
    await outbox.tick(); await outbox.tick();
    expect(synthesizeFile).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    const [url, init] = request.mock.calls[1]; const body = JSON.parse(String(init!.body));
    const text = channel === 'line' ? body.messages[0].text : channel === 'discord' ? body.content : body.text;
    expect(text).toBe('Voice quota exhausted (HTTP 429). Try again after the quota resets, or use /voice off.');
    expect(text).not.toContain(String(failed.id));
    if (channel === 'telegram') { expect(body).toMatchObject({ chat_id: '123', message_thread_id: 456 }); expect(body.parse_mode).toBeUndefined(); }
    if (channel === 'discord') { expect(String(url)).toContain('/channels/123/messages'); expect(body.allowed_mentions).toEqual({ parse: [] }); }
    if (channel === 'line') expect(body.to).toBe('123');
    if (channel === 'slack') expect(body).toMatchObject({ channel: '123', thread_ts: '456' });
    expect(store.all("SELECT id FROM outbox WHERE dedup_key LIKE 'speech-failure:%'")).toHaveLength(1);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ code: 'VOICE_PROVIDER_ERROR_HTTP_429_REASON_DAILY_QUOTA', referenceId: failed.id, category: 'daily_quota' });
  } finally { log.mockRestore(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test.each(['VOICE_REPLY_DISABLED', 'PROVIDER_RECEIPT_UNKNOWN'])('%s produces no misleading synthesis failure notice', async code => {
  const store = new OrchestrationStore(':memory:', 'a');
  const sender: ChannelSender = async (_binding, _text, _id, _file, audio) => audio
    ? { state: code === 'VOICE_REPLY_DISABLED' ? 'failed' : 'unknown', code }
    : { state: 'delivered' };
  const outbox = new DeliveryOutbox(store, sender);
  const decisions = new DecisionService(store, (r, b, text) => outbox.enqueue(r, b, text));
  try {
    const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'telegram', accountId: 'account', chatId: '123', threadKey: '', principalId: 'owner' }, text: 'hello' });
    const receipt = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    decisions.finish(receipt, 'Original answer');
    store.transaction(() => outbox.enqueueSpeech(receipt.responseId!, input.bindingId, speech));
    await outbox.tick(); await outbox.tick();
    expect(store.all("SELECT id FROM outbox WHERE dedup_key LIKE 'speech-failure:%'")).toHaveLength(0);
    expect(store.all("SELECT id FROM deliveries WHERE modality='text'")).toHaveLength(1);
  } finally { store.close(); }
});

test('turning voice off during failed synthesis suppresses error notices for every channel', async () => {
  for (const channel of ['telegram', 'discord', 'line', 'slack']) {
    let enabled = true;
    const request = jest.fn();
    const provider = () => ({ synthesizeFile: async () => { enabled = false; throw dailyQuota(); } } as unknown as TtsProvider);
    const outcome = await sendChannelSpeech({ telegram: { botToken: 'fixture' } } as AgentConfig, { channel }, speech, 'id', request, provider, () => enabled);
    expect(outcome).toEqual({ state: 'failed', code: 'VOICE_REPLY_DISABLED' });
    expect(request).not.toHaveBeenCalled();
  }
});


test.each([
  ['elevenlabs', providerVoiceError('TTS', 429, { detail: { status: 'quota_exceeded' } }).code, 'Voice quota exhausted (HTTP 429). Try again after the quota resets'],
  ['paxalabs', providerVoiceError('TTS', 402, { error: 'insufficient_credits' }).code, 'Voice credits or billing required (HTTP 402). Check provider billing'],
  ['gemini', dailyQuota().code, 'Voice quota exhausted (HTTP 429). Try again after the quota resets'],
  ['cartesia', providerVoiceError('TTS', 429, { error: { code: 'rate_limit_exceeded' } }).code, 'Voice rate limit reached (HTTP 429). Try again later'],
  ['future', 'VOICE_PROVIDER_ERROR_HTTP_503', 'Voice provider unavailable (HTTP 503). Try again later'],
  ['future', 'VOICE_PROVIDER_ERROR_HTTP_429', 'Voice rate limit or quota reached (HTTP 429). Check provider usage'],
  ['future', 'TTS_CREDENTIALS_MISSING', 'Voice authentication failed. Check your API key'],
  ['future', 'VOICE_PROVIDER_ERROR_HTTP_401', 'Voice authentication failed (HTTP 401). Check your API key'],
  ['future', 'VOICE_PROVIDER_ERROR_HTTP_403', 'Voice access denied (HTTP 403). Check provider permissions'],
  ['future', 'PROVIDER_TIMEOUT', 'Voice request timed out. Try again later'],
  ['future', 'PROVIDER_CONNECTION_FAILED', 'Voice connection failed. Try again later'],
  ['future', 'STT_LANGUAGE_UNSUPPORTED', 'Voice language not supported. Check voice settings'],
  ['future', 'TTS_FILE_UNSUPPORTED', 'Voice model or voice unavailable. Check voice settings'],
  ['future', 'VOICE_PROVIDER_ERROR_HTTP_400', 'Voice request rejected (HTTP 400). Check voice settings'],
  ['future', 'TTS_INCOMPLETE', 'Voice audio could not be created. Try again later'],
  ['future', 'PROVIDER_ABORTED', 'Voice request cancelled. Try again'],
  ['future', 'private unrecognized upstream detail', 'Voice audio unavailable. Try again later'],
])('%s has a concise safe notice for %s', (_provider, code, expected) => {
  expect(speechFailureNotice(code)).toBe(`${expected}, or use /voice off.`);
});
