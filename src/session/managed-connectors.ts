import { chmodSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { AgentConfig, GatewayConfig } from '../types';
import type { RuntimeProfile } from './runtime-profile';
import { resolveEnabledConnectors } from '../connectors/resolve';
import { isReservedConnectorId } from '../connectors/custom';

/** Both worker harnesses use the same host-only connector policy and lazy proxy.
 * Track paths before writing so failed preparation can also remove credentials. */
export function prepareManagedConnectors(agent: AgentConfig, gateway: GatewayConfig,
  profile: RuntimeProfile, paths: Set<string>) {
  const connectors = profile.role === 'worker' && profile.hostExecution &&
    agent.type !== 'app-agent' && agent.allow_tools !== false && profile.connectorsAllowed !== false
    ? resolveEnabledConnectors(agent, gateway.gateway.customConnectors, gateway.gateway.connectorsDefaultEnabled ?? true)
    : {};
  const eligible = Object.entries(connectors).filter(([id]) => !isReservedConnectorId(id));
  const servers = Object.fromEntries(eligible.map(([id, server], index) => {
    const filename = join(dirname(profile.mcpConfigPath), `connector-${index}.json`);
    paths.add(filename);
    writeFileSync(filename, JSON.stringify(server), { mode: 0o600 });
    chmodSync(filename, 0o600);
    return [id, { command: 'bun', args: [resolve(__dirname, '../../mcp/lazy-connector.ts'), filename] }];
  }));
  return { servers, connectors: Object.fromEntries(eligible) };
}
