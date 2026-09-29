import { processPlatform, type Fingerprint } from './process-platform';

const valid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;
/** Hosts where orchestration can prove a worker's processes stopped. */
export function processSupervisorSupported(): boolean { return Boolean(processPlatform()); }
/** `detached` for a supervised worker spawn: POSIX workers lead their own
 * process group; Windows workers stay attached and are supervised as a tree. */
export function workerSpawnDetached(): boolean { return processPlatform()?.detachWorkers ?? false; }
/** Windows caps a whole command line at 32767 characters, so a supervised
 * spawn must pass its long appended system prompt through a file. */
export function commandLineLimited(): boolean { return processPlatform()?.name === 'win32'; }

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
