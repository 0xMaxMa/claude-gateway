import { createMessageHandler } from '../../../mcp/tools/discord/inbound';
import type { DiscordMessage } from '../../../mcp/tools/discord/types';
import type { DiscordAccessConfig } from '../../../mcp/tools/discord/access';
import type { InboundMessage } from '../../../mcp/types';

function makeMockMessage(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: 'msg-1',
    content: 'hello',
    author: { id: 'user-1', username: 'testuser', bot: false },
    system: false,
    guild: { id: 'guild-1' },
    guildId: 'guild-1',
    channelId: 'channel-1',
    channel: {
      isThread: () => false,
      parentId: null,
    },
    createdTimestamp: 1_700_000_000,
    attachments: { first: () => undefined },
    client: { user: { id: 'bot-1' } },
    startThread: jest.fn().mockResolvedValue({ id: 'thread-1' }),
    ...overrides,
  } as unknown as DiscordMessage;
}

const openAccess: DiscordAccessConfig = {
  dmPolicy: 'open',
  dmAllowlist: [],
  guildAllowlist: [],
  channelAllowlist: [],
  roleAllowlist: [],
};

const baseConfig: any = {
  botToken: 'token',
  dmPolicy: 'open',
  dmAllowlist: [],
  guildAllowlist: [],
  channelAllowlist: [],
  autoThread: false,
  autoThreadArchiveMinutes: 60,
  maxMessageLength: 2000,
  useEmbeds: false,
};

describe('createMessageHandler', () => {
  it('DI1: skips bot messages', async () => {
    const handler = jest.fn();
    const msgHandler = createMessageHandler('agent-1', handler, baseConfig, openAccess);
    await msgHandler(makeMockMessage({ author: { id: 'bot-1', username: 'bot', bot: true } }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('DI2: skips system messages', async () => {
    const handler = jest.fn();
    const msgHandler = createMessageHandler('agent-1', handler, baseConfig, openAccess);
    await msgHandler(makeMockMessage({ system: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('DI3: calls handler for normal user message', async () => {
    const handler = jest.fn();
    const msgHandler = createMessageHandler('agent-1', handler, baseConfig, openAccess);
    await msgHandler(makeMockMessage());
    expect(handler).toHaveBeenCalledTimes(1);
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.channel).toBe('discord');
    expect(inbound.senderId).toBe('user-1');
    expect(inbound.text).toBe('hello');
  });

  it('DI4: DM message has chatType=direct', async () => {
    const handler = jest.fn();
    const msgHandler = createMessageHandler('agent-1', handler, baseConfig, openAccess);
    await msgHandler(makeMockMessage({ guild: null, guildId: null }));
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.chatType).toBe('direct');
  });

  it('DI5: guild message has chatType=group', async () => {
    const handler = jest.fn();
    const msgHandler = createMessageHandler('agent-1', handler, baseConfig, openAccess);
    await msgHandler(makeMockMessage());
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.chatType).toBe('group');
  });

  it('DI6: thread message has threadId set', async () => {
    const handler = jest.fn();
    const msgHandler = createMessageHandler('agent-1', handler, baseConfig, openAccess);
    await msgHandler(makeMockMessage({
      channelId: 'thread-abc',
      channel: { isThread: () => true, parentId: 'channel-1' },
    }));
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.threadId).toBe('thread-abc');
  });

  it('DI7: message with attachment has attachmentFileId set', async () => {
    const handler = jest.fn();
    const msgHandler = createMessageHandler('agent-1', handler, baseConfig, openAccess);
    await msgHandler(makeMockMessage({
      attachments: { first: () => ({ url: 'https://cdn.discordapp.com/file.png' }) },
    }));
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.attachmentFileId).toBe('https://cdn.discordapp.com/file.png');
  });

  it('skips message when access is denied', async () => {
    const handler = jest.fn();
    const closedAccess: DiscordAccessConfig = { ...openAccess, dmPolicy: 'disabled' };
    const msgHandler = createMessageHandler('agent-1', handler, baseConfig, closedAccess);
    await msgHandler(makeMockMessage({ guild: null, guildId: null }));
    expect(handler).not.toHaveBeenCalled();
  });
});
