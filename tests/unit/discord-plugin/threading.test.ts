import { maybeCreateThread, sanitizeThreadName, buildSessionKey } from '../../../mcp/tools/discord/threading';
import type { DiscordMessage } from '../../../mcp/tools/discord/types';

function makeMockMessage(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: 'msg-1',
    content: 'Hello world',
    author: { id: 'user-1', username: 'testuser', bot: false },
    system: false,
    guild: { id: 'guild-1' },
    guildId: 'guild-1',
    channelId: 'channel-1',
    channel: {
      isThread: () => false,
      parentId: null,
    },
    createdTimestamp: Date.now(),
    attachments: { first: () => undefined },
    client: { user: { id: 'bot-1' } },
    startThread: jest.fn().mockResolvedValue({ id: 'thread-1' }),
    ...overrides,
  } as unknown as DiscordMessage;
}

describe('sanitizeThreadName', () => {
  it('DT5: removes mentions', () => {
    expect(sanitizeThreadName('<@123456> hello')).toBe('hello');
  });

  it('truncates to 100 chars', () => {
    const long = 'a'.repeat(150);
    expect(sanitizeThreadName(long)).toHaveLength(100);
  });

  it('returns "conversation" for empty/mention-only text', () => {
    expect(sanitizeThreadName('<@123> <@456>')).toBe('conversation');
    expect(sanitizeThreadName('   ')).toBe('conversation');
  });

  it('collapses whitespace', () => {
    expect(sanitizeThreadName('hello   world')).toBe('hello world');
  });
});

describe('maybeCreateThread', () => {
  it('DT1: autoThread=true + guild message → creates thread', async () => {
    const msg = makeMockMessage();
    const result = await maybeCreateThread(msg, true, 60);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('thread-1');
    expect(msg.startThread).toHaveBeenCalledWith({ name: 'Hello world', autoArchiveDuration: 60 });
  });

  it('DT2: autoThread=true + DM → returns null', async () => {
    const msg = makeMockMessage({ guild: null, guildId: null });
    const result = await maybeCreateThread(msg, true, 60);
    expect(result).toBeNull();
  });

  it('DT3: already in thread → returns null', async () => {
    const msg = makeMockMessage({
      channel: { isThread: () => true, parentId: 'channel-1' },
    });
    const result = await maybeCreateThread(msg, true, 60);
    expect(result).toBeNull();
  });

  it('DT4: autoThread=false → returns null', async () => {
    const msg = makeMockMessage();
    const result = await maybeCreateThread(msg, false, 60);
    expect(result).toBeNull();
    expect(msg.startThread).not.toHaveBeenCalled();
  });
});

describe('buildSessionKey', () => {
  it('uses threadId when present', () => {
    const key = buildSessionKey('agent-1', 'channel-1', 'user-1', 'thread-1');
    expect(key).toBe('agent-1:discord:user-1:thread-1');
  });

  it('uses channelId when no threadId', () => {
    const key = buildSessionKey('agent-1', 'channel-1', 'user-1');
    expect(key).toBe('agent-1:discord:user-1:channel-1');
  });
});
