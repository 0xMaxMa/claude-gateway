import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { containerNode } from '../orchestration/container';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'fs';
import type { AgentConfig, CustomConnectorEntry } from '../types';
import { connectorSecretRoute } from '../connectors/custom';
import { sweepStaleSockets, type ContainerLaunch } from '../connectors/proxy';

const bundles = new Map<string, Promise<string>>();
/** Ship the same reviewed MCP proxy into the container as a standalone Node
 * module. No host MCP process, package directory, credential home or socket is
 * mounted. Bun is already the gateway's MCP runtime; it only bundles code here. */
export function bundleContainerModule(entry = 'lazy-connector.ts', format: 'esm' | 'cjs' = 'esm'): Promise<string> {
  const key = entry + ':' + format;
  let bundle = bundles.get(key);
  if (!bundle) bundle = (async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-mcp-bundle-'));
    try {
      const output = join(root, 'connector.mjs');
      await promisify(execFile)('bun', ['build', resolve(__dirname, '../../mcp', entry), '--target=node', '--format=' + format, '--env=disable', '--outfile=' + output], { timeout: 30000, maxBuffer: 1024 * 1024 });
      return await readFile(output, 'utf8');
    } finally { await rm(root, { recursive: true, force: true }); }
  })().catch(() => { bundles.delete(key); throw new Error('CONTAINER_MCP_ADAPTER_UNAVAILABLE: Check the gateway Bun installation and MCP dependencies.'); });
  bundles.set(key, bundle);
  return bundle;
}

export async function prepareContainerConnectors(agent: AgentConfig, directory: string, servers: Record<string, any>): Promise<Record<string, { command: string; args: string[] }>> {
  if (!Object.keys(servers).length) return {};
  const code = await bundleContainerModule();
  const configs = Object.entries(servers).map(([name, config], index) => ({ name, config, path: `${directory}/connector-${index}.json` }));
  await containerNode(agent.container!, `const fs=require('fs');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const p=JSON.parse(s);fs.writeFileSync(p.path,p.code,{mode:384});for(const entry of p.configs)fs.writeFileSync(entry.path,JSON.stringify(entry.config),{mode:384});});`, [], JSON.stringify({ path: directory + '/connector.mjs', code, configs }));
  return Object.fromEntries(configs.map(entry => [entry.name, { command: 'node', args: [directory + '/connector.mjs', entry.path] }]));
}

/** Workspace directory a legacy app-agent's container sees at /workspace/<name>. */
const LAUNCH_DIR = '.gateway-connectors';

/**
 * Make a legacy app-agent's container able to launch its connectors (#635): put the
 * launcher in the bind-mounted workspace and prove the container can run it. The
 * bridge is bundled here but only ever sent over a pipe (see ContainerLaunch). Undefined
 * when no connector needs it, or when the container has no Node or does not see the
 * workspace; that session keeps its resolved entries, as before, rather than losing
 * its connectors (agentFacingConnectors records that for the status API).
 *
 * The directory ignores itself for git, since agent workspaces are often repositories,
 * and sockets a crashed gateway left behind are removed before a new one is bound.
 */
export async function prepareContainerLaunch(container: string, workspace: string, connectors: Record<string, CustomConnectorEntry> = {}): Promise<ContainerLaunch | undefined> {
  if (!Object.values(connectors).some(entry => ['proxy', 'launch'].includes(connectorSecretRoute(entry)))) return undefined;
  const hostDir = join(workspace, LAUNCH_DIR), containerDir = `/workspace/${LAUNCH_DIR}`;
  try {
    const bridgeCode = await bundleContainerModule('connector-bridge.ts', 'cjs');
    mkdirSync(hostDir, { recursive: true, mode: 0o700 });
    chmodSync(hostDir, 0o700);
    writeFileSync(join(hostDir, '.gitignore'), '*\n', { mode: 0o600 });
    sweepStaleSockets(hostDir);
    copyFileSync(resolve(__dirname, '../../mcp/connector-launcher.mjs'), join(hostDir, 'connector-launcher.mjs'));
    await containerNode(container, "require('fs').accessSync(process.argv[1])", [`${containerDir}/connector-launcher.mjs`]);
    return { container, hostDir, containerDir, bridgeCode };
  } catch (err) {
    console.warn(`container-connectors: ${container} cannot launch connectors (${(err as Error).message}); its connectors keep their resolved entries`);
    return undefined;
  }
}
