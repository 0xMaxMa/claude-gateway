import type { ChildProcess } from 'child_process';
import { processPlatform, type Fingerprint } from './process-platform';

const valid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;
/** Hosts where orchestration can prove a worker's processes stopped. */
export function processSupervisorSupported(): boolean { return Boolean(processPlatform()); }
/** `detached` for a worker spawn: POSIX workers lead their own process group
 * (also on hosts without a supervisor); Windows workers stay attached and are
 * supervised as a tree. */
export function workerSpawnDetached(): boolean { return processPlatform()?.detachWorkers ?? process.platform !== 'win32'; }

type RootChild = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>;
// Start identity recorded for each spawned root (Windows only).
const recordedRoots = new WeakMap<RootChild, Promise<string | undefined>>();

/** Call right after spawning a supervised worker or probe root. Windows records
 * the root's start identity while the child handle still pins its PID, so a stop
 * can anchor orphans after the root exits and a reused PID is never adopted. */
export function recordProcessRoot(child: RootChild): void {
  const pid = child.pid;
  if (pid === undefined || !valid(pid)) return;
  const recorded = processPlatform()?.adopt?.(pid, () => child.exitCode === null && child.signalCode === null);
  if (recorded) recordedRoots.set(child, recorded);
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
  // Nothing survives a reboot: a process from another boot is gone, whatever
  // now holds its PID.
  const boot = identity.bootId ? await processPlatform()?.bootId() : undefined;
  if (boot && boot !== identity.bootId) return true;
  const members = await liveGroupMembers(identity.pid, identity.startTicks);
  if (!members) return false;
  if (!members.length) return true;
  const current = await processFingerprint(identity.pid);
  if (!current || !identity.bootId || !identity.startTicks || current.bootId !== identity.bootId || current.startTicks !== identity.startTicks) return false;
  return stopProcessGroup(identity.pid);
}

type ProbeChild = RootChild & Pick<ChildProcess, 'kill'>;
const probeKilled = new WeakSet<ProbeChild>();

/** Stop a short-lived probe (spawned with `detached: workerSpawnDetached()` and
 * passed to `recordProcessRoot`) and every process it started. Synchronous
 * callers may ignore the promise.
 *
 * POSIX signals the probe's process group. Windows has no polite console
 * signal, so SIGTERM only leaves the probe its grace period to exit on stdin
 * EOF; SIGKILL then terminates the whole tree once, only the creation-time-
 * verified members of the root identity recorded at spawn, so a reused PID is
 * refused. A probe whose identity could not be recorded (it exited first) is
 * not signalled beyond its own handle. */
export async function terminateProbeTree(child: ProbeChild, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const platform = processPlatform();
  const pid = child.pid;
  const kill = () => { try { child.kill(signal); } catch { /* Already exited. */ } };
  if (!platform || pid === undefined || !valid(pid)) return kill();
  if (platform.detachWorkers) {
    if (!await platform.signalGroup(pid, signal)) kill();
    return;
  }
  if (signal === 'SIGTERM' || probeKilled.has(child)) return;
  probeKilled.add(child);
  const start = await recordedRoots.get(child);
  if (start !== undefined && await platform.signalGroup(pid, 'SIGKILL', start)) return;
  if (child.exitCode === null && child.signalCode === null) kill();
}
