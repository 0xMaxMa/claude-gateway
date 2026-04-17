/**
 * Discord thread management — openclaw pattern from threading.ts.
 * Uses local DiscordMessage interface; no top-level discord.js import.
 */

import type { DiscordMessage } from './types';

export async function maybeCreateThread(
  message: DiscordMessage,
  autoThread: boolean,
  autoArchiveDuration: number,
): Promise<{ id: string } | null> {
  if (!autoThread) return null;
  if (message.channel.isThread()) return null;
  if (!message.guild) return null;

  const name = sanitizeThreadName(message.content);
  return message.startThread({ name, autoArchiveDuration });
}

export function sanitizeThreadName(text: string): string {
  return text
    .replace(/<@!?\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'conversation';
}

export function buildSessionKey(
  agentId: string,
  channelId: string,
  userId: string,
  threadId?: string | null,
): string {
  const chatId = threadId ?? channelId;
  return `${agentId}:discord:${userId}:${chatId}`;
}
