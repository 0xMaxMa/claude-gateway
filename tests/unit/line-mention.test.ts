/**
 * Unit tests for the LINE bot-mention helper (src/api/line-mention.ts).
 * Pure logic; @All never counts, native isSelf is the reliable signal.
 */
import { wasBotMentioned, hasNativeBotMention } from '../../src/api/line-mention';

describe('wasBotMentioned()', () => {
  test('native isSelf mention → true', () => {
    const msg = {
      type: 'text',
      text: '@bot help',
      mention: { mentionees: [{ type: 'user', isSelf: true }] },
    };
    expect(wasBotMentioned(msg)).toBe(true);
    expect(hasNativeBotMention(msg)).toBe(true);
  });

  test('mention of another user (isSelf false) → false', () => {
    const msg = {
      type: 'text',
      text: '@somchai hi',
      mention: { mentionees: [{ type: 'user', isSelf: false }] },
    };
    expect(wasBotMentioned(msg)).toBe(false);
  });

  test('@All (type: all) does NOT count as a bot mention', () => {
    const msg = { type: 'text', text: '@All meeting', mention: { mentionees: [{ type: 'all' }] } };
    expect(wasBotMentioned(msg)).toBe(false);
  });

  test('bot mentioned among several mentionees → true', () => {
    const msg = {
      type: 'text',
      text: '@somchai @bot',
      mention: { mentionees: [{ type: 'user', isSelf: false }, { type: 'user', isSelf: true }] },
    };
    expect(wasBotMentioned(msg)).toBe(true);
  });

  test('no mention object → false', () => {
    expect(wasBotMentioned({ type: 'text', text: 'hello' })).toBe(false);
    expect(wasBotMentioned(undefined)).toBe(false);
  });

  test('typed @name in plain text (no native mention) does NOT count', () => {
    // Only native isSelf mentions wake the bot; a typed name is let through silently.
    expect(wasBotMentioned({ type: 'text', text: 'hey @Buddy can you help' })).toBe(false);
  });
});
