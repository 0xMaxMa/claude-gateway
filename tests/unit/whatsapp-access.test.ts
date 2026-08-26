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

  test('DM under LID privacy (remoteJid ends @lid) → kind user, senderId prefers senderPn', () => {
    const lid = '30271718084720@lid';
    expect(resolveWhatsAppSource({ key: { remoteJid: lid, senderPn: USER } })).toEqual({
      conversationId: lid, // reply on the JID we actually received the message on
      senderId: USER, // gate on the real phone-number JID, matching allowlist entries
      kind: 'user',
      mentionedJids: [],
    });
  });

  test('DM under LID privacy without senderPn → falls back to the @lid JID (never dropped as "other")', () => {
    const lid = '30271718084720@lid';
    expect(resolveWhatsAppSource({ key: { remoteJid: lid } })).toEqual({
      conversationId: lid,
      senderId: lid,
      kind: 'user',
      mentionedJids: [],
    });
  });

  test('group participant under LID privacy → senderId prefers participantPn', () => {
    const lidParticipant = '30271718084720@lid';
    const resolved = resolveWhatsAppSource({
      key: { remoteJid: GROUP, participant: lidParticipant, participantPn: USER },
    });
    expect(resolved).toEqual({
      conversationId: GROUP,
      senderId: USER,
      kind: 'group',
      mentionedJids: [],
    });
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

  describe('LID privacy — bot mentioned by its @lid identity', () => {
    const BOT_LID = '99988877766@lid';
    test('mentionedJid carries the bot LID, not its phone JID → true when botLid is passed', () => {
      expect(wasBotMentioned([BOT_LID], BOT_JID, BOT_LID)).toBe(true);
    });
    test('mentionedJid carries the bot LID but botLid was not passed → false (cannot match)', () => {
      expect(wasBotMentioned([BOT_LID], BOT_JID)).toBe(false);
    });
    test('either identity still matches its own form (phone JID mention still works when botLid is also known)', () => {
      expect(wasBotMentioned([BOT_JID], BOT_JID, BOT_LID)).toBe(true);
    });
    test('mention is some other LID entirely → false', () => {
      expect(wasBotMentioned(['11122233344@lid'], BOT_JID, BOT_LID)).toBe(false);
    });
    test('no botJid but botLid known → still matches on LID', () => {
      expect(wasBotMentioned([BOT_LID], undefined, BOT_LID)).toBe(true);
    });
  });
});
