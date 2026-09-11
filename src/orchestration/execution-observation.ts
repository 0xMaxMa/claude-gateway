import type { ProcessSample } from './process-activity';
export interface ToolOutcome { name: string; status: 'returned' | 'error'; observedAt: number; exitCode?: number; }
/** Protocol metadata only: never infer outcomes from arbitrary tool output. */
export function toolOutcome(name: string, result: { is_error?: unknown; exit_code?: unknown }, observedAt: number): ToolOutcome {
  return { name: name.slice(0,128), status: result.is_error === true ? 'error' : 'returned', observedAt,
    ...(typeof result.exit_code === 'number' && Number.isSafeInteger(result.exit_code) ? { exitCode: result.exit_code } : {}) };
}
export interface TurnObservation {
  observedAt: number;
  lastProgressAt: number;
  phase: string;
  activeTools: string[];
  quiet: boolean;
  lastTool?: ToolOutcome;
}
export interface ExecutionObservation extends TurnObservation {
  attemptId: string;
  process: ProcessSample;
  lastActivityAt: number;
  status: 'observing' | 'process_activity' | 'waiting_for_tool' | 'waiting_for_model' | 'telemetry_unavailable';
}
export function executionDetails(e: ExecutionObservation) {
  const status = e.status === 'observing' ? 'Collecting process baseline; no movement comparison yet.' : e.status === 'process_activity' ? 'Process activity detected (not proof of task progress).'
    : e.status === 'telemetry_unavailable' ? 'Process telemetry unavailable; silence does not prove a stall.'
    : e.activeTools.length ? 'Waiting for tool; no process activity observed in the last sample.'
    : 'Waiting for model output; no process activity observed in the last sample.';
  const age = Math.max(0, Math.floor((Date.now() - e.lastActivityAt) / 1000));
  const counters = e.process.available && e.process.cpuTicksDelta !== undefined
    ? ` Processes: ${e.process.processCount}; CPU +${e.process.cpuTicksDelta} ticks (children +${e.process.childCpuTicksDelta ?? 0}); logical I/O ${e.process.ioAvailable ? `read +${e.process.readBytesDelta ?? 0}, write +${e.process.writeBytesDelta ?? 0} bytes` : 'partially unavailable'}.` : '';
  return { observationStatus: status, process: e.process, lastTool: e.lastTool, quiet: e.quiet, status: `${status}${e.quiet ? ' No recent tool/model progress; task retained for inspection or cancellation.' : ''}`, counters: counters.trim(), age, activeTools: e.activeTools };
}
export function executionDescription(e: ExecutionObservation): string {
  const details = executionDetails(e);
  return `${details.status}${details.counters ? ` ${details.counters}` : ''}\nLast activity: ${details.age}s ago.${details.activeTools.length ? `\nActive tools: ${details.activeTools.join(', ')}.` : ''}`;
}
