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
const buttons = (screen: ReturnType<typeof pstackMenuScreen>) => screen.keyboard.flat();

describe('screens', () => {
  test('home shows the status, the default effort and every role with its current model', () => {
    const screen = pstackMenuScreen({ kind: 'home' }, state({ roles: { 'bug-fix': 'gpt-6-sol[1m] @high' } }));
    expect(screen.text).toContain('Status: ✅ On');
    expect(screen.text).toContain('Default effort: session');
    expect(screen.text).toContain('✏️ bug-fix: gpt-6-sol[1m] @high');
    expect(screen.text).toContain('• perf-issue: claude-fable-5-1');
    expect(screen.text).toContain('• interrogate reviewers: claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5, claude-haiku-5-5');
    for (const { role: name } of PSTACK_ROLES) expect(screen.text).toContain(`${name}: `);
    expect(buttons(screen).map(b => b.data)).toEqual(['ps:off', 'ps:de', ...PSTACK_ROLES.map((_, i) => `ps:r:${i}`), 'ps:rs', 'ps:x']);
    expect(buttons(screen)[2 + bugFix].text).toBe('✏️ bug-fix');
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
    expect(buttons(screen).map(b => b.text)).toEqual(expect.arrayContaining(['Claude models', 'GPT models', '✅ high', 'Default effort', 'Use skill default', 'Back']));
  });

  test('a panel role lists its entries with remove buttons and add buttons per family', () => {
    const screen = pstackMenuScreen({ kind: 'role', role: panel }, state({}));
    expect(screen.text).toContain('1. claude-opus-5-5');
    expect(buttons(screen).map(b => b.data)).toEqual(expect.arrayContaining([`ps:rm:${panel}:0`, `ps:rm:${panel}:3`, `ps:p:${panel}:a:c:0`, `ps:p:${panel}:a:g:0`]));
    expect(buttons(screen).map(b => b.text)).not.toContain('Use skill default');
  });

  test('the picker offers Claude and GPT models only, base IDs where a [1m] twin exists, paged', () => {
    expect(pstackPickableModels(models, 'c').map(m => m.id)).not.toContain('claude-opus-5-5[1m]');
    expect(pstackPickableModels(models, 'c').map(m => m.id)).toContain('claude-opus-5-5');
    expect(pstackPickableModels(models, 'g').map(m => m.id)).toContain('gpt-6-sol[1m]');
    expect([...pstackPickableModels(models, 'c'), ...pstackPickableModels(models, 'g')].map(m => m.id)).not.toContain('grok-4');
    const first = pstackMenuScreen({ kind: 'pick', role: bugFix, add: false, family: 'c', page: 0 }, state({}));
    expect(first.text).toContain('(1/2)');
    expect(buttons(first).find(b => b.data === `ps:m:${bugFix}:claude-fable-5-1`)?.text).toBe('✅ Fable 5.1 · claude-fable-5-1');
    expect(buttons(first).map(b => b.text)).toEqual(expect.arrayContaining(['Next', 'Back']));
    const second = pstackMenuScreen({ kind: 'pick', role: bugFix, add: false, family: 'c', page: 1 }, state({}));
    expect(buttons(second).map(b => b.text)).toContain('Previous');
  });

  test('every button of every screen fits Telegram\'s 64-byte callback_data', () => {
    const block = { roles: { 'bug-fix': 'gpt-6-sol[1m] @xhigh' } };
    const views = [{ kind: 'home' as const }, { kind: 'effort' as const }, { kind: 'reset' as const },
      ...PSTACK_ROLES.flatMap((_, i) => [{ kind: 'role' as const, role: i }, ...(['c', 'g'] as const).flatMap(family => [0, 1].flatMap(page => [true, false].map(add => ({ kind: 'pick' as const, role: i, add, family, page }))))])];
    for (const view of views) for (const b of buttons(pstackMenuScreen(view, state(block)))) expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(64);
  });

  test('the text form lists roles, the syntax and the model IDs by family, without the duplicates', () => {
    const text = pstackMenuText(state({}), 'Usage: x');
    expect(text).toContain('• bug-fix: claude-fable-5-1');
    expect(text).toContain('Usage: x');
    expect(text).toMatch(/Claude: claude-fable-5-1, /);
    expect(text).toMatch(/GPT: gpt-6-sol\[1m\]/);
    expect(text).not.toContain('claude-opus-5-5[1m]');
    expect(text).not.toContain('Tap a role');
  });
});

describe('steps', () => {
  const step = (data: string, block: PstackMenuState['block'] = {}) => pstackMenuStep(data, state(block));

  test('navigation changes nothing', () => {
    for (const data of ['ps:h', 'ps:de', 'ps:rs', `ps:r:${bugFix}`, `ps:p:${bugFix}:s:g:1`, `ps:p:${panel}:a:c:0`, 'ps:x']) expect(step(data).next).toBeUndefined();
  });

  test('on, off, reset and default effort', () => {
    expect(step('ps:on', undefined).next).toEqual({});
    expect(step('ps:on', { defaultEffort: 'high' }).next).toEqual({ defaultEffort: 'high' });
    expect(step('ps:off').next).toBeNull();
    expect(step('ps:rs!', { roles: { 'bug-fix': 'claude-opus-5-5' }, defaultEffort: 'max' }).next).toEqual({});
    expect(step('ps:de:xhigh').next).toEqual({ defaultEffort: 'xhigh' });
    expect(step('ps:de:session').next).toEqual({ defaultEffort: 'session' });
  });

  test('a model choice keeps the role\'s effort; an effort choice keeps its model', () => {
    expect(step(`ps:m:${bugFix}:gpt-6-sol[1m]`, { roles: { 'bug-fix': 'claude-opus-5-5 @high' } }).next).toEqual({ roles: { 'bug-fix': 'gpt-6-sol[1m] @high' } });
    expect(step(`ps:e:${bugFix}:max`).next).toEqual({ roles: { 'bug-fix': 'claude-fable-5-1 @max' } });
    expect(step(`ps:e:${bugFix}:none`, { roles: { 'bug-fix': 'claude-opus-5-5 @high' } }).next).toEqual({ roles: { 'bug-fix': 'claude-opus-5-5' } });
    expect(step(`ps:d:${bugFix}`, { roles: { 'bug-fix': 'claude-opus-5-5' } }).next).toEqual({});
  });

  test('a panel adds and removes one entry, starting from its skill default', () => {
    expect(step(`ps:a:${panel}:gpt-6-sol[1m]`).next).toEqual({ roles: { 'interrogate reviewers': 'claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5, claude-haiku-5-5, gpt-6-sol[1m]' } });
    expect(step(`ps:rm:${panel}:3`).next).toEqual({ roles: { 'interrogate reviewers': 'claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5' } });
    expect(() => step(`ps:rm:${panel}:0`, { roles: { 'interrogate reviewers': 'claude-opus-5-5' } })).toThrow('at least one entry');
  });

  test.each([
    'ps:nope', 'ps:r:99', 'ps:de:turbo', `ps:m:${bugFix}:grok-4`, `ps:m:${bugFix}:claude-unknown`, `ps:a:${bugFix}:claude-opus-5-5`,
    `ps:m:${panel}:claude-opus-5-5`, `ps:e:${panel}:high`, `ps:e:${bugFix}:turbo`, `ps:rm:${bugFix}:0`, `ps:rm:${panel}:9`, `ps:p:${bugFix}:a:c:0`, `ps:p:${bugFix}:s:x:0`,
  ])('refuses forged or stale data %s', data => {
    expect(() => step(data)).toThrow(PstackConfigError);
  });
});
