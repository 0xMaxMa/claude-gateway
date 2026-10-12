import { ProviderRefusals } from './provider-refusal';
/** Protocol outcomes are independent of OS exit codes and CLI stderr warnings. */
export type TurnOutcome = 'pending' | 'completed' | 'failed' | 'cancelled' | 'timeout';
export class ProcessDiagnostics {
  outcome: TurnOutcome = 'pending';
  stopReason?: 'cancelled' | 'timeout' | 'shutdown';
  stderrObserved = false;
  nativeMessageId?: string;
  errorCode?: string;
  safetyStops?: number;
  readonly refusals = new ProviderRefusals();
  reset(): void {
    this.outcome = 'pending'; this.stopReason = undefined; this.stderrObserved = false;
    this.nativeMessageId = undefined; this.errorCode = undefined; this.safetyStops = undefined; this.refusals.reset();
  }
  observe(event: Record<string, any>): void {
    const id = event.message?.id ?? event.event?.message?.id;
    if (typeof id === 'string') this.nativeMessageId = id;
    this.refusals.observe(event);
    if (event.type === 'result' && Number.isSafeInteger(event.safety_stops)) this.safetyStops = event.safety_stops;
    if (event.type === 'result' && this.outcome === 'pending') this.outcome = event.is_error || (typeof event.subtype === 'string' && event.subtype.startsWith('error')) ? 'failed' : 'completed';
  }
  finish(outcome: TurnOutcome, errorCode?: string): void {
    this.outcome = outcome; this.errorCode = errorCode;
    if (outcome === 'timeout' || outcome === 'cancelled') this.stopReason = outcome;
  }
  snapshot(): object {
    const providerRefusals = this.refusals.list();
    return { turnOutcome: this.outcome, stopReason: this.stopReason,
      exitReason: this.stopReason ?? (this.outcome === 'completed' ? 'completed' : this.outcome === 'failed' ? 'failed' : 'unexpected_exit'),
      nativeMessageId: this.nativeMessageId, errorCode: this.errorCode,
      stderrObserved: this.stderrObserved,
      // A completed turn may still contain a refused message (e.g. before a fallback answer).
      ...(providerRefusals.length ? { providerRefusals } : {}), safetyStops: this.safetyStops,
      // A warning alone establishes neither success nor a provider rejection.
      inferenceOutcome: this.outcome === 'completed' ? 'succeeded' : this.outcome === 'failed' ? 'failed' : 'unconfirmed' };
  }
}
