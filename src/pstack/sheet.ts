import { AgentPstackConfig } from './config';
import { PstackModels } from './plugin-info';

/** pstack's model slugs as gateway model IDs. Each pstack SKILL.md names its
 * defaults as slugs, and the sheet must not hand a skill a slug: subagents
 * resolve full IDs only. */
export const PSTACK_SLUG_IDS: Record<string, string> = {
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

// No colon in the prose: pstack reads any `key: value` line as a setting.
const HEADER = `# pstack-models.md override sheet for this agent — takes precedence over any other pstack-models.md

Per-role model overrides for pstack skills, in the shape of pstack's own pstack-models.md. Every role is listed, so no skill falls back to a default from its SKILL.md. Values are model IDs; pass each one unchanged as the subagent \`model\`. A value of \`inherit-parent\` or \`auto\` runs that role on the parent's model (omit \`model\`); an alias entry in a panel list still counts toward that panel's fan-out. A model may carry a reasoning effort, as in \`claude-opus-5-5 @xhigh\` (levels low, medium, high, xhigh and max), each entry of a panel list on its own. \`default effort\` sets the level for a value without one; \`session\` keeps the parent's effort.`;

/**
 * Render an agent's sheet for its worker context (never written to disk: the
 * file pstack reads is global to the host, this is per agent). Roles come from
 * the installed plugin's models.json, in its order; a role the agent did not
 * set gets its skill default, as IDs. No `session hook` line: the plugin's hook
 * reads that from the global sheet only.
 */
export function renderPstackSheet(block: AgentPstackConfig, plugin: PstackModels): string {
  const lines = plugin.roles.map(({ role }) => `${role}: ${block.roles?.[role] ?? pstackRoleDefault(plugin, role)}`);
  return [HEADER, '', ...lines, '', `default effort: ${block.defaultEffort ?? 'session'}`].join('\n');
}

/** A role's skill default as model IDs (its models.json tier, slugs mapped). */
export function pstackRoleDefault(plugin: PstackModels, role: string): string | undefined {
  const tier = plugin.roles.find(r => r.role === role)?.models;
  if (!tier) return undefined;
  const slugs = plugin.tiers[tier] ?? plugin.tiers.default ?? 'opus';
  return (Array.isArray(slugs) ? slugs : [slugs]).map(slug => PSTACK_SLUG_IDS[slug] ?? slug).join(', ');
}

/** A panel role's skill default (its tier is a list, like `panel`); undefined for a one-model role. */
export function pstackPanelDefault(plugin: PstackModels, role: string): string | undefined {
  const tier = plugin.roles.find(r => r.role === role)?.models;
  return tier && Array.isArray(plugin.tiers[tier]) ? pstackRoleDefault(plugin, role) : undefined;
}
