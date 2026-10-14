import { createHash } from 'crypto';
import { EFFORT_LEVELS, isEffort } from '../agent/model-registry';
import type { ModelConfig } from '../types';
import { AgentPstackConfig, PstackConfigError, applySheetLines, parseRoleValue } from './config';
import { PstackModels } from './plugin-info';
import { pstackPanelDefault, pstackRoleDefault } from './sheet';

/**
 * The /pstack-setup menu: Telegram buttons over the same pstack-models.md
 * lines the text command takes. Every change is computed with
 * applySheetLines and saved by the caller through updatePstackConfig, so the
 * buttons, the text command and the API apply the same rules. Callback data
 * (`ps:…`, at most 64 bytes as Telegram requires) names roles by their index
 * in the installed plugin's role list plus a tag of the role's name, and models
 * by ID; both are checked again here and when saved.
 */

export interface PstackMenuButton { text: string; data: string }
export interface PstackMenuScreen { text: string; keyboard: PstackMenuButton[][]; closed?: boolean }
export interface PstackMenuState { block: AgentPstackConfig | undefined; plugin: PstackModels | undefined; models: ModelConfig[]; installHint: string }

type Family = 'c' | 'g';
/** pstack's two kinds of role: single-model roles and panel roles (a list of models, one subagent each). */
type Group = 's' | 'p';
export type PstackMenuView = { kind: 'home' } | { kind: 'effort' } | { kind: 'reset' } | { kind: 'close' } | { kind: 'roles' } | { kind: 'list'; group: Group; page: number }
  | { kind: 'role'; role: number } | { kind: 'pick'; role: number; add: boolean; family: Family; page: number };
/** What a button does: the screen to show next and, for a change, the new block (`null` turns pstack off). */
export interface PstackMenuStep { view: PstackMenuView; next?: AgentPstackConfig | null }

const PAGE_SIZE = 8;
const FAMILIES: Record<Family, string> = { c: 'Claude', g: 'GPT' };
const GROUPS: Record<Group, string> = { s: 'Single-model', p: 'Panels' };
const MAX_DATA_BYTES = 64;
/** Role buttons are kept short enough that Telegram shows the model beside the name on a phone. */
const MAX_ROLE_LABEL = 40;

/** pstack runs subagents on Claude workers and, for GPT models, Codex workers; other catalog models are left to the text command. */
function family(model: ModelConfig): Family | undefined {
  if (model.workerHarness === 'codex' || /^(?:(?:openai|chatgpt)\/)?gpt-[a-z0-9]/i.test(model.id)) return 'g';
  if (model.workerHarness === 'claude' || /^claude-/i.test(model.id)) return 'c';
  return undefined;
}

/** A family's models for a role; a `[1m]` row is left out where its base model is listed, as pstack's own defaults are base IDs. */
export function pstackPickableModels(models: ModelConfig[], wanted: Family): ModelConfig[] {
  const ids = new Set(models.map(m => m.id.toLowerCase()));
  return models.filter(m => family(m) === wanted && !(/\[1m\]$/i.test(m.id) && ids.has(m.id.toLowerCase().replace(/\[1m\]$/, ''))));
}

/**
 * A role in callback data: its index and a 3-character tag of its name, so a
 * button from before a plugin update that reorders the roles is refused
 * rather than changing another role.
 */
const roleTag = (role: string) => createHash('sha256').update(role).digest('hex').slice(0, 3);
const roleRef = (plugin: PstackModels, index: number) => `${index}-${roleTag(plugin.roles[index].role)}`;

const fits = (data: string) => Buffer.byteLength(data, 'utf8') <= MAX_DATA_BYTES;
const button = (text: string, data: string): PstackMenuButton => ({ text: text.length > 60 ? text.slice(0, 59) + '…' : text, data });

/** A role's current value: its override, or its skill default as model IDs. */
function roleValue(state: PstackMenuState, role: string): { value: string; override: boolean } {
  const override = state.block?.roles?.[role];
  return { value: override ?? pstackRoleDefault(state.plugin!, role) ?? '', override: override !== undefined };
}

/** A role's entries, or `undefined` for a value hand-edited into config.json that does not parse. */
function roleEntries(state: PstackMenuState, role: string): ReturnType<typeof parseRoleValue> | undefined {
  try { return parseRoleValue(roleValue(state, role).value); } catch (error) {
    if (error instanceof PstackConfigError) return undefined;
    throw error;
  }
}

const isPanel = (plugin: PstackModels, role: string) => pstackPanelDefault(plugin, role) !== undefined;

/** A group's roles as indexes into the plugin's role list, in sheet order. */
function groupRoles(plugin: PstackModels, group: Group): number[] {
  return plugin.roles.flatMap(({ role }, i) => (isPanel(plugin, role) === (group === 'p') ? [i] : []));
}

/** One `✏️`/`•` line per role, as the text form and the list screens show them. */
function roleLines(state: PstackMenuState, indexes: number[]): string[] {
  return indexes.map(i => {
    const role = state.plugin!.roles[i].role;
    const { value, override } = roleValue(state, role);
    if (!roleEntries(state, role)) return `⚠️ ${role}: ${value} (invalid)`;
    return `${override ? '✏️' : '•'} ${role}: ${value}`;
  });
}

/** A role button: name and current model (a panel shows its size), the name shortened first so the model stays visible. */
function roleLabel(state: PstackMenuState, role: string): string {
  const { value, override } = roleValue(state, role);
  const entries = roleEntries(state, role);
  const suffix = ` · ${!entries ? '⚠️ invalid' : isPanel(state.plugin!, role) ? `${entries.length} model${entries.length === 1 ? '' : 's'}` : value}`;
  const mark = override ? '✏️ ' : '';
  const room = Math.max(12, MAX_ROLE_LABEL - suffix.length - mark.length);
  return `${mark}${role.length > room ? role.slice(0, room - 1) + '…' : role}${suffix}`;
}

function invalid(): never {
  throw new PstackConfigError('INVALID_PSTACK_CONFIG', 'This button is out of date. Use /pstack-setup again.');
}

/** Turn a button's callback data into the next screen and, for a change, the new block. */
export function pstackMenuStep(data: string, state: PstackMenuState): PstackMenuStep {
  if (data === 'ps:h') return { view: { kind: 'home' } };
  if (data === 'ps:x') return { view: { kind: 'close' } };
  if (!state.plugin) invalid();
  const plugin = state.plugin;
  const block = state.block ?? {};
  const apply = (line: string) => applySheetLines(block, line, role => pstackPanelDefault(plugin, role));
  if (data === 'ps:on') return { view: { kind: 'home' }, next: block };
  if (data === 'ps:off') return { view: { kind: 'home' }, next: null };
  if (data === 'ps:de') return { view: { kind: 'effort' } };
  if (data === 'ps:rs') return { view: { kind: 'reset' } };
  // Off has no saved roles to reset; saving `{}` would turn pstack on.
  if (data === 'ps:rs!') return { view: { kind: 'home' }, ...(state.block ? { next: {} } : {}) };
  if (data === 'ps:g') return { view: { kind: 'roles' } };
  const list = /^ps:l:([sp]):(\d{1,3})$/.exec(data);
  if (list) return { view: { kind: 'list', group: list[1] as Group, page: Number(list[2]) } };
  const effort = /^ps:de:(\w+)$/.exec(data);
  if (effort) {
    if (effort[1] !== 'session' && !isEffort(effort[1])) invalid();
    return { view: { kind: 'home' }, next: apply(`default effort: ${effort[1]}`) };
  }
  const match = /^ps:(r|d|e|p|m|a|rm):(\d{1,3})-([0-9a-f]{3})(?::(.+))?$/.exec(data);
  const index = match ? Number(match[2]) : -1;
  const role = plugin.roles[index]?.role;
  if (!match || role === undefined || roleTag(role) !== match[3]) invalid();
  const [, verb, , , arg] = match;
  const panel = isPanel(plugin, role);
  // Parsed only where a change needs the current value, so an invalid one can still be opened and replaced.
  const entries = () => parseRoleValue(roleValue(state, role).value);
  switch (verb) {
    case 'r': return { view: { kind: 'role', role: index } };
    case 'd': return { view: { kind: 'role', role: index }, next: apply(`${role}: default`) };
    case 'e': {
      if (panel || !arg || (arg !== 'none' && !isEffort(arg))) invalid();
      return { view: { kind: 'role', role: index }, next: apply(`${role}: ${entries()[0].model}${arg === 'none' ? '' : ` @${arg}`}`) };
    }
    case 'p': {
      const pick = /^([sa]):([cg]):(\d{1,3})$/.exec(arg ?? '');
      if (!pick || (pick[1] === 'a') !== panel) invalid();
      return { view: { kind: 'pick', role: index, add: pick[1] === 'a', family: pick[2] as Family, page: Number(pick[3]) } };
    }
    case 'm': case 'a': {
      if ((verb === 'a') !== panel || !arg) invalid();
      // Only models the picker offers; the save checks them against the catalog again.
      if (!(['c', 'g'] as Family[]).some(f => pstackPickableModels(state.models, f).some(m => m.id === arg))) invalid();
      const level = verb === 'm' ? roleEntries(state, role)?.[0].effort : undefined;
      return { view: { kind: 'role', role: index }, next: apply(verb === 'a' ? `${role} += ${arg}` : `${role}: ${arg}${level ? ` @${level}` : ''}`) };
    }
    case 'rm': {
      const entry = entries()[Number(arg)];
      if (!panel || !entry) invalid();
      return { view: { kind: 'role', role: index }, next: apply(`${role} -= ${entry.model}`) };
    }
  }
  return invalid();
}

/** Render a screen for the current block. `notice` is the outcome of the last button, shown on top. */
export function pstackMenuScreen(view: PstackMenuView, state: PstackMenuState, notice?: string): PstackMenuScreen {
  const top = notice ? `${notice}\n\n` : '';
  if (view.kind === 'close') return { text: 'pstack setup closed.', keyboard: [], closed: true };
  const close = [button('Close', 'ps:x')];
  if (!state.plugin) return { text: `${top}pstack is not installed for Claude Code on this host. ${state.installHint}`, keyboard: [close] };
  const plugin = state.plugin;
  const effortLabel = state.block?.defaultEffort ?? 'session';
  const back = (data: string) => [button('◀ Back', data)];
  if (view.kind === 'effort') {
    return {
      text: `${top}Default effort: ${effortLabel}\nThe level for a role without its own. session keeps the parent's effort.`,
      keyboard: [...['session', ...EFFORT_LEVELS].map(level => [button(`${level === effortLabel ? '✅ ' : ''}${level}`, `ps:de:${level}`)]), back('ps:h')],
    };
  }
  if (view.kind === 'reset') {
    if (!state.block) return { text: `${top}pstack is off, so every role already uses its skill default.`, keyboard: [back('ps:h')] };
    return { text: `${top}Reset every role and the default effort to the skill defaults? pstack stays on.`, keyboard: [[button('✅ Reset', 'ps:rs!'), button('Cancel', 'ps:h')]] };
  }
  if (view.kind === 'home') {
    const on = state.block !== undefined;
    const changed = plugin.roles.filter(({ role }) => roleValue(state, role).override).length;
    return {
      text: `${top}pstack setup\nStatus: ${on ? '🟢 On' : '⚪ Off'}\nDefault effort: ${effortLabel}\nRoles: ${plugin.roles.length} (✏️ ${changed} changed)`,
      keyboard: [
        [button(on ? 'Turn off' : '✅ Turn on', on ? 'ps:off' : 'ps:on'), button(`Effort: ${effortLabel}`, 'ps:de')],
        [button('Roles ▸', 'ps:g')],
        [button('Reset all', 'ps:rs'), ...close],
      ],
    };
  }
  if (view.kind === 'roles') {
    return {
      text: `${top}pstack roles\nA single-model role runs one model. A panel role runs several models side by side, one subagent each.`,
      keyboard: [...(['s', 'p'] as Group[]).filter(g => groupRoles(plugin, g).length).map(g => [button(`${GROUPS[g]} ▸ (${groupRoles(plugin, g).length})`, `ps:l:${g}:0`)]), back('ps:h')],
    };
  }
  if (view.kind === 'list') {
    const indexes = groupRoles(plugin, view.group);
    const pages = Math.max(1, Math.ceil(indexes.length / PAGE_SIZE)), page = Math.min(view.page, pages - 1);
    const shown = indexes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const nav = (p: number) => `ps:l:${view.group}:${p}`;
    const paging = [...(page > 0 ? [button('◀ Previous', nav(page - 1))] : []), ...(page + 1 < pages ? [button('Next ▶', nav(page + 1))] : [])];
    return {
      text: `${top}${view.group === 'p' ? 'Panel roles' : 'Single-model roles'}${pages > 1 ? ` (${page + 1}/${pages})` : ''} (✏️ = changed, • = skill default):\n${roleLines(state, shown).join('\n')}\n\nTap a role to change it.`,
      keyboard: [...shown.map(i => [button(roleLabel(state, plugin.roles[i].role), `ps:r:${roleRef(plugin, i)}`)]), ...(paging.length ? [paging] : []), back('ps:g')],
    };
  }
  const role = plugin.roles[view.role]?.role;
  if (role === undefined) return pstackMenuScreen({ kind: 'home' }, state, notice);
  const panel = isPanel(plugin, role);
  const { value, override } = roleValue(state, role);
  const entries = roleEntries(state, role);
  // Back to the list page the role is on, worked out from the role so the button stays short.
  const group: Group = panel ? 'p' : 's';
  const roleBack = back(`ps:l:${group}:${Math.floor(groupRoles(plugin, group).indexOf(view.role) / PAGE_SIZE)}`);
  const ref = roleRef(plugin, view.role);
  const useDefault = override ? [[button('Use skill default', `ps:d:${ref}`)]] : [];
  if (view.kind === 'pick') {
    const models = pstackPickableModels(state.models, view.family).filter(m => fits(`ps:${view.add ? 'a' : 'm'}:${ref}:${m.id}`));
    const pages = Math.max(1, Math.ceil(models.length / PAGE_SIZE)), page = Math.min(view.page, pages - 1);
    const current = new Set((entries ?? []).map(e => e.model.toLowerCase()));
    const rows = models.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .map(m => [button(`${current.has(m.id.toLowerCase()) ? '✅ ' : ''}${m.label} · ${m.id}`, `ps:${view.add ? 'a' : 'm'}:${ref}:${m.id}`)]);
    const nav = (p: number) => `ps:p:${ref}:${view.add ? 'a' : 's'}:${view.family}:${p}`;
    const paging = [...(page > 0 ? [button('◀ Previous', nav(page - 1))] : []), ...(page + 1 < pages ? [button('Next ▶', nav(page + 1))] : [])];
    return {
      text: `${top}${role}: ${view.add ? 'add' : 'choose'} a ${FAMILIES[view.family]} model${pages > 1 ? ` (${page + 1}/${pages})` : ''}`,
      keyboard: [...rows, ...(paging.length ? [paging] : []), back(`ps:r:${ref}`)],
    };
  }
  const source = override ? 'changed' : 'skill default';
  const families = (['c', 'g'] as Family[]).map(f => button(`${FAMILIES[f]} models`, `ps:p:${ref}:s:${f}:0`));
  if (!entries) {
    return {
      text: `${top}${role} (${source})\n⚠️ "${value}" is not valid. ${panel ? 'Use the skill default' : 'Pick a model or use the skill default'} to fix it.`,
      keyboard: [...(panel ? [] : [families]), ...useDefault, roleBack],
    };
  }
  if (panel) {
    return {
      text: `${top}${role} (panel, ${source})\n${entries.map((e, i) => `${i + 1}. ${e.model}${e.effort ? ` @${e.effort}` : ''}`).join('\n')}\n\nTap ➖ to remove an entry or ➕ to add one.`,
      keyboard: [
        ...entries.map((e, i) => [button(`➖ ${i + 1}. ${e.model}`, `ps:rm:${ref}:${i}`)]),
        (['c', 'g'] as Family[]).map(f => button(`➕ ${FAMILIES[f]}`, `ps:p:${ref}:a:${f}:0`)),
        ...useDefault, roleBack,
      ],
    };
  }
  const entry = entries[0];
  return {
    text: `${top}${role} (${source})\nModel: ${entry.model}\nEffort: ${entry.effort ?? `default (${effortLabel})`}`,
    keyboard: [
      families,
      [...EFFORT_LEVELS.map(level => button(`${entry.effort === level ? '✅ ' : ''}${level}`, `ps:e:${ref}:${level}`))],
      [button(`${entry.effort ? '' : '✅ '}Default effort`, `ps:e:${ref}:none`)],
      ...useDefault, roleBack,
    ],
  };
}

/** The menu as text, for channels without buttons (web/API, Discord, LINE): every role's current value, the syntax, and the model IDs to use. */
export function pstackMenuText(state: PstackMenuState, usage: string): string {
  if (!state.plugin) return `pstack is not installed for Claude Code on this host. ${state.installHint}`;
  const home = pstackMenuScreen({ kind: 'home' }, state).text;
  const roles = roleLines(state, state.plugin.roles.map((_, i) => i));
  const ids = (['c', 'g'] as Family[]).map(f => `${FAMILIES[f]}: ${pstackPickableModels(state.models, f).map(m => m.id).join(', ')}`);
  return `${home}\n\nRoles (✏️ = changed, • = skill default):\n${roles.join('\n')}\n\n${usage}\nModel IDs (any catalog ID also works):\n${ids.join('\n')}`;
}
