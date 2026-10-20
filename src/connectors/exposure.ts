/**
 * Connectors whose secret a session still wrote into an agent-readable file because
 * its runtime could not use the gateway route (#635): an app-agent container without
 * Node, or a workspace path too long for the launcher socket. The connector's config
 * alone cannot tell this (see exposesSecretToAgent), so each spawn records what it
 * actually wrote and the status API reports it per agent.
 *
 * Keyed by live session/grant. A new spawn or a capabilities probe must not erase an
 * older session's exposure; the record ends only when its owning grant is revoked.
 */
import type { CustomConnectorEntry } from '../types';
import type { ConnectorStatus } from './types';
import { exposesSecretToAgent } from './custom';

const bySession = new Map<string, { agentId: string; connectorIds: ReadonlySet<string> }>();

export function recordRuntimeExposure(sessionId: string, agentId: string, connectorIds: Iterable<string>): void {
  const ids = new Set(connectorIds);
  if (ids.size) bySession.set(sessionId, { agentId, connectorIds: ids });
  else bySession.delete(sessionId);
}

export function clearRuntimeExposure(sessionId?: string): void {
  if (sessionId === undefined) bySession.clear();
  else bySession.delete(sessionId);
}

/** Agents with at least one live session that wrote this connector's secret, sorted. */
export function runtimeExposedAgents(connectorId: string): string[] {
  return [...new Set([...bySession.values()].filter(({ connectorIds }) => connectorIds.has(connectorId)).map(({ agentId }) => agentId))].sort();
}

/**
 * The status fields for one connector: `secretExposure` when its secret is written
 * into an agent-readable file for every agent (its config) or for some (their
 * runtime), and `exposedAgents` naming those agents in the second case.
 */
export function secretExposureFields(id: string, entry: CustomConnectorEntry): Pick<ConnectorStatus, 'secretExposure' | 'exposedAgents'> {
  if (exposesSecretToAgent(entry)) return { secretExposure: 'agent-readable' };
  const agents = runtimeExposedAgents(id);
  return agents.length ? { secretExposure: 'agent-readable', exposedAgents: agents } : {};
}
