/**
 * Unit tests for the outbound WhatsApp Cloud client
 * (src/api/whatsapp-cloud-client.ts) — Phase 2 of the WhatsApp feature-parity
 * plan: long-text chunking, quote-replies, read receipts and reactions.
 *
 * `fetch` is mocked at the global level (same approach as
 * tests/unit/whatsapp-mcp.test.ts) and every request body is captured, because
 * what matters here is the exact JSON shape Meta's Graph API is handed.
 */
import {
  WhatsAppCloudClient,
  WHATSAPP_CLOUD_MAX_TEXT_CHARS,
  WHATSAPP_ACK_EMOJI,
} from '../../src/api/whatsapp-cloud-client';

const PHONE_NUMBER_ID = '1234567890';
const TO = '66812345678';
const API_BASE = 'https://graph.test/v20.0';

describe('WhatsAppCloudClient — Phase 2 outbound', () => {
  const realFetch = global.fetch;
  let calls: Array<{ url: string; body: Record<string, unknown> }>;
  let respond: () => Record<string, unknown>;
  let client: WhatsAppCloudClient;

  beforeEach(() => {
    calls = [];
    respond = () => ({ messages: [{ id: 'wamid.out' }] });
    global.fetch = (async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return { ok: true, json: async () => respond() } as Response;
    }) as typeof fetch;
    client = new WhatsAppCloudClient({
      accessToken: 'test-token',
      phoneNumberId: PHONE_NUMBER_ID,
      logDir: '/tmp',
      apiBase: API_BASE,
    });
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('sendText() chunking', () => {
    test('a short message is still exactly one Graph call, unchanged', async () => {
      await client.sendText(TO, 'hello');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${API_BASE}/${PHONE_NUMBER_ID}/messages`);
      expect(calls[0]!.body).toEqual({
        messaging_product: 'whatsapp',
        to: TO,
        type: 'text',
        text: { body: 'hello' },
      });
    });

    test('a body over the 4096-char cap becomes several calls, each within the cap', async () => {
      const long = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
      expect(long.length).toBeGreaterThan(WHATSAPP_CLOUD_MAX_TEXT_CHARS);

      await client.sendText(TO, long);

      expect(calls.length).toBeGreaterThan(1);
      const bodies = calls.map((c) => (c.body.text as { body: string }).body);
      for (const b of bodies) expect(b.length).toBeLessThanOrEqual(WHATSAPP_CLOUD_MAX_TEXT_CHARS);
      // Nothing is dropped — the cuts only ate the whitespace they replaced.
      expect(bodies.join(' ')).toBe(long);
    });

    test('an empty body still makes the one call it always did', async () => {
      await client.sendText(TO, '');
      expect(calls).toHaveLength(1);
      expect((calls[0]!.body.text as { body: string }).body).toBe('');
    });

    test('a chunk that errors stops the run and surfaces the error to the caller', async () => {
      const long = 'z'.repeat(WHATSAPP_CLOUD_MAX_TEXT_CHARS * 3);
      respond = () => ({ error: { message: 'rate limited', code: 131056 } });

      const out = await client.sendText(TO, long);

      expect(out.error?.message).toBe('rate limited');
      // Stopped after the first failure rather than hammering the API with the
      // remaining chunks.
      expect(calls).toHaveLength(1);
    });
  });

  describe('sendText() quote-reply', () => {
    test('quotedMessageId attaches Meta’s outbound context object', async () => {
      await client.sendText(TO, 'answering that', 'wamid.inbound');
      expect(calls[0]!.body.context).toEqual({ message_id: 'wamid.inbound' });
    });

    test('only the FIRST chunk quotes — follow-ups are plain', async () => {
      const long = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
      await client.sendText(TO, long, 'wamid.inbound');
      expect(calls.length).toBeGreaterThan(1);
      expect(calls[0]!.body.context).toEqual({ message_id: 'wamid.inbound' });
      for (const c of calls.slice(1)) expect(c.body.context).toBeUndefined();
    });

    test('no quotedMessageId → no context key at all (unchanged v1 body)', async () => {
      await client.sendText(TO, 'plain');
      expect(Object.keys(calls[0]!.body)).not.toContain('context');
    });
  });

  describe('markAsRead()', () => {
    test('posts the read status for the inbound message id', async () => {
      await client.markAsRead('wamid.inbound');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toEqual({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: 'wamid.inbound',
      });
    });

    test('best-effort: an API error resolves quietly instead of throwing', async () => {
      respond = () => ({ error: { message: 'message not found', code: 100 } });
      await expect(client.markAsRead('wamid.gone')).resolves.toBeUndefined();
    });
  });

  describe('sendReaction() / removeReaction()', () => {
    test('adds the shared ⏳ ack emoji by default', async () => {
      await client.sendReaction(TO, 'wamid.inbound');
      expect(calls[0]!.body).toEqual({
        messaging_product: 'whatsapp',
        to: TO,
        type: 'reaction',
        reaction: { message_id: 'wamid.inbound', emoji: WHATSAPP_ACK_EMOJI },
      });
    });

    test('an explicit emoji overrides the default', async () => {
      await client.sendReaction(TO, 'wamid.inbound', '👍');
      expect((calls[0]!.body.reaction as { emoji: string }).emoji).toBe('👍');
    });

    test('removeReaction clears via the empty-emoji form of the same endpoint', async () => {
      await client.removeReaction(TO, 'wamid.inbound');
      expect(calls[0]!.body).toEqual({
        messaging_product: 'whatsapp',
        to: TO,
        type: 'reaction',
        reaction: { message_id: 'wamid.inbound', emoji: '' },
      });
    });

    test('best-effort: an API error resolves quietly instead of throwing', async () => {
      respond = () => ({ error: { message: 'reaction failed', code: 131009 } });
      await expect(client.sendReaction(TO, 'wamid.x')).resolves.toBeUndefined();
      await expect(client.removeReaction(TO, 'wamid.x')).resolves.toBeUndefined();
    });
  });
});
