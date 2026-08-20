/**
 * Unit tests for the Slack DM/channel access gate (src/api/slack-access.ts).
 * Pure logic, no network. Closed-by-default posture — mirrors
 * tests/unit/line-access.test.ts's coverage and structure exactly.
 */
import {
  isSlackSenderAllowed,
  isSlackConversationAllowed,
  resolveSlackSource,
} from '../../src/api/slack-access';

const U = 'U0123456789';
const D = 'D0123456789'; // DM channel id (distinct from the user id in Slack)
const C = 'C0123456789'; // public/private channel id

describe('isSlackSenderAllowed()', () => {
  describe("policy 'open' → allow everyone", () => {
    test('listed or not, always true', () => {
      expect(isSlackSenderAllowed('open', [], U)).toBe(true);
      expect(isSlackSenderAllowed('open', ['Uother'], U)).toBe(true);
      expect(isSlackSenderAllowed('open', undefined, U)).toBe(true);
    });
    test('even an empty id passes', () => {
      expect(isSlackSenderAllowed('open', [], '')).toBe(true);
    });
  });

  describe("policy 'disabled' → deny everyone", () => {
    test('always false, even if in the list', () => {
      expect(isSlackSenderAllowed('disabled', [U], U)).toBe(false);
      expect(isSlackSenderAllowed('disabled', [], U)).toBe(false);
    });
  });

  describe("policy 'allowlist' → only listed ids", () => {
    test('id in list → true', () => {
      expect(isSlackSenderAllowed('allowlist', [U, 'Uother'], U)).toBe(true);
    });
    test('id not in list → false', () => {
      expect(isSlackSenderAllowed('allowlist', ['Uother'], U)).toBe(false);
    });
    test('empty or undefined list → false', () => {
      expect(isSlackSenderAllowed('allowlist', [], U)).toBe(false);
      expect(isSlackSenderAllowed('allowlist', undefined, U)).toBe(false);
    });
  });

  describe('policy undefined → closed default (allowlist semantics)', () => {
    test('id in list → true', () => {
      expect(isSlackSenderAllowed(undefined, [U], U)).toBe(true);
    });
    test('id not in list / empty / undefined list → false', () => {
      expect(isSlackSenderAllowed(undefined, ['Uother'], U)).toBe(false);
      expect(isSlackSenderAllowed(undefined, [], U)).toBe(false);
      expect(isSlackSenderAllowed(undefined, undefined, U)).toBe(false);
    });
  });

  describe('empty id', () => {
    test('false under closed/allowlist even if "" somehow in the list', () => {
      expect(isSlackSenderAllowed(undefined, [''], '')).toBe(false);
      expect(isSlackSenderAllowed('allowlist', [''], '')).toBe(false);
    });
  });
});

describe('resolveSlackSource()', () => {
  test('im (DM) → conversationId = DM channel id, senderId = user id', () => {
    expect(resolveSlackSource({ channel_type: 'im', channel: D, user: U })).toEqual({
      conversationId: D, senderId: U, kind: 'user',
    });
  });
  test('channel → conversationId = senderId inputs preserved, kind group', () => {
    expect(resolveSlackSource({ channel_type: 'channel', channel: C, user: U })).toEqual({
      conversationId: C, senderId: U, kind: 'group',
    });
  });
  test('group and mpim channel_type also normalize to kind group', () => {
    expect(resolveSlackSource({ channel_type: 'group', channel: C, user: U }).kind).toBe('group');
    expect(resolveSlackSource({ channel_type: 'mpim', channel: C, user: U }).kind).toBe('group');
  });
  // Regression: Slack's app_mention event carries NO channel_type at all
  // (confirmed live) — without this branch it fell through to 'other' and
  // got silently denied, which was the actual reason @mentions in a channel
  // never reached the agent even after the channel was allowlisted.
  test('app_mention events have no channel_type but still resolve to kind group', () => {
    expect(resolveSlackSource({ type: 'app_mention', channel: C, user: U })).toEqual({
      conversationId: C, senderId: U, kind: 'group',
    });
  });
  test('missing channel → other', () => {
    expect(resolveSlackSource({ channel_type: 'im', user: U }).kind).toBe('other');
  });
  test('unknown / missing → other', () => {
    expect(resolveSlackSource(undefined).kind).toBe('other');
    expect(resolveSlackSource({ channel_type: 'something', channel: C }).kind).toBe('other');
  });
});

describe('isSlackConversationAllowed()', () => {
  test('user (DM) source uses dmPolicy/dmAllowlist keyed on the SENDER id, not the DM channel id', () => {
    expect(isSlackConversationAllowed({ dmPolicy: 'open' }, { channel_type: 'im', channel: D, user: U })).toBe(true);
    expect(isSlackConversationAllowed({ dmAllowlist: [U] }, { channel_type: 'im', channel: D, user: U })).toBe(true);
    expect(isSlackConversationAllowed({}, { channel_type: 'im', channel: D, user: U })).toBe(false); // closed default
    expect(isSlackConversationAllowed({ dmPolicy: 'disabled', dmAllowlist: [U] }, { channel_type: 'im', channel: D, user: U })).toBe(false);
    // Allowlisting the DM channel id instead of the user id must NOT grant access:
    expect(isSlackConversationAllowed({ dmAllowlist: [D] }, { channel_type: 'im', channel: D, user: U })).toBe(false);
  });
  test('group (channel) source uses groupPolicy/groupAllowlist keyed on the channel id, NOT dm fields', () => {
    expect(isSlackConversationAllowed({ groupAllowlist: [C] }, { channel_type: 'channel', channel: C, user: U })).toBe(true);
    expect(isSlackConversationAllowed({ groupPolicy: 'open' }, { channel_type: 'channel', channel: C })).toBe(true);
    expect(isSlackConversationAllowed({}, { channel_type: 'channel', channel: C })).toBe(false); // closed default
    expect(isSlackConversationAllowed({ groupPolicy: 'disabled', groupAllowlist: [C] }, { channel_type: 'channel', channel: C })).toBe(false);
    // DM allowlist must NOT grant channel access:
    expect(isSlackConversationAllowed({ dmPolicy: 'open' }, { channel_type: 'channel', channel: C })).toBe(false);
  });
  test('unknown source kind → denied', () => {
    expect(isSlackConversationAllowed({ dmPolicy: 'open', groupPolicy: 'open' }, { channel_type: 'x', channel: C })).toBe(false);
  });
});
