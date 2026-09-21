import { execFile } from 'child_process';
import { readFile, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { assertLocalCodexDocker } from '../session/codex-container-runtime';

export interface ProcessOwner {
  pid: number;
  group: 'gateway' | 'agent' | 'worker' | 'safemode';
  agentId?: string; sessionId?: string; model?: string; taskId?: string; title?: string;
  harness?: string; container?: string; name?: string; mode?: string;
  startTicks?: string;
}
interface ProcessRow { pid: number; ppid: number; stat: string; cpu: number; rssKb: number; command: string; args: string }
export interface ProcessContainer { name: string; id?: string; agentIds: string[]; state: string; pids: number[]; error?: string }
const execute = (file: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: {...process.env, LC_ALL: 'C'} }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
export function parseProcesses(stdout: string): ProcessRow[] {
  return stdout.split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    return m ? [{pid:+m[1],ppid:+m[2],stat:m[3],cpu:+m[4],rssKb:+m[5],command:m[6],args:m[7]}] : [];
  });
}

/** One host PID is counted once, even when docker top also reports it. Never return argv. */
export function classifyProcesses(rows: ProcessRow[], owners: ProcessOwner[], containers: ProcessContainer[]) {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const roots = new Map(owners.filter(owner => byPid.has(owner.pid)).map(owner => [owner.pid, owner]));
  const containerPids = new Map(containers.flatMap(c => c.pids.map(pid => [pid, c.name] as const)));
  // docker exec's host client is not the parent of the container process.
  // Correlate only with the private invocation marker from a known live owner.
  for (const owner of owners.filter(o=>o.container)) {
    const args = byPid.get(owner.pid)?.args ?? '';
    const marker = args.match(/\/tmp\/gateway-orch-[a-f0-9-]{36}\b/)?.[0];
    const session = args.match(/--session-id\s+([a-f0-9-]{36})\b/)?.[1];
    const matches = rows.filter(row => containerPids.get(row.pid) === owner.container &&
      (marker ? row.args.includes(marker) : session ? row.args.includes('--session-id '+session) : false));
    const matchingPids = new Set(matches.map(p=>p.pid));
    for (const row of matches.filter(p=>!matchingPids.has(p.ppid))) roots.set(row.pid,{...owner,pid:row.pid});
  }
  return [...byPid.values()].flatMap(row => {
    let cursor: ProcessRow | undefined = row, owner: ProcessOwner | undefined;
    const seen = new Set<number>();
    while (cursor && !seen.has(cursor.pid)) {
      seen.add(cursor.pid); owner = roots.get(cursor.pid);
      if (owner) break;
      cursor = byPid.get(cursor.ppid);
    }
    const container = containerPids.get(row.pid);
    const receiver = /(?:telegram|discord).*receiver/.exec(row.args)?.[0]?.split(/[^a-z]/)[0];
    // Unmanaged personal CLIs are not gateway orphans. Require gateway-specific evidence.
    const orphan = !owner && !container && /(?:\.claude-gateway\/.*(?:mcp|receiver)|--mcp-config\s+\S*claude-gateway|claude-gateway[^\s]*\/mcp\/server)/.test(row.args);
    if (!owner && !container && !orphan) return [];
    return [{...owner,pid:row.pid,ppid:row.ppid,stat:row.stat,cpu:row.cpu,rssKb:row.rssKb,command:row.command,
      group:container ? 'container' : receiver && owner?.group === 'gateway' ? 'receiver' : owner?.group ?? 'orphan',
      role:owner?.group, rootPid:owner?.pid, container:container ?? owner?.container, receiver,
    }];
  });
}

/** Read private safemode ownership without constructing a store (which migrates metadata). */
async function safemodeOwners(rows: ProcessRow[]): Promise<ProcessOwner[]> {
  const root = join(homedir(), '.claude-gateway', 'safemode');
  let entries: string[];
  try { entries = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result: ProcessOwner[] = [];
  for (const id of entries.filter(name => /^(starting-)?[a-f0-9-]{36}$/.test(name))) {
    try {
      const owner = JSON.parse(await readFile(join(root,id,'owner.json'),'utf8'));
      const process = rows.find(row => row.pid === owner.pid);
      if (!process || !/(?:entry|index)\.js\s+safemode\b/.test(process.args)) continue;
      const session = JSON.parse(await readFile(join(root,id,'session.json'),'utf8'));
      let name = session.name;
      try { name = JSON.parse(await readFile(join(root,id,'name.json'),'utf8')).name; } catch { /* Optional alias. */ }
      result.push({pid:owner.pid,group:'safemode',sessionId:session.nativeSessionId,name,harness:session.cli,mode:owner.mode,model:session.model});
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return result;
}

export async function collectDashboardProcesses(owners: ProcessOwner[], apps: Array<{name:string;agentIds:string[]}>) {
  const rows = parseProcesses(await execute('ps', ['-eo','pid,ppid,stat,pcpu,rss,comm,args','--no-headers']));
  const warnings: string[] = [];
  owners = (await Promise.all(owners.map(async owner => {
    if (!owner.startTicks) return owner;
    try {
      const stat = await readFile(`/proc/${owner.pid}/stat`,'utf8');
      return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19] === owner.startTicks ? owner : undefined;
    } catch { return undefined; }
  }))).filter((owner): owner is ProcessOwner => Boolean(owner));
  try { owners = [...owners, ...await safemodeOwners(rows)]; } catch { warnings.push('Safemode ownership could not be read.'); }
  const containers: ProcessContainer[] = [];
  let localDocker = true;
  if (apps.length) try { await assertLocalCodexDocker(); } catch { localDocker = false; }
  // Bound Docker concurrency; collect only containers declared by configured agents.
  for (let i=0; i<apps.length; i+=2) {
    containers.push(...await Promise.all(apps.slice(i,i+2).map(async app => {
      try {
        if (!localDocker) throw new Error('Local Docker process namespace unavailable');
        const state = (await execute('docker',['inspect','--format','{{json .Id}}|{{json .State.Status}}',app.name])).trim().split('|').map(part=>JSON.parse(part));
        const running = state[1] === 'running';
        const listing = running ? parseProcesses(await execute('docker',['top',app.name,'-eo','pid,ppid,stat,pcpu,rss,comm,args'])) : [];
        for (const row of listing) if (!rows.some(p=>p.pid===row.pid)) rows.push(row);
        return {...app,id:state[0] as string,state:state[1] as string,pids:listing.map(row=>row.pid)};
      } catch { return {...app,state:'unknown',pids:[],error:'Container inspection unavailable'}; }
    })));
  }
  const processes = classifyProcesses(rows,owners,containers);
  const containerProcesses = processes.filter(p=>p.group==='container');
  for (let i=0;i<containerProcesses.length;i+=16) await Promise.all(containerProcesses.slice(i,i+16).map(async p=>{
    try {
      const status = await readFile(`/proc/${p.pid}/status`,'utf8');
      const ids = status.match(/^NSpid:\s+([\d\s]+)$/m)?.[1].trim().split(/\s+/);
      if (ids && ids.length>1) Object.assign(p,{containerPid:Number(ids[ids.length-1])});
    } catch { /* Never substitute a host PID for an unknown container PID. */ }
  }));
  return {processes,containers,warnings};
}
