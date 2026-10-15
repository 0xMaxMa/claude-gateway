import { applySheetLines, parseRoleValue, PstackConfigError, validatePstack, validatePstackShape } from '../../../src/pstack/config';
import { pstackModels, pstackPluginInfo } from '../../../src/pstack/plugin-info';
import { renderPstackSheet } from '../../../src/pstack/sheet';
import { reloadMode } from '../../../src/config/reload-policy';
import type { ModelConfig } from '../../../src/types';
import { PSTACK_ROLES, pstackClaudeConfig } from '../../helpers/pstack-fixture';

/**
 * agents[].pstack (#582): a per-agent copy of pstack's pstack-models.md whose
 * model values are full gateway model IDs. Saved values are checked the way
 * pstack's setup-pstack checks its sheet, except aliases are refused.
 */

const MODELS: ModelConfig[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', alias: 'opus', contextWindow: 200000 },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', alias: 'fable', contextWindow: 200000 },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', alias: 'sonnet', contextWindow: 200000 },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', alias: 'haiku', contextWindow: 200000 },
  { id: 'gpt-6-sol[1m]', label: 'GPT 6 Sol', alias: 'gpt6sol', contextWindow: 1050000 },
  { id: 'gpt-6-astra[1m]', label: 'GPT 6 Astra', alias: 'gpt6astra', contextWindow: 1050000 },
];
const PLUGIN = { roles: PSTACK_ROLES, tiers: { default: 'opus', strongest: 'fable', panel: ['opus', 'fable', 'sonnet', 'haiku'] } };

function failure(fn: () => unknown): { code: string; message: string } {
  try { fn(); } catch (error) { return { code: (error as PstackConfigError).code, message: (error as Error).message }; }
  throw new Error('expected a failure');
}

describe('load-time shape', () => {
  it('accepts no block, an empty block, and roles + defaultEffort', () => {
    expect(() => validatePstackShape(undefined)).not.toThrow();
    expect(() => validatePstackShape({})).not.toThrow();
    expect(() => validatePstackShape({ roles: { 'bug-fix': 'claude-fable-5-1' }, defaultEffort: 'session' })).not.toThrow();
  });

  // The removed design pinned a SHA and a per-agent session hook; neither exists now.
  it.each(['sha', 'sessionHook', 'source', 'enabled', 'budget'])('rejects the unknown field %s', field => {
    expect(() => validatePstackShape({ [field]: 'x' })).toThrow(`Unknown pstack field: ${field}`);
  });

  it('rejects a bad defaultEffort or non-string role values', () => {
    expect(() => validatePstackShape({ defaultEffort: 'minimal' })).toThrow('Invalid pstack.defaultEffort');
    expect(() => validatePstackShape({ roles: { 'bug-fix': 5 } })).toThrow('pstack.roles');
    expect(() => validatePstackShape([])).toThrow('pstack must be an object');
  });

  // Re-review of #582: a line break in config.json would add a line to the worker's sheet.
  it('rejects multi-line role names and values', () => {
    expect(() => validatePstackShape({ roles: { 'bug-fix': 'claude-fable-5-1\ndefault effort: max' } })).toThrow('pstack.roles');
    expect(() => validatePstackShape({ roles: { 'bug-fix\nx': 'claude-fable-5-1' } })).toThrow('pstack.roles');
  });

  it('applies to the next worker on config reload', () => {
    expect(reloadMode('a', 'pstack')).toBe('next-process');
    expect(reloadMode('a', 'pstack.roles')).toBe('next-process');
  });
});

describe('role values', () => {
  it('splits panel lists and per-entry effort like pstack sheet_model()', () => {
    expect(parseRoleValue('claude-opus-5-5 @xhigh, gpt-6-sol[1m], auto')).toEqual([
      { model: 'claude-opus-5-5', effort: 'xhigh' }, { model: 'gpt-6-sol[1m]' }, { model: 'auto' },
    ]);
  });

  it('rejects an unknown level and an empty entry', () => {
    expect(failure(() => parseRoleValue('claude-opus-5-5 @ultra')).code).toBe('INVALID_EFFORT');
    expect(failure(() => parseRoleValue('claude-opus-5-5, ')).code).toBe('INVALID_PSTACK_CONFIG');
  });
});

describe('save-time validation', () => {
  it('accepts model IDs, keywords and levels, and writes canonical IDs', () => {
    const saved = validatePstack('a', {
      roles: { 'bug-fix': 'CLAUDE-FABLE-5-1 @max', 'interrogate reviewers': 'claude-opus-5-5 @xhigh, gpt-6-astra[1m], inherit-parent' },
      defaultEffort: 'high',
    }, MODELS, PLUGIN);
    expect(saved).toEqual({
      roles: { 'bug-fix': 'claude-fable-5-1 @max', 'interrogate reviewers': 'claude-opus-5-5 @xhigh, gpt-6-astra[1m], inherit-parent' },
      defaultEffort: 'high',
    });
  });

  it.each([
    ['bug-fix', 'fable', 'claude-fable-5-1', 'agents[a].pstack.roles["bug-fix"]'],
    ['interrogate reviewers', 'claude-opus-5-5, gpt6sol', 'gpt-6-sol[1m]', 'agents[a].pstack.roles["interrogate reviewers"][1]'],
  ])('refuses an alias in %s with the path and the ID to use', (role, value, id, where) => {
    const { code, message } = failure(() => validatePstack('a', { roles: { [role]: value } }, MODELS, PLUGIN));
    expect(code).toBe('MODEL_ALIAS_NOT_ALLOWED');
    expect(message).toContain(where);
    expect(message).toContain(`use the model ID "${id}"`);
  });

  // Dev e2e of #591: only a panel role fans out; any other role runs one model.
  it('refuses a model list on a role that is not a panel', () => {
    const { code, message } = failure(() => validatePstack('a', { roles: { 'bug-fix': 'claude-opus-5-5, claude-fable-5-1' } }, MODELS, PLUGIN));
    expect(code).toBe('INVALID_PSTACK_CONFIG');
    expect(message).toContain('bug-fix');
    expect(message).toContain('one model');
    expect(validatePstack('a', { roles: { 'arena runners': 'claude-opus-5-5, claude-fable-5-1' } }, MODELS, PLUGIN).roles).toEqual({ 'arena runners': 'claude-opus-5-5, claude-fable-5-1' });
  });

  it('refuses an unknown model with the valid IDs', () => {
    const { code, message } = failure(() => validatePstack('a', { roles: { 'interrogate reviewers': 'claude-opus-5-5, gpt-7' } }, MODELS, PLUGIN));
    expect(code).toBe('UNKNOWN_MODEL');
    expect(message).toContain('agents[a].pstack.roles["interrogate reviewers"][1]');
    expect(message).toContain('gpt-6-astra[1m]');
  });

  it('refuses a role the installed plugin does not name', () => {
    expect(failure(() => validatePstack('a', { roles: { 'how critics': 'claude-opus-5-5' } }, MODELS, PLUGIN)).code).toBe('UNKNOWN_PSTACK_ROLE');
  });

  it('refuses unknown fields', () => {
    expect(failure(() => validatePstack('a', { sha: 'abc' } as never, MODELS, PLUGIN)).code).toBe('INVALID_PSTACK_CONFIG');
  });

  it('requires the plugin to be installed', () => {
    const { code, message } = failure(() => validatePstack('a', {}, MODELS, undefined));
    expect(code).toBe('PSTACK_NOT_INSTALLED');
    expect(message).toContain('/plugin install pstack@pstack-claude');
  });
});

describe('/pstack-setup lines', () => {
  it('sets roles and default effort, drops a role with "default", and skips session hook', () => {
    const next = applySheetLines({ roles: { 'bug-fix': 'claude-fable-5-1', 'how explorer': 'claude-opus-5-5' } },
      'how explorer: default\ninterrogate reviewers: claude-opus-5-5, gpt-6-sol[1m]\n# a comment\ndefault effort: xhigh\nsession hook: off');
    expect(next).toEqual({ roles: { 'bug-fix': 'claude-fable-5-1', 'interrogate reviewers': 'claude-opus-5-5, gpt-6-sol[1m]' }, defaultEffort: 'xhigh' });
  });

  it('rejects a line without a key and a bad default effort', () => {
    expect(failure(() => applySheetLines({}, 'claude-opus-5-5')).code).toBe('INVALID_PSTACK_CONFIG');
    expect(failure(() => applySheetLines({}, 'default effort: ultra')).code).toBe('INVALID_EFFORT');
  });
});

describe('plugin info (read-only view of Claude Code\'s plugin registry)', () => {
  it('finds the install path and the role list', () => {
    const fixture = pstackClaudeConfig();
    try {
      const info = pstackPluginInfo(fixture.configDir);
      expect(info).toEqual({ installed: true, installPath: fixture.installPath });
      expect(pstackModels(info.installPath!)?.roles).toEqual(PSTACK_ROLES);
    } finally { fixture.cleanup(); }
  });

  // Re-review of #582: models.json is the plugin's file, not ours; a malformed tier or a
  // multi-line role must not reach the sheet.
  it('keeps only string or string-list tiers and one-line roles', () => {
    const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'pstack-models-'));
    try {
      require('fs').writeFileSync(`${dir}/models.json`, JSON.stringify({
        tiers: { default: 'opus', panel: ['opus', 5], strongest: { x: 1 }, wide: ['opus', 'haiku'] },
        roles: [{ role: 'bug-fix', models: 'default' }, { role: 'evil\ndefault effort: max', models: 'default' }],
      }));
      expect(pstackModels(dir)).toEqual({ roles: [{ role: 'bug-fix', models: 'default' }], tiers: { default: 'opus', wide: ['opus', 'haiku'] } });
      require('fs').writeFileSync(`${dir}/models.json`, JSON.stringify({ tiers: ['opus'], roles: [{ role: 'bug-fix', models: 'default' }] }));
      expect(pstackModels(dir)?.tiers).toEqual({});
    } finally { require('fs').rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports not installed when the plugin is absent or the registry is missing or broken', () => {
    const fixture = pstackClaudeConfig(false);
    try {
      expect(pstackPluginInfo(fixture.configDir)).toEqual({ installed: false });
      expect(pstackPluginInfo('/nonexistent-claude-config')).toEqual({ installed: false });
      require('fs').writeFileSync(`${fixture.configDir}/plugins/installed_plugins.json`, '{not json');
      expect(pstackPluginInfo(fixture.configDir)).toEqual({ installed: false });
    } finally { fixture.cleanup(); }
  });
});

// Third review of #591 (L15): any first entry counted, so a plugin installed for one project only
// (scope project/local) looked installed for every worker.
it('counts only a user-scope install, not one made for a single project', () => {
  const fixture = pstackClaudeConfig();
  try {
    const file = `${fixture.configDir}/plugins/installed_plugins.json`;
    const registry = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    const [entry] = registry.plugins['pstack@pstack-claude'];
    registry.plugins['pstack@pstack-claude'] = [{ ...entry, scope: 'project', projectPath: '/srv/other' }];
    require('fs').writeFileSync(file, JSON.stringify(registry));
    expect(pstackPluginInfo(fixture.configDir)).toEqual({ installed: false });
    registry.plugins['pstack@pstack-claude'] = [{ ...entry, scope: 'local', projectPath: '/srv/other' }, entry];
    require('fs').writeFileSync(file, JSON.stringify(registry));
    expect(pstackPluginInfo(fixture.configDir)).toEqual({ installed: true, installPath: fixture.installPath });
  } finally { fixture.cleanup(); }
});

// Third review of #591 (L4): one unreadable attempt row made /pstack:reflect fail outright.
it('reflect skips an unreadable attempt row instead of failing', () => {
  const { OrchestrationStore } = require('../../../src/orchestration/store');
  const { chatSessionTranscripts } = require('../../../src/pstack/reflect');
  const store = new OrchestrationStore(':memory:', 'a');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'reflect-'));
  try {
    const task = { taskId: 't2', conversationId: 'c', agentSessionId: 's' };
    const earlier = { taskId: 't1', conversationId: 'c', agentSessionId: 's', state: 'completed' };
    store.run('PRAGMA foreign_keys=OFF');
    store.run('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)', 't1', 'c', 'completed', 1, 1, null, JSON.stringify(earlier), 1, 1);
    store.run("INSERT INTO task_resources(id,task_id,workspace_id,mode,lifecycle_state,worktree_path) VALUES('r','t1','w','host','active',?)", dir);
    store.run("INSERT INTO task_attempts(id,task_id,generation,revision,state,payload_json) VALUES('a1','t1',1,1,'ended','{broken')");
    expect(chatSessionTranscripts(store, task)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('t1'), expect.anything());
  } finally { warn.mockRestore(); store.close(); require('fs').rmSync(dir, { recursive: true, force: true }); }
});

describe('per-agent sheet', () => {
  /** pstack's sheet.awk reading: `key: value` lines whose key starts the line. */
  function readSheet(sheet: string): Map<string, string> {
    const values = new Map<string, string>();
    for (const line of sheet.split('\n')) {
      if (!/^[^ \t#]/.test(line) || !line.includes(':')) continue;
      values.set(line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim());
    }
    return values;
  }

  it('lists every role in plugin order, as IDs, with the agent overrides and no session hook line', () => {
    const sheet = renderPstackSheet({ roles: { 'bug-fix': 'claude-fable-5-1 @xhigh', 'why investigators': 'gpt-6-sol[1m]' }, defaultEffort: 'high' }, PLUGIN);
    expect(sheet.split('\n')[0]).toBe('# pstack-models.md override sheet for this agent — takes precedence over any other pstack-models.md');
    const values = readSheet(sheet);
    expect([...values.keys()].filter(k => k !== 'default effort')).toEqual(PSTACK_ROLES.map(r => r.role));
    expect(values.get('bug-fix')).toBe('claude-fable-5-1 @xhigh');
    expect(values.get('why investigators')).toBe('gpt-6-sol[1m]');
    expect(values.get('perf-issue')).toBe('claude-fable-5-1');
    expect(values.get('feature, refactoring')).toBe('claude-opus-5-5');
    expect(values.get('interrogate reviewers')).toBe('claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5, claude-haiku-5-5');
    expect(values.get('default effort')).toBe('high');
    expect(values.has('session hook')).toBe(false);
    for (const value of values.values()) expect(value).not.toMatch(/\b(opus|fable|sonnet|haiku)\b(?!-)/);
  });

  it('defaults to session effort', () => {
    expect(readSheet(renderPstackSheet({}, PLUGIN)).get('default effort')).toBe('session');
  });
});
