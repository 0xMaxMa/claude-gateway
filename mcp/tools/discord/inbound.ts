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
      attachmentKind: (message.attachments.first()?.contentType?.startsWith('audio/') || (typeof message.flags==='number' ? !!(message.flags&8192) : message.flags?.has(8192))) ? 'voice' : 'file',
      ts: message.createdTimestamp,
    };

    const attachments = (msg: DiscordMessage, quoted=false) => (msg.attachments.values ? [...msg.attachments.values()] : [msg.attachments.first()].filter(Boolean)).slice(0,10).map(a=>({url:a!.url,name:a!.name,kind:a!.contentType?.startsWith('image/')?'image':a!.contentType?.startsWith('audio/')?'audio':'file',quoted}));
    inbound.attachments = attachments(message);
    if (message.reference?.messageId && (!message.reference.channelId || message.reference.channelId === message.channelId)) {
      inbound.replyToMessageId = message.reference.messageId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const replied = await Promise.race([message.fetchReference?.(), new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),3000);})]);
        if (replied && replied.channelId === message.channelId) { inbound.repliedText=replied.content; inbound.repliedSender=replied.author.username; inbound.attachments.push(...attachments(replied,true)); }
      } catch { /* ID still resolves from scoped local history when available. */ } finally { if(timer)clearTimeout(timer); }
    }
    await handler(inbound);
  };
}
