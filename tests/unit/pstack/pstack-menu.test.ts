import { createHash } from 'crypto';
import { DEFAULT_MODELS } from '../../../src/agent/model-registry';
import { PstackMenuState, pstackMenuScreen, pstackMenuStep, pstackMenuText, pstackPickableModels } from '../../../src/pstack/menu';
import { PstackConfigError } from '../../../src/pstack/config';
import type { ModelConfig } from '../../../src/types';
import { PSTACK_ROLES } from '../../helpers/pstack-fixture';

/**
 * Dev e2e of #591: on Telegram /pstack-setup was a wall of text listing every
 * model ID and no roles. It is now a button menu over the same
 * pstack-models.md lines the text command takes.
 */

const plugin = { roles: PSTACK_ROLES, tiers: { default: 'opus', strongest: 'fable', panel: ['opus', 'fable', 'sonnet', 'haiku'] } };
const models: ModelConfig[] = [...DEFAULT_MODELS, { id: 'grok-4', label: 'Grok 4', alias: 'grok', contextWindow: 256000 }];
const state = (block: PstackMenuState['block']): PstackMenuState => ({ block, plugin, models, installHint: 'Install it.' });
const role = (name: string) => PSTACK_ROLES.findIndex(r => r.role === name);
const bugFix = role('bug-fix'), panel = role('interrogate reviewers');
/** A role in callback data: its index and a tag of its name (review of #591, L2). */
const ref = (i: number) => `${i}-${createHash('sha256').update(PSTACK_ROLES[i].role).digest('hex').slice(0, 3)}`;
const B = ref(bugFix), P = ref(panel);
/** A panel entry in a ➖ button: its index and a tag of the entry (review of #591, M1/L4). */
const rm = (i: number, entry: string) => `ps:rm:${P}:${i}-${createHash('sha256').update(entry).digest('hex').slice(0, 3)}`;
const buttons = (screen: ReturnType<typeof pstackMenuScreen>) => screen.keyboard.flat();

describe('screens', () => {
  test('home shows the status, the default effort and the role count only, with a Roles button', () => {
    const screen = pstackMenuScreen({ kind: 'home' }, state({ roles: { 'bug-fix': 'gpt-6-sol[1m] @high' } }));
    expect(screen.text).toBe('pstack setup\nStatus: 🟢 On\nDefault effort: session\nRoles: 17 (✏️ 1 changed)');
    expect(screen.keyboard).toEqual([
      [{ text: 'Turn off', data: 'ps:off' }, { text: 'Effort: session', data: 'ps:de' }],
      [{ text: 'Roles ▸', data: 'ps:g' }],
      [{ text: 'Reset all', data: 'ps:rs' }, { text: 'Close', data: 'ps:x' }],
    ]);
  });

  test('Roles splits single-model and panel roles, counted from the plugin\'s role list', () => {
    const screen = pstackMenuScreen({ kind: 'roles' }, state({}));
    expect(screen.keyboard).toEqual([[{ text: 'Single-model ▸ (13)', data: 'ps:l:s:0' }], [{ text: 'Panels ▸ (4)', data: 'ps:l:p:0' }], [{ text: '◀ Back', data: 'ps:h' }]]);
    const fewer = { ...plugin, roles: PSTACK_ROLES.filter(r => r.role !== 'arena runners' && r.role !== 'bug-fix') };
    expect(buttons(pstackMenuScreen({ kind: 'roles' }, { ...state({}), plugin: fewer })).map(b => b.text)).toEqual(['Single-model ▸ (12)', 'Panels ▸ (3)', '◀ Back']);
    // Review of #591 (L9): a group with no roles is left out rather than opening an empty list.
    const singlesOnly = { ...plugin, roles: PSTACK_ROLES.filter(r => r.models !== 'panel') };
    expect(buttons(pstackMenuScreen({ kind: 'roles' }, { ...state({}), plugin: singlesOnly })).map(b => b.text)).toEqual(['Single-model ▸ (13)', '◀ Back']);
  });

  test('a group lists its roles with their current models, 8 a page', () => {
    const block = { roles: { 'bug-fix': 'gpt-6-sol[1m] @high' } };
    const first = pstackMenuScreen({ kind: 'list', group: 's', page: 0 }, state(block));
    const singles = PSTACK_ROLES.map((r, i) => ({ ...r, i })).filter(r => r.models !== 'panel');
    expect(first.text).toContain('Single-model roles (1/2)');
    expect(first.text).toContain('✏️ bug-fix: gpt-6-sol[1m] @high');
    expect(first.text).not.toContain('interrogate reviewers');
    expect(buttons(first).map(b => b.data)).toEqual([...singles.slice(0, 8).map(r => `ps:r:${ref(r.i)}`), 'ps:l:s:1', 'ps:g']);
    expect(buttons(first).find(b => b.data === `ps:r:${B}`)?.text).toBe('✏️ bug-fix · gpt-6-sol[1m] @high');
    expect(buttons(first).find(b => b.data === `ps:r:${ref(0)}`)?.text).toBe('feature, refactoring · claude-opus-5-5');
    expect(buttons(first).find(b => b.data === 'ps:l:s:1')?.text).toBe('Next ▶');
    const second = pstackMenuScreen({ kind: 'list', group: 's', page: 1 }, state(block));
    expect(buttons(second).map(b => b.data)).toEqual([...singles.slice(8).map(r => `ps:r:${ref(r.i)}`), 'ps:l:s:0', 'ps:g']);
    expect(buttons(second).find(b => b.data === 'ps:l:s:0')?.text).toBe('◀ Previous');
    const long = buttons(second).find(b => b.data === `ps:r:${ref(role('reflect judgment, divergent, synthesizer'))}`)!.text;
    expect(long).toMatch(/^reflect judgment.*… · claude-opus-5-5$/);
    expect(long.length).toBeLessThanOrEqual(40);
    const panels = pstackMenuScreen({ kind: 'list', group: 'p', page: 0 }, state({}));
    expect(panels.text).toContain('• interrogate reviewers: claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5, claude-haiku-5-5');
    expect(buttons(panels).map(b => b.text)).toEqual(['arena runners · 4 models', 'arena cross-judge pool · 4 models', 'architect runners · 4 models', 'interrogate reviewers · 4 models', '◀ Back']);
    // A stale page past the end shows the last one.
    expect(pstackMenuScreen({ kind: 'list', group: 'p', page: 5 }, state({})).keyboard).toEqual(panels.keyboard);
  });

  test('Back on a role returns to the list page it is on', () => {
    const backOf = (i: number) => buttons(pstackMenuScreen({ kind: 'role', role: i }, state({}))).find(b => b.text === '◀ Back')?.data;
    expect(backOf(bugFix)).toBe('ps:l:s:0');
    expect(backOf(role('swarm workers'))).toBe('ps:l:s:1');
    expect(backOf(panel)).toBe('ps:l:p:0');
  });

  test('an agent that is not set up offers Turn on; a missing plugin says how to install', () => {
    expect(buttons(pstackMenuScreen({ kind: 'home' }, state(undefined)))[0]).toEqual({ text: '✅ Turn on', data: 'ps:on' });
    expect(pstackMenuScreen({ kind: 'home' }, state(undefined)).text).toContain('⚪ Off');
    const missing = pstackMenuScreen({ kind: 'home' }, { ...state(undefined), plugin: undefined });
    expect(missing.text).toContain('not installed');
    expect(buttons(missing).map(b => b.data)).toEqual(['ps:x']);
  });

  test('a one-model role offers model families, effort levels and the default', () => {
    const screen = pstackMenuScreen({ kind: 'role', role: bugFix }, state({ roles: { 'bug-fix': 'claude-opus-5-5 @high' } }));
    expect(screen.text).toContain('Model: claude-opus-5-5');
    expect(screen.text).toContain('Effort: high');
    expect(buttons(screen).map(b => b.text)).toEqual(expect.arrayContaining(['Claude models', 'GPT models', '✅ high', 'Default effort', 'Use skill default', '◀ Back']));
  });

  test('a panel role lists its entries with remove buttons and add buttons per family', () => {
    const screen = pstackMenuScreen({ kind: 'role', role: panel }, state({}));
    expect(screen.text).toContain('1. claude-opus-5-5');
    expect(buttons(screen).map(b => b.data)).toEqual(expect.arrayContaining([rm(0, 'claude-opus-5-5'), rm(3, 'claude-haiku-5-5'), `ps:p:${P}:a:c:0`, `ps:p:${P}:a:g:0`]));
    expect(buttons(screen).map(b => b.text)).not.toContain('Use skill default');
  });

  test('the picker offers Claude and GPT models only, base IDs where a [1m] twin exists, paged', () => {
    expect(pstackPickableModels(models, 'c').map(m => m.id)).not.toContain('claude-opus-5-5[1m]');
    expect(pstackPickableModels(models, 'c').map(m => m.id)).toContain('claude-opus-5-5');
    expect(pstackPickableModels(models, 'g').map(m => m.id)).toContain('gpt-6-sol[1m]');
    expect([...pstackPickableModels(models, 'c'), ...pstackPickableModels(models, 'g')].map(m => m.id)).not.toContain('grok-4');
    const first = pstackMenuScreen({ kind: 'pick', role: bugFix, add: false, family: 'c', page: 0 }, state({}));
    expect(first.text).toContain('(1/2)');
    expect(buttons(first).find(b => b.data === `ps:m:${B}:claude-fable-5-1`)?.text).toBe('✅ Fable 5.1 · claude-fable-5-1');
    expect(buttons(first).map(b => b.text)).toEqual(expect.arrayContaining(['Next ▶', '◀ Back']));
    const second = pstackMenuScreen({ kind: 'pick', role: bugFix, add: false, family: 'c', page: 1 }, state({}));
    expect(buttons(second).map(b => b.text)).toContain('◀ Previous');
  });

  test('every button of every screen fits Telegram\'s 64-byte callback_data', () => {
    const block = { roles: { 'bug-fix': 'gpt-6-sol[1m] @xhigh' } };
    const views = [{ kind: 'home' as const }, { kind: 'effort' as const }, { kind: 'reset' as const }, { kind: 'roles' as const },
      ...(['s', 'p'] as const).flatMap(group => [0, 1].map(page => ({ kind: 'list' as const, group, page }))),
      ...PSTACK_ROLES.flatMap((_, i) => [{ kind: 'role' as const, role: i }, ...(['c', 'g'] as const).flatMap(family => [0, 1].flatMap(page => [true, false].map(add => ({ kind: 'pick' as const, role: i, add, family, page }))))])];
    for (const view of views) for (const b of buttons(pstackMenuScreen(view, state(block)))) expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(64);
  });

  test('the text form lists roles, the syntax and the model IDs by family, without the duplicates', () => {
    const text = pstackMenuText(state({}), 'Usage: x');
    expect(text).toContain('• bug-fix: claude-fable-5-1');
    for (const { role: name } of PSTACK_ROLES) expect(text).toContain(`${name}: `);
    expect(text).toContain('Usage: x');
    expect(text).toMatch(/Claude: claude-fable-5-1, /);
    expect(text).toMatch(/GPT: gpt-6-sol\[1m\]/);
    expect(text).not.toContain('claude-opus-5-5[1m]');
    expect(text).not.toContain('Tap a role');
  });
});

// Review of #591 (L1): one role hand-edited into config.json with a bad value
// (here `@turbo`) made every list page that showed it fail.
test('a role value that does not parse is marked and can be fixed, without breaking the list', () => {
  const bad = state({ roles: { 'bug-fix': 'claude-opus-5-5 @turbo', 'interrogate reviewers': 'claude-opus-5-5 @nope' } });
  const list = pstackMenuScreen({ kind: 'list', group: 's', page: 0 }, bad);
  expect(list.text).toContain('⚠️ bug-fix: claude-opus-5-5 @turbo (invalid)');
  expect(buttons(list).find(b => b.data === `ps:r:${B}`)?.text).toBe('✏️ bug-fix · ⚠️ invalid');
  expect(pstackMenuText(bad, 'usage')).toContain('(invalid)');
  const screen = pstackMenuScreen({ kind: 'role', role: bugFix }, bad);
  expect(screen.text).toContain('is not valid');
  expect(buttons(screen).map(b => b.data)).toEqual([`ps:p:${B}:s:c:0`, `ps:p:${B}:s:g:0`, `ps:d:${B}`, 'ps:l:s:0']);
  expect(buttons(pstackMenuScreen({ kind: 'role', role: panel }, bad)).map(b => b.data)).toEqual([`ps:d:${P}`, 'ps:l:p:0']);
  expect(pstackMenuStep(`ps:r:${B}`, bad).next).toBeUndefined();
  expect(pstackMenuStep(`ps:d:${B}`, bad).next).toEqual({ roles: { 'interrogate reviewers': 'claude-opus-5-5 @nope' } });
  expect(pstackMenuStep(`ps:m:${B}:claude-opus-5-5`, bad).next?.roles?.['bug-fix']).toBe('claude-opus-5-5');
});

// Review of #591 (L2): buttons named roles by index only, so after a plugin
// update that reorders the roles an old button changed a different role.
test('a button from before the roles were reordered is refused, not applied to another role', () => {
  const reordered = { ...plugin, roles: [PSTACK_ROLES[bugFix], ...PSTACK_ROLES.filter((_, i) => i !== bugFix)] };
  const old = `ps:m:${B}:gpt-6-sol[1m]`;
  expect(() => pstackMenuStep(old, { ...state({}), plugin: reordered })).toThrow('out of date');
  expect(() => pstackMenuStep(`ps:m:${bugFix}:gpt-6-sol[1m]`, state({}))).toThrow(PstackConfigError);
  expect(pstackMenuStep(old, state({})).next).toEqual({ roles: { 'bug-fix': 'gpt-6-sol[1m]' } });
});

test('walks main → Roles → group → page → role → Back through callback data alone', () => {
  const s = state({});
  const go = (data: string) => pstackMenuScreen(pstackMenuStep(data, s).view, s);
  const tap = (screen: ReturnType<typeof pstackMenuScreen>, text: string | RegExp) => {
    const hit = buttons(screen).find(b => (typeof text === 'string' ? b.text === text : text.test(b.text)));
    if (!hit) throw new Error(`no button ${text} in ${buttons(screen).map(b => b.text).join(' | ')}`);
    return go(hit.data);
  };
  let screen = go('ps:h');
  screen = tap(screen, 'Roles ▸');
  screen = tap(screen, /^Single-model ▸/);
  screen = tap(screen, 'Next ▶');
  expect(screen.text).toContain('(2/2)');
  screen = tap(screen, /^swarm workers · /);
  expect(screen.text).toContain('swarm workers (skill default)');
  screen = tap(screen, '◀ Back');
  expect(screen.text).toContain('Single-model roles (2/2)');
  screen = tap(screen, '◀ Back');
  expect(buttons(screen).map(b => b.data)).toEqual(['ps:l:s:0', 'ps:l:p:0', 'ps:h']);
  screen = tap(screen, '◀ Back');
  expect(screen.text).toContain('pstack setup');
});

describe('steps', () => {
  const step = (data: string, block: PstackMenuState['block'] = {}) => pstackMenuStep(data, state(block));

  test('navigation changes nothing', () => {
    for (const data of ['ps:h', 'ps:de', 'ps:rs', 'ps:g', 'ps:l:s:1', 'ps:l:p:0', `ps:r:${B}`, `ps:p:${B}:s:g:1`, `ps:p:${P}:a:c:0`, 'ps:x']) expect(step(data).next).toBeUndefined();
  });

  test('on, off, reset and default effort', () => {
    expect(step('ps:on', undefined).next).toEqual({});
    expect(step('ps:on', { defaultEffort: 'high' }).next).toEqual({ defaultEffort: 'high' });
    expect(step('ps:off').next).toBeNull();
    expect(step('ps:rs!', { roles: { 'bug-fix': 'claude-opus-5-5' }, defaultEffort: 'max' }).next).toEqual({});
    expect(step('ps:de:xhigh').next).toEqual({ defaultEffort: 'xhigh' });
    expect(step('ps:de:session').next).toEqual({ defaultEffort: 'session' });
  });

  // Review of #591 (M1): Reset all while pstack is off saved `{}`, which turned it on.
  test('Reset all leaves pstack off when it is off, and says so', () => {
    expect(pstackMenuStep('ps:rs!', state(undefined)).next).toBeUndefined();
    const off = pstackMenuScreen({ kind: 'reset' }, state(undefined));
    expect(off.text).toContain('pstack is off');
    expect(buttons(off).map(b => b.data)).toEqual(['ps:h']);
    expect(pstackMenuScreen({ kind: 'reset' }, state({})).text).toContain('pstack stays on');
  });

  test('a model choice keeps the role\'s effort; an effort choice keeps its model', () => {
    expect(step(`ps:m:${B}:gpt-6-sol[1m]`, { roles: { 'bug-fix': 'claude-opus-5-5 @high' } }).next).toEqual({ roles: { 'bug-fix': 'gpt-6-sol[1m] @high' } });
    expect(step(`ps:e:${B}:max`).next).toEqual({ roles: { 'bug-fix': 'claude-fable-5-1 @max' } });
    expect(step(`ps:e:${B}:none`, { roles: { 'bug-fix': 'claude-opus-5-5 @high' } }).next).toEqual({ roles: { 'bug-fix': 'claude-opus-5-5' } });
    expect(step(`ps:d:${B}`, { roles: { 'bug-fix': 'claude-opus-5-5' } }).next).toEqual({});
  });

  test('a panel adds and removes one entry, starting from its skill default', () => {
    expect(step(`ps:a:${P}:gpt-6-sol[1m]`).next).toEqual({ roles: { 'interrogate reviewers': 'claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5, claude-haiku-5-5, gpt-6-sol[1m]' } });
    expect(step(rm(3, 'claude-haiku-5-5')).next).toEqual({ roles: { 'interrogate reviewers': 'claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5' } });
    expect(() => step(rm(0, 'claude-opus-5-5'), { roles: { 'interrogate reviewers': 'claude-opus-5-5' } })).toThrow('at least one entry');
  });

  // Review of #591 (M1): ➖ dropped every entry of the tapped model, so of opus@xhigh and
  // opus@low neither could be removed alone (removing both left the panel empty).
  test('➖ removes the tapped entry only, even beside another entry of the same model', () => {
    const block = { roles: { 'interrogate reviewers': 'claude-opus-5-5 @xhigh, claude-opus-5-5 @low' } };
    expect(step(rm(1, 'claude-opus-5-5 @low'), block).next).toEqual({ roles: { 'interrogate reviewers': 'claude-opus-5-5 @xhigh' } });
    expect(step(rm(0, 'claude-opus-5-5 @xhigh'), block).next).toEqual({ roles: { 'interrogate reviewers': 'claude-opus-5-5 @low' } });
  });

  // Review of #591 (L4): a ➖ button names its entry, so after the panel changed elsewhere it
  // is refused instead of removing whatever entry now has its index.
  test('a ➖ button from before the panel changed is refused', () => {
    const changed = { roles: { 'interrogate reviewers': 'claude-fable-5-1, claude-sonnet-5-5' } };
    expect(() => step(rm(0, 'claude-opus-5-5'), changed)).toThrow('out of date');
    expect(() => step(`ps:rm:${P}:0`)).toThrow(PstackConfigError);
  });

  // Review of #591 (M1): ➕ on a model that is already in the panel added the same entry twice.
  test('➕ refuses an entry the panel already has', () => {
    expect(() => step(`ps:a:${P}:claude-opus-5-5`)).toThrow('already in interrogate reviewers');
    expect(step(`ps:a:${P}:claude-opus-5-5`, { roles: { 'interrogate reviewers': 'claude-opus-5-5 @low' } }).next)
      .toEqual({ roles: { 'interrogate reviewers': 'claude-opus-5-5 @low, claude-opus-5-5' } });
  });

  test.each([
    'ps:nope', 'ps:r:99', 'ps:l:x:0', 'ps:l:s:', 'ps:l:s:1234', 'ps:de:turbo', `ps:m:${B}:grok-4`, `ps:m:${B}:claude-unknown`, `ps:a:${B}:claude-opus-5-5`,
    `ps:m:${P}:claude-opus-5-5`, `ps:e:${P}:high`, `ps:e:${B}:turbo`, `ps:rm:${B}:0-000`, `ps:rm:${P}:9-000`, rm(0, 'claude-fable-5-1'), `ps:p:${B}:a:c:0`, `ps:p:${B}:s:x:0`,
  ])('refuses forged or stale data %s', data => {
    expect(() => step(data)).toThrow(PstackConfigError);
  });
});
