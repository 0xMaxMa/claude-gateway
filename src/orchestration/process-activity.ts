import { processPlatform, type ProcessRecord } from './process-platform';

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
type Member = ProcessRecord;

/** Read counters only, never argv/env/output. A process identity is PID + start time.
 * On POSIX, descendants in new process groups are included while still linked to
 * the root; detached/reparented children outside the original group cannot be
 * proven here. A platform with its own `tree` (Windows) decides ownership itself. */
export class ProcessActivitySampler {
  private rootStart?: string;
  private previous?: Map<string, Member>;
  private known = new Map<number, string>();
  constructor(private readonly pid: () => number | undefined, private readonly enabled = true) {}
  async sample(): Promise<ProcessSample> {
    const unavailable: ProcessSample = { observedAt: Date.now(), available: false };
    const pid = this.pid();
    const platform = processPlatform();
    if (!this.enabled || !platform || !pid || pid <= 0) return unavailable;
    try {
      const members = await platform.snapshot();
      if (!members) return unavailable;
      const root = members.get(pid);
      if (!root || ['Z','X'].includes(root.state[0]) || (this.rootStart && this.rootStart !== root.start)) return unavailable;
      this.rootStart = root.start;
      let owned = new Set([pid]);
      if (platform.tree) {
        const tree = platform.tree(members, pid, this.known);
        if (!tree) return unavailable;
        this.known = tree;
        owned = new Set(tree.keys());
      } else {
        let changed = true;
        while (changed) {
          changed = false;
          for (const m of members.values()) if (!owned.has(m.pid) && (owned.has(m.parent) || (root.group === pid && m.group === pid))) { owned.add(m.pid); changed = true; }
        }
      }
      const current = new Map<string, Member>();
      for (const id of owned) {
        const m = members.get(id)!;
        if (['Z','X'].includes(m.state[0])) continue;
        if (platform.refine && !await platform.refine(m)) continue;
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
