import { formatTaskElapsed } from './task-elapsed';
import type { ProcessSample } from '../../../src/orchestration/process-activity';
import type { ToolOutcome } from '../../../src/orchestration/execution-observation';

export interface TaskDetail {
  title: string; state: string; startedAt?: number; finishedAt?: number;
  progress?: string; progressText?: string; question?: string;
  activityDetails?: { counters: string; status: string; age: number; activeTools: string[];
    observationStatus?: string; process?: ProcessSample; lastTool?: ToolOutcome; quiet?: boolean };
}
function bytes(value: number): string {
  const unit = value >= 1000000 ? 'MB' : value >= 1000 ? 'KB' : 'B';
  return `${Number((value / (unit === 'MB' ? 1000000 : unit === 'KB' ? 1000 : 1)).toFixed(2))} ${unit}`;
}
export function formatTaskDetail(task: TaskDetail, label: string): string {
  const activity = task.activityDetails;
  const progress = task.progressText ?? task.progress;
  const progressLines = [progress, activity?.activeTools.length ? `Active tools: ${activity.activeTools.join(', ')}` : '', activity ? `Last activity: ${activity.age}s ago.` : '', task.question ? `Waiting for your input:\n${task.question}` : ''].filter(Boolean);
  const process = activity?.process;
  const counters = process ? process.available ? [
    `Processes: ${process.processCount}`,
    process.cpuTicksDelta !== undefined ? `CPU: +${process.cpuTicksDelta} ticks · Children: ${process.childCpuTicksDelta === undefined ? 'unavailable' : `+${process.childCpuTicksDelta} ticks`}` : 'CPU: unavailable',
    process.ioAvailable ? `I/O: Read ${process.readBytesDelta === undefined ? 'unavailable' : `+${bytes(process.readBytesDelta)}`} · Write ${process.writeBytesDelta === undefined ? 'unavailable' : `+${bytes(process.writeBytesDelta)}`}` : 'I/O: partially unavailable',
  ].join('\n') : '' : activity?.counters;
  const lastTool = activity?.lastTool;
  const diagnostics = [counters, lastTool ? `Last tool: ${lastTool.name} · ${lastTool.status === 'error' ? 'Reported error' : 'Result received'}${lastTool.exitCode === undefined ? '' : ` · Exit code: ${lastTool.exitCode}`}\nReported at: ${new Date(lastTool.observedAt).toISOString().replace('T',' ').replace(/\.\d{3}Z$/, ' UTC')}` : '', activity?.observationStatus ?? activity?.status, activity?.quiet ? 'No recent tool/model progress; task retained for inspection or cancellation.' : ''].filter(Boolean);
  return [
    `${task.title}\n${label} · Elapsed: ${formatTaskElapsed(task.startedAt,task.finishedAt)}`,
    progressLines.length ? `Progress\n${progressLines.join('\n')}` : '',
    diagnostics.length ? `Diagnostics\n${diagnostics.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
