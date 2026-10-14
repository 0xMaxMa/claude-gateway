import { EFFORT_LEVELS, isEffort } from '../agent/model-registry';
import type { ModelConfig } from '../types';
import { AgentPstackConfig, PstackConfigError, applySheetLines, parseRoleValue } from './config';
import { PstackModels } from './plugin-info';
import { pstackPanelDefault, pstackRoleDefault } from './sheet';

/**
 * The /pstack-setup menu: Telegram buttons over the same pstack-models.md
 * lines the text command takes. Every change is computed with
 * applySheetLines and saved by the caller through savePstackConfig, so the
 * buttons, the text command and the API apply the same rules. Callback data
 * (`ps:…`, at most 64 bytes as Telegram requires) names roles by their index
 * in the installed plugin's role list and models by ID; both are checked again
 * here and when saved.
 */

export interface PstackMenuButton { text: string; data: string }
export interface PstackMenuScreen { text: string; keyboard: PstackMenuButton[][]; closed?: boolean }
export interface PstackMenuState { block: AgentPstackConfig | undefined; plugin: PstackModels | undefined; models: ModelConfig[]; installHint: string }

type Family = 'c' | 'g';
export type PstackMenuView = { kind: 'home' } | { kind: 'effort' } | { kind: 'reset' } | { kind: 'close' } | { kind: 'role'; role: number } | { kind: 'pick'; role: number; add: boolean; family: Family; page: number };
/** What a button does: the screen to show next and, for a change, the new block (`null` turns pstack off). */
export interface PstackMenuStep { view: PstackMenuView; next?: AgentPstackConfig | null }

const PAGE_SIZE = 8;
const FAMILIES: Record<Family, string> = { c: 'Claude', g: 'GPT' };
const MAX_DATA_BYTES = 64;

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

const fits = (data: string) => Buffer.byteLength(data, 'utf8') <= MAX_DATA_BYTES;
const button = (text: string, data: string): PstackMenuButton => ({ text: text.length > 60 ? text.slice(0, 59) + '…' : text, data });

/** A role's current value: its override, or its skill default as model IDs. */
function roleValue(state: PstackMenuState, role: string): { value: string; override: boolean } {
  const override = state.block?.roles?.[role];
  return { value: override ?? pstackRoleDefault(state.plugin!, role) ?? '', override: override !== undefined };
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
  if (data === 'ps:rs!') return { view: { kind: 'home' }, next: {} };
  const effort = /^ps:de:(\w+)$/.exec(data);
  if (effort) {
    if (effort[1] !== 'session' && !isEffort(effort[1])) invalid();
    return { view: { kind: 'home' }, next: apply(`default effort: ${effort[1]}`) };
  }
  const match = /^ps:(r|d|e|p|m|a|rm):(\d{1,3})(?::(.+))?$/.exec(data);
  const index = match ? Number(match[2]) : -1;
  const role = plugin.roles[index]?.role;
  if (!match || role === undefined) invalid();
  const [, verb, , arg] = match;
  const panel = pstackPanelDefault(plugin, role) !== undefined;
  const entries = parseRoleValue(roleValue(state, role).value);
  switch (verb) {
    case 'r': return { view: { kind: 'role', role: index } };
    case 'd': return { view: { kind: 'role', role: index }, next: apply(`${role}: default`) };
    case 'e': {
      if (panel || !arg || (arg !== 'none' && !isEffort(arg))) invalid();
      return { view: { kind: 'role', role: index }, next: apply(`${role}: ${entries[0].model}${arg === 'none' ? '' : ` @${arg}`}`) };
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
      const level = entries[0].effort;
      return { view: { kind: 'role', role: index }, next: apply(verb === 'a' ? `${role} += ${arg}` : `${role}: ${arg}${level ? ` @${level}` : ''}`) };
    }
    case 'rm': {
      const entry = entries[Number(arg)];
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
  if (view.kind === 'effort') {
    return {
      text: `${top}Default effort: ${effortLabel}\nThe level for a role without its own. session keeps the parent's effort.`,
      keyboard: [...['session', ...EFFORT_LEVELS].map(level => [button(`${level === effortLabel ? '✅ ' : ''}${level}`, `ps:de:${level}`)]), [button('Back', 'ps:h')]],
    };
  }
  if (view.kind === 'reset') {
    return { text: `${top}Reset every role and the default effort to the skill defaults? pstack stays on.`, keyboard: [[button('✅ Reset', 'ps:rs!'), button('Cancel', 'ps:h')]] };
  }
  if (view.kind === 'home') {
    const on = state.block !== undefined;
    const lines = plugin.roles.map(({ role }) => {
      const { value, override } = roleValue(state, role);
      return `${override ? '✏️' : '•'} ${role}: ${value}`;
    });
    const text = `${top}pstack setup\nStatus: ${on ? '✅ On: the next worker loads pstack' : '⚪ Off: workers do not load pstack'}\nDefault effort: ${effortLabel}\n\nRoles (✏️ = changed, • = skill default):\n${lines.join('\n')}\n\nTap a role to change it.`;
    return {
      text,
      keyboard: [
        [button(on ? '⚪ Turn off' : '✅ Turn on', on ? 'ps:off' : 'ps:on'), button(`Default effort: ${effortLabel}`, 'ps:de')],
        ...plugin.roles.map(({ role }, i) => [button(`${roleValue(state, role).override ? '✏️ ' : ''}${role}`, `ps:r:${i}`)]),
        [button('Reset all to defaults', 'ps:rs'), ...close],
      ],
    };
  }
  const role = plugin.roles[view.role]?.role;
  if (role === undefined) return pstackMenuScreen({ kind: 'home' }, state, notice);
  const panel = pstackPanelDefault(plugin, role) !== undefined;
  const { value, override } = roleValue(state, role);
  const entries = parseRoleValue(value);
  const back = [button('Back', 'ps:h')];
  const useDefault = override ? [[button('Use skill default', `ps:d:${view.role}`)]] : [];
  if (view.kind === 'pick') {
    const models = pstackPickableModels(state.models, view.family).filter(m => fits(`ps:${view.add ? 'a' : 'm'}:${view.role}:${m.id}`));
    const pages = Math.max(1, Math.ceil(models.length / PAGE_SIZE)), page = Math.min(view.page, pages - 1);
    const current = new Set(entries.map(e => e.model.toLowerCase()));
    const rows = models.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .map(m => [button(`${current.has(m.id.toLowerCase()) ? '✅ ' : ''}${m.label} · ${m.id}`, `ps:${view.add ? 'a' : 'm'}:${view.role}:${m.id}`)]);
    const nav = (p: number) => `ps:p:${view.role}:${view.add ? 'a' : 's'}:${view.family}:${p}`;
    const paging = [...(page > 0 ? [button('Previous', nav(page - 1))] : []), ...(page + 1 < pages ? [button('Next', nav(page + 1))] : [])];
    return {
      text: `${top}${role}: ${view.add ? 'add' : 'choose'} a ${FAMILIES[view.family]} model${pages > 1 ? ` (${page + 1}/${pages})` : ''}`,
      keyboard: [...rows, ...(paging.length ? [paging] : []), [button('Back', `ps:r:${view.role}`)]],
    };
  }
  const source = override ? 'changed' : 'skill default';
  if (panel) {
    return {
      text: `${top}${role} (panel, ${source})\n${entries.map((e, i) => `${i + 1}. ${e.model}${e.effort ? ` @${e.effort}` : ''}`).join('\n')}\n\nTap ➖ to remove an entry or ➕ to add one.`,
      keyboard: [
        ...entries.map((e, i) => [button(`➖ ${i + 1}. ${e.model}`, `ps:rm:${view.role}:${i}`)]),
        (['c', 'g'] as Family[]).map(f => button(`➕ ${FAMILIES[f]}`, `ps:p:${view.role}:a:${f}:0`)),
        ...useDefault, back,
      ],
    };
  }
  const entry = entries[0];
  return {
    text: `${top}${role} (${source})\nModel: ${entry.model}\nEffort: ${entry.effort ?? `default (${effortLabel})`}`,
    keyboard: [
      (['c', 'g'] as Family[]).map(f => button(`${FAMILIES[f]} models`, `ps:p:${view.role}:s:${f}:0`)),
      [...EFFORT_LEVELS.map(level => button(`${entry.effort === level ? '✅ ' : ''}${level}`, `ps:e:${view.role}:${level}`))],
      [button(`${entry.effort ? '' : '✅ '}Default effort`, `ps:e:${view.role}:none`)],
      ...useDefault, back,
    ],
  };
}

/** The menu as text, for channels without buttons (web/API, Discord, LINE): every role's current value, the syntax, and the model IDs to use. */
export function pstackMenuText(state: PstackMenuState, usage: string): string {
  if (!state.plugin) return `pstack is not installed for Claude Code on this host. ${state.installHint}`;
  const home = pstackMenuScreen({ kind: 'home' }, state).text.replace(/\n\nTap a role to change it\.$/, '');
  const ids = (['c', 'g'] as Family[]).map(f => `${FAMILIES[f]}: ${pstackPickableModels(state.models, f).map(m => m.id).join(', ')}`);
  return `${home}\n\n${usage}\nModel IDs (any catalog ID also works):\n${ids.join('\n')}`;
}
