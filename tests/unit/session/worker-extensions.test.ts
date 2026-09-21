import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readClaudeExtensions, mergeCodexExtensions, discoverWorkerExtensions } from '../../../src/session/worker-extensions';
import { resolveNamedSkill, skillCatalog } from '../../../src/orchestration/skills';

let root: string, home: string, cwd: string;
function file(path: string, content: string | object) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content)); }
function skill(path: string, name = 'review') { file(path, `---\nname: ${name}\ndescription: Review the current work\n---\nRead shared/foundation.md from the plugin root.`); }
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'worker-extensions-')); home = join(root, 'home'); cwd = join(root, 'project'); mkdirSync(home); mkdirSync(cwd); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function plugin(enabled = true) {
  const path = join(home, '.claude', 'plugins', 'cache', 'market', 'workflow', '1');
  file(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'workflow@market': enabled } });
  file(join(home, '.claude', 'plugins', 'installed_plugins.json'), { plugins: { 'workflow@market': [{ scope: 'user', installPath: path }] } });
  file(join(path, '.claude-plugin', 'plugin.json'), { name: 'workflow' });
  skill(join(path, 'skills', 'review', 'SKILL.md'));
  file(join(path, 'shared', 'foundation.md'), 'Installed foundation');
  return path;
}
test('only enabled installed plugins enter the catalog, with their whole resource root', () => {
  const path = plugin();
  skill(join(home, '.claude', 'plugins', 'cache', 'market', 'workflow', '999', 'skills', 'stale', 'SKILL.md'));
  const result = readClaudeExtensions(cwd, { HOME: home });
  expect(result.skills).toHaveLength(1);
  expect(result.skills[0]).toMatchObject({ name: 'workflow:review', resourceRoot: path });
  const registry = { skills: new Map(), cliSkills: result.skills };
  expect(resolveNamedSkill('workflow:review', '123', registry)).toMatchObject({ invocation: 'cli', content: expect.stringContaining('shared/foundation.md'), resourceRoot: path });
  expect(skillCatalog(registry)).not.toContain(path);
  expect(skillCatalog(registry)).not.toContain('Read shared/foundation.md');
});
test('project disable overrides a globally enabled plugin', () => {
  plugin(); file(join(cwd, '.claude', 'settings.local.json'), { enabledPlugins: { 'workflow@market': false } });
  expect(readClaudeExtensions(cwd, { HOME: home }).skills).toEqual([]);
});
test('disabled and uninstalled cached plugins are not inferred as enabled', () => {
  plugin(false);
  expect(readClaudeExtensions(cwd, { HOME: home }).skills).toEqual([]);
});
test('project install takes precedence and other projects are excluded', () => {
  const base = plugin(), local = join(root, 'local');
  file(join(local, '.claude-plugin', 'plugin.json'), {}); skill(join(local, 'skills', 'review', 'SKILL.md'));
  file(join(home, '.claude', 'plugins', 'installed_plugins.json'), { plugins: { 'workflow@market': [{ scope: 'project', projectPath: join(root, 'other'), installPath: join(root, 'wrong') }, { scope: 'user', installPath: base }, { scope: 'project', projectPath: cwd, installPath: local }] } });
  expect(readClaudeExtensions(cwd, { HOME: home }).skills[0].resourceRoot).toBe(local);
});
test('plugin files cannot follow a symlink outside their installed root', () => {
  const path = plugin(), outside = join(root, 'outside.md'); skill(outside);
  rmSync(join(path, 'skills', 'review', 'SKILL.md')); symlinkSync(outside, join(path, 'skills', 'review', 'SKILL.md'));
  expect(readClaudeExtensions(cwd, { HOME: home }).skills).toEqual([]);
});
test('Claude MCP preserves project consent, disabled servers, env and plugin root', () => {
  const path = plugin();
  file(join(path, '.mcp.json'), { mcpServers: { local: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], env: { TOKEN: '${EXTENSION_TOKEN}' } } } });
  file(join(home, '.claude.json'), { mcpServers: { global: { url: 'https://example.invalid/mcp' }, disabled: { command: 'disabled' } }, projects: { [cwd]: { disabledMcpServers: ['disabled'], enabledMcpjsonServers: ['approved'] } } });
  file(join(cwd, '.mcp.json'), { mcpServers: { approved: { command: 'approved' }, unapproved: { command: 'unapproved' } } });
  const result = readClaudeExtensions(cwd, { HOME: home, EXTENSION_TOKEN: 'fixture-token' });
  expect(Object.keys(result.servers).sort()).toEqual(['claude__approved', 'claude__global', 'claude_workflow__local']);
  expect(result.servers.claude_workflow__local).toMatchObject({ args: [path + '/server.js'], env: { TOKEN: 'fixture-token' } });
});
test('missing required MCP env is actionable without leaking values', () => {
  const path = plugin(); file(join(path, '.mcp.json'), { mcpServers: { local: { command: 'node', env: { TOKEN: '${MISSING_TOKEN}' } } } });
  const result = readClaudeExtensions(cwd, { HOME: home });
  expect(result.servers).toEqual({}); expect(result.notices[0]).toContain('required environment');
});
test('native Codex skills, plugin resources and tool restrictions survive projection', () => {
  const result = readClaudeExtensions(cwd, { HOME: home });
  const path = join(root, 'codex-plugin'); file(join(path, '.codex-plugin', 'plugin.json'), { name: 'research' }); skill(join(path, 'skills', 'research', 'SKILL.md'), 'research');
  mergeCodexExtensions(result, { config: { mcp_servers: { docs: { url: 'https://example.invalid/mcp', enabled_tools: ['read'], disabled_tools: ['delete'], bearer_token_env_var: 'MCP_TOKEN' }, off: { enabled: false, command: 'no' } } }, skills: [{ name: 'research', description: 'Read', enabled: true, pluginId: 'research@market', path: join(path, 'skills', 'research', 'SKILL.md') }] }, { HOME: home, MCP_TOKEN: 'fixture' });
  expect(result.skills[0]).toMatchObject({ name: 'research:research', resourceRoot: path, source: 'codex' });
  expect(resolveNamedSkill('research:research', '', { skills: new Map(), cliSkills: result.skills })?.invocation).toBeUndefined();
  expect(result.servers.codex__docs).toMatchObject({ headers: { Authorization: 'Bearer fixture' }, enabled_tools: ['read'], disabled_tools: ['delete'] });
  expect(result.servers.codex__off).toBeUndefined();
});
test('remote plugin materialization respects explicit disabled skills', () => {
  const result = readClaudeExtensions(cwd, { HOME: home }), path = join(root, 'remote');
  file(join(path, '.codex-plugin', 'plugin.json'), { name: 'remote' }); skill(join(path, 'skills', 'active', 'SKILL.md')); skill(join(path, 'skills', 'disabled', 'SKILL.md'));
  mergeCodexExtensions(result, { skills: [], plugins: [{ name: 'remote', root: path }], config: { skills: { config: [{ path: join(path, 'skills', 'disabled', 'SKILL.md'), enabled: false }] } } }, { HOME: home });
  expect(result.skills.map(s => s.name)).toEqual(['remote:active']);
});
test('personal extensions are not discovered for an isolated worker', async () => {
  await expect(discoverWorkerExtensions({ workspace: cwd, orchestration: { tasks: { workspaceMode: 'isolated-worktree' } } } as any)).resolves.toEqual({ skills: [], servers: {}, notices: [] });
});

test('container skill paths are never opened in the host namespace', () => {
  const entry = { name: 'workflow:review', description: 'Review', fileScope: 'container' as const, content: 'Read shared/foundation.md', filePath: '/does-not-exist-on-host/SKILL.md' };
  expect(resolveNamedSkill(entry.name, '', { skills: new Map(), cliSkills: [entry] })?.content).toContain('shared/foundation.md');
});

test('native plugin skill is not duplicated when installed and skills inventories overlap', () => {
  const result = readClaudeExtensions(cwd, { HOME: home }), path = join(root, 'remote');
  file(join(path, '.codex-plugin', 'plugin.json'), { name: 'remote' });
  const entry = join(path, 'skills', 'review', 'SKILL.md'); skill(entry);
  mergeCodexExtensions(result, { config: {}, plugins: [{ name: 'remote', root: path }], skills: [{ name: 'review', description: 'Review', path: entry, enabled: true, pluginId: 'remote@market' }] }, { HOME: home });
  expect(result.skills.map(s => s.name)).toEqual(['remote:review']);
});
test('Claude settings environment resolves MCP placeholders with local precedence', () => {
  plugin();
  file(join(cwd, '.claude', 'settings.local.json'), { env: { MCP_ENDPOINT: 'https://local.example/mcp' }, enableAllProjectMcpServers: true });
  file(join(cwd, '.mcp.json'), { mcpServers: { docs: { url: '${MCP_ENDPOINT}' } } });
  expect(readClaudeExtensions(cwd, { HOME: home, MCP_ENDPOINT: 'https://base.example/mcp' }).servers.claude__docs.url).toBe('https://local.example/mcp');
});
