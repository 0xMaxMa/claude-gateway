/**
 * Unit tests for the WhatsApp Cloud webhook's pure inbound-parsing logic:
 *  - extractInboundMessages — status-only / messages-less payload → no-op
 *  - normalizeWhatsAppCloudMessage — text/image/document message types,
 *    missing `from` → rejected
 * (src/api/whatsapp-cloud-webhook-router.ts). No network.
 */
import {
  extractInboundMessages,
  normalizeWhatsAppCloudMessage,
} from '../../src/api/whatsapp-cloud-webhook-router';

const FROM = '66812345678';

describe('extractInboundMessages()', () => {
  test('a status-only batch (our own outbound delivery receipts) → no-op', () => {
    expect(extractInboundMessages({ statuses: [{ id: 'wamid.1', status: 'delivered' }] })).toEqual([]);
  });
  test('a value with neither messages nor statuses → no-op', () => {
    expect(extractInboundMessages({ messaging_product: 'whatsapp' })).toEqual([]);
  });
  test('undefined value → no-op', () => {
    expect(extractInboundMessages(undefined)).toEqual([]);
  });
  test('a value with messages → returns them', () => {
    const messages = [{ from: FROM, id: 'wamid.1', type: 'text', text: { body: 'hi' } }];
    expect(extractInboundMessages({ messages })).toEqual(messages);
  });
});

describe('normalizeWhatsAppCloudMessage()', () => {
  test('text message → content + meta, source whatsapp_cloud', () => {
    const out = normalizeWhatsAppCloudMessage({
      from: FROM,
      id: 'wamid.100',
      type: 'text',
      text: { body: 'hello' },
    });
    expect(out).toEqual({
      content: 'hello',
      meta: {
        source: 'whatsapp_cloud',
        chat_id: FROM,
        user_id: FROM,
        user: FROM,
        message_id: 'wamid.100',
      },
    });
  });

  test('image message → content is the caption', () => {
    const out = normalizeWhatsAppCloudMessage({
      from: FROM,
      id: 'wamid.101',
      type: 'image',
      image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'look at this' },
    });
    expect(out?.content).toBe('look at this');
    expect(out?.meta.chat_id).toBe(FROM);
  });

  test('image message with no caption → empty content, not null', () => {
    const out = normalizeWhatsAppCloudMessage({
      from: FROM,
      id: 'wamid.102',
      type: 'image',
      image: { id: 'media-2', mime_type: 'image/jpeg' },
    });
    expect(out).not.toBeNull();
    expect(out?.content).toBe('');
  });

  test('document message → content is the caption', () => {
    const out = normalizeWhatsAppCloudMessage({
      from: FROM,
      id: 'wamid.103',
      type: 'document',
      document: { id: 'media-3', mime_type: 'application/pdf', filename: 'report.pdf', caption: 'the report' },
    });
    expect(out?.content).toBe('the report');
  });

  test('unsupported message type (e.g. audio) → empty content, still forwarded (not dropped)', () => {
    const out = normalizeWhatsAppCloudMessage({
      from: FROM,
      id: 'wamid.104',
      type: 'audio',
    });
    expect(out).not.toBeNull();
    expect(out?.content).toBe('');
    expect(out?.meta.message_id).toBe('wamid.104');
  });

  // ---- Phase 2: reply context, location, contacts, sticker ----------------

  test('quoted message → replied_message_id ONLY (Meta does not inline the quote)', () => {
    const out = normalizeWhatsAppCloudMessage({
      from: FROM,
      id: 'wamid.200',
      type: 'text',
      text: { body: 'yes, that one' },
      context: { id: 'wamid.original' },
    });
    expect(out?.meta.replied_message_id).toBe('wamid.original');
    // A real Cloud API limitation, not a gap in the parser: the webhook payload
    // carries no quoted text and no quoted sender, so these stay unset (Baileys
    // fills all three — see whatsapp-manager.test.ts).
    expect(out?.meta.replied_text).toBeUndefined();
    expect(out?.meta.replied_user).toBeUndefined();
  });

  test('no context → no replied_* keys at all (meta shape unchanged for ordinary messages)', () => {
    const out = normalizeWhatsAppCloudMessage({ from: FROM, id: 'wamid.201', type: 'text', text: { body: 'hi' } });
    expect(Object.keys(out!.meta)).not.toContain('replied_message_id');
  });

  test('location → lat/lng meta plus a human summary as the content', () => {
    const out = normalizeWhatsAppCloudMessage({
      from: FROM,
      id: 'wamid.202',
      type: 'location',
      location: { latitude: 13.7563, longitude: 100.5018, name: 'Grand Palace', address: 'Phra Nakhon, Bangkok' },
    });
    expect(out?.meta.location_lat).toBe('13.7563');
    expect(out?.meta.location_lng).toBe('100.5018');
    expect(out?.content).toBe('Grand Palace, Phra Nakhon, Bangkok');
  });

  test('a bare dropped pin (coords only) → generic summary, coords still in meta', () => {
    const out = normalizeWhatsAppCloudMessage({
      from: FROM,
      id: 'wamid.203',
      type: 'location',
      location: { latitude: 1.5, longitude: -2.25 },
    });
    expect(out?.content).toBe('[Location shared]');
    expect(out?.meta.location_lat).toBe('1.5');
    expect(out?.meta.location_lng).toBe('-2.25');
  });

  test('contact card → a vCard synthesized from Meta’s structured payload', () => {
    const out = normalizeWhatsAppCloudMessage({
      from: FROM,
      id: 'wamid.204',
      type: 'contacts',
      contacts: [
        { name: { formatted_name: 'Ada Lovelace' }, phones: [{ phone: '+66812345678' }] },
      ],
    });
    // Same meta.vcard key Baileys fills with its (already raw) vCard, so the
    // agent never needs channel-specific handling.
    expect(out?.meta.vcard).toBe('BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nTEL:+66812345678\nEND:VCARD');
  });

  test('contact card with neither name nor phone → no vcard key rather than an empty card', () => {
    const out = normalizeWhatsAppCloudMessage({ from: FROM, id: 'wamid.205', type: 'contacts', contacts: [{}] });
    expect(out).not.toBeNull();
    expect(out?.meta.vcard).toBeUndefined();
  });

  test('sticker → forwarded with empty content (the bytes land on meta.sticker_path in the handler)', () => {
    const out = normalizeWhatsAppCloudMessage({
      from: FROM,
      id: 'wamid.206',
      type: 'sticker',
      sticker: { id: 'media-9', mime_type: 'image/webp' },
    });
    expect(out).not.toBeNull();
    expect(out?.content).toBe('');
    expect(out?.meta.image_path).toBeUndefined();
  });

  // Phase 3 — a tap on a button / a pick from a list we sent. The whole point
  // is that it reads to the agent like typed text, so `content` is the DISPLAY
  // TITLE, with the machine-readable id alongside it in meta.
  describe('interactive replies (Phase 3)', () => {
    test('button tap → content is the button title, id lands in meta.interactive_id', () => {
      const out = normalizeWhatsAppCloudMessage({
        from: FROM,
        id: 'wamid.300',
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'confirm_booking', title: 'Yes, confirm' } },
      });
      expect(out).toEqual({
        content: 'Yes, confirm',
        meta: {
          source: 'whatsapp_cloud',
          chat_id: FROM,
          user_id: FROM,
          user: FROM,
          message_id: 'wamid.300',
          interactive_id: 'confirm_booking',
        },
      });
    });

    test('list pick → content is the row title, id lands in meta.interactive_id', () => {
      const out = normalizeWhatsAppCloudMessage({
        from: FROM,
        id: 'wamid.301',
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'slot-1400', title: '14:00', description: 'with Dr. A' },
        },
      });
      expect(out?.content).toBe('14:00');
      expect(out?.meta.interactive_id).toBe('slot-1400');
    });

    // The row description is picker-only chrome (a grey sub-line in the list
    // UI); the agent gets the title the user actually chose, not the blurb.
    test("a list row's description is not folded into content", () => {
      const out = normalizeWhatsAppCloudMessage({
        from: FROM,
        id: 'wamid.302',
        type: 'interactive',
        interactive: { list_reply: { id: 'r1', title: 'Standard', description: 'ships in 5 days' } },
      });
      expect(out?.content).toBe('Standard');
    });

    test('button_reply wins when both shapes are somehow present', () => {
      const out = normalizeWhatsAppCloudMessage({
        from: FROM,
        id: 'wamid.303',
        type: 'interactive',
        interactive: {
          button_reply: { id: 'btn', title: 'From button' },
          list_reply: { id: 'row', title: 'From list' },
        },
      });
      expect(out?.content).toBe('From button');
      expect(out?.meta.interactive_id).toBe('btn');
    });

    // An unknown future interactive sub-type (nfm_reply, flows, ...) must
    // still forward the turn rather than drop it — same posture as the
    // audio/video types.
    test('an interactive payload with no recognized reply → forwarded with empty content, no id', () => {
      const out = normalizeWhatsAppCloudMessage({
        from: FROM,
        id: 'wamid.304',
        type: 'interactive',
        interactive: { type: 'nfm_reply' },
      });
      expect(out).not.toBeNull();
      expect(out?.content).toBe('');
      expect(out?.meta.interactive_id).toBeUndefined();
    });

    test('a plain text message never gets an interactive_id', () => {
      const out = normalizeWhatsAppCloudMessage({ from: FROM, id: 'wamid.305', type: 'text', text: { body: 'hi' } });
      expect(out?.meta.interactive_id).toBeUndefined();
    });
  });

  test('missing `from` → rejected (null)', () => {
    expect(normalizeWhatsAppCloudMessage({ id: 'wamid.105', type: 'text', text: { body: 'hi' } })).toBeNull();
  });

  test('empty `from` → rejected (null)', () => {
    expect(normalizeWhatsAppCloudMessage({ from: '', id: 'wamid.106', type: 'text', text: { body: 'hi' } })).toBeNull();
  });
});
