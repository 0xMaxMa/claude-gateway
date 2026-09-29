import type { ChildProcess } from 'child_process';
import { processPlatform, type Fingerprint } from './process-platform';

const valid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;
/** Hosts where orchestration can prove a worker's processes stopped. */
export function processSupervisorSupported(): boolean { return Boolean(processPlatform()); }
/** `detached` for a worker spawn: POSIX workers lead their own process group
 * (also on hosts without a supervisor); Windows workers stay attached and are
 * supervised as a tree. */
export function workerSpawnDetached(): boolean { return processPlatform()?.detachWorkers ?? process.platform !== 'win32'; }

/** Call right after spawning a supervised worker root. Windows records the
 * root's start identity while the child handle still pins its PID, so a stop
 * can anchor orphans after the root exits and a reused PID is never adopted. */
export function recordProcessRoot(child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>): void {
  const pid = child.pid;
  if (pid === undefined || !valid(pid)) return;
  processPlatform()?.adopt?.(pid, () => child.exitCode === null && child.signalCode === null);
}

/** Process-group evidence ignores exited zombies. On POSIX, escaped/detached
 * process groups are outside this proof and must be reconciled separately; on
 * Windows the group is the tree rooted at `group` (see windowsTree). */
export async function liveGroupMembers(group: number, rootStart?: string): Promise<number[] | undefined> {
  const platform = processPlatform();
  if (!platform || !valid(group)) return undefined;
  return platform.groupMembers(group, rootStart);
}
export async function stopProcessGroup(group: number): Promise<boolean> {
  const platform = processPlatform();
  if (!platform || !valid(group)) return false;
  if (!await platform.signalGroup(group, 'SIGTERM')) return false;
  const deadline = Date.now() + platform.termGraceMs;
  while (Date.now() < deadline) {
    const members = await platform.groupMembers(group);
    if (!members) return false;
    if (!members.length) return true;
    await new Promise(resolve => setTimeout(resolve, platform.pollMs));
  }
  if (!await platform.signalGroup(group, 'SIGKILL')) return false;
  await new Promise(resolve => setTimeout(resolve, platform.killSettleMs));
  return (await platform.groupMembers(group))?.length === 0;
}

/** Kernel identity prevents signalling an unrelated process after PID reuse. */
export async function processFingerprint(pid: number): Promise<Fingerprint | undefined> {
  const platform = processPlatform();
  if (!platform || !valid(pid)) return undefined;
  return platform.fingerprint(pid);
}
export async function cleanupPersistedProcess(identity?: { pid: number; bootId?: string; startTicks?: string }): Promise<boolean> {
  if (!identity || !valid(identity.pid)) return false;
  const members = await liveGroupMembers(identity.pid, identity.startTicks);
  if (!members) return false;
  if (!members.length) return true;
  const current = await processFingerprint(identity.pid);
  if (!current || !identity.bootId || !identity.startTicks || current.bootId !== identity.bootId || current.startTicks !== identity.startTicks) return false;
  return stopProcessGroup(identity.pid);
}

type ProbeChild = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>;
// Windows lineage per probe: true once a snapshot was taken while the child
// handle was held, so the recorded root start really belongs to our child.
const probeLineage = new WeakMap<ProbeChild, Promise<boolean>>();
const probeKilled = new WeakSet<ProbeChild>();

/** Stop a short-lived probe (spawned with `detached: workerSpawnDetached()`)
 * and every process it started. Synchronous callers may ignore the promise.
 *
 * POSIX signals the probe's process group. Windows has no polite console
 * signal, so SIGTERM only records the tree lineage (one WMI snapshot, while
 * the child handle is held so its PID cannot be reused) and leaves the probe
 * its grace period to exit on stdin EOF. SIGKILL then terminates the whole
 * tree once, only the creation-time-verified members; the recorded root start
 * time refuses a reused PID. A probe that exited
 * before any lineage was recorded cannot be proven, so nothing is signalled. */
export async function terminateProbeTree(child: ProbeChild, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const platform = processPlatform();
  const pid = child.pid;
  const running = () => child.exitCode === null && child.signalCode === null;
  const kill = () => { try { child.kill(signal); } catch { /* Already exited. */ } };
  if (!platform || pid === undefined || !valid(pid)) return kill();
  if (platform.detachWorkers) {
    if (!await platform.signalGroup(pid, signal)) kill();
    return;
  }
  let lineage = probeLineage.get(child);
  if (!lineage && running()) {
    lineage = platform.groupMembers(pid).then(members => members !== undefined && running(), () => false);
    probeLineage.set(child, lineage);
  }
  if (signal === 'SIGTERM' || probeKilled.has(child)) return;
  probeKilled.add(child);
  if (lineage && await lineage && await platform.signalGroup(pid, 'SIGKILL')) return;
  if (running()) kill();
}
