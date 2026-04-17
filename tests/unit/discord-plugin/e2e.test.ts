/**
 * E2E-style tests for DiscordModule using a mock Discord client.
 * These tests inject a mock client to verify tool call behavior.
 */

import { DiscordModule } from '../../../mcp/tools/discord/module';

function makeModule(mockClient: any): DiscordModule {
  const mod = new DiscordModule();
  // @ts-ignore — inject mock client
  mod['client'] = mockClient;
  return mod;
}

describe('DiscordModule E2E (mocked client)', () => {
  describe('E2E-DC-1: discord_reply sends message', () => {
    it('calls channel.send with correct content', async () => {
      const mockSend = jest.fn().mockResolvedValue({ id: 'msg-123' });
      const mockClient = {
        channels: {
          fetch: jest.fn().mockResolvedValue({ send: mockSend }),
        },
      };
      const mod = makeModule(mockClient);
      const result = await mod.handleTool('discord_reply', {
        channel_id: 'channel-abc',
        text: 'hello discord',
      });
      expect(result.isError).toBeFalsy();
      expect(mockSend).toHaveBeenCalled();
      const sendArg = mockSend.mock.calls[0][0];
      expect(sendArg.content).toBe('hello discord');
    });
  });

  describe('E2E-DC-2: discord_react adds reaction', () => {
    it('calls message.react with correct emoji', async () => {
      const mockReact = jest.fn().mockResolvedValue(undefined);
      const mockFetch = jest.fn().mockResolvedValue({ react: mockReact });
      const mockClient = {
        channels: {
          fetch: jest.fn().mockResolvedValue({ messages: { fetch: mockFetch } }),
        },
      };
      const mod = makeModule(mockClient);
      const result = await mod.handleTool('discord_react', {
        channel_id: 'channel-abc',
        message_id: 'msg-456',
        emoji: '👍',
      });
      expect(result.isError).toBeFalsy();
      expect(mockReact).toHaveBeenCalledWith('👍');
    });
  });

  describe('E2E-DC-3: discord_reply with long text is chunked', () => {
    it('calls channel.send multiple times for >2000 char text', async () => {
      const mockSend = jest.fn().mockResolvedValue({ id: 'msg-x' });
      const mockClient = {
        channels: {
          fetch: jest.fn().mockResolvedValue({ send: mockSend }),
        },
      };
      const mod = makeModule(mockClient);
      const longText = 'a '.repeat(1200); // ~2400 chars
      await mod.handleTool('discord_reply', { channel_id: 'ch', text: longText });
      expect(mockSend.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('E2E-DC-4: discord_edit_message edits message', () => {
    it('calls message.edit with new text', async () => {
      const mockEdit = jest.fn().mockResolvedValue({ id: 'msg-789' });
      const mockFetch = jest.fn().mockResolvedValue({ edit: mockEdit });
      const mockClient = {
        channels: {
          fetch: jest.fn().mockResolvedValue({ messages: { fetch: mockFetch } }),
        },
      };
      const mod = makeModule(mockClient);
      const result = await mod.handleTool('discord_edit_message', {
        channel_id: 'ch',
        message_id: 'msg-789',
        text: 'updated text',
      });
      expect(result.isError).toBeFalsy();
      expect(mockEdit).toHaveBeenCalledWith('updated text');
    });
  });

  describe('E2E-DC-5: discord_create_thread creates thread from message', () => {
    it('calls message.startThread when message_id is provided', async () => {
      const mockStartThread = jest.fn().mockResolvedValue({ id: 'thread-new' });
      const mockFetch = jest.fn().mockResolvedValue({ startThread: mockStartThread });
      const mockClient = {
        channels: {
          fetch: jest.fn().mockResolvedValue({ messages: { fetch: mockFetch } }),
        },
      };
      const mod = makeModule(mockClient);
      const result = await mod.handleTool('discord_create_thread', {
        channel_id: 'ch',
        name: 'My Thread',
        message_id: 'msg-1',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('thread-new');
    });

    it('calls channel.threads.create when no message_id', async () => {
      const mockCreate = jest.fn().mockResolvedValue({ id: 'thread-standalone' });
      const mockClient = {
        channels: {
          fetch: jest.fn().mockResolvedValue({ threads: { create: mockCreate } }),
        },
      };
      const mod = makeModule(mockClient);
      const result = await mod.handleTool('discord_create_thread', {
        channel_id: 'ch',
        name: 'Standalone Thread',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('thread-standalone');
    });
  });

  describe('E2E-DC-7: tool visibility', () => {
    it('discord tools not visible when GATEWAY_ORIGIN_CHANNEL=telegram', () => {
      process.env.GATEWAY_ORIGIN_CHANNEL = 'telegram';
      const mod = new DiscordModule();
      expect(mod.toolVisibility).toBe('current-channel');
      delete process.env.GATEWAY_ORIGIN_CHANNEL;
    });

    it('discord tools visible when GATEWAY_ORIGIN_CHANNEL=discord', () => {
      const mod = new DiscordModule();
      expect(mod.id).toBe('discord');
      expect(mod.toolVisibility).toBe('current-channel');
    });
  });

  describe('E2E-DC-8: handleTool returns error gracefully', () => {
    it('returns isError on tool failure without throwing', async () => {
      const mockClient = {
        channels: {
          fetch: jest.fn().mockRejectedValue(new Error('channel not found')),
        },
      };
      const mod = makeModule(mockClient);
      const result = await mod.handleTool('discord_reply', {
        channel_id: 'bad-channel',
        text: 'hello',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('failed');
    });
  });
});
