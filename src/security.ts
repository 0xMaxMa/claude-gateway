import { AgentConfig } from './types';

/**
 * Determine whether a user is allowed to interact with the given agent.
 *
 * Rules:
 * - Group chats (chatId starts with '-') always bypass the allowlist.
 * - If dmPolicy === 'open', always allow.
 * - If dmPolicy === 'allowlist', allow only if userId is in allowedUsers.
 */
export function isAllowed(userId: number, agentConfig: AgentConfig, chatId?: string): boolean {
  // Group chats bypass the allowlist
  if (chatId !== undefined && isGroupChat(chatId)) {
    return true;
  }

  if (!agentConfig.telegram) return false;

  if (agentConfig.telegram.dmPolicy === 'open') {
    return true;
  }

  // dmPolicy === 'allowlist'
  return agentConfig.telegram.allowedUsers.includes(userId);
}

/**
 * Return true if the chatId represents a group/supergroup chat.
 * Telegram group chats have negative IDs (starting with '-').
 */
export function isGroupChat(chatId: string): boolean {
  return chatId.startsWith('-');
}
