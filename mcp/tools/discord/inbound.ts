/**
 * Discord inbound message handler — openclaw pattern from message-handler.ts.
 * Preflight validation → context building → handler dispatch.
 */

import type { InboundMessage, InboundMessageHandler } from '../../types';
import type { DiscordConfig, DiscordMessage, DiscordMessageContext } from './types';
import type { DiscordAccessConfig } from './access';
import { checkAccess } from './access';

export function createMessageHandler(
  agentId: string,
  handler: InboundMessageHandler,
  config: DiscordConfig,
  accessConfig: DiscordAccessConfig,
) {
  return async (message: DiscordMessage): Promise<void> => {
    if (message.author.bot) return;
    if (message.system) return;

    const isDM = !message.guild;
    const isThread = message.channel.isThread();

    const context: DiscordMessageContext = {
      guildId: message.guildId,
      channelId: message.channelId,
      threadId: isThread ? message.channelId : null,
      userId: message.author.id,
      username: message.author.username,
      messageId: message.id,
      isDM,
      isThread,
    };

    const result = checkAccess(accessConfig, context);
    if (!result.allowed) return;

    const inbound: InboundMessage = {
      channel: 'discord',
      accountId: message.client.user?.id ?? 'discord',
      senderId: message.author.id,
      chatId: isThread ? message.channelId : message.channelId,
      chatType: isDM ? 'direct' : 'group',
      text: message.content,
      messageId: message.id,
      threadId: isThread ? message.channelId : undefined,
      attachmentFileId: message.attachments.first()?.url,
      ts: message.createdTimestamp,
    };

    await handler(inbound);
  };
}
