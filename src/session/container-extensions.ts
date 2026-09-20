import { containerNode, validateContainer } from '../orchestration/container';
import type { AgentConfig } from '../types';
import type { WorkerExtensions, ExtensionSkill } from './worker-extensions';
import { extractFrontmatter } from '../skills/parser';
import { inspectCodexExtensions } from './codex-extension-discovery';
import { CODEX_CONTAINER_EXECUTABLE } from './codex-runtime';
import { homedir } from 'os';
import { bundleContainerModule } from './container-connectors';

export async function discoverContainerExtensions(agent: AgentConfig): Promise<WorkerExtensions> {
  await validateContainer(agent);
  const code = await bundleContainerModule('extension-catalog.ts', 'cjs');
  const codexHome = await containerNode(agent.container!, "process.stdout.write(process.env.CODEX_HOME || require('path').join(process.env.HOME, '.codex'));", []);
  let native;
  const notices: string[] = [];
  try {
    native = await inspectCodexExtensions(CODEX_CONTAINER_EXECUTABLE, '/workspace', { ...process.env, CODEX_HOME: codexHome }, agent.container);
  } catch { notices.push('Native Codex extension discovery is unavailable inside this container. Its gateway and Claude extension MCP remain available.'); }
  // Both harnesses use the same file/enablement reader, executed entirely inside
  // the selected container. Native metadata is passed over stdin, never argv.
  const data = JSON.parse(await containerNode(agent.container!, `let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const p=JSON.parse(s);globalThis.__gatewayNativeExtensions=p.native;const Module=require('module');const m=new Module('/tmp/gateway-extension-catalog.cjs');m.filename='/tmp/gateway-extension-catalog.cjs';m.paths=[];m._compile(p.code,m.filename);});`, ['/workspace', homedir()], JSON.stringify({ code, native })));
  data.notices.push(...notices);
  if (native) {
    const servers = Object.entries(native.config.mcp_servers ?? {}).filter(([, entry]: [string, any]) => entry.enabled !== false).map(([name]) => name);
    if (servers.length || native.pluginIds?.length) data.servers.codex_native = { nativeCodex: { bin: CODEX_CONTAINER_EXECUTABLE, cwd: '/workspace', home: codexHome, servers, pluginIds: native.pluginIds ?? [] } };
  }
  const skills: ExtensionSkill[] = [];
  for (const skill of data.skills ?? []) {
    const fm = extractFrontmatter(skill.content)?.frontmatter;
    if (fm?.['user-invocable'] === false) continue;
    const entry = { ...skill, description: (typeof fm?.description === 'string' ? fm.description : `Container skill ${skill.name}`).slice(0, 4096) };
    const index = skills.findIndex(value => value.name === entry.name);
    if (index >= 0) skills[index] = entry; else skills.push(entry);
  }
  return { skills, servers: data.servers ?? {}, notices: data.notices ?? [] };
}
