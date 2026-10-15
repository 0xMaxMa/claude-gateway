import { Effort, isEffort, ModelResolutionError, resolveModelId } from '../agent/model-registry';
import type { ModelConfig } from '../types';
import { PSTACK_INSTALL_HINT, PSTACK_PLUGIN_ID, PstackModels } from './plugin-info';
import { pstackPanelDefault } from './sheet';

/**
 * `agents[].pstack` mirrors pstack's own pstack-models.md sheet: role lines
 * (`<model>[ @<level>]`, comma-separated for panel roles) and `default effort`.
 * The one difference is that models are full gateway model IDs, never slugs or
 * aliases, so a role keeps its model when an alias moves. Having the block at
 * all is what sets the agent up; there is nothing else to configure.
 */
export type PstackEffort = Effort | 'session';
export interface AgentPstackConfig {
  roles?: Record<string, string>;
  defaultEffort?: PstackEffort;
}

/** pstack keywords, not model aliases: the role runs on the parent's model. */
export const PSTACK_KEYWORDS = ['inherit-parent', 'auto'];

export type PstackConfigCode = 'PSTACK_NOT_INSTALLED' | 'PSTACK_UNSUPPORTED_AGENT' | 'UNKNOWN_PSTACK_ROLE' | 'INVALID_EFFORT' | 'UNKNOWN_MODEL' | 'MODEL_ALIAS_NOT_ALLOWED' | 'INVALID_PSTACK_CONFIG';
export class PstackConfigError extends Error {
  constructor(readonly code: PstackConfigCode, message: string) {
    super(message);
    this.name = 'PstackConfigError';
  }
}

/** Load-time shape check only. Models and roles are checked when saved: they
 * need the live catalog and the installed plugin, and a load-time failure
 * would take the whole agent offline. */
export function validatePstackShape(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pstack must be an object');
  for (const key of Object.keys(value)) if (!['roles', 'defaultEffort'].includes(key)) throw new Error(`Unknown pstack field: ${key}`);
  const { roles, defaultEffort } = value as AgentPstackConfig;
  if (defaultEffort !== undefined && defaultEffort !== 'session' && !isEffort(defaultEffort)) throw new Error('Invalid pstack.defaultEffort');
  if (roles !== undefined && (!roles || typeof roles !== 'object' || Array.isArray(roles) || Object.entries(roles).some(([k, v]) => typeof v !== 'string' || !v.trim() || /[\r\n]/.test(k + v)))) {
    throw new Error('pstack.roles must map role names to one-line model values');
  }
}

/** A role value's entries. Like pstack's sheet_model(), a trailing ` @<level>`
 * is split off before the model is looked at. */
export function parseRoleValue(value: string): Array<{ model: string; effort?: Effort }> {
  return value.split(',').map(raw => {
    const entry = raw.trim();
    const suffix = /^(.*?)\s+@(\S+)$/.exec(entry);
    if (suffix && !isEffort(suffix[2])) throw new PstackConfigError('INVALID_EFFORT', `"@${suffix[2]}" is not an effort level; use low, medium, high, xhigh or max.`);
    const model = suffix ? suffix[1].trim() : entry;
    if (!model) throw new PstackConfigError('INVALID_PSTACK_CONFIG', `"${value}" has an empty entry.`);
    return suffix ? { model, effort: suffix[2] as Effort } : { model };
  });
}

/**
 * Save-time validation, the same checks as step 5 of pstack's setup-pstack:
 * every model is a known model ID (or `inherit-parent`/`auto`), every level is
 * a level, every role is one the installed plugin names. Returns the block
 * with each model written as its canonical ID.
 */
export function validatePstack(agentId: string, block: AgentPstackConfig, models: ModelConfig[], plugin: PstackModels | undefined): AgentPstackConfig {
  try { validatePstackShape(block); } catch (error) { throw new PstackConfigError('INVALID_PSTACK_CONFIG', (error as Error).message); }
  if (!plugin) throw new PstackConfigError('PSTACK_NOT_INSTALLED', `${PSTACK_PLUGIN_ID} is not installed for Claude Code on this host. ${PSTACK_INSTALL_HINT} Then run /pstack-setup again.`);
  const known = plugin.roles.map(r => r.role);
  const roles: Record<string, string> = {};
  for (const [role, value] of Object.entries(block.roles ?? {})) {
    if (!known.includes(role)) throw new PstackConfigError('UNKNOWN_PSTACK_ROLE', `Unknown pstack role "${role}" at agents[${agentId}].pstack.roles. Roles: ${known.join('; ')}.`);
    const entries = parseRoleValue(value);
    if (entries.length > 1 && pstackPanelDefault(plugin, role) === undefined) throw new PstackConfigError('INVALID_PSTACK_CONFIG', `"${role}" is not a panel role; give it one model at agents[${agentId}].pstack.roles.`);
    roles[role] = entries.map(({ model, effort }, i) => {
      let id = model;
      if (!PSTACK_KEYWORDS.includes(model)) {
        try { id = resolveModelId(models, model, `agents[${agentId}].pstack.roles["${role}"]${entries.length > 1 ? `[${i}]` : ''}`).id; }
        catch (error) {
          if (error instanceof ModelResolutionError) throw new PstackConfigError(error.code, error.message);
          throw error;
        }
      }
      return effort ? `${id} @${effort}` : id;
    }).join(', ');
  }
  return { ...(Object.keys(roles).length ? { roles } : {}), ...(block.defaultEffort ? { defaultEffort: block.defaultEffort } : {}) };
}

/**
 * Apply pstack-models.md lines (`<role>: <value>`, `default effort: <level>`)
 * to a block, the way /pstack-setup edits it. `<role>: default` drops the
 * override, like deleting the line from the sheet; `<role> += <entry>` and
 * `<role> -= <model>[ @<level>]` edit a panel list one entry at a time. A `session hook` line is
 * skipped: the plugin's hook reads it from the global sheet only.
 */
export function applySheetLines(block: AgentPstackConfig, text: string, panelDefault?: (role: string) => string | undefined): AgentPstackConfig {
  const roles = { ...block.roles };
  let defaultEffort = block.defaultEffort;
  for (const line of text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
    // Panel lists change one entry at a time: `<role> += <entry>` appends, `<role> -= <model>` drops that model's
    // entries and `<role> -= <model> @<level>` drops that one entry.
    const edit = /^(.+?)\s+([+-])=\s*(.+)$/.exec(line);
    if (edit) {
      const [, key, op, value] = edit;
      // Without the installed plugin there is no role list; saving reports that.
      const fallback = panelDefault?.(key);
      if (panelDefault && fallback === undefined) throw new PstackConfigError('INVALID_PSTACK_CONFIG', `${key} is not a panel role; use "${key}: <model-id>".`);
      if (op === '+' && value.includes(',')) throw new PstackConfigError('INVALID_PSTACK_CONFIG', `"+=" adds one entry at a time; use one line per model.`);
      // An unset role starts from its skill default, as the sheet shows it.
      const entries = (roles[key] ?? fallback ?? '').split(',').map(e => e.trim()).filter(Boolean);
      const model = (entry: string) => entry.replace(/\s+@\S+$/, '').toLowerCase();
      const same = (entry: string) => entry.replace(/\s+/g, ' ').toLowerCase() === value.replace(/\s+/g, ' ').toLowerCase();
      if (op === '+' && entries.some(same)) throw new PstackConfigError('INVALID_PSTACK_CONFIG', `"${value}" is already in ${key}.`);
      const kept = op === '+' ? [...entries, value] : entries.filter(e => /\s@\S+$/.test(value) ? !same(e) : model(e) !== model(value));
      if (op === '-' && kept.length === entries.length) throw new PstackConfigError('INVALID_PSTACK_CONFIG', `"${value}" is not in ${key}.`);
      if (!kept.length) throw new PstackConfigError('INVALID_PSTACK_CONFIG', `A panel needs at least one entry; use "${key}: default" to go back to the skill default.`);
      roles[key] = kept.join(', ');
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1) throw new PstackConfigError('INVALID_PSTACK_CONFIG', `"${line}" is not a "<role>: <value>" line.`);
    const key = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim();
    if (key === 'session hook') continue;
    if (key === 'default effort') {
      if (value !== 'session' && !isEffort(value)) throw new PstackConfigError('INVALID_EFFORT', `default effort must be session or one of low, medium, high, xhigh, max.`);
      defaultEffort = value as PstackEffort;
    } else if (value === 'default') delete roles[key];
    else roles[key] = value;
  }
  return { ...(Object.keys(roles).length ? { roles } : {}), ...(defaultEffort ? { defaultEffort } : {}) };
}
