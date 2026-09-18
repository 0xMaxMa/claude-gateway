import { promises as fs } from 'fs';
import * as path from 'path';
import { parseDreamReport } from '../agent/dreaming/report';

/** Read audit files asynchronously; refuse oversized files instead of blocking the gateway. */
async function auditFile(filename: string): Promise<string> {
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    if ((await handle.stat()).size > 16 * 1024 * 1024) throw new Error('Audit file exceeds the dashboard read limit');
    return await handle.readFile('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  } finally { await handle?.close(); }
}
export interface MaintenanceReader { readonly workspacePath?: string; getDashboardSource?: () => {filename:string}; sessionCompactionReport?: () => Promise<{runs?: any[]; schedule: any}>; }
export async function readMemoryActivity(agents: Map<string, MaintenanceReader>, root: string, readCompactions?: (filename:string,agent:string)=>Promise<any[]>) {
  const runs: any[] = [], schedules: any[] = [], unavailable: string[] = [];
  for (const [agent, runner] of agents) {
    try {
      const dir = path.join(runner.workspacePath ?? path.join(root,agent,'workspace'), '.dreaming');
      const [diary, promotions, accepted] = await Promise.all(['DREAMS.md','promotions.jsonl','accepted.jsonl'].map(name => auditFile(path.join(dir,name))));
      for (const run of parseDreamReport(diary,promotions,accepted).slice(0,100)) {
        const pending = run.mode === 'propose' ? run.proposals.filter(p=>!p.accepted).length : 0;
        runs.push({...run, id:'dream:'+agent+':'+run.ts, agent, kind:'memory_dream', startedAt:run.ts, endedAt:run.ts,
          status:pending?'pending':/fail|error/.test(run.outcome)?'failed':/skip/.test(run.outcome)?'skipped':'completed', pendingProposals:pending});
      }
    } catch { unavailable.push(agent+': memory audit unavailable'); }
    try {
      const report = await runner.sessionCompactionReport?.();
      const source=runner.getDashboardSource?.();
      const recorded=source&&readCompactions ? await readCompactions(source.filename,agent) : report?.runs??[];
      runs.push(...(recorded??[]).slice(0,100).map(run=>({...run,agent,kind:'session_compaction'})));
      if(report)schedules.push({agent,...report.schedule});
    } catch { unavailable.push(agent+': compaction audit unavailable'); }
  }
  runs.sort((a,b)=>b.startedAt-a.startedAt || String(b.id).localeCompare(String(a.id)));
  return {runs,schedules,agents:[...agents.keys()].sort(),unavailable};
}
export function activitySummary(run: any) {
  const {proposals,items,...summary}=run;
  return {...summary,summary:typeof summary.summary==='string'?summary.summary.slice(0,400):undefined,
    proposalCount:proposals?.length??0,itemCount:items?.length??summary.itemCount??0,
    completedSessions:items?.filter((item:any)=>item.status==='completed').length??summary.completedSessions??0,
    failedSessions:items?.filter((item:any)=>item.status==='failed').length??summary.failedSessions??0};
}
