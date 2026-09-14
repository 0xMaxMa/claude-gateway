import type { TaskSnapshot } from '../types';
export type TimingPhase = 'working' | 'tool' | 'input' | 'queued' | 'other' | 'finished';
export interface TaskTiming { since: number; phase: TimingPhase; totals: Partial<Record<TimingPhase, number>>; measuredFrom: number; activeToolCount?: number; attemptId?: string; }
export function timingPhase(task: TaskSnapshot): TimingPhase {
  if (['completed', 'failed', 'cancelled'].includes(task.state)) return 'finished';
  if (task.state === 'waiting_input') return 'input';
  if (task.state === 'queued') return 'queued';
  if (['running','starting'].includes(task.state)) return (task.timing?.attemptId === task.activeAttemptId ? task.timing?.activeToolCount : task.execution?.attemptId === task.activeAttemptId ? task.execution?.activeTools.length : 0) ? 'tool' : 'working';
  return 'other';
}
export function advanceTiming(task: TaskSnapshot, now = Date.now()): void {
  const old = task.timing;
  const phase = timingPhase(task);
  if (!old) {
    // Existing records have no phase history: do not invent time spent working.
    task.timing = { since: now, phase, totals: {}, measuredFrom: now };
    return;
  }
  if (old.phase !== phase) {
    if (old.phase !== 'finished') old.totals[old.phase] = (old.totals[old.phase] ?? 0) + Math.max(0, now - old.since);
    old.since = Math.max(old.since,now); old.phase = phase;
  }
}
export function timingTotals(task: TaskSnapshot, now = Date.now()): Partial<Record<TimingPhase, number>> | undefined {
  if (!task.timing) return;
  const { totals, phase, since } = task.timing;
  return { ...totals, ...(phase === 'finished' ? {} : { [phase]: (totals[phase] ?? 0) + Math.max(0,now-since) }) };
}

export function formatTiming(totals: Partial<Record<TimingPhase, number>> | undefined): string {
  if (!totals) return '';
  const labels: Record<string,string> = { working:'Working / model', tool:'Tool execution / waiting', input:'Waiting for input', queued:'Queued', other:'Recovery / stopping' };
  return Object.entries(totals).filter(([key,ms])=>labels[key] && ms > 0).map(([key,ms])=>{
    const seconds=Math.floor(ms/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
    return `${labels[key]}: ${hours?hours+'h ':''}${hours||minutes?minutes+'m ':''}${seconds%60}s`;
  }).join('\n');
}
