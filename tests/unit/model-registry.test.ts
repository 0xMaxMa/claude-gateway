import {
  DEFAULT_MODELS, EFFORT_LEVELS, ModelResolutionError, availableModels, findModel, isEffort, resolveModelId, selectableModels,
} from '../../src/agent/model-registry';
import { resetModelCatalogCache, resetSettingsEnvCache } from '../../src/agent/model-catalog';
import type { ModelConfig } from '../../src/types';

/**
 * The shared model registry (#581): one resolver for `/models`, `/model`,
 * `GET /api/v1/models` and orchestration. `resolveModelId` is the ID-only
 * variant pstack config and `subagent_spawn` use — an alias there would
 * silently change models the next time the alias moves.
 */

const MODELS: ModelConfig[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', alias: 'opus', contextWindow: 200000 },
  { id: 'claude-opus-5-5[1m]', label: 'Opus 5.5 (1M)', alias: 'opus[1m]', contextWindow: 1000000 },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', alias: 'haiku', contextWindow: 200000 },
  { id: 'gpt-6-sol[1m]', label: 'GPT 6 Sol', alias: 'gpt6sol', contextWindow: 1050000 },
  { id: 'gpt-6-astra', label: 'GPT 6 Astra', alias: 'gpt-6-astra', contextWindow: 1050000 },
];

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return error instanceof ModelResolutionError ? error.code : 'OTHER'; }
  return undefined;
}

describe('resolveModelId — full model IDs only', () => {
  it('resolves an exact id, case-insensitively', () => {
    expect(resolveModelId(MODELS, 'claude-opus-5-5').id).toBe('claude-opus-5-5');
    expect(resolveModelId(MODELS, 'CLAUDE-Haiku-5-5').id).toBe('claude-haiku-5-5');
    expect(resolveModelId(MODELS, 'gpt-6-sol[1m]').id).toBe('gpt-6-sol[1m]');
  });

  it.each([
    ['opus', 'claude-opus-5-5'],
    ['gpt6sol', 'gpt-6-sol[1m]'],
    ['opus[1m]', 'claude-opus-5-5[1m]'],
    ['HAIKU', 'claude-haiku-5-5'],
  ])('rejects the alias %s and names the id to use instead', (alias, id) => {
    expect(codeOf(() => resolveModelId(MODELS, alias))).toBe('MODEL_ALIAS_NOT_ALLOWED');
    expect(() => resolveModelId(MODELS, alias)).toThrow(`use the model ID "${id}"`);
  });

  it('accepts a model whose alias is its own id (the uncurated-model convention)', () => {
    expect(resolveModelId(MODELS, 'gpt-6-astra').id).toBe('gpt-6-astra');
  });

  it('accepts a context suffix on an id the catalog lists without it', () => {
    expect(resolveModelId(MODELS, 'gpt-6-astra[1m]')).toMatchObject({ id: 'gpt-6-astra[1m]', label: 'GPT 6 Astra' });
    expect(resolveModelId(MODELS, 'claude-haiku-5-5[200k]').id).toBe('claude-haiku-5-5[200k]');
  });

  it('rejects an unknown model and lists every valid id, with the config path', () => {
    let message = '';
    try { resolveModelId(MODELS, 'gpt-7', 'agents[a].pstack.roles["interrogate reviewers"][1]'); }
    catch (error) { expect((error as ModelResolutionError).code).toBe('UNKNOWN_MODEL'); message = (error as Error).message; }
    expect(message).toContain('Unknown model "gpt-7" at agents[a].pstack.roles["interrogate reviewers"][1].');
    for (const m of MODELS) expect(message).toContain(m.id);
    expect(message).toContain('see /models');
  });

  // Review of #581: the resolved id is what reaches `--model`, so it must be the catalog's, not the caller's casing.
  it('returns the canonical id with a lowercase suffix, and refuses a doubled suffix', () => {
    expect(resolveModelId(MODELS, 'GPT-6-Astra[1M]').id).toBe('gpt-6-astra[1m]');
    expect(codeOf(() => resolveModelId(MODELS, 'claude-opus-5-5[1m][1m]'))).toBe('UNKNOWN_MODEL');
    expect(codeOf(() => resolveModelId(MODELS, 'claude-opus-5-5[1m][200k]'))).toBe('UNKNOWN_MODEL');
  });

  it('does not accept a suffix on an unknown base', () => {
    expect(codeOf(() => resolveModelId(MODELS, 'gpt-7[1m]'))).toBe('UNKNOWN_MODEL');
  });
});

describe('findModel — `/model` and task_spawn keep accepting aliases', () => {
  it('matches an id or an alias, case-insensitively', () => {
    expect(findModel(MODELS, 'opus')?.id).toBe('claude-opus-5-5');
    expect(findModel(MODELS, 'Claude-Opus-5-5')?.id).toBe('claude-opus-5-5');
    expect(findModel(MODELS, 'nope')).toBeUndefined();
  });
});

describe('effort levels', () => {
  it('are exactly what Claude Code --effort and Codex accept', () => {
    expect([...EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(isEffort('max')).toBe(true);
    expect(isEffort('minimal')).toBe(false);
    expect(isEffort(undefined)).toBe(false);
  });
});

describe('availableModels / selectableModels', () => {
  const ENV_KEYS = ['MODELS_BASE_URL', 'ANTHROPIC_BASE_URL', 'MODELS_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'] as const;
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.CLAUDE_CONFIG_DIR = '/nonexistent-claude-config-for-tests';
    resetModelCatalogCache(); resetSettingsEnvCache();
  });
  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = realFetch;
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    resetModelCatalogCache(); resetSettingsEnvCache();
  });

  it('falls back to the configured list, then to DEFAULT_MODELS', async () => {
    expect(await availableModels(MODELS)).toEqual(MODELS);
    expect(await availableModels(undefined)).toEqual(DEFAULT_MODELS);
  });

  it('resolves both configured and live-only models', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://catalog.example';
    process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-token';
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, { id: 'live-only-model', display_name: 'Live only' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    expect((await availableModels(MODELS)).map((m) => m.id)).toContain('live-only-model');

    const selectable = await selectableModels(MODELS);
    expect(resolveModelId(selectable, 'live-only-model').id).toBe('live-only-model');
    expect(resolveModelId(selectable, 'claude-haiku-5-5').id).toBe('claude-haiku-5-5');
    expect(findModel(selectable, 'opus')?.id).toBe('claude-opus-5-5');
  });
});
