import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { DeliveryOutbox, channelSender } from '../../../src/orchestration/delivery';
import { resetLineQuotaCache, resetLowQuotaWarnings } from '../../../src/orchestration/line-quota';
import type { AgentConfig } from '../../../src/types';

const agent = { id: 'a', line: { channelAccessToken: 'fixture' } } as AgentConfig;
const speech = { provider: 'gemini', model: 'fixture', voiceId: 'Laomedeia', text: 'Hello' };
const scope = { agentId: 'a', agentSessionId: 's', source: 'line' as const, accountId: 'account', chatId: '123', threadKey: '', principalId: 'owner' };

const rateLimited = () => new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429, headers: { 'retry-after': '2' } });
const quotaExhausted = () => new Response(JSON.stringify({ message: 'You have reached your monthly limit.' }), { status: 429 });

/** A quota/consumption probe unavailable via 500 never changes 429 classification here — it only removes the
 * cache-derived override, leaving the rejection message itself to decide quota_exhausted vs rate_limited. */
function lineRequestMock(pushResponses: Response[]) {
  let pushCall = 0;
  return jest.fn(async (url: string | URL | Request) => {
    if (String(url).includes('/message/push')) return pushResponses[Math.min(pushCall++, pushResponses.length - 1)];
    return new Response('', { status: 500 });
  });
}
const pushCalls = (request: jest.Mock) => request.mock.calls.filter(call => String(call[0]).includes('/message/push'));

beforeEach(() => { resetLineQuotaCache(); resetLowQuotaWarnings(); });

test('a rate-limited LINE push retries with bounded backoff, reuses the same retry key, and stops at the cap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'line-retry-')), database = join(root, 'state.db');
  const store = new OrchestrationStore(database, 'a');
  const request = lineRequestMock([rateLimited(), rateLimited(), rateLimited()]);
  const outbox = new DeliveryOutbox(store, channelSender(agent, request));
  const decisions = new DecisionService(store, (r, b, text) => outbox.enqueue(r, b, text));
  try {
    const input = store.acceptInput({ scope, text: 'hi' });
    const receipt = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    decisions.finish(receipt, 'reply');

    await outbox.tick();
    expect(pushCalls(request)).toHaveLength(1);
    let delivery = store.get("SELECT * FROM deliveries WHERE modality='text'")!;
    expect(delivery.state).toBe('pending'); // requeued for retry, not terminal
    let row = store.get("SELECT * FROM outbox WHERE dedup_key LIKE 'delivery:%'")!;
    expect(row.state).toBe('pending');
    expect(Number(row.available_at)).toBeGreaterThan(Date.now());

    // A retry that isn't due yet must never be replayed early.
    await outbox.tick();
    expect(pushCalls(request)).toHaveLength(1);

    store.run('UPDATE outbox SET available_at=? WHERE id=?', Date.now() - 1, row.id);
    await outbox.tick();
    expect(pushCalls(request)).toHaveLength(2);
    row = store.get('SELECT * FROM outbox WHERE id=?', row.id)!;
    expect(row.state).toBe('pending'); // second rejection: still under the cap

    store.run('UPDATE outbox SET available_at=? WHERE id=?', Date.now() - 1, row.id);
    await outbox.tick();
    expect(pushCalls(request)).toHaveLength(3);
    delivery = store.get("SELECT * FROM deliveries WHERE modality='text'")!;
    expect(delivery.state).toBe('failed'); // third rejection hits LINE_RATE_LIMIT_MAX_ATTEMPTS: terminal
    row = store.get('SELECT * FROM outbox WHERE id=?', row.id)!;
    expect(row.state).toBe('failed');
    expect(row.last_error).toBe('LINE_RATE_LIMITED');

    // A terminal row is never picked up again, even once its available_at is past.
    store.run('UPDATE outbox SET available_at=? WHERE id=?', Date.now() - 1, row.id);
    await outbox.tick();
    expect(pushCalls(request)).toHaveLength(3);

    // Every attempt reused the identical delivery id as the LINE retry key — never a fresh id per attempt.
    const keys = pushCalls(request).map(call => (call[1] as RequestInit).headers as Record<string, string>).map(headers => headers['X-Line-Retry-Key']);
    expect(new Set(keys).size).toBe(1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a retry is scheduled from LINE's own Retry-After value, not the fixed backoff, when the header gives a longer wait", async () => {
  const root = mkdtempSync(join(tmpdir(), 'line-retry-after-')), database = join(root, 'state.db');
  const store = new OrchestrationStore(database, 'a');
  const longRetryAfter = () => new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429, headers: { 'retry-after': '10' } });
  const request = lineRequestMock([longRetryAfter()]);
  const outbox = new DeliveryOutbox(store, channelSender(agent, request));
  const decisions = new DecisionService(store, (r, b, text) => outbox.enqueue(r, b, text));
  try {
    const input = store.acceptInput({ scope, text: 'hi' });
    const receipt = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    decisions.finish(receipt, 'reply');

    const before = Date.now();
    await outbox.tick();

    const row = store.get("SELECT * FROM outbox WHERE dedup_key LIKE 'delivery:%'")!;
    expect(row.state).toBe('pending');
    // 10s from Retry-After, not the fixed schedule's 2s first step — the fixed step
    // alone would put available_at just ~2s out, well under this 9s floor.
    expect(Number(row.available_at)).toBeGreaterThanOrEqual(before + 9000);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a rate-limited LINE speech delivery is classified but never retried — resending would re-run TTS synthesis from scratch, not resend the same audio', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const sendCalls: string[] = [];
  const sender = jest.fn(async (_binding: unknown, _text: string, _id: string, _file: unknown, audio: unknown) => {
    sendCalls.push(audio ? 'speech' : 'text');
    return audio ? { state: 'failed' as const, code: 'LINE_RATE_LIMITED', retryAfterMs: 2000 } : { state: 'delivered' as const };
  });
  const outbox = new DeliveryOutbox(store, sender);
  const decisions = new DecisionService(store, (r, b, text) => outbox.enqueue(r, b, text));
  try {
    const input = store.acceptInput({ scope, text: 'hi' });
    const receipt = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    store.transaction(() => outbox.enqueueSpeech(receipt.responseId!, input.bindingId, speech));
    decisions.finish(receipt, 'reply');

    await outbox.tick();

    expect(sendCalls.filter(call => call === 'speech')).toHaveLength(1); // exactly one attempt, unlike text's bounded retry
    const speechRow = store.get("SELECT * FROM deliveries WHERE modality='speech'")!;
    expect(speechRow.state).toBe('failed'); // terminal immediately, never requeued to 'pending'
    const speechOutbox = store.get("SELECT * FROM outbox WHERE dedup_key LIKE 'speech:%'")!;
    expect(speechOutbox.state).toBe('failed');
    expect(speechOutbox.last_error).toBe('LINE_RATE_LIMITED'); // still classified correctly — just never retried
  } finally { store.close(); }
});

test('quota exhaustion is terminal, is never retried, and blocks dependent speech visibly instead of waiting forever', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const request = lineRequestMock([quotaExhausted()]);
  const outbox = new DeliveryOutbox(store, channelSender(agent, request));
  const decisions = new DecisionService(store, (r, b, text) => outbox.enqueue(r, b, text));
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const input = store.acceptInput({ scope, text: 'hi' });
    const receipt = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    // Speech is queued before text resolves, mirroring real generation order.
    store.transaction(() => outbox.enqueueSpeech(receipt.responseId!, input.bindingId, speech));
    decisions.finish(receipt, 'reply');

    await outbox.tick();

    expect(pushCalls(request)).toHaveLength(1); // quota exhaustion never retries and speech never reaches LINE
    const text = store.get("SELECT * FROM deliveries WHERE modality='text'")!;
    expect(text.state).toBe('failed');
    const speechRow = store.get("SELECT * FROM deliveries WHERE modality='speech'")!;
    expect(speechRow.state).toBe('failed');
    const speechOutbox = store.get('SELECT * FROM outbox WHERE dedup_key=?', `speech:${receipt.responseId}`)!;
    expect(speechOutbox.state).toBe('failed');
    expect(speechOutbox.last_error).toBe('TEXT_DELIVERY_FAILED');

    const events = log.mock.calls.map(call => JSON.parse(String(call[0])));
    expect(events).toContainEqual(expect.objectContaining({ event: 'LINE delivery failed', classification: 'quota_exhausted' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'Speech blocked by failed text delivery', referenceId: speechRow.id }));
  } finally { log.mockRestore(); store.close(); }
});

test('a nonzero remaining quota that cannot cover the currently pending LINE group logs an explicit warning', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const request = jest.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes('/message/push')) return rateLimited();
    if (href.includes('/quota/consumption')) return new Response(JSON.stringify({ totalUsage: 997 }));
    if (href.includes('/quota')) return new Response(JSON.stringify({ type: 'limited', value: 1000 }));
    throw new Error(`unexpected url ${href}`);
  });
  // 3 remaining cannot cover the 10 sends this agent still has queued right now.
  const outbox = new DeliveryOutbox(store, channelSender(agent, request, undefined, undefined, () => 10));
  const decisions = new DecisionService(store, (r, b, text) => outbox.enqueue(r, b, text));
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const input = store.acceptInput({ scope, text: 'hi' });
    const receipt = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    decisions.finish(receipt, 'reply');

    await outbox.tick();

    const events = log.mock.calls.map(call => JSON.parse(String(call[0])));
    expect(events).toContainEqual(expect.objectContaining({ event: 'LINE quota insufficient for pending group delivery', remaining: 3, groupSize: 10 }));
  } finally { log.mockRestore(); store.close(); }
});

test('a pending group the remaining quota can still cover never logs the insufficient-group warning', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const request = jest.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes('/message/push')) return rateLimited();
    if (href.includes('/quota/consumption')) return new Response(JSON.stringify({ totalUsage: 0 }));
    if (href.includes('/quota')) return new Response(JSON.stringify({ type: 'limited', value: 1000 }));
    throw new Error(`unexpected url ${href}`);
  });
  const outbox = new DeliveryOutbox(store, channelSender(agent, request, undefined, undefined, () => 10));
  const decisions = new DecisionService(store, (r, b, text) => outbox.enqueue(r, b, text));
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const input = store.acceptInput({ scope, text: 'hi' });
    const receipt = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    decisions.finish(receipt, 'reply');

    await outbox.tick();

    const events = log.mock.calls.map(call => JSON.parse(String(call[0])));
    expect(events.some(event => event.event === 'LINE quota insufficient for pending group delivery')).toBe(false);
  } finally { log.mockRestore(); store.close(); }
});
