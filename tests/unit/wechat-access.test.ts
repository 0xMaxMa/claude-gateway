/**
 * Unit tests for the WeChat DM access gate (src/api/wechat-access.ts).
 * Pure logic, no network. Closed-by-default posture (matches every other
 * allowlisted channel — LINE/Slack/Discord/Telegram).
 */
import {
  isWeChatSenderAllowed,
  isWeChatConversationAllowed,
  isResolvedSourceAllowed,
  resolveWeChatSource,
} from '../../src/api/wechat-access';

const A = 'ilink-user-aaaa';
const B = 'ilink-user-bbbb';

describe('isWeChatSenderAllowed()', () => {
  describe("policy 'open' → allow everyone", () => {
    test('listed or not, always true', () => {
      expect(isWeChatSenderAllowed('open', [], A)).toBe(true);
      expect(isWeChatSenderAllowed('open', [B], A)).toBe(true);
      expect(isWeChatSenderAllowed('open', undefined, A)).toBe(true);
    });
  });

  describe("policy 'disabled' → deny everyone", () => {
    test('always false, even if in the list', () => {
      expect(isWeChatSenderAllowed('disabled', [A], A)).toBe(false);
      expect(isWeChatSenderAllowed('disabled', [], A)).toBe(false);
    });
  });

  describe("policy 'allowlist' → only listed senders", () => {
    test('id in list → true', () => {
      expect(isWeChatSenderAllowed('allowlist', [A, B], A)).toBe(true);
    });
    test('id not in list → false', () => {
      expect(isWeChatSenderAllowed('allowlist', [B], A)).toBe(false);
    });
    test('empty or undefined list → false', () => {
      expect(isWeChatSenderAllowed('allowlist', [], A)).toBe(false);
      expect(isWeChatSenderAllowed('allowlist', undefined, A)).toBe(false);
    });
  });

  describe('policy undefined → closed default (allowlist semantics)', () => {
    test('id in list → true', () => {
      expect(isWeChatSenderAllowed(undefined, [A], A)).toBe(true);
    });
    test('id not in list / empty / undefined list → false', () => {
      expect(isWeChatSenderAllowed(undefined, [B], A)).toBe(false);
      expect(isWeChatSenderAllowed(undefined, [], A)).toBe(false);
      expect(isWeChatSenderAllowed(undefined, undefined, A)).toBe(false);
    });
  });

  test("policy 'open' passes even an empty senderId (an unresolved source is filtered later, by resolveWeChatSource/isResolvedSourceAllowed)", () => {
    expect(isWeChatSenderAllowed('open', [], '')).toBe(true);
  });
});

describe('resolveWeChatSource()', () => {
  test('maps fromId to both conversationId and senderId', () => {
    expect(resolveWeChatSource({ fromId: A })).toEqual({ conversationId: A, senderId: A });
  });
  test('missing/null message resolves to empty ids', () => {
    expect(resolveWeChatSource(undefined)).toEqual({ conversationId: '', senderId: '' });
    expect(resolveWeChatSource(null)).toEqual({ conversationId: '', senderId: '' });
    expect(resolveWeChatSource({})).toEqual({ conversationId: '', senderId: '' });
  });
});

describe('isResolvedSourceAllowed() / isWeChatConversationAllowed()', () => {
  test('denies when senderId resolves empty, regardless of policy', () => {
    expect(isResolvedSourceAllowed({ dmPolicy: 'open' }, { conversationId: '', senderId: '' })).toBe(
      false,
    );
  });

  test('end-to-end: allowlisted sender passes, unlisted sender is denied', () => {
    const cfg = { dmPolicy: 'allowlist' as const, dmAllowlist: [A] };
    expect(isWeChatConversationAllowed(cfg, { fromId: A })).toBe(true);
    expect(isWeChatConversationAllowed(cfg, { fromId: B })).toBe(false);
  });

  test('end-to-end: closed default (no dmPolicy) denies an unlisted sender', () => {
    expect(isWeChatConversationAllowed(undefined, { fromId: A })).toBe(false);
  });

  test('end-to-end: open policy allows any sender', () => {
    expect(isWeChatConversationAllowed({ dmPolicy: 'open' }, { fromId: B })).toBe(true);
  });
});
