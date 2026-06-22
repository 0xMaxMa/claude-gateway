/**
 * Connector resolution — the single source of truth shared by the session spawner
 * and the HTTP API.
 *
 * resolveEnabledConnectors(): for the injection point in SessionProcess.writeMcpConfig.
 * listConnectorStatus(): for GET /v1/connectors.
 */

import type { AgentConfig } from '../types';
import { CONNECTOR_CATALOG } from './catalog';
import { secretEnvOf, type ConnectorStatus } from './types';
import { readTokenEnv } from './token-env';

/**
 * Build the mcpServers entries for every connector that is (a) in the catalog,
 * (b) enabled for this agent, and (c) connected (secret present, or auth kind 'none').
 * Returns a map keyed by connector id, ready to merge into mcp-config.json.
 */
export function resolveEnabledConnectors(
  agentConfig: Pick<AgentConfig, 'connectors'>,
): Record<string, unknown> {
  const enabled = agentConfig.connectors ?? {};
  const tokenEnv = readTokenEnv();
  const out: Record<string, unknown> = {};

  for (const spec of CONNECTOR_CATALOG) {
    if (!enabled[spec.id]?.enabled) continue;

    const envName = secretEnvOf(spec);
    if (envName === null) {
      // No-auth connector — always injectable when enabled.
      out[spec.id] = spec.build(null);
      continue;
    }

    const secret = tokenEnv[envName];
    if (!secret) continue; // enabled but not connected — skip
    out[spec.id] = spec.build(secret);
  }

  return out;
}

/** Catalog + connected state for the API. `connected` reflects secret presence. */
export function listConnectorStatus(): ConnectorStatus[] {
  const tokenEnv = readTokenEnv();
  return CONNECTOR_CATALOG.map((spec) => {
    const envName = secretEnvOf(spec);
    const connected = envName === null ? true : !!tokenEnv[envName];
    return {
      id: spec.id,
      label: spec.label,
      description: spec.description,
      authKind: spec.auth.kind,
      connected,
      setup: spec.setup,
    };
  });
}
