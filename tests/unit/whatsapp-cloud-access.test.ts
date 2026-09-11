/**
 * Unit tests for the WhatsApp Cloud DM access gate
 * (src/api/whatsapp-cloud-access.ts). Pure logic, no network. Closed-by-default
 * posture — ports slack-access.test.ts's DM-tier cases; this channel is
 * DM-only (no group concept on the Cloud API), so there are no group cases
 * to port.
 */
import {
  isWhatsAppCloudSenderAllowed,
  resolveWhatsAppCloudSource,
  isResolvedWhatsAppCloudSourceAllowed,
} from '../../src/api/whatsapp-cloud-access';

const PHONE = '66812345678';

describe('isWhatsAppCloudSenderAllowed()', () => {
  describe("policy 'open' → allow everyone", () => {
    test('listed or not, always true', () => {
      expect(isWhatsAppCloudSenderAllowed('open', [], PHONE)).toBe(true);
      expect(isWhatsAppCloudSenderAllowed('open', ['999'], PHONE)).toBe(true);
      expect(isWhatsAppCloudSenderAllowed('open', undefined, PHONE)).toBe(true);
    });
    test('even an empty id passes', () => {
      expect(isWhatsAppCloudSenderAllowed('open', [], '')).toBe(true);
    });
  });

  describe("policy 'disabled' → deny everyone", () => {
    test('always false, even if in the list', () => {
      expect(isWhatsAppCloudSenderAllowed('disabled', [PHONE], PHONE)).toBe(false);
      expect(isWhatsAppCloudSenderAllowed('disabled', [], PHONE)).toBe(false);
    });
  });

  describe("policy 'allowlist' → only listed ids", () => {
    test('id in list → true', () => {
      expect(isWhatsAppCloudSenderAllowed('allowlist', [PHONE, '999'], PHONE)).toBe(true);
    });
    test('id not in list → false', () => {
      expect(isWhatsAppCloudSenderAllowed('allowlist', ['999'], PHONE)).toBe(false);
    });
    test('empty or undefined list → false', () => {
      expect(isWhatsAppCloudSenderAllowed('allowlist', [], PHONE)).toBe(false);
      expect(isWhatsAppCloudSenderAllowed('allowlist', undefined, PHONE)).toBe(false);
    });
  });

  describe('policy undefined → closed default (allowlist semantics)', () => {
    test('id in list → true', () => {
      expect(isWhatsAppCloudSenderAllowed(undefined, [PHONE], PHONE)).toBe(true);
    });
    test('id not in list / empty / undefined list → false', () => {
      expect(isWhatsAppCloudSenderAllowed(undefined, ['999'], PHONE)).toBe(false);
      expect(isWhatsAppCloudSenderAllowed(undefined, [], PHONE)).toBe(false);
      expect(isWhatsAppCloudSenderAllowed(undefined, undefined, PHONE)).toBe(false);
    });
  });

  describe('empty id', () => {
    test('false under closed/allowlist even if "" somehow in the list', () => {
      expect(isWhatsAppCloudSenderAllowed(undefined, [''], '')).toBe(false);
      expect(isWhatsAppCloudSenderAllowed('allowlist', [''], '')).toBe(false);
    });
  });

  // Footgun regression: allowlist entries must be bare digits, not a JID or a
  // "+"-prefixed E.164 string — see the module's own doc comment.
  describe('JID/"+"-prefixed entries never match a bare-digit sender', () => {
    test('a JID in the allowlist does not match the bare phone number', () => {
      expect(isWhatsAppCloudSenderAllowed('allowlist', [`${PHONE}@s.whatsapp.net`], PHONE)).toBe(false);
    });
    test('a "+"-prefixed E.164 entry does not match the bare phone number', () => {
      expect(isWhatsAppCloudSenderAllowed('allowlist', [`+${PHONE}`], PHONE)).toBe(false);
    });
  });
});

describe('resolveWhatsAppCloudSource()', () => {
  test('a bare phone number → conversationId = senderId = the number, kind user', () => {
    expect(resolveWhatsAppCloudSource(PHONE)).toEqual({
      conversationId: PHONE, senderId: PHONE, kind: 'user',
    });
  });
  test('missing/empty from → other', () => {
    expect(resolveWhatsAppCloudSource(undefined)).toEqual({ conversationId: '', senderId: '', kind: 'other' });
    expect(resolveWhatsAppCloudSource(null)).toEqual({ conversationId: '', senderId: '', kind: 'other' });
    expect(resolveWhatsAppCloudSource('')).toEqual({ conversationId: '', senderId: '', kind: 'other' });
  });
});

describe('isResolvedWhatsAppCloudSourceAllowed()', () => {
  test('user source uses dmPolicy/dmAllowlist keyed on the sender phone number', () => {
    expect(isResolvedWhatsAppCloudSourceAllowed({ dmPolicy: 'open' }, resolveWhatsAppCloudSource(PHONE))).toBe(true);
    expect(isResolvedWhatsAppCloudSourceAllowed({ dmAllowlist: [PHONE] }, resolveWhatsAppCloudSource(PHONE))).toBe(true);
    expect(isResolvedWhatsAppCloudSourceAllowed({}, resolveWhatsAppCloudSource(PHONE))).toBe(false); // closed default
    expect(isResolvedWhatsAppCloudSourceAllowed({ dmPolicy: 'disabled', dmAllowlist: [PHONE] }, resolveWhatsAppCloudSource(PHONE))).toBe(false);
  });
  test('unknown/"other" source kind → denied', () => {
    expect(isResolvedWhatsAppCloudSourceAllowed({ dmPolicy: 'open' }, { conversationId: '', senderId: '', kind: 'other' })).toBe(false);
  });
});
