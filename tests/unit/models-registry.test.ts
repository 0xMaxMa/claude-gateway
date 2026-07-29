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

describe('model registry — DEFAULT_MODELS and template stay in sync', () => {
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
