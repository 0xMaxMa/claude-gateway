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
  WHATSAPP_CLOUD_MAX_BUTTONS,
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


/**
 * Phase 3 — the Cloud-only send modes: interactive buttons/lists and
 * pre-approved templates. Same fetch-capture harness as above; what is under
 * test is again the exact JSON body Meta is handed, plus the one limit
 * (3 buttons) that is enforced locally instead of being left to Meta.
 */
describe('WhatsAppCloudClient — Phase 3 interactive + templates', () => {
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

  describe('sendInteractiveButtons()', () => {
    test('builds Meta\'s interactive/button payload, one reply object per button', async () => {
      await client.sendInteractiveButtons(TO, 'Pick one', [
        { id: 'yes', title: 'Yes' },
        { id: 'no', title: 'No' },
      ]);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${API_BASE}/${PHONE_NUMBER_ID}/messages`);
      expect(calls[0]!.body).toEqual({
        messaging_product: 'whatsapp',
        to: TO,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Pick one' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
              { type: 'reply', reply: { id: 'no', title: 'No' } },
            ],
          },
        },
      });
    });

    test(`exactly ${WHATSAPP_CLOUD_MAX_BUTTONS} buttons is still allowed (the limit is inclusive)`, async () => {
      await client.sendInteractiveButtons(TO, 'Pick', [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
        { id: 'c', title: 'C' },
      ]);
      expect(calls).toHaveLength(1);
      expect(((calls[0]!.body.interactive as Record<string, unknown>).action as { buttons: unknown[] }).buttons).toHaveLength(3);
    });

    // The point of enforcing locally: Meta rejects a 4th button with an opaque
    // code, so the agent gets a readable reason and a pointer to list messages.
    test('a 4th button is refused locally — no Graph call is made at all', async () => {
      await expect(
        client.sendInteractiveButtons(TO, 'Pick', [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
          { id: 'c', title: 'C' },
          { id: 'd', title: 'D' },
        ]),
      ).rejects.toThrow(/at most 3 buttons, got 4/);
      expect(calls).toHaveLength(0);
    });

    test('the over-limit error points at the list-message alternative', async () => {
      await expect(
        client.sendInteractiveButtons(TO, 'Pick', Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, title: `B${i}` }))),
      ).rejects.toThrow(/sendInteractiveList/);
    });

    test('an empty button list is refused rather than sent as an invalid payload', async () => {
      await expect(client.sendInteractiveButtons(TO, 'Pick', [])).rejects.toThrow(/at least 1 button/);
      expect(calls).toHaveLength(0);
    });

    test('an API error is surfaced to the caller like any other send', async () => {
      respond = () => ({ error: { message: 'invalid button title', code: 131009 } });
      const res = await client.sendInteractiveButtons(TO, 'Pick', [{ id: 'a', title: 'A' }]);
      expect(res.error?.message).toBe('invalid button title');
    });
  });

  describe('sendInteractiveList()', () => {
    test("builds Meta's interactive/list payload, sections passed through as given", async () => {
      const sections = [
        {
          title: 'Morning',
          rows: [
            { id: 'slot-9', title: '09:00', description: 'with Dr. A' },
            { id: 'slot-10', title: '10:00' },
          ],
        },
        { title: 'Afternoon', rows: [{ id: 'slot-14', title: '14:00' }] },
      ];

      await client.sendInteractiveList(TO, 'Choose a time', 'Open slots', sections);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toEqual({
        messaging_product: 'whatsapp',
        to: TO,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: 'Choose a time' },
          action: { button: 'Open slots', sections },
        },
      });
    });

    // Lists are the escape hatch FROM the 3-button ceiling, so they must not
    // inherit any such cap of their own.
    test('a list is not subject to the 3-option button cap', async () => {
      const rows = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` }));
      await client.sendInteractiveList(TO, 'Pick', 'Open', [{ title: 'All', rows }]);
      expect(calls).toHaveLength(1);
      const action = (calls[0]!.body.interactive as Record<string, unknown>).action as {
        sections: Array<{ rows: unknown[] }>;
      };
      expect(action.sections[0]!.rows).toHaveLength(8);
    });
  });

  describe('sendTemplate()', () => {
    test('builds the template payload with the language code nested under `language.code`', async () => {
      await client.sendTemplate(TO, 'appointment_reminder', 'en_US');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toEqual({
        messaging_product: 'whatsapp',
        to: TO,
        type: 'template',
        template: { name: 'appointment_reminder', language: { code: 'en_US' } },
      });
    });

    // `components` is a Meta-shaped array whose required contents depend on the
    // individual template — the client must not reshape or validate it.
    test('components are forwarded verbatim, not reshaped', async () => {
      const components = [
        { type: 'body', parameters: [{ type: 'text', text: 'Alice' }, { type: 'text', text: '3pm' }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'abc123' }] },
      ];
      await client.sendTemplate(TO, 'appointment_reminder', 'th', components);
      expect((calls[0]!.body.template as { components: unknown }).components).toEqual(components);
    });

    test('omitting components leaves the key out of the payload entirely', async () => {
      await client.sendTemplate(TO, 'hello_world', 'en_US', undefined);
      expect(calls[0]!.body.template).not.toHaveProperty('components');
    });

    test('an API error (e.g. template not approved) is surfaced to the caller', async () => {
      respond = () => ({ error: { message: 'template name does not exist', code: 132001 } });
      const res = await client.sendTemplate(TO, 'nope', 'en_US');
      expect(res.error?.message).toBe('template name does not exist');
    });
  });
});
