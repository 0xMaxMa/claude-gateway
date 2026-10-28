import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

/** Correlates one spoken turn across STT, the agent turn and TTS. */
export type VoiceTraceIds = { responseId?: string; utteranceId?: string; inputId?: string };
/** `turn` spans one user turn end to end, from the end of speech to the first audio heard. */
export type VoiceDiagnostic = { operation: 'stt' | 'tts' | 'turn'; operationId: string; phase: string; elapsedMs: number; httpStatus?: number; code?: string } & VoiceTraceIds;
export type VoiceDiagnosticSink = (event: VoiceDiagnostic) => void;
const context = new AsyncLocalStorage<(phase: string, details?: { httpStatus?: number; code?: string }) => void>();
/** Only bounded metadata is accepted: never transcript, audio, URL or credentials.
 * `ids` is read on every event, so ids learned later in the turn are attached as they arrive. */
export function voiceTrace(operation: VoiceDiagnostic['operation'], sink?: VoiceDiagnosticSink, ids: VoiceTraceIds = {}) {
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
