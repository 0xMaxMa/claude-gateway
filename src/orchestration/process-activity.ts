import { readdir, readFile } from 'fs/promises';

export interface ProcessSample {
  observedAt: number;
  available: boolean;
  processCount?: number;
  cpuTicksDelta?: number;
  childCpuTicksDelta?: number;
  readBytesDelta?: number;
  writeBytesDelta?: number;
  membershipChanged?: boolean;
  ioAvailable?: boolean;
}
interface Member { pid: number; parent: number; group: number; start: string; state: string; cpu: number; read?: number; write?: number; }

/** Read counters only, never argv/env/output. A process identity is PID + start time.
 * Descendants in new process groups are included while still linked to the root.
 * Detached/reparented children outside the original group cannot be proven here. */
export class ProcessActivitySampler {
  private rootStart?: string;
  private previous?: Map<string, Member>;
  constructor(private readonly pid: () => number | undefined, private readonly enabled = true) {}
  async sample(): Promise<ProcessSample> {
    const unavailable: ProcessSample = { observedAt: Date.now(), available: false };
    const pid = this.pid();
    if (!this.enabled || process.platform !== 'linux' || !pid || pid <= 0) return unavailable;
    try {
      const members = new Map<number, Member>();
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
      const root = members.get(pid);
      if (!root || ['Z','X'].includes(root.state) || (this.rootStart && this.rootStart !== root.start)) return unavailable;
      this.rootStart = root.start;
      const owned = new Set([pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const m of members.values()) if (!owned.has(m.pid) && (owned.has(m.parent) || (root.group === pid && m.group === pid))) { owned.add(m.pid); changed = true; }
      }
      const current = new Map<string, Member>();
      for (const id of owned) {
        const m = members.get(id)!;
        if (['Z','X'].includes(m.state)) continue;
        try {
          const io = await readFile(`/proc/${id}/io`, 'utf8');
          // Logical I/O includes pipes/cache, so piped test output is visible.
          m.read = Number(/^rchar:\s+(\d+)/m.exec(io)?.[1]);
          m.write = Number(/^wchar:\s+(\d+)/m.exec(io)?.[1]);
        } catch { /* CPU/membership remain usable without I/O permission. */ }
        try {
          const stat = await readFile(`/proc/${id}/stat`, 'utf8');
          if (stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] !== m.start) continue;
        } catch { continue; }
        current.set(`${id}:${m.start}`, m);
      }
      const result: ProcessSample = { observedAt: Date.now(), available: true, processCount: current.size, ioAvailable: [...current.values()].every(m => Number.isFinite(m.read) && Number.isFinite(m.write)) };
      if (this.previous) {
        result.childCpuTicksDelta = 0; result.cpuTicksDelta = 0; result.readBytesDelta = 0; result.writeBytesDelta = 0;
        result.membershipChanged = current.size !== this.previous.size || [...current.keys()].some(k => !this.previous!.has(k));
        for (const [key, m] of current) {
          const prior = this.previous.get(key);
          result.cpuTicksDelta += Math.max(0, m.cpu - (prior?.cpu ?? 0));
          if (m.pid !== pid) result.childCpuTicksDelta += Math.max(0, m.cpu - (prior?.cpu ?? 0));
          if (Number.isFinite(m.read) && (!prior || Number.isFinite(prior.read))) result.readBytesDelta += Math.max(0, m.read! - (prior?.read ?? 0));
          if (Number.isFinite(m.write) && (!prior || Number.isFinite(prior.write))) result.writeBytesDelta += Math.max(0, m.write! - (prior?.write ?? 0));
        }
      }
      this.previous = current;
      return result;
    } catch { return unavailable; }
  }
}
