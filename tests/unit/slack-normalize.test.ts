/**
 * Unit tests for normalizeSlackEvent (src/api/slack-webhook-router.ts) —
 * the Slack Events API → {content, meta} intake shape, with focus on the
 * bot self-mention stripping added for app_mention text (an app_mention is
 * delivered with the raw `<@Ubot>` markup inline, which is noise to the agent).
 */
import { normalizeSlackEvent } from '../../src/api/slack-webhook-router';

const BOT = 'U0BOT';

describe('normalizeSlackEvent() — bot mention stripping', () => {
  test('strips the leading bot self-mention from app_mention text', () => {
    const norm = normalizeSlackEvent(
      { type: 'app_mention', channel: 'C123', user: 'U456', text: `<@${BOT}> hello there`, ts: '1.2' },
      undefined,
      BOT,
    );
    expect(norm?.content).toBe('hello there');
  });

  test('strips an embedded bot self-mention and collapses extra whitespace', () => {
    const norm = normalizeSlackEvent(
      { type: 'app_mention', channel: 'C123', user: 'U456', text: `hey <@${BOT}> please help`, ts: '1.2' },
      undefined,
      BOT,
    );
    expect(norm?.content).toBe('hey please help');
  });

  test('strips a labeled bot mention (<@Ubot|name>)', () => {
    const norm = normalizeSlackEvent(
      { type: 'app_mention', channel: 'C123', user: 'U456', text: `<@${BOT}|somdebot> ping`, ts: '1.2' },
      undefined,
      BOT,
    );
    expect(norm?.content).toBe('ping');
  });

  test('leaves OTHER users\' mentions intact — only the bot id is removed', () => {
    const norm = normalizeSlackEvent(
      { type: 'app_mention', channel: 'C123', user: 'U456', text: `<@${BOT}> ask <@U999> about it`, ts: '1.2' },
      undefined,
      BOT,
    );
    expect(norm?.content).toBe('ask <@U999> about it');
  });

  test('no-op when the bot id is unknown (text passes through verbatim)', () => {
    const norm = normalizeSlackEvent(
      { type: 'app_mention', channel: 'C123', user: 'U456', text: `<@${BOT}> hi`, ts: '1.2' },
      undefined,
      undefined,
    );
    expect(norm?.content).toBe(`<@${BOT}> hi`);
  });

  test('carries thread_ts into meta when the message is threaded', () => {
    const norm = normalizeSlackEvent(
      { type: 'message', channel: 'D123', channel_type: 'im', user: 'U456', text: 'in thread', ts: '2.0', thread_ts: '1.0' },
      undefined,
      BOT,
    );
    expect(norm?.meta.thread_ts).toBe('1.0');
    expect(norm?.content).toBe('in thread');
  });

  test('returns null for bot-authored events (bot-loop protection)', () => {
    const norm = normalizeSlackEvent(
      { type: 'message', channel: 'C123', user: 'U456', bot_id: 'B1', text: 'loop', ts: '1.2' },
      undefined,
      BOT,
    );
    expect(norm).toBeNull();
  });
});
