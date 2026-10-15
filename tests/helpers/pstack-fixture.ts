import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The 17 roles and tiers of pstack-claude's models.json (v0.9.82), in sheet order. */
export const PSTACK_ROLES: Array<{ role: string; models: string }> = [
  { role: 'feature, refactoring', models: 'default' },
  { role: 'bug-fix', models: 'strongest' },
  { role: 'perf-issue', models: 'strongest' },
  { role: 'hillclimb', models: 'strongest' },
  { role: 'judgment and prose', models: 'default' },
  { role: 'strongest judgment', models: 'strongest' },
  { role: 'how explorer', models: 'default' },
  { role: 'how explainer', models: 'default' },
  { role: 'why investigators', models: 'default' },
  { role: 'why synthesizer', models: 'default' },
  { role: 'reflect tooling', models: 'default' },
  { role: 'reflect judgment, divergent, synthesizer', models: 'default' },
  { role: 'arena runners', models: 'panel' },
  { role: 'arena cross-judge pool', models: 'panel' },
  { role: 'swarm workers', models: 'default' },
  { role: 'architect runners', models: 'panel' },
  { role: 'interrogate reviewers', models: 'panel' },
];

/**
 * A Claude Code config dir as `/plugin install pstack@pstack-claude` leaves it:
 * installed_plugins.json (v2) pointing at an install path holding models.json.
 * `installed: false` writes a registry with only another plugin in it.
 */
export function pstackClaudeConfig(installed = true): { configDir: string; installPath: string; cleanup: () => void } {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-claude-config-'));
  const installPath = path.join(configDir, 'plugins', 'cache', 'pstack-claude', 'pstack', '0.9.82');
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(path.join(installPath, 'models.json'), JSON.stringify({
    tiers: { default: 'opus', strongest: 'fable', panel: ['opus', 'fable', 'sonnet', 'haiku'] },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'session', roles: PSTACK_ROLES.map(r => ({ ...r, skill: 'x' })),
  }));
  // Agent definitions as plugin.json declares them (two of pstack's twelve).
  fs.mkdirSync(path.join(installPath, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(installPath, 'effort-agents'), { recursive: true });
  fs.mkdirSync(path.join(installPath, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pstack', agents: ['./agents/comment-sicko.md', './effort-agents/effort-xhigh.md'] }));
  fs.writeFileSync(path.join(installPath, 'effort-agents', 'effort-xhigh.md'), '---\nname: effort-xhigh\ndescription: pstack subagent at xhigh effort.\neffort: xhigh\n---\n\n# pstack subagent (xhigh effort)\n\nDo the task in your prompt. You have the full tool set. The effort level changes how long you reason, not the task.\n');
  fs.writeFileSync(path.join(installPath, 'agents', 'comment-sicko.md'), '---\nname: comment-sicko\ndescription: A comment-hater.\n---\n\n# Comment Sicko\n\nDelete comments.\n');
  const entry = { scope: 'user', installPath, version: '0.9.82', installedAt: '2026-10-12T00:00:00.000Z', lastUpdated: '2026-10-12T00:00:00.000Z', gitCommitSha: '1bfdab4219d41c4d0bb28d1e7832de6128373611' };
  fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: {
      'what-the-bug@crown-labs-what-the-bug': [{ ...entry, installPath: path.join(configDir, 'other') }],
      ...(installed ? { 'pstack@pstack-claude': [entry] } : {}),
    },
  }));
  return { configDir, installPath, cleanup: () => fs.rmSync(configDir, { recursive: true, force: true }) };
}
