import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JevConfig, JevConnection, JevContext, JevError, JevErrorCode, JevEvaluationEvent, JevRequest, JevResult } from './types';
import { validateJevConfig, validateJevRequest, validateJevResponse } from './validation';

export function jevEndpoint(connection: JevConnection, provider: JevConfig['provider']): URL {
  let url: URL;
  try { url = new URL(connection.baseUrl); } catch { throw new JevError('INVALID_CONFIG', 'Invalid Jev endpoint URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw new JevError('INVALID_CONFIG', 'Jev requires HTTPS (or local loopback HTTP), without URL credentials, query or fragment.');
  const suffix = provider === 'typesafe' ? '/v1/systemone' : '/v1/jev/evaluate';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(suffix) ? path : path.endsWith('/v1') ? `${path}${suffix.slice(3)}` : `${path}${suffix}`;
  return url;
}
export async function resolveDirectJevConnection(config: JevConfig): Promise<JevConnection> {
  if (config.provider !== 'typesafe') throw new JevError('INVALID_CONFIG', 'An upstream connection resolver is required.');
  if (config.apiKeyFile && config.apiKeyEnv) throw new JevError('INVALID_CONFIG', 'Choose one Jev credential reference.');
  let apiKey = '';
  try { apiKey = config.apiKeyFile ? (await readFile(config.apiKeyFile, 'utf8')).trim() : (process.env[config.apiKeyEnv ?? 'TYPESAFE_API_KEY'] ?? '').trim(); }
  catch { throw new JevError('AUTHENTICATION_FAILED', 'The Jev credential file cannot be read.'); }
  if (!apiKey || apiKey.length > 16384 || /[\r\n]/.test(apiKey)) throw new JevError('AUTHENTICATION_FAILED', 'A valid Jev credential is required.');
  return { baseUrl: config.baseUrl ?? 'https://api.typesafe.ai', apiKey };
}
interface Options {
  getConfig: () => JevConfig | undefined;
  resolveConnection?: (config: JevConfig) => Promise<JevConnection>;
  fetch?: typeof fetch;
  onEvaluation?: (event: JevEvaluationEvent) => void;
}
interface Waiter { limit: number; accept: () => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void }
/** The single queue is shared across config generations. No retries or source fallback. */
export class JevService {
  private active = 0;
  private queue: Waiter[] = [];
  private requests = new Map<string, { digest: string; expires: number; settled: boolean }>();
  constructor(private readonly options: Options) {}
  evaluate(input: JevRequest, context: JevContext): Promise<JevResult> {
    const config = structuredClone(this.options.getConfig());
    if (!config?.enabled) return Promise.reject(new JevError('DISABLED', 'Jev is not enabled.'));
    try {
      validateJevConfig(config);
      if (!context.principalId || !context.consumer) throw new JevError('ACCESS_DENIED', 'An authenticated evaluation context is required.');
      if (context.authorize && !context.authorize()) throw new JevError('ACCESS_DENIED', 'Jev access was denied.');
      const request = validateJevRequest(input, config);
      const requestId = request.requestId ?? randomUUID();
      const key = `${context.principalId.length}:${context.principalId}:${requestId}`;
      const digest = createHash('sha256').update(JSON.stringify({ request, config })).digest('hex');
      const now = Date.now();
      for (const [k, entry] of this.requests) if (entry.settled && entry.expires < now) this.requests.delete(k);
      const existing = this.requests.get(key);
      if (existing) {
        if (existing.digest !== digest) throw new JevError('REQUEST_CONFLICT', 'Request ID already identifies a different evaluation.');
        // Never let a second caller detach the original cancellation/deadline contract.
        throw new JevError('REQUEST_CONFLICT', 'Request ID has already been submitted; inspect the original evaluation result.');
      }
      if (this.requests.size >= 4096) throw new JevError('QUEUE_FULL', 'The Jev request ledger is full; retry later.');
      const result = this.run(request, requestId, config, context);
      const entry = { digest, expires: now + 300000, settled: false };
      this.requests.set(key, entry);
      void result.then(() => { entry.settled = true; entry.expires = Date.now() + 300000; }, () => { entry.settled = true; entry.expires = Date.now() + 300000; });
      return result;
    } catch (error) { return Promise.reject(error); }
  }
  private async run(request: JevRequest, requestId: string, config: JevConfig, context: JevContext): Promise<JevResult> {
    const startedAt = Date.now();
    const wireRequestId = createHash('sha256').update(`${context.principalId.length}:${context.principalId}:${requestId}`).digest('hex');
    const controller = new AbortController();
    let expired = false;
    const timeout = Math.min(config.timeoutMs ?? 5000, context.deadlineMs === undefined ? Infinity : context.deadlineMs - startedAt);
    const abort = () => controller.abort();
    const timer = setTimeout(() => { expired = true; controller.abort(); }, Math.max(0, timeout));
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    if (timeout <= 0) { expired = true; abort(); }
    let acquired = false;
    let result: JevResult | undefined;
    let failure: JevError | undefined;
    try {
      await this.acquire(config, controller.signal); acquired = true;
      this.authorized(context);
      const connection = await this.abortable((this.options.resolveConnection ?? resolveDirectJevConnection)(config), controller.signal);
      this.authorized(context);
      if (!connection.apiKey || /[\r\n]/.test(connection.apiKey)) throw new JevError('AUTHENTICATION_FAILED', 'A valid Jev credential is required.');
      const endpoint = jevEndpoint(connection, config.provider);
      const response = await this.abortable((this.options.fetch ?? fetch)(endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${connection.apiKey}`, 'content-type': 'application/json', 'x-request-id': wireRequestId },
        body: JSON.stringify({ model: config.model, state: request.state, questions: request.questions, ...(config.provider === 'upstream' ? { request_id: wireRequestId } : {}) }),
      }), controller.signal);
      if (!response.ok) {
        let code: JevErrorCode = response.status === 401 ? 'AUTHENTICATION_FAILED' : response.status === 403 ? 'ACCESS_DENIED' : response.status === 402 ? 'QUOTA_EXCEEDED' : response.status === 429 ? 'RATE_LIMITED' : response.status === 409 ? 'REQUEST_CONFLICT' : response.status === 504 ? 'DEADLINE_EXCEEDED' : response.status === 404 ? 'MODEL_UNAVAILABLE' : response.status === 400 || response.status === 413 || response.status === 422 ? 'INVALID_REQUEST' : 'PROVIDER_UNAVAILABLE';
        const metadata = this.errorMetadata(response);
        // Read only bounded structured codes/reset metadata. Provider prose can echo secrets or state.
        if (config.provider === 'upstream' && response.headers.get('content-type')?.includes('application/json')) {
          try {
            const body = await this.abortable(this.readResponse(response, 16384), controller.signal) as {error?: {code?: string; resets_at?: string; resetAt?: string}};
            const mapped: Record<string,JevErrorCode> = {QUOTA_EXHAUSTED:'QUOTA_EXCEEDED',QUOTA_EXCEEDED:'QUOTA_EXCEEDED',MODEL_DISABLED:'MODEL_UNAVAILABLE',UNKNOWN_MODEL:'MODEL_UNAVAILABLE',UPSTREAM_AUTH_ERROR:'AUTHENTICATION_FAILED',UPSTREAM_RATE_LIMITED:'RATE_LIMITED',REQUEST_CONFLICT:'REQUEST_CONFLICT',UPSTREAM_TIMEOUT:'OUTCOME_UNKNOWN',UPSTREAM_OUTCOME_UNKNOWN:'OUTCOME_UNKNOWN',CANCELLED_OUTCOME_UNKNOWN:'OUTCOME_UNKNOWN',RESERVATION_UNKNOWN:'OUTCOME_UNKNOWN',SETTLEMENT_UNKNOWN:'OUTCOME_UNKNOWN'};
            if (body?.error?.code && Object.prototype.hasOwnProperty.call(mapped,body.error.code)) code=mapped[body.error.code];
            const reset=body?.error?.resets_at ?? body?.error?.resetAt;
            if(typeof reset==='string'&&reset.length<128&&/^[\w\s,:.+-]+$/.test(reset)) metadata.resetAt=reset;
          } catch { /* Keep the HTTP failure; never turn a malformed error into success. */ }
        } else void response.body?.cancel().catch(() => undefined);
        throw new JevError(code, code==='OUTCOME_UNKNOWN'?'Jev outcome and charges require reconciliation. Do not retry automatically.':`Jev evaluation failed (HTTP ${response.status}).`, { status: response.status, ...metadata });
      }
      const raw = await this.abortable(this.readResponse(response), controller.signal);
      result = { ...validateJevResponse(raw, request, config.model!, wireRequestId), requestId };
      this.authorized(context);
      if (controller.signal.aborted) throw new JevError('CANCELLED', 'Jev evaluation cancelled.');
      return result;
    } catch (error) {
      failure = controller.signal.aborted ? new JevError(expired ? 'DEADLINE_EXCEEDED' : 'CANCELLED', expired ? 'Jev evaluation deadline exceeded.' : 'Jev evaluation cancelled.') : error instanceof JevError ? error : new JevError('PROVIDER_UNAVAILABLE', 'Jev could not complete the evaluation.');
      throw failure;
    } finally {
      clearTimeout(timer); context.signal?.removeEventListener('abort', abort);
      if (acquired) { this.active--; this.drain(); }
      try { this.options.onEvaluation?.({ requestId, principalId: context.principalId, consumer: context.consumer, agentId: context.agentId, sessionId: context.sessionId, taskId: context.taskId, requestedModel: config.model!, model: result?.model, startedAt, elapsedMs: Date.now() - startedAt, outcome: failure ? 'failed' : 'completed', errorCode: failure?.code, usage: result?.usage, billing: result?.billing }); } catch { /* Accounting observers cannot change an already-issued inference outcome. */ }
    }
  }
  private authorized(context: JevContext): void {
    if (!this.options.getConfig()?.enabled || (context.authorize && !context.authorize())) throw new JevError('ACCESS_DENIED', 'Jev access was revoked.');
  }
  private errorMetadata(response: Response): { retryAfter?: string; resetAt?: string } {
    const retryAfter = response.headers.get('retry-after');
    const resetAt = response.headers.get('x-ratelimit-reset');
    return { ...(retryAfter && retryAfter.length < 128 && /^[\w\s,:.+-]+$/.test(retryAfter) ? { retryAfter } : {}), ...(resetAt && resetAt.length < 128 && /^[\w\s,:.+-]+$/.test(resetAt) ? { resetAt } : {}) };
  }
  private async readResponse(response: Response, maxBytes=2097152): Promise<unknown> {
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new JevError('INVALID_RESPONSE', 'Jev returned a non-JSON response.');
    const reader = response.body?.getReader();
    if (!reader) throw new JevError('INVALID_RESPONSE', 'Jev returned an empty response.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > maxBytes) throw new JevError('INVALID_RESPONSE', 'Jev response exceeds the byte limit.'); chunks.push(chunk.value); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new JevError('INVALID_RESPONSE', 'Jev returned malformed JSON.'); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new JevError('CANCELLED', 'Jev evaluation cancelled.'));
      if (signal.aborted) { void promise.catch(() => undefined); abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private acquire(config: JevConfig, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new JevError('CANCELLED', 'Jev evaluation cancelled.'));
    const limit = config.maxConcurrentRequests ?? 4;
    if (!this.queue.length && this.active < limit) { this.active++; return Promise.resolve(); }
    if (this.queue.length >= (config.maxQueueSize ?? 16)) return Promise.reject(new JevError('QUEUE_FULL', 'Jev evaluation queue is full.'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { limit, accept: resolve, reject, signal, abort: () => { this.queue = this.queue.filter(x => x !== waiter); reject(new JevError('CANCELLED', 'Jev evaluation cancelled.')); this.drain(); } };
      this.queue.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
    });
  }
  private drain(): void {
    while (this.queue.length && this.active < this.queue[0].limit) {
      const next = this.queue.shift()!; next.signal.removeEventListener('abort', next.abort);
      if (next.signal.aborted) { next.reject(new JevError('CANCELLED', 'Jev evaluation cancelled.')); continue; }
      this.active++; next.accept();
    }
  }
}
