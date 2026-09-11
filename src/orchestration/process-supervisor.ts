import { readdirSync, readFileSync } from 'fs';

/** Linux process-group evidence ignores exited zombies. Escaped/detached
 * process groups are outside this proof and must be reconciled separately. */
export function liveGroupMembers(group: number): number[] | undefined {
  if (process.platform !== 'linux' || !Number.isSafeInteger(group) || group <= 0) return undefined;
  const members: number[] = [];
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === group && fields[0] !== 'Z' && fields[0] !== 'X') members.push(Number(entry));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') return undefined; }
    }
    return members;
  } catch { return undefined; }
}
export async function stopProcessGroup(group: number): Promise<boolean> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(group) || group <= 0) return false;
  try { process.kill(-group, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const members = liveGroupMembers(group);
    if (!members) return false;
    if (!members.length) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  try { process.kill(-group, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  await new Promise(resolve => setTimeout(resolve, 50));
  return liveGroupMembers(group)?.length === 0;
}

/** Kernel identity prevents signalling an unrelated process after PID reuse. */
export function processFingerprint(pid: number): { bootId: string; startTicks: string } | undefined {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[2]) !== pid) return undefined;
    return { bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), startTicks: fields[19] };
  } catch { return undefined; }
}
export async function cleanupPersistedProcess(identity?: { pid: number; bootId?: string; startTicks?: string }): Promise<boolean> {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return false;
  const members = liveGroupMembers(identity.pid);
  if (!members) return false;
  if (!members.length) return true;
  const current = processFingerprint(identity.pid);
  if (!current || !identity.bootId || !identity.startTicks || current.bootId !== identity.bootId || current.startTicks !== identity.startTicks) return false;
  return stopProcessGroup(identity.pid);
}
