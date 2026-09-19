import { compactMeasurements, type CompactMeasurements } from './compact-measurements';
import { SessionProcess } from '../session/process';
import { startProcessTurn, ProcessTurn } from './process-turn';
import { OrchestrationError } from './types';

/** The CLI owns context compaction. Never replace gateway chat history. */
export function startNativeCompact(process: SessionProcess, alreadyStarted = false): ProcessTurn & { measurements():CompactMeasurements|null } {
  let compacted = false;
  let measured:CompactMeasurements|null=null;
  const observe = (line: string) => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'system' && event.subtype === 'compact_boundary') { compacted = true; measured=compactMeasurements(event); }
    } catch { /* Ignore non-protocol output. */ }
  };
  process.on('output', observe);
  const turn = startProcessTurn(process, '/compact', 300000, undefined, undefined, [], undefined, undefined, alreadyStarted);
  const result = turn.result.then(result => {
    if (result.interrupted) throw new OrchestrationError('INTERRUPTED', 'Context compaction was stopped.');
    if (!compacted) throw new OrchestrationError('COMPACT_NOT_CONFIRMED', 'Claude Code did not confirm context compaction. The context may be too short, or this CLI version may not support /compact.');
    return result;
  }).finally(() => process.off('output', observe));
  void result.catch(() => {});
  return {...turn, result, measurements:()=>measured};
}
