import { runtimeProfileArgs, type RuntimeProfile } from '../../../src/session/runtime-profile';

/**
 * The per-worker plugin gate (#582). A host worker loads every plugin enabled
 * in ~/.claude/settings.json, so a globally installed pstack would reach every
 * agent. Each host worker now gets `enabledPlugins["pstack@pstack-claude"]` in
 * its --settings overlay: false unless the agent is set up. Claude Code merges
 * that map key by key over user/project settings (verified with Claude Code
 * 2.1.296), so other plugins are untouched.
 */

const host: RuntimeProfile = { role: 'worker', hostExecution: true, mcpConfigPath: '/task/mcp.json', overlay: 'worker policy' };
const settingsOf = (args: string[]) => {
  const at = args.indexOf('--settings');
  return at < 0 ? undefined : JSON.parse(args[at + 1]);
};

test.each([false, true])('a host worker gets the pstack plugin key = %s', enabled => {
  const args = runtimeProfileArgs({ ...host, pluginOverrides: { 'pstack@pstack-claude': enabled } }, []);
  expect(settingsOf(args)).toEqual({ enabledPlugins: { 'pstack@pstack-claude': enabled } });
  expect(args.filter(a => a === '--settings')).toHaveLength(1);
  expect(args).not.toContain('--setting-sources');
});

test('checkpoint hooks and the plugin key share one --settings document', () => {
  const settings = settingsOf(runtimeProfileArgs({ ...host, checkpointCommand: 'node checkpoint.cjs', pluginOverrides: { 'pstack@pstack-claude': false } }, []));
  expect(Object.keys(settings).sort()).toEqual(['enabledPlugins', 'hooks']);
  expect(settings.enabledPlugins).toEqual({ 'pstack@pstack-claude': false });
  expect(JSON.stringify(settings.hooks)).toContain('node checkpoint.cjs');
});

test('without overrides a host worker keeps its previous arguments', () => {
  expect(settingsOf(runtimeProfileArgs(host, []))).toBeUndefined();
  expect(settingsOf(runtimeProfileArgs({ ...host, checkpointCommand: 'node c.cjs' }, []))).toEqual({ hooks: expect.any(Object) });
});

test('non-host profiles ignore the overrides and still disable every plugin', () => {
  const args = runtimeProfileArgs({ role: 'worker', mcpConfigPath: '/m.json', overlay: '', pluginOverrides: { 'pstack@pstack-claude': true } }, []);
  expect(args).toContain('--strict-mcp-config');
  expect(settingsOf(args).enabledPlugins['pstack@pstack-claude']).toBeUndefined();
});

test('disallowed native tools are removed from a host worker (#583)', () => {
  const args = runtimeProfileArgs({ ...host, disallowedTools: ['Agent', 'Task'] }, []);
  expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Agent,Task');
  expect(runtimeProfileArgs(host, [])).not.toContain('--disallowedTools');
});

// Review of #591: sessions outside orchestration read the same host settings, so
// they need the same gate; it joins an operator's own --settings instead of adding one.
describe('non-orchestration sessions', () => {
  const { mkdtempSync, rmSync, writeFileSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');
  const { SessionProcess } = require('../../../src/session/process');
  const { SessionStore } = require('../../../src/session/store');
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pstack-legacy-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const argsFor = (extra: Record<string, unknown> = {}, extraFlags: string[] = []): string[] => {
    const agent = { id: 'a', description: '', workspace: dir, env: '', telegram: { botToken: 't' }, claude: { model: 'claude-sonnet-5-5', dangerouslySkipPermissions: false, extraFlags }, ...extra };
    const sp = new SessionProcess('s', 'telegram', agent, { gateway: { logDir: dir, timezone: 'UTC' }, agents: [] }, new SessionStore(join(dir, 'sessions')), 'c');
    return (sp as any).buildArgs(null, 'claude-sonnet-5-5');
  };

  test('an agent that is not set up turns pstack off', () => {
    const args = argsFor();
    expect(args.filter(a => a === '--settings')).toHaveLength(1);
    expect(settingsOf(args)).toEqual({ enabledPlugins: { 'pstack@pstack-claude': false } });
  });

  test('a set-up agent keeps the host settings as they are', () => {
    expect(argsFor({ pstack: {} })).not.toContain('--settings');
  });

  test('the gate joins an inline --settings from claude.extraFlags', () => {
    const args = argsFor({}, ['--settings', JSON.stringify({ env: { A: '1' }, enabledPlugins: { 'figma@x': true } })]);
    expect(args.filter(a => a === '--settings')).toHaveLength(1);
    expect(settingsOf(args)).toEqual({ env: { A: '1' }, enabledPlugins: { 'figma@x': true, 'pstack@pstack-claude': false } });
  });

  test('the gate joins a --settings file from claude.extraFlags', () => {
    writeFileSync(join(dir, 'extra.json'), JSON.stringify({ model: 'x' }));
    const args = argsFor({}, ['--settings=extra.json']);
    expect(args.filter(a => a.startsWith('--settings'))).toHaveLength(1);
    const flag = args.find(a => a.startsWith('--settings='))!;
    expect(JSON.parse(flag.slice('--settings='.length))).toEqual({ model: 'x', enabledPlugins: { 'pstack@pstack-claude': false } });
  });

  test('an unreadable --settings is left as configured', () => {
    expect(argsFor({}, ['--settings', 'missing.json']).filter(a => a.startsWith('--settings') || a === 'missing.json')).toEqual(['--settings', 'missing.json']);
  });
});
