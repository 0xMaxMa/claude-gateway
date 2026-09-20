import { readFileSync, readdirSync, realpathSync, statSync, existsSync } from 'fs';
import { dirname, join, resolve, relative, isAbsolute } from 'path';
import { homedir } from 'os';
import type { AgentConfig, GatewayConfig } from '../types';
import type { CliSkill } from '../orchestration/cli-skills';
import { extractFrontmatter } from '../skills/parser';
import { inspectCodexExtensions, NativeCodexExtensions } from './codex-extension-discovery';
import { resolveCodexRuntime } from './codex-runtime';
import { resolveOrchestrationConfig } from '../orchestration/config';

export interface ExtensionSkill extends CliSkill { filePath: string; resourceRoot: string; source: 'claude' | 'codex'; }
export interface WorkerExtensions { skills: ExtensionSkill[]; servers: Record<string, any>; notices: string[]; }
const validName = (value: unknown): value is string => typeof value === 'string' && /^[\w:.-]{1,128}$/.test(value);
function json(file: string): any {
  try {
    if (statSync(file).size > 2 * 1024 * 1024) throw new Error('EXTENSION_CONFIG_TOO_LARGE');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('EXTENSION_CONFIG_INVALID'); }
}
function directories(dir: string): string[] {
  try { return readdirSync(dir).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function within(root: string, file: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(file));
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
function addSkill(result: WorkerExtensions, name: string, file: string, root: string, source: 'claude' | 'codex') {
  if (!validName(name) || !existsSync(file) || !within(root, file)) return;
  if (statSync(file).size > 1024 * 1024) throw new Error('EXTENSION_SKILL_TOO_LARGE');
  const content = readFileSync(file, 'utf8');
  const fm = extractFrontmatter(content)?.frontmatter;
  if (fm?.['user-invocable'] === false) return;
  const description = (typeof fm?.description === 'string' ? fm.description : `${source === 'codex' ? 'Codex' : 'Claude Code'} installed skill ${name}`).slice(0, 4096);
  if (result.skills.some(skill => skill.name === name && skill.source !== source)) name = `${source}:${name}`;
  const entry = { name, description, filePath: realpathSync(file), resourceRoot: realpathSync(root), source };
  const index = result.skills.findIndex(s => s.name === name);
  if (index >= 0) result.skills[index] = entry; else result.skills.push(entry);
}
function scanSkills(result: WorkerExtensions, directory: string, root: string | undefined, source: 'claude' | 'codex', prefix = '') {
  for (const name of directories(directory)) {
    if (name.startsWith('.')) continue;
    const path = join(directory, name);
    if (existsSync(join(path, 'SKILL.md'))) addSkill(result, prefix + name, join(path, 'SKILL.md'), root ?? path, source);
  }
}
function expand(value: any, root: string, env: NodeJS.ProcessEnv): any {
  if (typeof value === 'string') return value.replace(/\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|[A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    if (name === 'CLAUDE_PLUGIN_ROOT' || name === 'CODEX_PLUGIN_ROOT') return root;
    if (name === 'CLAUDE_PLUGIN_DATA') throw new Error('EXTENSION_PLUGIN_DATA_UNAVAILABLE');
    if (env[name] === undefined && fallback === undefined) throw new Error('EXTENSION_ENV_MISSING');
    return env[name] ?? fallback;
  });
  if (Array.isArray(value)) return value.map(entry => expand(entry, root, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry, root, env)]));
  return value;
}
function addServers(result: WorkerExtensions, servers: any, prefix: string, root: string, env: NodeJS.ProcessEnv) {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
  for (const [name, raw] of Object.entries(servers) as [string, any][]) {
    if (!/^[\w-]{1,100}$/.test(name) || !raw || raw.disabled === true || raw.enabled === false) continue;
    const id = prefix + name;
    try {
      const server = expand(raw, root, env);
      if (typeof server.command !== 'string' && typeof server.url !== 'string') throw new Error('EXTENSION_MCP_INVALID');
      if (server.command && server.args !== undefined && (!Array.isArray(server.args) || server.args.some((v: any) => typeof v !== 'string'))) throw new Error('EXTENSION_MCP_INVALID');
      result.servers[id] = { ...server, ...(server.command ? { args: server.args ?? [], cwd: server.cwd ?? root } : {}) };
    } catch { result.notices.push(`MCP ${id} could not be prepared. Check its configuration and required environment variables.`); }
  }
}
function pluginComponents(result: WorkerExtensions, root: string, name: string, source: 'claude' | 'codex', env: NodeJS.ProcessEnv, includeSkills = true) {
  const manifest = json(join(root, source === 'claude' ? '.claude-plugin' : '.codex-plugin', 'plugin.json'));
  if (includeSkills) scanSkills(result, join(root, 'skills'), root, source, name + ':');
  for (const file of directories(join(root, 'commands'))) {
    if (includeSkills && file.endsWith('.md')) addSkill(result, name + ':' + file.slice(0, -3), join(root, 'commands', file), root, source);
  }
  for (const extra of typeof manifest.skills === 'string' ? [manifest.skills] : Array.isArray(manifest.skills) ? manifest.skills : []) {
    const dir = resolve(root, extra);
    if (includeSkills && existsSync(dir) && within(root, dir)) scanSkills(result, dir, root, source, name + ':');
  }
  const mcpFile = join(root, '.mcp.json');
  const prefix = `${source}_${name.replace(/[^\w-]/g, '_')}__`;
  addServers(result, json(mcpFile).mcpServers, prefix, root, env);
  if (typeof manifest.mcpServers === 'string') {
    const file = resolve(root, manifest.mcpServers);
    if (existsSync(file) && within(root, file)) { const data = json(file); addServers(result, data.mcpServers ?? data, prefix, root, env); }
  } else addServers(result, manifest.mcpServers, prefix, root, env);
  if (manifest.hooks || existsSync(join(root, 'hooks', 'hooks.json'))) result.notices.push(`Plugin ${name}: native executable hooks are not transferred between harnesses; its skills and MCP are available.`);
}

/** Filesystem discovery is restricted to the already-authorized host profile.
 * Container discovery must run inside the container, never against the host home. */
export function readClaudeExtensions(cwd: string, env: NodeJS.ProcessEnv = process.env): WorkerExtensions {
  const home = env.HOME ?? homedir(), claude = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  const result: WorkerExtensions = { skills: [], servers: {}, notices: [] };
  const user = json(join(claude, 'settings.json'));
  const project = json(join(cwd, '.claude', 'settings.json'));
  const local = json(join(cwd, '.claude', 'settings.local.json'));
  const settings = { ...user, ...project, ...local, enabledPlugins: { ...user.enabledPlugins, ...project.enabledPlugins, ...local.enabledPlugins } };
  const cliEnv = { ...env, ...user.env, ...project.env, ...local.env };
  const installed = json(join(claude, 'plugins', 'installed_plugins.json')).plugins ?? {};
  for (const [id, entries] of Object.entries(installed) as [string, any][]) {
    if (settings.enabledPlugins[id] !== true || !Array.isArray(entries)) continue;
    const selected = entries.filter(entry => typeof entry.installPath === 'string' && (entry.scope === 'user' || entry.projectPath && resolve(entry.projectPath) === resolve(cwd)))
      .sort((a, b) => (a.scope === 'user' ? 1 : 0) - (b.scope === 'user' ? 1 : 0))[0];
    if (selected && existsSync(selected.installPath)) pluginComponents(result, selected.installPath, id.split('@')[0], 'claude', cliEnv);
  }
  for (const dir of [claude, join(cwd, '.claude')]) {
    scanSkills(result, join(dir, 'skills'), undefined, 'claude');
    for (const file of directories(join(dir, 'commands'))) if (file.endsWith('.md')) addSkill(result, file.slice(0, -3), join(dir, 'commands', file), join(dir, 'commands'), 'claude');
  }
  const native = json(env.CLAUDE_CONFIG_DIR ? join(claude, '.claude.json') : join(home, '.claude.json'));
  const scope = native.projects?.[resolve(cwd)] ?? {};
  const projectServers = json(join(cwd, '.mcp.json')).mcpServers ?? {};
  const disabled = new Set([...(settings.disabledMcpServers ?? []), ...(settings.disabledMcpjsonServers ?? []), ...(scope.disabledMcpServers ?? []), ...(scope.disabledMcpjsonServers ?? [])]);
  const approvedProject = Object.fromEntries(Object.entries(projectServers).filter(([name]) => settings.enableAllProjectMcpServers === true || scope.enableAllProjectMcpServers === true || (settings.enabledMcpjsonServers ?? []).includes(name) || (scope.enabledMcpjsonServers ?? []).includes(name)));
  const servers = { ...native.mcpServers, ...approvedProject, ...scope.mcpServers };
  addServers(result, Object.fromEntries(Object.entries(servers).filter(([name]) => !disabled.has(name))), 'claude__', cwd, cliEnv);
  return result;
}

export function mergeCodexExtensions(result: WorkerExtensions, native: NativeCodexExtensions, env = process.env): void {
  const roots = new Set<string>();
  for (const plugin of native.plugins ?? []) {
    roots.add(plugin.root);
    pluginComponents(result, plugin.root, plugin.name, 'codex', env);
  }
  for (const skill of native.skills) {
    if (!skill.enabled || !existsSync(skill.path)) continue;
    if (result.skills.some(entry => entry.source === 'codex' && entry.filePath === realpathSync(skill.path))) continue;
    let root = dirname(skill.path);
    if (skill.pluginId) {
      for (let parent = root; dirname(parent) !== parent; parent = dirname(parent)) {
        if (existsSync(join(parent, '.codex-plugin', 'plugin.json'))) { root = parent; break; }
      }
      const pluginName = skill.pluginId.split('@')[0];
      if (!roots.has(root)) { roots.add(root); pluginComponents(result, root, pluginName, 'codex', env, false); }
      const name = pluginName + ':' + skill.name;
      addSkill(result, result.skills.some(entry => entry.name === name) ? `codex:${name}` : name, skill.path, root, 'codex');
    } else addSkill(result, result.skills.some(entry => entry.name === skill.name) ? `codex:${skill.name}` : skill.name, skill.path, root, 'codex');
  }
  const servers: Record<string, any> = {};
  for (const [name, raw] of Object.entries(native.config.mcp_servers ?? {}) as [string, any][]) {
    if (raw.enabled === false) continue;
    const headers = { ...raw.http_headers };
    let missing = false;
    for (const [header, variable] of Object.entries(raw.env_http_headers ?? {})) {
      if (typeof variable !== 'string' || !env[variable]) missing = true; else headers[header] = env[variable];
    }
    if (raw.bearer_token_env_var) {
      if (!env[raw.bearer_token_env_var]) missing = true; else headers.Authorization = `Bearer ${env[raw.bearer_token_env_var]}`;
    }
    if (missing) { result.notices.push(`MCP codex__${name} is missing a required environment variable.`); continue; }
    servers[name] = { ...raw, headers, type: raw.url ? 'http' : 'stdio' };
  }
  addServers(result, servers, 'codex__', env.HOME ?? homedir(), env);
  // Explicit native skill overrides remain authoritative, including for remote
  // plugins whose metadata had to be resolved from the installed cache version.
  const disabled = new Set((native.config.skills?.config ?? []).filter((entry: any) => entry.enabled === false && typeof entry.path === 'string').map((entry: any) => resolve(entry.path)));
  result.skills = result.skills.filter(skill => skill.source !== 'codex' || !disabled.has(skill.filePath) && !disabled.has(dirname(skill.filePath)));
}

export function addUnambiguousSkillAliases(skills: ExtensionSkill[]): void {
  for (const skill of skills) {
    const short = skill.name.split(':').pop()!;
    if (short !== skill.name && skills.filter(candidate => candidate.name.split(':').pop() === short).length === 1) skill.aliases = [...new Set([...(skill.aliases ?? []), short])];
  }
}

const cache = new Map<string, { until: number; value: Promise<WorkerExtensions> }>();
let discoveryTail: Promise<unknown> = Promise.resolve();
export function discoverWorkerExtensions(agent: AgentConfig, gateway?: GatewayConfig, cwd = agent.orchestration?.tasks?.projectRoot || agent.workspace): Promise<WorkerExtensions> {
  if (agent.allow_tools === false) return Promise.resolve({ skills: [], servers: {}, notices: [] });
  if (agent.type === 'app-agent') return import('./container-extensions').then(module => module.discoverContainerExtensions(agent));
  if (resolveOrchestrationConfig(agent.orchestration).tasks.workspaceMode !== 'host') return Promise.resolve({ skills: [], servers: {}, notices: [] });
  const bin = agent.workers?.codex?.bin ?? gateway?.gateway.workers?.codex?.bin;
  const key = JSON.stringify([cwd, bin, process.env.HOME, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]);
  const old = cache.get(key); if (old && old.until > Date.now()) return old.value;
  const value = discoveryTail.catch(() => {}).then(async () => {
    const result = readClaudeExtensions(cwd);
    try {
      const executable = resolveCodexRuntime(bin, cwd).executable;
      const native = await inspectCodexExtensions(executable, cwd);
      mergeCodexExtensions(result, native);
      // Preserve native MCP OAuth/keyring and per-tool policy by calling through
      // the installed CLI, rather than copying its OAuth store into workers.
      for (const name of Object.keys(result.servers)) if (name.startsWith('codex_')) delete result.servers[name];
      const servers = Object.entries(native.config.mcp_servers ?? {}).filter(([, entry]: [string, any]) => entry.enabled !== false).map(([name]) => name);
      if (servers.length || native.pluginIds?.length) {
        const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && /^(OPENAI_|CODEX_ACCESS_TOKEN$)/.test(name))) as Record<string,string>;
        for (const raw of Object.values(native.config.mcp_servers ?? {}) as any[]) {
          const required = [...(Array.isArray(raw.env_vars) ? raw.env_vars : []), ...Object.values(raw.env_http_headers ?? {}), raw.bearer_token_env_var];
          for (const name of required) if (typeof name === 'string' && process.env[name] !== undefined) env[name] = process.env[name]!;
        }
        const providerEnv = native.config.model_providers?.[native.config.model_provider ?? 'openai']?.env_key;
        if (typeof providerEnv === 'string' && process.env[providerEnv]) env[providerEnv] = process.env[providerEnv]!;
        result.servers.codex_native = { nativeCodex: { bin: executable, cwd, home: process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), '.codex'), servers, pluginIds: native.pluginIds ?? [], env } };
      }
    }
    catch { result.notices.push('Codex extension discovery is unavailable. Check the native Codex installation and configuration.'); }
    addUnambiguousSkillAliases(result.skills);
    return result;
  });
  discoveryTail = value.then(() => {}, () => {});
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, { until: Date.now() + 30000, value });
  void value.catch(() => cache.delete(key));
  return value;
}
