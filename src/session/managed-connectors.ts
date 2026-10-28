import { chmodSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { AgentConfig, GatewayConfig } from '../types';
import type { RuntimeProfile } from './runtime-profile';
import { resolveEnabledConnectors } from '../connectors/resolve';
import { isReservedConnectorId } from '../connectors/custom';
import { agentFacingConnectors, revokeConnectorGrant } from '../connectors/proxy';

/** Both worker harnesses use the same host-only connector policy and lazy proxy.
 * Track paths before writing so failed preparation can also remove credentials.
 * Secret-bearing HTTP connectors are written as loopback proxy entries (#635); the
 * caller owns the returned grant and revokes it with the paths. `connectors` stays
 * the resolved form, for in-memory restart fingerprints only. */
export function prepareManagedConnectors(agent: AgentConfig, gateway: GatewayConfig,
  profile: RuntimeProfile, paths: Set<string>, extensions: Record<string, any> = {}) {
  const connectors = profile.role === 'worker' && profile.hostExecution &&
    agent.type !== 'app-agent' && agent.allow_tools !== false && profile.connectorsAllowed !== false
    ? resolveEnabledConnectors(agent, gateway.gateway.customConnectors, gateway.gateway.connectorsDefaultEnabled ?? true)
    : {};
  const eligible = Object.entries({ ...(profile.hostExecution && agent.type !== 'app-agent' && agent.allow_tools !== false && profile.connectorsAllowed !== false ? extensions : {}), ...connectors }).filter(([id]) => !isReservedConnectorId(id));
  const isConnector = (id: string): boolean => Object.prototype.hasOwnProperty.call(connectors, id);
  const { servers: facing, grant } = agentFacingConnectors(agent, gateway, Object.fromEntries(eligible.filter(([id]) => isConnector(id))), { sanitizeEnv: true });
  let servers: Record<string, { command: string; args: string[] }>;
  try {
    servers = Object.fromEntries(eligible.map(([id, original], index) => {
      const server = isConnector(id) ? facing[id] : original;
      const filename = join(dirname(profile.mcpConfigPath), `connector-${index}.json`);
      paths.add(filename);
      writeFileSync(filename, JSON.stringify(server), { mode: 0o600 });
      chmodSync(filename, 0o600);
      return [id, { command: 'bun', args: [resolve(__dirname, '../../mcp/lazy-connector.ts'), filename] }];
    }));
  } catch (err) {
    revokeConnectorGrant(grant);
    throw err;
  }
  return { servers, connectors: Object.fromEntries(eligible), grant };
}
