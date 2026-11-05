import { resolveRealDir } from '../files/fs';
import { FilesErrorCode, RelPath } from '../files/paths';
import { pathWithin } from '../utils/paths';
import { err, ok, Result } from '../utils/result';
import { collectListeners, listenersIn, OwnedListener, readStartTicks } from './listeners';

export interface PortPids {
  port: number;
  pids: number[];
}

export interface Stopped {
  path: RelPath;
  stopped: PortPids[];
  remaining: PortPids[];
  running: boolean;
}

/** One process to stop, as it was when its listener was found. */
export interface StopTarget {
  pid: number;
  startTicks: string;
}

export interface StopOptions {
  /** How long the processes have after SIGTERM before SIGKILL. */
  termWaitMs: number;
  pollMs?: number;
}

export const STOP_TERM_WAIT_MS = 5000;
const KILL_WAIT_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Signal `pid` only while it is still the process whose start time was recorded, so a reused pid is never hit. */
export async function signalIfSame(target: StopTarget, signal: NodeJS.Signals): Promise<boolean> {
  if ((await readStartTicks(target.pid)) !== target.startTicks) return false;
  try {
    process.kill(target.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** The listeners of `realDir` that one of `targets`, unchanged, still holds. */
function heldBy(all: OwnedListener[], targets: StopTarget[]): OwnedListener[] {
  return all.filter((l) => l.owners.some((o) => targets.some((t) => t.pid === o.pid && t.startTicks === o.startTicks)));
}

function byPort(listeners: OwnedListener[], targets: StopTarget[]): PortPids[] {
  const map = new Map<number, Set<number>>();
  for (const l of listeners) {
    const pids = map.get(l.port) ?? new Set<number>();
    for (const o of l.owners) if (targets.some((t) => t.pid === o.pid)) pids.add(o.pid);
    map.set(l.port, pids);
  }
  return [...map].sort((a, b) => a[0] - b[0]).map(([port, pids]) => ({ port, pids: [...pids].sort((a, b) => a - b) }));
}

/** SIGTERM `targets`, wait for their listeners to close, then SIGKILL those still listening. Each signal re-checks the start time. */
export async function stopTargets(targets: StopTarget[], opts: StopOptions): Promise<{ before: OwnedListener[]; after: OwnedListener[] }> {
  const before = heldBy(await collectListeners(), targets);
  for (const t of targets) await signalIfSame(t, 'SIGTERM');
  const poll = opts.pollMs ?? 100;
  const waitClosed = async (ms: number) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const held = heldBy(await collectListeners(), targets);
      if (held.length === 0 || Date.now() >= deadline) return held;
      await sleep(poll);
    }
  };
  let after = await waitClosed(opts.termWaitMs);
  if (after.length > 0) {
    const stubborn = targets.filter((t) => after.some((l) => l.owners.some((o) => o.pid === t.pid)));
    for (const t of stubborn) await signalIfSame(t, 'SIGKILL');
    after = await waitClosed(KILL_WAIT_MS);
  }
  return { before, after };
}

/**
 * Stop the servers of the folder `rel` names: every process that listens and works in the folder or inside it. A
 * process working elsewhere is never signalled.
 */
export async function stopFolder(root: string, rel: RelPath, opts: StopOptions): Promise<Result<Stopped, FilesErrorCode>> {
  const dir = await resolveRealDir(root, rel);
  if (!dir.ok) return err(dir.error);
  const all = await collectListeners();
  const mine = new Set(listenersIn(all, dir.value).flatMap((l) => l.pids));
  const targets: StopTarget[] = [];
  for (const l of all) {
    for (const o of l.owners) {
      if (!mine.has(o.pid) || o.startTicks === undefined || targets.some((t) => t.pid === o.pid)) continue;
      // listenersIn keeps a socket when any owner works here; an owner working elsewhere is not ours to stop.
      if (o.cwd === undefined || !pathWithin(dir.value, o.cwd)) continue;
      targets.push({ pid: o.pid, startTicks: o.startTicks });
    }
  }
  if (targets.length === 0) return ok({ path: rel, stopped: [], remaining: [], running: listenersIn(all, dir.value).length > 0 });
  const { before, after } = await stopTargets(targets, opts);
  const remaining = byPort(after, targets);
  const stopped = byPort(before, targets).filter((p) => !remaining.some((r) => r.port === p.port));
  const running = listenersIn(await collectListeners(), dir.value).length > 0;
  return ok({ path: rel, stopped, remaining, running });
}
