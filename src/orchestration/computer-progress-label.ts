import type {ComputerTaskReport} from './types';

const OUTCOME_WORDS:Record<string,string>={succeeded:'done',blocked:'blocked',needs_input:'needs input',needs_verification:'needs verification',cancelled:'cancelled',needs_reconciliation:'needs reconciliation'};

/** Owner-facing progress line. A finished goal loop names its outcome, never the internal 'terminal' phase,
 *  which owners read as the Terminal app. Progress reports carry status 'running', so the outcome comes from the
 *  terminal trace event when the report itself has none. */
export function computerProgressLabel(report:ComputerTaskReport):string{
 const evaluations=report.evaluations??0;
 if(report.phase!=='terminal')return `Computer Use: ${report.phase} · ${report.steps} actions · ${evaluations} evaluations.`;
 const last=report.trace?.at(-1);
 const status=report.status!=='running'?report.status:last?.phase==='terminal'?last.status:undefined;
 if(status==='succeeded')return `Computer Use: done · ${report.steps} actions · ${evaluations} evaluations.`;
 const reason=report.reason&&report.reason!=='terminal'?` · ${report.reason}`:'';
 return `Computer Use: ${(status&&OUTCOME_WORDS[status])??'ended'}${reason} · ${report.steps} actions.`;
}
