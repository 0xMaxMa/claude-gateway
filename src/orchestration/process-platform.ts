import { execFile } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { readdir, readFile } from 'fs/promises';

/** One process as seen by a platform snapshot. `start` is an opaque per-boot
 * start identity (Linux start ticks, macOS lstart, Windows creation FILETIME);
 * `cpu` is user+system time in 10ms ticks. */
export interface ProcessRecord { pid: number; parent: number; group: number; state: string; start: string; cpu: number; read?: number; write?: number; command?: string; }
export type Fingerprint = { bootId: string; startTicks: string };

/** Everything the orchestration supervisor needs from the OS. A "group" is the
 * set of processes the gateway may prove stopped: the POSIX process group led by
 * a detached worker, or on Windows the process tree rooted at the worker. */
export interface ProcessPlatform {
  /** Spawn the worker with `detached` so it leads its own process group. */
  readonly detachWorkers: boolean;
  readonly termGraceMs: number;
  readonly pollMs: number;
  readonly killSettleMs: number;
  /** Live, non-zombie members; undefined when membership cannot be proven. */
  groupMembers(group: number, rootStart?: string): Promise<number[] | undefined>;
  /** False only when the signal could not be delivered for a reason other than "already gone". */
  signalGroup(group: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<boolean>;
  /** Kernel identity that rejects PID reuse; the pid must still lead its group. */
  fingerprint(pid: number): Promise<Fingerprint | undefined>;
  /** Counters for every visible process; undefined when unavailable. */
  snapshot(): Promise<Map<number, ProcessRecord> | undefined>;
  /** Processes owned by the worker rooted at `root`, when ownership is not the
   * POSIX parent/process-group link. `known` maps pid->start of members owned
   * at the previous sample, so orphaned descendants stay owned. */
  tree?(snapshot: Map<number, ProcessRecord>, root: number, known: Map<number, string>): Map<number, string> | undefined;
  /** Linux enriches owned members with I/O counters and re-checks start identity. */
  refine?(member: ProcessRecord): Promise<boolean>;
  /** Record a just-spawned root's identity while its handle is held (`alive`), so
   * a later stop can anchor orphans and refuse a reused PID. */
  adopt?(pid: number, alive: () => boolean): void;
}

const gone = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
function signalPosixGroup(group: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  try { process.kill(-group, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  return true;
}
function run(file: string, args: string[], timeout = 10_000): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => resolve(error ? undefined : stdout));
  });
}

export const linuxPlatform: ProcessPlatform = {
  detachWorkers: true, termGraceMs: 2000, pollMs: 25, killSettleMs: 50,
  async groupMembers(group) {
    const members: number[] = [];
    try {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          if (Number(fields[2]) === group && fields[0] !== 'Z' && fields[0] !== 'X') members.push(Number(entry));
        } catch (error) { if (!gone(error)) return undefined; }
      }
      return members;
    } catch { return undefined; }
  },
  async signalGroup(group, signal) { return signalPosixGroup(group, signal); },
  async fingerprint(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) !== pid) return undefined;
      return { bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), startTicks: fields[19] };
    } catch { return undefined; }
  },
  async snapshot() {
    const members = new Map<number, ProcessRecord>();
    const entries = await readdir('/proc');
    // Sequential stat reads bound open files and memory on busy shared hosts.
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
        const f = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        members.set(Number(entry), { pid: Number(entry), parent: Number(f[1]), group: Number(f[2]), state: f[0], start: f[19], cpu: Number(f[11]) + Number(f[12]) });
      } catch { /* Processes may exit while being sampled. */ }
    }
    return members;
  },
  async refine(m) {
    try {
      const io = await readFile(`/proc/${m.pid}/io`, 'utf8');
      // Logical I/O includes pipes/cache, so piped test output is visible.
      m.read = Number(/^rchar:\s+(\d+)/m.exec(io)?.[1]);
      m.write = Number(/^wchar:\s+(\d+)/m.exec(io)?.[1]);
    } catch { /* CPU/membership remain usable without I/O permission. */ }
    try {
      const stat = await readFile(`/proc/${m.pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] === m.start;
    } catch { return false; }
  },
};

/** BSD ps `time` is [[dd-]hh:]mm:ss.cc of user+system CPU. */
export function parsePsCpuTicks(value: string): number {
  const [days, clock] = value.includes('-') ? value.split('-') : ['0', value];
  const seconds = clock.split(':').reduce((total, part) => total * 60 + Number(part), 0) + Number(days) * 86400;
  return Number.isFinite(seconds) ? Math.round(seconds * 100) : 0;
}
/** `ps -o pid=,ppid=,pgid=,stat=,time=,lstart=[,comm=]`. lstart is always five
 * fields ("Mon Sep 28 10:00:01 2026"); an optional comm (may hold spaces) follows. */
export function parseDarwinPs(output: string): Map<number, ProcessRecord> {
  const members = new Map<number, ProcessRecord>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)(?:\s+(.*?))?\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    members.set(pid, { pid, parent: Number(match[2]), group: Number(match[3]), state: match[4], start: match[6].replace(/\s+/g, ' '), cpu: parsePsCpuTicks(match[5]),
      ...(match[7] ? { command: match[7] } : {}) });
  }
  return members;
}
const PS_COLUMNS = 'pid=,ppid=,pgid=,stat=,time=,lstart=';
export const darwinPlatform: ProcessPlatform = {
  detachWorkers: true, termGraceMs: 2000, pollMs: 50, killSettleMs: 50,
  async groupMembers(group) {
    const output = await run('ps', ['-A', '-o', 'pid=,pgid=,stat=']);
    if (output === undefined) return undefined;
    const members: number[] = [];
    for (const line of output.split('\n')) {
      const [pid, pgid, state] = line.trim().split(/\s+/);
      if (Number(pgid) === group && state && state[0] !== 'Z') members.push(Number(pid));
    }
    return members;
  },
  async signalGroup(group, signal) { return signalPosixGroup(group, signal); },
  async fingerprint(pid) {
    // ps exits 1 for an unknown pid; that is "no identity", not an error.
    const [output, bootId] = await Promise.all([run('ps', ['-p', String(pid), '-o', `${PS_COLUMNS},comm=`]), run('sysctl', ['-n', 'kern.bootsessionuuid'])]);
    const record = output === undefined ? undefined : parseDarwinPs(output).get(pid);
    if (!record?.command || record.group !== pid || record.state[0] === 'Z' || !bootId?.trim()) return undefined;
    // ps offers no start time finer than lstart's 1s, so a PID reused within the
    // same second would match on start alone; the executable (and the group-leader
    // check above) must match too. Only this per-attempt call pays for comm.
    return { bootId: bootId.trim(), startTicks: `${record.start}|${record.command}` };
  },
  async snapshot() {
    const output = await run('ps', ['-A', '-o', PS_COLUMNS]);
    return output === undefined ? undefined : parseDarwinPs(output);
  },
};

/** Windows has no process groups and no reparenting: a child keeps the PID of
 * its dead parent. A tree edge is trusted only when the child was created no
 * earlier than that parent, which rejects edges to a reused parent PID. */
// Plain .NET WMI (System.Management), never a cmdlet: resolving a cmdlet such as
// Get-CimInstance makes PowerShell run module discovery, which without a warm
// module-analysis cache (e.g. under the minimal env a desktop app gives its
// sidecar) takes 20-70s and outlives the timeout, so no stop could be proven.
const WIN_WMI = "$ErrorActionPreference='Stop';$null=[Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');";
const winQuery = (wql: string, row: string) => `${WIN_WMI}foreach($p in [Management.ManagementObjectSearcher]::new('${wql}').Get()){${row}}`;
const winTime = (field: string) => `[Management.ManagementDateTimeConverter]::ToDateTime($p['${field}']).ToFileTimeUtc()`;
const WIN_SNAPSHOT = winQuery('SELECT ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount FROM Win32_Process',
  `if($p['CreationDate']){'{0} {1} {2} {3} {4} {5}' -f $p['ProcessId'],$p['ParentProcessId'],${winTime('CreationDate')},([uint64]$p['KernelModeTime']+[uint64]$p['UserModeTime']),$p['ReadTransferCount'],$p['WriteTransferCount']}`);
const WIN_BOOT = winQuery('SELECT LastBootUpTime FROM Win32_OperatingSystem', winTime('LastBootUpTime'));
export function parseWindowsSnapshot(output: string): Map<number, ProcessRecord> {
  const members = new Map<number, ProcessRecord>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+) (\d+) (\d+) (\d+) (\d*) (\d*)$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    // 100ns units -> 10ms ticks, matching Linux USER_HZ accounting.
    members.set(pid, { pid, parent: Number(match[2]), group: 0, state: 'R', start: match[3], cpu: Math.floor(Number(match[4]) / 100_000),
      ...(match[5] ? { read: Number(match[5]) } : {}), ...(match[6] ? { write: Number(match[6]) } : {}) });
  }
  return members;
}
const filetime = (value: string) => /^\d+$/.test(value) ? BigInt(value) : undefined;
const notBefore = (child: string, parent: string) => filetime(parent) !== undefined && filetime(child)! >= filetime(parent)!;
/** Members of the tree rooted at `root`. `known` holds pid->start of members owned
 * at the previous snapshot, so a grandchild orphaned by an exited intermediate is
 * still owned. Undefined when nothing is proven: the root PID now belongs to a
 * different process (its original tree may still have orphans that cannot be told
 * apart), or the root is gone and no start identity anchors its orphans. */
export function windowsTree(snapshot: Map<number, ProcessRecord>, root: number, known: Map<number, string> = new Map(), rootStart?: string): Map<number, string> | undefined {
  const expected = known.get(root) ?? rootStart;
  const lineage = new Map(known);
  if (expected !== undefined) lineage.set(root, expected);
  const owned = new Map<number, string>();
  const current = snapshot.get(root);
  if (current && expected !== undefined && current.start !== expected) return undefined;
  if (!current && expected === undefined) return undefined;
  if (current) { owned.set(root, current.start); lineage.set(root, current.start); }
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of snapshot.values()) {
      if (owned.has(m.pid) || m.pid === m.parent) continue;
      // A live parent must itself be owned; a dead one is trusted from lineage.
      const parentStart = snapshot.has(m.parent) ? owned.get(m.parent) : lineage.get(m.parent);
      if (known.get(m.pid) === m.start || (parentStart !== undefined && notBefore(m.start, parentStart))) { owned.set(m.pid, m.start); changed = true; }
    }
  }
  return owned;
}
const bounded = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key); map.set(key, value);
  for (const oldest of map.keys()) { if (map.size <= 256) break; map.delete(oldest); }
};
export function windowsPlatform(powershell = 'powershell.exe'): ProcessPlatform {
  // Latest root identity per PID: its start, or null when the root exited before
  // it could be recorded (a live process at that PID is then someone else).
  const roots = new Map<number, Promise<string | null | undefined>>();
  // Lineage per root identity (pid:start), replaced by every snapshot: a dead
  // member is trusted as a parent only in the first snapshot that misses it, so
  // an entry never outlives its PID into a later reuse.
  const lineages = new Map<string, Map<number, string>>();
  const ps = (script: string) => run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 30_000);
  const snapshot = async () => { const output = await ps(WIN_SNAPSHOT); return output === undefined ? undefined : parseWindowsSnapshot(output); };
  const tree = async (group: number, rootStart?: string) => {
    const recorded = await roots.get(group);
    const processes = await snapshot();
    if (!processes || (rootStart === undefined && recorded === null)) return undefined;
    // An unrecorded root is adopted only while it is alive; a dead one proves nothing.
    const start = rootStart ?? recorded ?? processes.get(group)?.start;
    if (start === undefined) return undefined;
    const owned = windowsTree(processes, group, lineages.get(`${group}:${start}`), start);
    if (!owned) return undefined;
    bounded(lineages, `${group}:${start}`, owned);
    if (recorded === undefined) bounded(roots, group, Promise.resolve(start));
    return owned;
  };
  return {
    // Each poll is a PowerShell WMI snapshot (0.4-4s), so poll far less often than POSIX.
    detachWorkers: false, termGraceMs: 2000, pollMs: 500, killSettleMs: 500,
    async groupMembers(group, rootStart) { const owned = await tree(group, rootStart); return owned && [...owned.keys()]; },
    // Console processes cannot be asked to exit politely, so both signals terminate
    // every creation-time-verified member individually. Never taskkill /T: it
    // follows bare parent PIDs, which Windows keeps after the parent dies.
    async signalGroup(group) {
      const owned = await tree(group);
      if (!owned) return false;
      for (const pid of owned.keys()) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (!gone(error)) return false; } }
      return true;
    },
    async fingerprint(pid) {
      const [processes, boot] = await Promise.all([snapshot(), ps(WIN_BOOT)]);
      const record = processes?.get(pid);
      if (!record || !boot?.trim()) return undefined;
      return { bootId: boot.trim(), startTicks: record.start };
    },
    snapshot,
    tree(processes, root, known) {
      const owned = windowsTree(processes, root, known);
      // The activity sampler's fresher view also serves a later stop of an
      // adopted root, without another snapshot.
      const key = `${root}:${owned?.get(root)}`;
      if (owned && lineages.has(key)) bounded(lineages, key, owned);
      return owned;
    },
    adopt(pid, alive) {
      bounded(roots, pid, snapshot().then(processes => {
        if (!processes) return undefined;
        const start = processes.get(pid)?.start;
        if (start === undefined || !alive()) return null;
        // A new root at a reused PID starts a fresh lineage.
        bounded(lineages, `${pid}:${start}`, new Map([[pid, start]]));
        return start;
      }));
    },
  };
}

let selected: ProcessPlatform | null | undefined;
/** The supervisor for this host, or undefined where orchestration cannot prove process lifetime. */
export function processPlatform(): ProcessPlatform | undefined {
  if (selected === undefined) selected = process.platform === 'linux' ? linuxPlatform : process.platform === 'darwin' ? darwinPlatform : process.platform === 'win32' ? windowsPlatform() : null;
  return selected ?? undefined;
}
/** Windows caps a whole command line at 32767 characters. An OS property, not a
 * supervisor one, so it holds even where no supervisor is selected. */
export function commandLineLimited(): boolean { return process.platform === 'win32'; }
/** Test hook: substitute a platform (e.g. a mocked Windows supervisor on Linux CI). */
export function setProcessPlatform(platform: ProcessPlatform | null | undefined): void { selected = platform; }
