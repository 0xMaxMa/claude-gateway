/**
 * Connector resolution — the single source of truth shared by the session spawner
 * and the HTTP API.
 *
 * resolveEnabledConnectors(): for the injection point in SessionProcess.writeMcpConfig.
 * listConnectorStatus(): for GET /v1/connectors.
 */

import type { AgentConfig, CustomConnectorEntry } from '../types';
import { CONNECTOR_CATALOG } from './catalog';
import { secretEnvOf, type ConnectorStatus } from './types';
import { readTokenEnv } from './token-env';
import { customSecretKey, substitutePlaceholders } from './custom';

/**
 * Build the mcpServers entries for every connector that is (a) in the catalog
 * (built-in) or customConnectors (user-pasted), (b) enabled for this agent, and
 * (c) connected (all required secrets present, or auth kind 'none'/no placeholders).
 * Returns a map keyed by connector id, ready to merge into mcp-config.json.
 *
 * Enablement is opt-OUT, not opt-in: a globally-connected connector is
 * available to every agent by default the moment it's connected — an agent
 * only misses it if explicitly disabled (`{enabled: false}`). This matches
 * how the built-in catalog already works as a security boundary (only
 * *connecting* a connector at all is the gate); per-agent is a refinement,
 * not a second required step.
 */
export function resolveEnabledConnectors(
  agentConfig: Pick<AgentConfig, 'connectors'>,
  customConnectors: Record<string, CustomConnectorEntry> = {},
): Record<string, unknown> {
  const enabled = agentConfig.connectors ?? {};
  const tokenEnv = readTokenEnv();
  const out: Record<string, unknown> = {};

  for (const spec of CONNECTOR_CATALOG) {
    if (enabled[spec.id]?.enabled === false) continue; // explicitly opted out

    const envName = secretEnvOf(spec);
    if (envName === null) {
      // No-auth connector — always injectable when enabled.
      out[spec.id] = spec.build(null);
      continue;
    }

    const secret = tokenEnv[envName];
    if (!secret) continue; // not connected — skip regardless of enablement
    out[spec.id] = spec.build(secret);
  }

  for (const [id, entry] of Object.entries(customConnectors)) {
    if (enabled[id]?.enabled === false) continue; // explicitly opted out

    const secrets: Record<string, string> = {};
    let allPresent = true;
    for (const name of entry.secretNames) {
      const value = tokenEnv[customSecretKey(id, name)];
      if (!value) {
        allPresent = false;
        break;
      }
      secrets[name] = value;
    }
    if (!allPresent) continue; // enabled but not fully connected — skip

    out[id] = substitutePlaceholders(entry.config, secrets);
  }

  return out;
}

/** Catalog + connected state for the API. `connected` reflects secret presence. */
export function listConnectorStatus(
  customConnectors: Record<string, CustomConnectorEntry> = {},
): ConnectorStatus[] {
  const tokenEnv = readTokenEnv();
  const builtins: ConnectorStatus[] = CONNECTOR_CATALOG.map((spec) => {
    const envName = secretEnvOf(spec);
    const connected = envName === null ? true : !!tokenEnv[envName];
    return {
      id: spec.id,
      label: spec.label,
      description: spec.description,
      authKind: spec.auth.kind,
      connected,
      setup: spec.setup,
      source: 'built-in',
      repoUrl: spec.repoUrl,
    };
  });

  const customs: ConnectorStatus[] = Object.entries(customConnectors).map(([id, entry]) => {
    const connected = entry.secretNames.every(
      (name: string) => !!tokenEnv[customSecretKey(id, name)],
    );
    return {
      id,
      label: entry.label,
      description: entry.description,
      authKind: entry.secretNames.length > 0 ? 'secret' : 'none',
      connected,
      source: 'custom',
      repoUrl: entry.sourceUrl,
    };
  });

  return [...builtins, ...customs];
}
