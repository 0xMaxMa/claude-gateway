import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

export type VoiceDiagnostic = { operation: 'stt' | 'tts'; operationId: string; phase: string; elapsedMs: number; responseId?: string; utteranceId?: string; httpStatus?: number; code?: string };
export type VoiceDiagnosticSink = (event: VoiceDiagnostic) => void;
const context = new AsyncLocalStorage<(phase: string, details?: { httpStatus?: number; code?: string }) => void>();
/** Only bounded metadata is accepted: never transcript, audio, URL or credentials. */
export function voiceTrace(operation: 'stt' | 'tts', sink?: VoiceDiagnosticSink, ids: { responseId?: string; utteranceId?: string } = {}) {
  const started = performance.now(), operationId = randomUUID();
  const emit = (phase: string, details: { httpStatus?: number; code?: string } = {}) => {
    try { sink?.({ operation, operationId, ...ids, phase, elapsedMs: Math.round(performance.now() - started), ...details }); } catch { /* Diagnostics cannot interrupt speech. */ }
  };
  return { emit, run: <T>(fn: () => T): T => context.run(emit, fn) };
}
export function voiceTiming(phase: string, details?: { httpStatus?: number; code?: string }): void { context.getStore()?.(phase, details); }
/** Async generators execute on next(), not when created. Preserve request context. */
export async function* tracedAudio<T>(source: AsyncIterable<T>, trace: ReturnType<typeof voiceTrace>): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try { while (true) { const item = await trace.run(() => iterator.next()); if (item.done) return; yield item.value; } }
  finally { await trace.run(() => iterator.return?.()); }
}
