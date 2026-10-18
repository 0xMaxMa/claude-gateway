import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { DeliveryOutbox, channelSender, ChannelSender, speechFailureNotice } from '../../../src/orchestration/delivery';
import { sendChannelSpeech } from '../../../src/orchestration/channel-speech';
import { describeVoiceError, providerVoiceError } from '../../../src/voice/errors';
import { VoiceError } from '../../../src/voice/types';
import { voiceNoteFailureMessage } from '../../../src/voice/notes';
import type { AgentConfig } from '../../../src/types';
import type { TtsProvider } from '../../../src/voice/types';

const speech = { provider: 'gemini', model: 'fixture', voiceId: 'Laomedeia', text: 'Hello' };
const dailyQuota = () => providerVoiceError('VOICE', 429, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } });

test.each(['telegram', 'discord', 'line', 'slack'] as const)('%s sends one durable TTS failure notice after text in the same destination', async channel => {
  const root = mkdtempSync(join(tmpdir(), 'speech-notice-')), database = join(root, 'state.db');
  let store = new OrchestrationStore(database, 'a');
  const agent = { id: 'a', telegram: { botToken: 'fixture' }, discord: { botToken: 'fixture' }, line: { channelAccessToken: 'fixture' }, slack: { botToken: 'fixture' } } as AgentConfig;
  const request = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, id: 'receipt', result: { message_id: 42 } })));
  const synthesizeFile = jest.fn(async () => {
    expect(request).toHaveBeenCalledTimes(1); // Text accepted before synthesis starts.
    throw dailyQuota();
  });
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
    expect(synthesizeFile).toHaveBeenCalledTimes(1);
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

test.each(['telegram', 'discord', 'line', 'slack'] as const)('%s follows text with one empty-wallet voice notice per chat, even across a restart', async channel => {
  const root = mkdtempSync(join(tmpdir(), 'speech-credit-')), database = join(root, 'state.db');
  let store = new OrchestrationStore(database, 'a');
  const agent = { id: 'a', telegram: { botToken: 'fixture' }, discord: { botToken: 'fixture' }, line: { channelAccessToken: 'fixture' }, slack: { botToken: 'fixture' } } as AgentConfig;
  const request = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, id: 'receipt', result: { message_id: 42 } })));
  const synthesizeFile = jest.fn(async () => { throw new VoiceError('MANAGED_VOICE_QUOTA_EXHAUSTED'); });
  const provider = () => ({ synthesizeFile } as unknown as TtsProvider);
  const sender: ChannelSender = (binding, text, id, file, audio, format) => audio
    ? sendChannelSpeech(agent, binding, { ...audio, provider: 'managed:paxalabs' }, id, request, provider)
    : channelSender(agent, request)(binding, text, id, file, audio, format);
  const sentTexts = () => request.mock.calls.map(([, init]) => { const body = JSON.parse(String(init!.body)); return channel === 'line' ? body.messages[0].text : channel === 'discord' ? body.content : body.text; });
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const reply = async (text: string) => {
      const outbox = new DeliveryOutbox(store, sender);
      const decisions = new DecisionService(store, (r, b, body) => outbox.enqueue(r, b, body));
      const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: channel, accountId: 'account', chatId: '123', threadKey: '', principalId: 'owner' }, text });
      const receipt = decisions.begin(input.conversationId, 'owner', [input.inputId]);
      store.transaction(() => outbox.enqueueSpeech(receipt.responseId!, input.bindingId, speech));
      decisions.finish(receipt, text);
      for (let i = 0; i < 4; i++) await outbox.tick();
    };
    await reply('First answer');
    expect(sentTexts()).toEqual(['First answer', 'Voice reply unavailable: voice credit is used up. Text replies continue until the credit resets or is topped up, or use /voice off.']);
    store.close(); store = new OrchestrationStore(database, 'a');
    await reply('Second answer');
    expect(sentTexts()).toHaveLength(3);
    expect(sentTexts()[2]).toBe('Second answer');
    expect(synthesizeFile).toHaveBeenCalledTimes(2);
    expect(store.all("SELECT id FROM outbox WHERE dedup_key LIKE 'speech-failure:%'")).toHaveLength(1);
  } finally { log.mockRestore(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test.each([
  ['a delivered managed voice reply means credit is back', 'managed:paxalabs', 'delivered', 2],
  ['a delivered BYOK voice reply says nothing about the managed wallet', 'paxalabs', 'delivered', 1],
  ['an undelivered notice releases its claim', 'managed:paxalabs', 'failed', 2],
  ['a notice that may have arrived keeps its claim', 'managed:paxalabs', 'unknown', 1],
] as const)('%s', async (_name, provider, noticeState, expected) => {
  const store = new OrchestrationStore(':memory:', 'a');
  let outcome: 'quota' | 'ok' = 'quota';
  const sender: ChannelSender = async (_binding, text, _id, _file, audio) => audio
    ? outcome === 'ok' ? { state: 'delivered', providerId: 'voice' } : { state: 'failed', code: 'MANAGED_VOICE_QUOTA_EXHAUSTED', speechSynthesisFailed: true }
    : text.startsWith('Voice reply unavailable') && noticeState !== 'delivered' ? { state: noticeState, code: noticeState === 'failed' ? 'PROVIDER_HTTP_400' : 'PROVIDER_RECEIPT_UNKNOWN' } : { state: 'delivered' };
  const outbox = new DeliveryOutbox(store, sender);
  const decisions = new DecisionService(store, (r, b, text) => outbox.enqueue(r, b, text));
  const reply = async () => {
    const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'telegram', accountId: 'account', chatId: '123', threadKey: '', principalId: 'owner' }, text: 'hello' });
    const receipt = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    decisions.finish(receipt, 'Answer');
    store.transaction(() => outbox.enqueueSpeech(receipt.responseId!, input.bindingId, { ...speech, provider }));
    for (let i = 0; i < 3; i++) await outbox.tick();
  };
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await reply();
    if (noticeState === 'delivered') { await reply(); outcome = 'ok'; await reply(); outcome = 'quota'; }
    await reply();
    expect(store.all("SELECT id FROM outbox WHERE dedup_key LIKE 'speech-failure:%'")).toHaveLength(expected);
    expect(log.mock.calls.map(([line]) => JSON.parse(line)).filter(event => event.event === 'Speech synthesis failed')).toHaveLength(noticeState === 'delivered' ? 3 : 2);
  } finally { log.mockRestore(); store.close(); }
});

test('only a definite empty wallet uses the used-up wording', () => {
  expect(describeVoiceError('MANAGED_VOICE_QUOTA_EXHAUSTED')).toEqual({ category: 'managed_credit', message: 'Voice credit is used up. Voice will work again after the credit resets or is topped up.', retryable: false });
  expect(voiceNoteFailureMessage('MANAGED_VOICE_QUOTA_EXHAUSTED')).toBe('Voice credit is used up, so this voice message could not be transcribed. Please type your message instead.');
  for (const code of ['MANAGED_VOICE_USAGE_TIMEOUT', 'MANAGED_VOICE_USAGE_HTTP_503', 'STT_PROVIDER_ERROR_HTTP_503', 'PROVIDER_TIMEOUT', 'STT_PROVIDER_ERROR_HTTP_429_REASON_RATE_LIMIT', 'STT_PROVIDER_ERROR_HTTP_402']) {
    expect(describeVoiceError(code).category).not.toBe('managed_credit');
    expect(speechFailureNotice(code)).not.toContain('used up');
    expect(voiceNoteFailureMessage(code)).not.toContain('used up');
  }
  expect(describeVoiceError('MANAGED_VOICE_USAGE_TIMEOUT')).toMatchObject({ category: 'credit_check', retryable: true });
  // Only the exact wallet code, never a provider reason that happens to share the category name.
  expect(describeVoiceError('TTS_PROVIDER_ERROR_HTTP_400_REASON_MANAGED_CREDIT').category).toBe('invalid_request');
});

test('a voice-note credit notice that failed to send releases its claim; other chats share the managed wallet reset', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  let fail = true;
  const outbox = new DeliveryOutbox(store, async () => fail ? { state: 'failed', code: 'PROVIDER_HTTP_403' } : { state: 'delivered' });
  const decisions = new DecisionService(store, (r, b, text) => outbox.enqueue(r, b, text));
  try {
    const notice = (chatId: string) => {
      const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'telegram', accountId: 'account', chatId, threadKey: '', principalId: 'owner' }, text: '(voice message)' });
      const receipt = decisions.begin(input.conversationId, 'owner', [input.inputId]);
      const claimed = store.compose(() => { const ok = store.claimVoiceCreditNotice('telegram', chatId, '', 'stt', receipt.responseId!); if (ok) decisions.finish(receipt, 'Voice credit is used up', 'failed'); return ok; });
      if (!claimed) decisions.finish(receipt, '', 'completed', undefined, false);
      return claimed;
    };
    expect(notice('1')).toBe(true);
    await outbox.tick();
    expect(notice('1')).toBe(true);
    fail = false; await outbox.tick();
    expect(notice('1')).toBe(false);
  } finally { store.close(); }
});
