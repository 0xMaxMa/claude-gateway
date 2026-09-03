import * as path from 'path';
import * as fs from 'fs';
import { DEFAULT_MODELS } from '../../src/agent/runner';
import type { ModelConfig } from '../../src/types';

/**
 * Model registry invariants.
 *
 * The set of selectable models lives in TWO places that must stay in lockstep:
 *   1. DEFAULT_MODELS (src/agent/runner.ts) — the fallback used when a config has
 *      no gateway.models key.
 *   2. config.template.json gateway.models — what fresh installs get, and the
 *      source migrateModels() merges into existing installs.
 *
 * If they drift, some install paths see a model the others don't. These tests
 * pin Opus 5 as a first-class model in both, and guard the "bare alias = newest"
 * convention so `opus`/`sonnet`/`fable` always resolve to the latest of each
 * family. They read the REAL template so a hand-edit that updates one file but
 * not the other goes red here.
 */

const REAL_TEMPLATE = path.join(__dirname, '..', '..', 'config.template.json');

function templateModels(): ModelConfig[] {
  const t = JSON.parse(fs.readFileSync(REAL_TEMPLATE, 'utf-8'));
  return t.gateway.models as ModelConfig[];
}

const byId = (models: ModelConfig[], id: string) => models.find((m) => m.id === id);
const byAlias = (models: ModelConfig[], alias: string) => models.find((m) => m.alias === alias);

describe('model registry — Opus 5 is a first-class model', () => {
  it('DEFAULT_MODELS includes both Opus 5 variants with correct context windows', () => {
    expect(byId(DEFAULT_MODELS, 'claude-opus-5')?.contextWindow).toBe(200000);
    expect(byId(DEFAULT_MODELS, 'claude-opus-5[1m]')?.contextWindow).toBe(1000000);
  });

  it('the template includes both Opus 5 variants with correct context windows', () => {
    const models = templateModels();
    expect(byId(models, 'claude-opus-5')?.contextWindow).toBe(200000);
    expect(byId(models, 'claude-opus-5[1m]')?.contextWindow).toBe(1000000);
  });

  it('the bare `opus` alias resolves to Opus 5 in both registries', () => {
    expect(byAlias(DEFAULT_MODELS, 'opus')?.id).toBe('claude-opus-5');
    expect(byAlias(DEFAULT_MODELS, 'opus[1m]')?.id).toBe('claude-opus-5[1m]');
    expect(byAlias(templateModels(), 'opus')?.id).toBe('claude-opus-5');
    expect(byAlias(templateModels(), 'opus[1m]')?.id).toBe('claude-opus-5[1m]');
  });

  it('Opus 4.8 is demoted to the `opus48` alias (kept, not dropped)', () => {
    expect(byAlias(DEFAULT_MODELS, 'opus48')?.id).toBe('claude-opus-4-8');
    expect(byAlias(DEFAULT_MODELS, 'opus48[1m]')?.id).toBe('claude-opus-4-8[1m]');
    expect(byAlias(templateModels(), 'opus48')?.id).toBe('claude-opus-4-8');
    expect(byAlias(templateModels(), 'opus48[1m]')?.id).toBe('claude-opus-4-8[1m]');
  });
});

describe('model registry — Fable 5.1 is a first-class model', () => {
  it('DEFAULT_MODELS includes both Fable 5.1 variants with correct context windows', () => {
    expect(byId(DEFAULT_MODELS, 'claude-fable-5-1')?.contextWindow).toBe(200000);
    expect(byId(DEFAULT_MODELS, 'claude-fable-5-1[1m]')?.contextWindow).toBe(1000000);
  });

  it('the template includes both Fable 5.1 variants with correct context windows', () => {
    const models = templateModels();
    expect(byId(models, 'claude-fable-5-1')?.contextWindow).toBe(200000);
    expect(byId(models, 'claude-fable-5-1[1m]')?.contextWindow).toBe(1000000);
  });

  it('Fable 5 is demoted to the `fable5` alias (kept, not dropped)', () => {
    expect(byAlias(DEFAULT_MODELS, 'fable5')?.id).toBe('claude-fable-5');
    expect(byAlias(DEFAULT_MODELS, 'fable5[1m]')?.id).toBe('claude-fable-5[1m]');
    expect(byAlias(templateModels(), 'fable5')?.id).toBe('claude-fable-5');
    expect(byAlias(templateModels(), 'fable5[1m]')?.id).toBe('claude-fable-5[1m]');
  });

  /**
   * The "bare alias = newest of the family" convention, applied to Fable the
   * same way `opus` -> Opus 5 and `sonnet` -> Sonnet 5 already are.
   *
   * Worth knowing while reading this: `fable` therefore names a model not
   * every provider has entitled yet (ours 400s on it until
   * Crown-Labs/getpod#2538 lands). That is deliberate and it moves nobody —
   * handleModelCommand stores the resolved *id*, not the alias, so agents
   * already on Fable 5 stay on claude-fable-5, and migrateModels() rewrites
   * their row's alias to `fable5` rather than leaving two rows claiming
   * `fable`.
   */
  it('the bare `fable` alias resolves to Fable 5.1 in both registries', () => {
    expect(byAlias(DEFAULT_MODELS, 'fable')?.id).toBe('claude-fable-5-1');
    expect(byAlias(DEFAULT_MODELS, 'fable[1m]')?.id).toBe('claude-fable-5-1[1m]');
    expect(byAlias(templateModels(), 'fable')?.id).toBe('claude-fable-5-1');
    expect(byAlias(templateModels(), 'fable[1m]')?.id).toBe('claude-fable-5-1[1m]');
  });
});

describe('model registry — DEFAULT_MODELS and template stay in sync', () => {
  it('uses OpenAI-documented 1,050,000-token windows for all GPT models', () => {
    const gptIds = ['gpt-5.6-sol[1m]', 'gpt-5.6-terra[1m]', 'gpt-5.6-luna[1m]', 'gpt-5.5[1m]'];
    for (const id of gptIds) {
      expect(byId(DEFAULT_MODELS, id)?.contextWindow).toBe(1050000);
      expect(byId(templateModels(), id)?.contextWindow).toBe(1050000);
    }
  });

  it('both registries contain exactly the same set of model ids', () => {
    const codeIds = DEFAULT_MODELS.map((m) => m.id).sort();
    const templateIds = templateModels().map((m) => m.id).sort();
    expect(codeIds).toEqual(templateIds);
  });

  it('each model has an identical alias and contextWindow in both registries', () => {
    const templateMap = new Map(templateModels().map((m) => [m.id, m]));
    for (const m of DEFAULT_MODELS) {
      const t = templateMap.get(m.id);
      expect(t).toBeDefined();
      expect({ alias: m.alias, contextWindow: m.contextWindow }).toEqual({
        alias: t!.alias,
        contextWindow: t!.contextWindow,
      });
    }
  });

  it('no two models share an alias (aliases are unambiguous)', () => {
    const aliases = DEFAULT_MODELS.map((m) => m.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});

/**
 * The Telegram receiver (mcp/tools/telegram/receiver-server.ts) runs as a
 * separate process and can't import DEFAULT_MODELS, so it keeps a hardcoded
 * AVAILABLE_MODELS fallback for the /models picker (used when the live
 * get_models call fails). That third copy silently drifted before — Opus 5 was
 * added to the two src registries but not here. We can't import the module
 * (top-level Bot construction needs a token), so we parse the array literal
 * from source and assert its id/alias set matches the code registry.
 */
describe('model registry — Telegram fallback list stays in sync', () => {
  const RECEIVER = path.join(
    __dirname,
    '..',
    '..',
    'mcp',
    'tools',
    'telegram',
    'receiver-server.ts',
  );

  /** Extract { id, alias } pairs from the AVAILABLE_MODELS array literal. */
  function telegramFallbackModels(): Array<{ id: string; alias: string }> {
    const src = fs.readFileSync(RECEIVER, 'utf-8');
    const start = src.indexOf('const AVAILABLE_MODELS = [');
    expect(start).toBeGreaterThan(-1);
    // Close on the array's own-line `]` — a bare indexOf(']') would stop at the
    // `[1m]` suffix inside the first model id.
    const end = src.indexOf('\n]', start);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    const out: Array<{ id: string; alias: string }> = [];
    const re = /id:\s*'([^']+)'[^}]*alias:\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) out.push({ id: m[1], alias: m[2] });
    return out;
  }

  it('lists exactly the same model ids as DEFAULT_MODELS', () => {
    const telegramIds = telegramFallbackModels().map((m) => m.id).sort();
    const codeIds = DEFAULT_MODELS.map((m) => m.id).sort();
    expect(telegramIds).toEqual(codeIds);
  });

  it('maps each alias identically to DEFAULT_MODELS (incl. opus -> Opus 5)', () => {
    const codeMap = new Map(DEFAULT_MODELS.map((m) => [m.id, m.alias]));
    for (const m of telegramFallbackModels()) {
      expect(m.alias).toBe(codeMap.get(m.id));
    }
    // Explicit anchor for the repoint the user asked us to verify everywhere.
    const opus = telegramFallbackModels().find((m) => m.alias === 'opus');
    expect(opus?.id).toBe('claude-opus-5');
  });
});
