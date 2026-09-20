import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { containerNode } from '../orchestration/container';
import type { AgentConfig } from '../types';

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
