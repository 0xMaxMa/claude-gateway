/**
 * The gateway's model registry, shared by `/models`, `/model`,
 * `GET /api/v1/models` and orchestration (`task_spawn`), so every entry point
 * lists and resolves the same models.
 */

import { fetchModelCatalog } from './model-catalog';
import type { ModelConfig } from '../types';

// Fable 5.1 takes the bare `fable` alias and Fable 5 is demoted to `fable5`,
// following the "bare alias = newest of the family" convention the rest of this
// list uses — the same demotion Opus 4.8 took to `opus48` when Opus 5 landed.
//
// Note that `fable` therefore points at a model not every provider has
// entitled yet; ours answers `400 model not supported` for it today, until
// Crown-Labs/getpod#2538 adds it to the catalog. This only affects someone
// typing `/model fable` from now on: selection stores the resolved id, not the
// alias, so an agent already on Fable 5 stays on claude-fable-5 and existing
// configs have their claude-fable-5 row rewritten to `fable5` by
// migrateModels(). Nobody is moved onto 5.1 by this change.
//
// Both Fable 5.x entries carry the same 200k/1M split as the rest: their CLI
// catalog entry says `native_1m`, but native 1M only applies when the base URL
// is api.anthropic.com. Behind a proxy the `[1m]` id suffix and the
// `context-1m-2025-08-07` beta header are what actually buy the larger window,
// which is exactly what the paired rows below encode.
//
// Opus 5.5 (`claude-opus-5-5`) follows the same convention on its own family:
// it takes the bare `opus` alias and Opus 5 is demoted to `opus5`, mirroring
// the Opus 5 -> Opus 4.8 demotion above and the Fable 5.1 -> Fable 5 one.
// Selection still stores the resolved id, so an agent already on Opus 5 stays
// on claude-opus-5 — only `/model opus` from now on resolves to 5.5.
//
// Sonnet 5.5 (`claude-sonnet-5-5`) does the same on the Sonnet family: it takes
// `sonnet` / `sonnet[1m]` and Sonnet 5 is demoted to `sonnet5` / `sonnet5[1m]`;
// Sonnet 4.6 keeps `sonnet46`. An agent already on Sonnet 5 stays on
// claude-sonnet-5.
//
// Haiku 5.5 (`claude-haiku-5-5`) takes the bare `haiku` alias and Haiku 4.5 is
// demoted to `haiku45`. An agent already on Haiku 4.5 stays on
// claude-haiku-4-5-20251001.
export const DEFAULT_MODELS: ModelConfig[] = [
  { id: 'claude-fable-5-1[1m]',      label: 'Fable 5.1 (1M)',   alias: 'fable[1m]',   contextWindow: 1000000 },
  { id: 'claude-fable-5[1m]',        label: 'Fable 5 (1M)',     alias: 'fable5[1m]',  contextWindow: 1000000 },
  { id: 'claude-opus-5-5[1m]',       label: 'Opus 5.5 (1M)',    alias: 'opus[1m]',    contextWindow: 1000000 },
  { id: 'claude-opus-5[1m]',         label: 'Opus 5 (1M)',      alias: 'opus5[1m]',   contextWindow: 1000000 },
  { id: 'claude-opus-4-8[1m]',       label: 'Opus 4.8 (1M)',    alias: 'opus48[1m]',  contextWindow: 1000000 },
  { id: 'claude-sonnet-5-5[1m]',     label: 'Sonnet 5.5 (1M)',  alias: 'sonnet[1m]',  contextWindow: 1000000 },
  { id: 'claude-sonnet-5[1m]',       label: 'Sonnet 5 (1M)',    alias: 'sonnet5[1m]', contextWindow: 1000000 },
  { id: 'claude-fable-5-1',          label: 'Fable 5.1',        alias: 'fable',       contextWindow: 200000 },
  { id: 'claude-fable-5',            label: 'Fable 5',          alias: 'fable5',      contextWindow: 200000 },
  { id: 'claude-opus-5-5',           label: 'Opus 5.5',         alias: 'opus',        contextWindow: 200000 },
  { id: 'claude-opus-5',             label: 'Opus 5',           alias: 'opus5',       contextWindow: 200000 },
  { id: 'claude-opus-4-8',           label: 'Opus 4.8',         alias: 'opus48',      contextWindow: 200000 },
  { id: 'claude-opus-4-6',           label: 'Opus 4.6',         alias: 'opus46',      contextWindow: 200000 },
  { id: 'claude-sonnet-5-5',         label: 'Sonnet 5.5',       alias: 'sonnet',      contextWindow: 200000 },
  { id: 'claude-sonnet-5',           label: 'Sonnet 5',         alias: 'sonnet5',     contextWindow: 200000 },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6',       alias: 'sonnet46',    contextWindow: 200000 },
  { id: 'claude-haiku-5-5',          label: 'Haiku 5.5',        alias: 'haiku',       contextWindow: 200000 },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',        alias: 'haiku45',     contextWindow: 200000 },
  { id: 'gpt-6-sol[1m]',             label: 'GPT 6 Sol',        alias: 'gpt6sol',     contextWindow: 1050000 },
  { id: 'gpt-6-astra[1m]',           label: 'GPT 6 Astra',      alias: 'gpt6astra',   contextWindow: 1050000 },
  { id: 'gpt-6-luna[1m]',            label: 'GPT 6 Luna',       alias: 'gpt6luna',    contextWindow: 1050000 },
  { id: 'gpt-5.6-sol[1m]',           label: 'GPT 5.6 Sol',      alias: 'gpt56sol',    contextWindow: 1050000 },
  { id: 'gpt-5.6-terra[1m]',         label: 'GPT 5.6 Terra',    alias: 'gpt56terra',  contextWindow: 1050000 },
  { id: 'gpt-5.6-luna[1m]',          label: 'GPT 5.6 Luna',     alias: 'gpt56luna',   contextWindow: 1050000 },
  { id: 'gpt-5.5[1m]',               label: 'GPT 5.5',          alias: 'gpt55',       contextWindow: 1050000 },
];

/** Reasoning effort levels, as Claude Code's `--effort` and Codex's `model_reasoning_effort` spell them. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORT_LEVELS[number];
export const isEffort = (value: unknown): value is Effort => EFFORT_LEVELS.includes(value as Effort);

/**
 * The model list this gateway offers: the live catalog when one is reachable,
 * the configured/static list otherwise (issue #409). Cached upstream, so
 * callers that only want one model's context window pay for at most one fetch
 * a minute between them.
 */
export async function availableModels(configured: ModelConfig[] | undefined): Promise<ModelConfig[]> {
  const staticModels = configured ?? DEFAULT_MODELS;
  return (await fetchModelCatalog(staticModels)) ?? staticModels;
}

/**
 * Models a name may resolve to: what the catalog offers, plus the configured
 * list.
 *
 * The union is only for *resolution*, never for the `/models` listing — the
 * listing has to reflect what upstream actually offers, or a model removed
 * upstream would linger in the picker forever, which is the bug this all
 * started from. Without the union a user who switches to a live-only model
 * is trapped: their previous configured model is no longer nameable.
 */
export async function selectableModels(configured: ModelConfig[] | undefined): Promise<ModelConfig[]> {
  const live = await availableModels(configured);
  const ids = new Set(live.map((m) => m.id));
  return [...live, ...(configured ?? DEFAULT_MODELS).filter((m) => !ids.has(m.id))];
}

/** `/model` and `task_spawn`: an id or an alias, case-insensitive. */
export function findModel(models: ModelConfig[], name: string): ModelConfig | undefined {
  const wanted = name.toLowerCase();
  return models.find((m) => m.id.toLowerCase() === wanted || m.alias.toLowerCase() === wanted);
}

export class ModelResolutionError extends Error {
  constructor(readonly code: 'UNKNOWN_MODEL' | 'MODEL_ALIAS_NOT_ALLOWED', message: string) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}

const CONTEXT_SUFFIX = /\[(?:1m|200k)\]$/i;

/**
 * Resolve a full model ID, rejecting aliases. Used where a config must name
 * one model that never changes when an alias moves (pstack roles,
 * `subagent_spawn`). Matching is exact and case-insensitive. A context suffix
 * (`[1m]`, `[200k]`) on an id the catalog lists without it still resolves:
 * the suffix selects the context window, not a different model. `[1m]` needs a
 * model with a 1M window.
 *
 * `where` names the config path in the error, e.g.
 * `agents[a].pstack.roles["bug-fix"]`.
 */
export function resolveModelId(models: ModelConfig[], value: string, where?: string): ModelConfig {
  const wanted = value.toLowerCase();
  const exact = models.find((m) => m.id.toLowerCase() === wanted);
  if (exact) return exact;
  const suffix = CONTEXT_SUFFIX.exec(wanted)?.[0];
  const base = suffix && models.find((m) => m.id.toLowerCase() === wanted.slice(0, -suffix.length) && !CONTEXT_SUFFIX.test(m.id));
  // `[1m]` only where the model has a 1M window; a Claude model that does lists its own `[1m]` row.
  if (base && (suffix !== '[1m]' || base.contextWindow >= 1000000)) return { ...base, id: base.id + suffix };
  const at = where ? ` at ${where}` : '';
  const valid = `Valid IDs: ${models.map((m) => m.id).join(', ')} — see /models.`;
  const alias = models.find((m) => m.alias.toLowerCase() === wanted);
  if (alias) throw new ModelResolutionError('MODEL_ALIAS_NOT_ALLOWED', `"${value}"${at} is an alias; use the model ID "${alias.id}". ${valid}`);
  throw new ModelResolutionError('UNKNOWN_MODEL', `Unknown model "${value}"${at}. ${valid}`);
}
