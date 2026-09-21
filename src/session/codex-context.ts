import defaults from './codex-context-defaults.json';

/** Never a promise of upstream capacity. The native runtime may impose a lower limit. */
export interface CodexContextMeasurement {
  requested: number | null;
  configured: number | null;
  providerLimit: number | null;
  limitSource: 'documented-model' | 'unknown';
  observed: number | null;
  used: number | null;
  status: 'unverified' | 'observed';
}
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export function codexContextPolicy(model: string, requested?: number): CodexContextMeasurement {
  if (requested !== undefined && !positive(requested)) throw new Error('Invalid Codex context window');
  // Versioned model data lives in one place. Never perform prefix matching or
  // assume a dated/custom model has its family's capacity. No user setup required.
  const limit = Object.hasOwnProperty.call(defaults.limits, model) ? (defaults.limits as Record<string, number>)[model] : undefined;
  return { requested: requested ?? null, configured: limit === undefined ? requested ?? null : Math.min(requested ?? limit, limit),
    providerLimit: limit ?? null, limitSource: limit !== undefined ? 'documented-model' : 'unknown',
    observed: null, used: null, status: 'unverified' };
}
export function observeCodexContext(policy: CodexContextMeasurement, usage: any): CodexContextMeasurement {
  const observed = positive(usage?.modelContextWindow) ? usage.modelContextWindow : null;
  const used = typeof usage?.last?.totalTokens === 'number' && Number.isSafeInteger(usage.last.totalTokens) && usage.last.totalTokens >= 0 ? usage.last.totalTokens : null;
  // A missing native measurement remains unknown. Never substitute cumulative usage
  // (many requests) or the requested window as a measurement of the current context.
  return { ...policy, observed, used, status: observed === null ? 'unverified' : 'observed' };
}
