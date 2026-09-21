import { validateWorkerEnvironment } from '../session/worker-environment';
import type { AgentConfig, GatewayConfig, ModelConfig, WorkerHarnessConfig } from '../types';
import { OrchestrationError } from './types';

export function validateWorkerHarness(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workers must be an object');
  const c = value as WorkerHarnessConfig;
  for (const key of Object.keys(c)) if (!['harness', 'codex', 'environment', 'containerEnvironment'].includes(key)) throw new Error(`Unknown workers field: ${key}`);
  if (c.harness !== undefined && !['claude', 'auto', 'codex'].includes(c.harness)) throw new Error('Invalid workers.harness');
  validateWorkerEnvironment(c.environment, 'workers.environment');
  validateWorkerEnvironment(c.containerEnvironment, 'workers.containerEnvironment');
  if (c.codex === undefined) return;
  if (!c.codex || typeof c.codex !== 'object' || Array.isArray(c.codex)) throw new Error('workers.codex must be an object');
  for (const key of Object.keys(c.codex)) if (!['baseUrl','apiKeyEnv','reasoningEffort','bin'].includes(key)) throw new Error(`Unknown workers.codex field: ${key}`);
  if (c.codex.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(c.codex.apiKeyEnv)) throw new Error('workers.codex.apiKeyEnv must name an environment variable');
  if (c.codex.reasoningEffort !== undefined && !['low','medium','high','xhigh'].includes(c.codex.reasoningEffort)) throw new Error('Invalid workers.codex.reasoningEffort');
  if (c.codex.bin !== undefined && (typeof c.codex.bin !== 'string' || !c.codex.bin.trim() || /[\r\n\0]/.test(c.codex.bin))) throw new Error('workers.codex.bin must be an executable path, not shell arguments');
  if (c.codex.baseUrl !== undefined) {
    const u = new URL(c.codex.baseUrl);
    if (u.username || u.password || u.search || u.hash || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))) throw new Error('workers.codex.baseUrl requires HTTPS (or local HTTP), without credentials or query parameters');
  }
}

export function validateWorkerModel(model: ModelConfig): void {
  if (model.workerHarness !== undefined && !['claude','codex'].includes(model.workerHarness)) throw new Error('Invalid model.workerHarness');
  if (model.workerModel !== undefined && (typeof model.workerModel !== 'string' || !model.workerModel.trim() || model.workerModel.length > 200 || /[\r\n\0]/.test(model.workerModel))) throw new Error('Invalid model.workerModel');
}

export function resolveWorkerHarness(agent: AgentConfig, gateway: GatewayConfig, model: string) {
  validateWorkerHarness(gateway.gateway.workers); validateWorkerHarness(agent.workers);
  const settings = { ...gateway.gateway.workers, ...agent.workers };
  const metadata = gateway.gateway.models?.find(m => m.id === model || m.alias === model);
  if (metadata) validateWorkerModel(metadata);
  const canonical = metadata?.id ?? model;
  const selector = settings.harness ?? 'auto';
  const harness = selector === 'auto'
    ? metadata?.workerHarness ?? (/^(?:(?:openai|chatgpt)\/)?gpt-[a-z0-9]/i.test(canonical) ? 'codex' : 'claude')
    : selector;
  // Preserve provider namespaces: stripping chatgpt/ could silently switch BYOK to a pool.
  // A direct endpoint can declare workerModel when its native name differs.
  const nativeModel = metadata?.workerModel ?? canonical.replace(/\[(?:1m|200k)\]$/i, '');
  if (harness === 'codex' && (!nativeModel || /[\r\n\0]/.test(nativeModel))) throw new OrchestrationError('WORKER_MODEL_INVALID');
  // Claude's context suffix is not part of a Responses model ID. Carry its
  // meaning into native Codex configuration instead of silently dropping it.
  const suffix = /\[(1m|200k)\]$/i.exec(canonical)?.[1].toLowerCase();
  const contextWindow = suffix === '1m' ? 1_000_000 : suffix === '200k' ? 200_000 : metadata?.contextWindow;
  if (harness === 'codex' && contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) throw new OrchestrationError('WORKER_MODEL_INVALID');
  return { harness, config: { ...gateway.gateway.workers?.codex, ...agent.workers?.codex, model: nativeModel,
    ...(harness === 'codex' && contextWindow !== undefined ? { contextWindow } : {}) } } as const;
}
