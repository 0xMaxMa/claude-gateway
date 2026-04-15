/**
 * Route resolution and channel context rendering.
 * Adopts openclaw pattern: (channel, accountId, peer) -> (agentId, sessionKey)
 */

import type { InboundMessage, ResolvedRoute, ChannelId, ChannelContext } from './types';

export function resolveRoute(
  msg: InboundMessage,
  agentId: string,
): ResolvedRoute {
  const sessionKey = buildSessionKey({
    agentId,
    channel: msg.channel,
    accountId: msg.accountId,
    chatId: msg.chatId,
  });

  return {
    agentId,
    channel: msg.channel,
    accountId: msg.accountId,
    sessionKey,
    chatId: msg.chatId,
    chatType: msg.chatType,
    senderId: msg.senderId,
  };
}

export function buildSessionKey(params: {
  agentId: string;
  channel: string;
  accountId: string;
  chatId: string;
}): string {
  return `${params.agentId}:${params.channel}:${params.accountId}:${params.chatId}`;
}

export function buildChannelContext(
  route: ResolvedRoute,
  configuredChannels: ChannelId[],
): ChannelContext {
  return {
    origin: {
      channel: route.channel,
      chatId: route.chatId,
      senderId: route.senderId,
      chatType: route.chatType,
    },
    configuredChannels,
  };
}

export function renderChannelContextSection(ctx: ChannelContext): string {
  const lines = [
    `--- CHANNEL CONTEXT ---`,
    `Origin: ${ctx.origin.channel} (chat_id=${ctx.origin.chatId}, from=${ctx.origin.senderId})`,
    `Chat type: ${ctx.origin.chatType}`,
    ``,
    `Reply to this conversation using the ${ctx.origin.channel}_reply tool.`,
  ];

  if (ctx.configuredChannels.length > 1) {
    const others = ctx.configuredChannels.filter(c => c !== ctx.origin.channel);
    lines.push(``, `Other configured channels: ${others.join(', ')} (cross-channel available)`);
  }

  return lines.join('\n');
}
