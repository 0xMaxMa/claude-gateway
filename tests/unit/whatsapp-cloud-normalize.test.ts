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

  test('missing `from` → rejected (null)', () => {
    expect(normalizeWhatsAppCloudMessage({ id: 'wamid.105', type: 'text', text: { body: 'hi' } })).toBeNull();
  });

  test('empty `from` → rejected (null)', () => {
    expect(normalizeWhatsAppCloudMessage({ from: '', id: 'wamid.106', type: 'text', text: { body: 'hi' } })).toBeNull();
  });
});
