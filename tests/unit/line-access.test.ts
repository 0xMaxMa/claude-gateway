/**
 * Unit tests for the LINE DM access gate (src/api/line-access.ts).
 * Pure logic, no network. Closed-by-default posture (matches hermes/openclaw).
 */
import { isLineSenderAllowed, isLineConversationAllowed, resolveLineSource } from '../../src/api/line-access';

const U = 'Ub3b856bfb309cf5717a305d0df1e846b';
const G = 'Cf3a9c0000000000000000000000000000';
const R = 'Re8f1d0000000000000000000000000000';

describe('isLineSenderAllowed()', () => {
  describe("policy 'open' → allow everyone", () => {
    test('listed or not, always true', () => {
      expect(isLineSenderAllowed('open', [], U)).toBe(true);
      expect(isLineSenderAllowed('open', ['Uother'], U)).toBe(true);
      expect(isLineSenderAllowed('open', undefined, U)).toBe(true);
    });
    test('even an empty userId passes (group source drops later in normalize)', () => {
      expect(isLineSenderAllowed('open', [], '')).toBe(true);
    });
  });

  describe("policy 'disabled' → deny everyone", () => {
    test('always false, even if in the list', () => {
      expect(isLineSenderAllowed('disabled', [U], U)).toBe(false);
      expect(isLineSenderAllowed('disabled', [], U)).toBe(false);
    });
  });

  describe("policy 'allowlist' → only listed senders", () => {
    test('id in list → true', () => {
      expect(isLineSenderAllowed('allowlist', [U, 'Uother'], U)).toBe(true);
    });
    test('id not in list → false', () => {
      expect(isLineSenderAllowed('allowlist', ['Uother'], U)).toBe(false);
    });
    test('empty or undefined list → false', () => {
      expect(isLineSenderAllowed('allowlist', [], U)).toBe(false);
      expect(isLineSenderAllowed('allowlist', undefined, U)).toBe(false);
    });
  });

  describe('policy undefined → closed default (allowlist semantics)', () => {
    test('id in list → true', () => {
      expect(isLineSenderAllowed(undefined, [U], U)).toBe(true);
    });
    test('id not in list / empty / undefined list → false', () => {
      expect(isLineSenderAllowed(undefined, ['Uother'], U)).toBe(false);
      expect(isLineSenderAllowed(undefined, [], U)).toBe(false);
      expect(isLineSenderAllowed(undefined, undefined, U)).toBe(false);
    });
  });

  describe('empty userId', () => {
    test('false under closed/allowlist even if "" somehow in the list', () => {
      expect(isLineSenderAllowed(undefined, [''], '')).toBe(false);
      expect(isLineSenderAllowed('allowlist', [''], '')).toBe(false);
    });
  });

  describe('case sensitivity (LINE userIds are case-sensitive)', () => {
    test('different case → not a match', () => {
      expect(isLineSenderAllowed('allowlist', [U.toUpperCase()], U)).toBe(false);
      expect(isLineSenderAllowed('allowlist', [U.toLowerCase()], U)).toBe(false);
    });
  });
});

describe('resolveLineSource()', () => {
  test('user → conversationId = senderId = userId', () => {
    expect(resolveLineSource({ type: 'user', userId: U })).toEqual({
      conversationId: U, senderId: U, kind: 'user',
    });
  });
  test('group → conversationId = groupId, senderId = userId', () => {
    expect(resolveLineSource({ type: 'group', groupId: G, userId: U })).toEqual({
      conversationId: G, senderId: U, kind: 'group',
    });
  });
  test('group without userId (no profile consent) → senderId empty', () => {
    expect(resolveLineSource({ type: 'group', groupId: G })).toEqual({
      conversationId: G, senderId: '', kind: 'group',
    });
  });
  test('room → conversationId = roomId', () => {
    expect(resolveLineSource({ type: 'room', roomId: R, userId: U })).toEqual({
      conversationId: R, senderId: U, kind: 'room',
    });
  });
  test('unknown / missing → other', () => {
    expect(resolveLineSource(undefined).kind).toBe('other');
    expect(resolveLineSource({ type: 'something' }).kind).toBe('other');
  });
});

describe('isLineConversationAllowed()', () => {
  test('user source uses dmPolicy/dmAllowlist (unchanged DM behavior)', () => {
    expect(isLineConversationAllowed({ dmPolicy: 'open' }, { type: 'user', userId: U })).toBe(true);
    expect(isLineConversationAllowed({ dmAllowlist: [U] }, { type: 'user', userId: U })).toBe(true);
    expect(isLineConversationAllowed({}, { type: 'user', userId: U })).toBe(false); // closed default
    expect(isLineConversationAllowed({ dmPolicy: 'disabled', dmAllowlist: [U] }, { type: 'user', userId: U })).toBe(false);
  });
  test('group source uses groupPolicy/groupAllowlist, NOT dm fields', () => {
    expect(isLineConversationAllowed({ groupAllowlist: [G] }, { type: 'group', groupId: G, userId: U })).toBe(true);
    expect(isLineConversationAllowed({ groupPolicy: 'open' }, { type: 'group', groupId: G })).toBe(true);
    expect(isLineConversationAllowed({}, { type: 'group', groupId: G })).toBe(false); // closed default
    expect(isLineConversationAllowed({ groupPolicy: 'disabled', groupAllowlist: [G] }, { type: 'group', groupId: G })).toBe(false);
    // DM allowlist must NOT grant group access:
    expect(isLineConversationAllowed({ dmPolicy: 'open' }, { type: 'group', groupId: G })).toBe(false);
  });
  test('room source gated on groupAllowlist (shared with groups)', () => {
    expect(isLineConversationAllowed({ groupAllowlist: [R] }, { type: 'room', roomId: R })).toBe(true);
    expect(isLineConversationAllowed({}, { type: 'room', roomId: R })).toBe(false);
  });
  test('unknown source kind → denied', () => {
    expect(isLineConversationAllowed({ dmPolicy: 'open', groupPolicy: 'open' }, { type: 'x' })).toBe(false);
  });
});
