import { createHash } from 'crypto';
import type { AgentConfig, ApiKey } from '../types';
import type { ExecutionCapabilities } from './types';

/** Config IDs survive key rotation; legacy keys have a non-reversible stable fallback. */
export function apiPrincipal(key: ApiKey): string {
  return key.id ? `api:${key.id}` : `api-sha256:${createHash('sha256').update(key.key).digest('hex')}`;
}
export function apiExecutionCapabilities(agent: AgentConfig, key: ApiKey): ExecutionCapabilities {
  return { execute: agent.allow_tools ?? Boolean(key.allow_tools), writeMemory: false };
}
