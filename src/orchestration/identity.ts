import { createHash } from 'crypto';
import type { AgentConfig, ApiKey } from '../types';
import type { ChatChannel } from '../history/types';
import type { ConversationScope, ExecutionCapabilities } from './types';

/** Config IDs survive key rotation; legacy keys have a non-reversible stable fallback. */
export function apiPrincipal(key: ApiKey): string {
  return key.id ? `api:${key.id}` : `api-sha256:${createHash('sha256').update(key.key).digest('hex')}`;
}
export function apiExecutionCapabilities(agent: AgentConfig, key: ApiKey): ExecutionCapabilities {
  return { execute: agent.allow_tools ?? Boolean(key.allow_tools), writeMemory: false };
}
/** The conversation a chat-channel sender speaks in. Channel ingress and a
 * channel-bound voice call share it, so both land in the same conversation. */
export function channelScope(agentId: string, agentSessionId: string, source: ChatChannel, chatId: string, threadKey: string, senderId: string): ConversationScope {
  return { agentId, agentSessionId, source, accountId: agentId, chatId, threadKey, principalId: `${source}:${senderId}` };
}
