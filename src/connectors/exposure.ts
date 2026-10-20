/**
 * Connectors whose secret a session still wrote into an agent-readable file because
 * its runtime could not use the gateway route (#635): an app-agent container without
 * Node, or a workspace path too long for the launcher socket. The connector's config
 * alone cannot tell this (see exposesSecretToAgent), so each spawn records what it
 * actually wrote and the status API reports it per agent.
 *
 * Keyed by agent: the latest spawn of an agent replaces that agent's record, so a
 * container that gains Node clears it on its next spawn. In memory only; a gateway
 * restart rewrites every session's files, and records again on the next spawn.
 */
import type { CustomConnectorEntry } from '../types';
import type { ConnectorStatus } from './types';
import { exposesSecretToAgent } from './custom';

const byAgent = new Map<string, ReadonlySet<string>>();

export function recordRuntimeExposure(agentId: string, connectorIds: Iterable<string>): void {
  const ids = new Set(connectorIds);
  if (ids.size) byAgent.set(agentId, ids);
  else byAgent.delete(agentId);
}

/** Agents whose latest spawn wrote this connector's secret into a file, sorted. */
export function runtimeExposedAgents(connectorId: string): string[] {
  return [...byAgent].filter(([, ids]) => ids.has(connectorId)).map(([agentId]) => agentId).sort();
}

/** Test seam. */
export function clearRuntimeExposure(): void {
  byAgent.clear();
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
