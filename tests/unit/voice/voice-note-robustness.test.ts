jest.mock('../../../src/config/claude-settings', () => ({claudeSettingsEnv: () => ({ANTHROPIC_BASE_URL:'https://provider.test',ANTHROPIC_AUTH_TOKEN:'pod-token'})}));
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { requireManagedVoiceCredit, checkManagedVoiceCredit } from '../../../src/voice/managed-quota';
import { describeVoiceError } from '../../../src/voice/errors';
import { transcribeVoiceNote, voiceNoteFailureMessage, retryableVoiceNoteFailure } from '../../../src/voice/notes';

// meguri, input 16e7b607 (managed:paxalabs): one wallet check that did not finish in time
// stopped the voice note before any audio reached the provider, reported as an outage.
const usageUrl = 'https://provider.test/v1/voice/managed/usage';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

function recorder() {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
}

test('a credit check that cannot finish is retried with backoff, then the request goes through', async () => {
  for (const [failure, code] of [
    [() => { throw timeoutError(); }, 'MANAGED_VOICE_USAGE_TIMEOUT'],
    [() => { throw new Error('socket hang up'); }, 'MANAGED_VOICE_USAGE_NETWORK'],
    [() => json({}, 503), 'MANAGED_VOICE_USAGE_HTTP_503'],
    [() => new Response('<html>bad gateway</html>'), 'MANAGED_VOICE_USAGE_INVALID_BODY'],
    [() => json({ remaining: 'lots' }), 'MANAGED_VOICE_USAGE_INVALID_BODY'],
  ] as const) {
    const { sleeps, sleep } = recorder(), diagnostics: unknown[] = [];
    const request = jest.fn(async () => failure());
    await expect(requireManagedVoiceCredit('managed:paxalabs', request as any, undefined, { sleep, onDiagnostic: event => diagnostics.push(event) })).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1500]);
    expect(diagnostics).toEqual([expect.objectContaining({ stage: 'usage_check', outcome: 'indeterminate', code, attempts: 3, elapsedMs: expect.any(Number) })]);
  }
});

test('a check that recovers on retry uses the real answer', async () => {
  const { sleeps, sleep } = recorder();
  const request = jest.fn().mockResolvedValueOnce(json({}, 502)).mockResolvedValueOnce(json({ remaining: 0 }));
  await expect(requireManagedVoiceCredit('managed:paxalabs', request, undefined, { sleep })).rejects.toMatchObject({ code: 'MANAGED_VOICE_QUOTA_EXHAUSTED' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(sleeps).toEqual([500]);
});

test('a definite "no credit" answer stops at once and is never bypassed', async () => {
  for (const response of [json({ remaining: 0 }), json({ remaining: -3 }), json({}, 402), json({ code: 'MANAGED_VOICE_QUOTA_EXHAUSTED' }, 429)]) {
    const { sleeps, sleep } = recorder(), request = jest.fn(async () => response);
    await expect(requireManagedVoiceCredit('managed:elevenlabs', request, undefined, { sleep })).rejects.toMatchObject({ code: 'MANAGED_VOICE_QUOTA_EXHAUSTED' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  }
});

test('a client error from the wallet is not retried, and does not block the request', async () => {
  const { sleeps, sleep } = recorder(), request = jest.fn(async (_url: unknown) => json({}, 401));
  await expect(checkManagedVoiceCredit('managed:paxalabs', request, undefined, { sleep })).resolves.toMatchObject({ outcome: 'indeterminate', code: 'MANAGED_VOICE_USAGE_HTTP_401', httpStatus: 401, attempts: 1 });
  expect(sleeps).toEqual([]);
  expect(String(request.mock.calls[0][0])).toBe(usageUrl);
});

test('cancellation still stops the check without a retry', async () => {
  const controller = new AbortController(); controller.abort();
  const request = jest.fn();
  await expect(requireManagedVoiceCredit('managed:paxalabs', request, controller.signal)).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
  expect(request).not.toHaveBeenCalled();
});

describe('voice-note transcription', () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-note-retry-')), path = join(root, 'note.ogg');
  writeFileSync(path, Buffer.from('OggSfixture'));
  const previous = process.env.ELEVENLABS_API_KEY;
  beforeAll(() => { process.env.ELEVENLABS_API_KEY = 'fixture-only'; });
  afterAll(() => { if (previous === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = previous; rmSync(root, { recursive: true, force: true }); });

  test.each([
    ['server error', () => json({}, 503)],
    ['rate limit', () => json({}, 429)],
    ['timeout', () => { throw timeoutError(); }],
    ['network', () => { throw new Error('ECONNRESET'); }],
  ])('a %s is retried with backoff and then succeeds', async (_name, failure) => {
    const { sleeps, sleep } = recorder(), diagnostics: any[] = [];
    const request = jest.fn().mockImplementationOnce(async () => failure()).mockImplementationOnce(async () => failure()).mockResolvedValueOnce(json({ text: 'สวัสดีครับ' }));
    await expect(transcribeVoiceNote(path, { provider: 'elevenlabs', model: 'scribe_v2', sleep, onDiagnostic: event => diagnostics.push(event) }, request)).resolves.toBe('สวัสดีครับ');
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 3000]);
    expect(diagnostics.map(event => event.outcome)).toEqual(['retry', 'retry']);
  });

  test('retries are bounded: the third failure is returned', async () => {
    const { sleep } = recorder(), request = jest.fn(async () => json({}, 503));
    await expect(transcribeVoiceNote(path, { provider: 'elevenlabs', model: 'scribe_v2', sleep }, request)).rejects.toMatchObject({ code: 'STT_PROVIDER_ERROR_HTTP_503' });
    expect(request).toHaveBeenCalledTimes(3);
  });

  test.each([
    [400, {}], [401, {}], [402, {}], [403, {}], [413, {}],
    [429, { error: { code: 'insufficient_quota' } }],
    [429, { code: 'MANAGED_VOICE_QUOTA_EXHAUSTED' }],
  ])('HTTP %s %j is final and never retried', async (status, body) => {
    const { sleeps, sleep } = recorder(), request = jest.fn(async () => json(body, status));
    await expect(transcribeVoiceNote(path, { provider: 'elevenlabs', model: 'scribe_v2', sleep }, request)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  test('an empty transcript is final', async () => {
    const { sleep } = recorder(), request = jest.fn(async () => json({ text: '' }));
    await expect(transcribeVoiceNote(path, { provider: 'elevenlabs', model: 'scribe_v2', sleep }, request)).rejects.toThrow('VOICE_NOTE_NO_TRANSCRIPT');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

test('a managed voice note is transcribed even when the credit check never answers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-note-')), path = join(root, 'note.oga');
  writeFileSync(path, Buffer.from('OggSfixture'));
  try {
    const { sleep } = recorder(), diagnostics: any[] = [];
    const request = jest.fn(async (url: unknown) => {
      if (String(url) === usageUrl) throw timeoutError();
      return json({ text: 'สรุปงานให้หน่อย' });
    });
    await expect(transcribeVoiceNote(path, { provider: 'managed:paxalabs', model: 'fixture', sleep, onDiagnostic: event => diagnostics.push(event) }, request as any)).resolves.toBe('สรุปงานให้หน่อย');
    expect(request.mock.calls.filter(call => String(call[0]) === usageUrl)).toHaveLength(3);
    expect(diagnostics[0]).toMatchObject({ stage: 'usage_check', outcome: 'indeterminate', code: 'MANAGED_VOICE_USAGE_TIMEOUT' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('credit-check codes say what failed, and keep the old code readable', () => {
  for (const code of ['MANAGED_VOICE_USAGE_UNAVAILABLE', 'MANAGED_VOICE_USAGE_TIMEOUT', 'MANAGED_VOICE_USAGE_NETWORK', 'MANAGED_VOICE_USAGE_HTTP_503', 'MANAGED_VOICE_USAGE_INVALID_BODY']) {
    const diagnostic = describeVoiceError(code);
    expect(diagnostic).toMatchObject({ category: 'credit_check', retryable: true });
    expect(diagnostic.message).toContain('Could not check the voice credit balance');
    const text = voiceNoteFailureMessage(code);
    expect(text).not.toContain('temporarily unavailable');
    expect(text).not.toContain('pod-token');
    expect(retryableVoiceNoteFailure(code)).toBe(true);
  }
  expect(describeVoiceError('MANAGED_VOICE_USAGE_TIMEOUT').message).toContain('(timed out)');
  expect(describeVoiceError('MANAGED_VOICE_USAGE_HTTP_503').message).toContain('(HTTP 503)');
  // The provider itself failing still reads as a provider error.
  expect(describeVoiceError('STT_PROVIDER_ERROR_HTTP_503')).toMatchObject({ category: 'unavailable' });
  for (const code of ['STT_PROVIDER_ERROR_HTTP_503', 'PROVIDER_TIMEOUT', 'PROVIDER_CONNECTION_FAILED', 'VOICE_NOTE_INTERRUPTED', 'STT_PROVIDER_ERROR_HTTP_429']) expect(retryableVoiceNoteFailure(code)).toBe(true);
  for (const code of ['MANAGED_VOICE_QUOTA_EXHAUSTED', 'STT_PROVIDER_ERROR_HTTP_401', 'STT_PROVIDER_ERROR_HTTP_402', 'VOICE_NOTE_NO_TRANSCRIPT', 'VOICE_NOTE_SIZE_LIMIT', 'VOICE_NOTES_DISABLED']) expect(retryableVoiceNoteFailure(code)).toBe(false);
});
