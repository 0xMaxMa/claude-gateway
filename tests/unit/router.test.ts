import {
  resolveRoute,
  buildSessionKey,
  buildChannelContext,
  renderChannelContextSection,
} from '../../mcp/gateway/router';
import type { InboundMessage, ResolvedRoute } from '../../mcp/gateway/types';

function createTestMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'telegram',
    accountId: 'bot-123',
    senderId: 'user-456',
    chatId: 'chat-789',
    chatType: 'direct',
    text: 'hello',
    messageId: 'msg-001',
    ts: Date.now(),
    ...overrides,
  };
}

describe('Router', () => {
  // R1: same inputs → same sessionKey (deterministic)
  it('R1: should produce deterministic session key for same inputs', () => {
    const msg = createTestMessage();
    const route1 = resolveRoute(msg, 'agent-alpha');
    const route2 = resolveRoute(msg, 'agent-alpha');

    expect(route1.sessionKey).toBe(route2.sessionKey);
    expect(route1.sessionKey).toBe('agent-alpha:telegram:bot-123:chat-789');
  });

  // R2: different chatId → different sessionKey
  it('R2: should produce different session keys for different chatIds', () => {
    const msg1 = createTestMessage({ chatId: 'chat-AAA' });
    const msg2 = createTestMessage({ chatId: 'chat-BBB' });

    const route1 = resolveRoute(msg1, 'agent-alpha');
    const route2 = resolveRoute(msg2, 'agent-alpha');

    expect(route1.sessionKey).not.toBe(route2.sessionKey);
  });

  // R3: buildChannelContext() → correct origin + configuredChannels
  it('R3: should build correct channel context from resolved route', () => {
    const msg = createTestMessage();
    const route = resolveRoute(msg, 'agent-alpha');
    const ctx = buildChannelContext(route, ['telegram', 'cron']);

    expect(ctx.origin.channel).toBe('telegram');
    expect(ctx.origin.chatId).toBe('chat-789');
    expect(ctx.origin.senderId).toBe('user-456');
    expect(ctx.origin.chatType).toBe('direct');
    expect(ctx.configuredChannels).toEqual(['telegram', 'cron']);
  });

  // R4: renderChannelContextSection() → valid prompt text
  it('R4: should render valid channel context section for system prompt', () => {
    const msg = createTestMessage();
    const route = resolveRoute(msg, 'agent-alpha');
    const ctx = buildChannelContext(route, ['telegram', 'cron']);
    const section = renderChannelContextSection(ctx);

    expect(section).toContain('--- CHANNEL CONTEXT ---');
    expect(section).toContain('Origin: telegram');
    expect(section).toContain('chat_id=chat-789');
    expect(section).toContain('from=user-456');
    expect(section).toContain('telegram_reply');
    expect(section).toContain('Other configured channels: cron');
  });

  // Additional: buildSessionKey standalone
  it('should build session key with correct format', () => {
    const key = buildSessionKey({
      agentId: 'my-agent',
      channel: 'discord',
      accountId: 'bot-999',
      chatId: 'room-42',
    });

    expect(key).toBe('my-agent:discord:bot-999:room-42');
  });
});
