import { execFile } from 'child_process';
import * as path from 'path';

/**
 * Reclaim channel receiver processes left behind by a previous gateway.
 *
 * The gateway spawns one `bun .../mcp/tools/<channel>/receiver-server.ts` child
 * per channel per agent. Those children only die if the gateway runs its
 * shutdown path. Any exit that bypasses it — SIGKILL, the OOM killer, or (until
 * issue #405) a SIGHUP — reparents them to init, where they keep polling with no
 * supervisor to hand messages to and survive every subsequent restart.
 *
 * Handling more signals cannot fix SIGKILL or OOM, so a boot-time sweep is the
 * only mechanism that can recover from those. See issue #405.
 */

export interface OrphanedReceiver {
  pid: number;
  /** Full argv of the orphan, for logging. */
  command: string;
}

/** Injectable so tests can drive the sweep without real processes. */
export interface SweepDeps {
  listProcesses?: () => Promise<string>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: (ms: number) => Promise<void>;
}

export interface SweepResult {
  reclaimed: OrphanedReceiver[];
  /** Orphans that ignored SIGTERM and had to be SIGKILLed. */
  forced: number[];
}

/** Grace period between SIGTERM and SIGKILL for an orphan. */
export const ORPHAN_SIGKILL_GRACE_MS = 2_000;

const defaultListProcesses = (): Promise<string> =>
  new Promise((resolve, reject) => {
    // `pid=,ppid=,args=` suppresses the header, so every line is a record.
    // `-ww` disables width truncation: a clipped argv would silently stop
    // matching the tools-directory prefix and reclaim nothing.
    execFile('ps', ['-ww', '-eo', 'pid=,ppid=,args='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

const defaultKill = (pid: number, signal: NodeJS.Signals): void => {
  process.kill(pid, signal);
};

const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Find receiver processes spawned from `receiverToolsDir` that have been
 * reparented to init.
 *
 * Both conditions are load-bearing:
 *
 * - `ppid === 1` proves the supervising gateway is *gone*. A receiver owned by a
 *   live gateway always has that gateway's pid as its parent, including when the
 *   gateway itself is a systemd service whose own ppid is 1. So this never
 *   matches a receiver another running gateway still owns.
 * - The tools-directory prefix keeps a gateway from killing receivers belonging
 *   to a different checkout on the same host. `receiverToolsDir` is the very
 *   `<install>/mcp/tools` the receivers are spawned from, and matching includes
 *   the trailing separator, so `/opt/gw/mcp/tools` cannot match a receiver under
 *   `/opt/gw-research/mcp/tools`.
 */
export function findOrphanedReceivers(psOutput: string, receiverToolsDir: string): OrphanedReceiver[] {
  const needle = path.resolve(receiverToolsDir) + path.sep;
  const found: OrphanedReceiver[] = [];

  for (const line of psOutput.split('\n')) {
    // `pid ppid args...` — args may contain spaces, so split off only the first two.
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;

    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3].trim();

    if (ppid !== 1) continue;
    if (pid === process.pid) continue;
    if (!command.includes(needle)) continue;
    if (!command.includes('receiver-server.ts')) continue;

    found.push({ pid, command });
  }

  return found;
}

/**
 * Terminate every orphaned receiver spawned from `receiverToolsDir`.
 *
 * Escalates SIGTERM → SIGKILL so a receiver wedged in an in-flight long-poll
 * cannot survive the sweep.
 *
 * Rejects if the process list cannot be read at all — the caller must decide
 * whether that is fatal (it is not: boot continues, loudly). Once the sweep is
 * under way it stops throwing, so a partial failure degrades to "fewer orphans
 * reclaimed this boot" rather than a failed startup.
 *
 * `reclaimed` lists the orphans that were signalled. In the ordinary path they
 * are gone by the time this resolves; if escalation had to be skipped, a wedged
 * one may still be alive and the next boot will retry it.
 */
export async function sweepOrphanedReceivers(
  receiverToolsDir: string,
  deps: SweepDeps = {},
): Promise<SweepResult> {
  const listProcesses = deps.listProcesses ?? defaultListProcesses;
  const kill = deps.kill ?? defaultKill;
  const wait = deps.wait ?? defaultWait;

  const orphans = findOrphanedReceivers(await listProcesses(), receiverToolsDir);
  if (orphans.length === 0) return { reclaimed: [], forced: [] };

  for (const orphan of orphans) {
    // ESRCH: it exited between the listing and now — already reclaimed.
    try {
      kill(orphan.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  await wait(ORPHAN_SIGKILL_GRACE_MS);

  // Re-list before escalating. A pid freed by SIGTERM can be recycled by an
  // unrelated process within the grace period, and SIGKILLing that would be a
  // far worse bug than the one being fixed — so only pids that are STILL a
  // matching orphan are escalated, not merely pids that still exist.
  let survivors: Set<number>;
  try {
    survivors = new Set(
      findOrphanedReceivers(await listProcesses(), receiverToolsDir).map((o) => o.pid),
    );
  } catch {
    // The second listing failed even though the first succeeded. Skipping
    // escalation leaves a wedged receiver alive, which the next boot will retry;
    // guessing from stale pids could kill an unrelated process. Prefer the
    // recoverable failure.
    return { reclaimed: orphans, forced: [] };
  }

  const forced: number[] = [];
  for (const orphan of orphans) {
    if (!survivors.has(orphan.pid)) continue; // exited on SIGTERM, as expected
    try {
      kill(orphan.pid, 'SIGKILL');
      forced.push(orphan.pid);
    } catch {
      /* raced us to exit between the listing and now */
    }
  }

  return { reclaimed: orphans, forced };
}
