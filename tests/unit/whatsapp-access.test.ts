/**
 * Unit tests for the WhatsApp DM/group access gate (src/api/whatsapp-access.ts).
 * Pure logic, no network. Mirrors tests/unit/slack-access.test.ts's coverage
 * and structure (Slack is the right template here — both tiers, unlike
 * SMS's DM-only gate).
 */
import {
  isWhatsAppSenderAllowed,
  isWhatsAppConversationAllowed,
  resolveWhatsAppSource,
  wasBotMentioned,
} from '../../src/api/whatsapp-access';

const USER = '66812345678@s.whatsapp.net';
const OTHER_USER = '66898765432@s.whatsapp.net';
const GROUP = '123456789-987654321@g.us';
const BOT_JID = '66811112222@s.whatsapp.net';

describe('isWhatsAppSenderAllowed()', () => {
  describe("policy 'open' → allow everyone", () => {
    test('listed or not, always true', () => {
      expect(isWhatsAppSenderAllowed('open', [], USER)).toBe(true);
      expect(isWhatsAppSenderAllowed('open', [OTHER_USER], USER)).toBe(true);
      expect(isWhatsAppSenderAllowed('open', undefined, USER)).toBe(true);
    });
    test('even an empty id passes', () => {
      expect(isWhatsAppSenderAllowed('open', [], '')).toBe(true);
    });
  });

  describe("policy 'disabled' → deny everyone", () => {
    test('always false, even if in the list', () => {
      expect(isWhatsAppSenderAllowed('disabled', [USER], USER)).toBe(false);
      expect(isWhatsAppSenderAllowed('disabled', [], USER)).toBe(false);
    });
  });

  describe("policy 'allowlist' → only listed ids", () => {
    test('id in list → true', () => {
      expect(isWhatsAppSenderAllowed('allowlist', [USER, OTHER_USER], USER)).toBe(true);
    });
    test('id not in list → false', () => {
      expect(isWhatsAppSenderAllowed('allowlist', [OTHER_USER], USER)).toBe(false);
    });
    test('empty or undefined list → false', () => {
      expect(isWhatsAppSenderAllowed('allowlist', [], USER)).toBe(false);
      expect(isWhatsAppSenderAllowed('allowlist', undefined, USER)).toBe(false);
    });
  });

  describe('policy undefined → closed default (allowlist semantics)', () => {
    test('id in list → true', () => {
      expect(isWhatsAppSenderAllowed(undefined, [USER], USER)).toBe(true);
    });
    test('id not in list / empty / undefined list → false', () => {
      expect(isWhatsAppSenderAllowed(undefined, [OTHER_USER], USER)).toBe(false);
      expect(isWhatsAppSenderAllowed(undefined, [], USER)).toBe(false);
      expect(isWhatsAppSenderAllowed(undefined, undefined, USER)).toBe(false);
    });
  });
});

describe('resolveWhatsAppSource()', () => {
  test('DM (remoteJid ends @s.whatsapp.net) → conversationId = senderId = the JID', () => {
    expect(resolveWhatsAppSource({ key: { remoteJid: USER } })).toEqual({
      conversationId: USER,
      senderId: USER,
      kind: 'user',
      mentionedJids: [],
    });
  });

  test('group (remoteJid ends @g.us) → conversationId = group JID, senderId = participant', () => {
    expect(resolveWhatsAppSource({ key: { remoteJid: GROUP, participant: USER } })).toEqual({
      conversationId: GROUP,
      senderId: USER,
      kind: 'group',
      mentionedJids: [],
    });
  });

  test('group message without a participant → other (malformed, cannot resolve a sender)', () => {
    expect(resolveWhatsAppSource({ key: { remoteJid: GROUP } }).kind).toBe('other');
  });

  test('extracts mentionedJid from extendedTextMessage', () => {
    const resolved = resolveWhatsAppSource({
      key: { remoteJid: GROUP, participant: USER },
      message: { extendedTextMessage: { contextInfo: { mentionedJid: [BOT_JID] } } },
    });
    expect(resolved.mentionedJids).toEqual([BOT_JID]);
  });

  test('extracts mentionedJid from imageMessage when extendedTextMessage is absent', () => {
    const resolved = resolveWhatsAppSource({
      key: { remoteJid: GROUP, participant: USER },
      message: { imageMessage: { contextInfo: { mentionedJid: [BOT_JID] } } },
    });
    expect(resolved.mentionedJids).toEqual([BOT_JID]);
  });

  test('missing/empty remoteJid → other', () => {
    expect(resolveWhatsAppSource({ key: { remoteJid: '' } }).kind).toBe('other');
    expect(resolveWhatsAppSource(undefined).kind).toBe('other');
    expect(resolveWhatsAppSource(null).kind).toBe('other');
  });

  test('an unrecognized JID suffix (broadcast/status/newsletter) → other', () => {
    expect(resolveWhatsAppSource({ key: { remoteJid: 'status@broadcast' } }).kind).toBe('other');
  });
});

describe('isWhatsAppConversationAllowed()', () => {
  test('user (DM) source uses dmPolicy/dmAllowlist keyed on the sender JID', () => {
    expect(isWhatsAppConversationAllowed({ dmPolicy: 'open' }, { key: { remoteJid: USER } })).toBe(true);
    expect(isWhatsAppConversationAllowed({ dmAllowlist: [USER] }, { key: { remoteJid: USER } })).toBe(true);
    expect(isWhatsAppConversationAllowed({}, { key: { remoteJid: USER } })).toBe(false); // closed default
    expect(
      isWhatsAppConversationAllowed({ dmPolicy: 'disabled', dmAllowlist: [USER] }, { key: { remoteJid: USER } }),
    ).toBe(false);
  });

  test('group source uses groupPolicy/groupAllowlist keyed on the group JID, NOT dm fields', () => {
    const msg = { key: { remoteJid: GROUP, participant: USER } };
    expect(isWhatsAppConversationAllowed({ groupAllowlist: [GROUP] }, msg)).toBe(true);
    expect(isWhatsAppConversationAllowed({ groupPolicy: 'open' }, msg)).toBe(true);
    expect(isWhatsAppConversationAllowed({}, msg)).toBe(false); // closed default
    expect(isWhatsAppConversationAllowed({ groupPolicy: 'disabled', groupAllowlist: [GROUP] }, msg)).toBe(false);
    // DM allowlist must NOT grant group access:
    expect(isWhatsAppConversationAllowed({ dmPolicy: 'open' }, msg)).toBe(false);
  });

  test('unknown source kind → denied', () => {
    expect(isWhatsAppConversationAllowed({ dmPolicy: 'open', groupPolicy: 'open' }, { key: { remoteJid: '' } })).toBe(
      false,
    );
  });
});

describe('wasBotMentioned()', () => {
  test('bot JID present in the mentioned list → true', () => {
    expect(wasBotMentioned([BOT_JID], BOT_JID)).toBe(true);
  });
  test('bot JID absent → false', () => {
    expect(wasBotMentioned([USER], BOT_JID)).toBe(false);
    expect(wasBotMentioned([], BOT_JID)).toBe(false);
  });
  test('normalizes away a ":<device>" suffix on either side before comparing', () => {
    expect(wasBotMentioned([`${BOT_JID.split('@')[0]}:5@s.whatsapp.net`], BOT_JID)).toBe(true);
    expect(wasBotMentioned([BOT_JID], `${BOT_JID.split('@')[0]}:5@s.whatsapp.net`)).toBe(true);
  });
  test('no bot JID configured → false (never claim a mention without knowing our own identity)', () => {
    expect(wasBotMentioned([BOT_JID], undefined)).toBe(false);
  });
});
