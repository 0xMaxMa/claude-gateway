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
  /** Orphans that are gone as a result of this sweep. */
  reclaimed: OrphanedReceiver[];
  /** Orphans that ignored SIGTERM and had to be SIGKILLed. */
  forced: number[];
  /**
   * Orphans that could NOT be terminated — most realistically EPERM, when a
   * previous gateway ran under a different account or under sudo. Reported
   * separately so the boot log never claims to have reclaimed a process that is
   * still alive and still polling its bot token.
   */
  failed: Array<{ pid: number; reason: string }>;
}

/**
 * Grace period between SIGTERM and SIGKILL for an orphan.
 *
 * Must stay comfortably above the receivers' own exit deadline — both
 * `mcp/tools/discord/receiver-server.ts` and `mcp/tools/telegram/receiver-server.ts`
 * force-exit on a 2000ms timer after SIGTERM, and Discord's is unconditional. A
 * 2000ms grace would be a dead heat, so healthy receivers would routinely be
 * SIGKILLed and counted as wedged, making the "needed SIGKILL" figure useless as
 * a signal.
 */
export const ORPHAN_SIGKILL_GRACE_MS = 5_000;

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

/** ESRCH means the process is already gone — the one "failure" that is a success. */
function isAlreadyGone(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
}

function describeKillError(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  if (e?.code === 'EPERM') return 'EPERM (owned by another user)';
  return e?.code ?? (e instanceof Error ? e.message : String(err));
}

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
 *
 *   Caveat: on a host where an ancestor has called `prctl(PR_SET_CHILD_SUBREAPER)`
 *   — `systemd --user` for user services, `docker run --init` / tini, s6 —
 *   orphans reparent to that subreaper rather than to pid 1, and this sweep finds
 *   nothing. The gateway still shuts down cleanly there (gap 1 covers the signal
 *   paths); what is lost is the SIGKILL/OOM recovery, and such a host has a
 *   supervisor that generally reaps the process group itself.
 *
 * - The argv must *execute* the receiver from this installation's own tools
 *   directory. Matching is on argv tokens in the exact shape the receivers are
 *   spawned with (`bun <toolsDir>/<channel>/receiver-server.ts`) rather than a
 *   substring test, so a detached `grep -r receiver-server.ts <toolsDir>/`, an
 *   editor, or a `bun test` over the same file is not mistaken for a receiver and
 *   killed. `tests/unit/receiver-stop-teardown.test.ts` pins this shape against
 *   the receivers' real spawn arguments.
 */
export function findOrphanedReceivers(psOutput: string, receiverToolsDir: string): OrphanedReceiver[] {
  const toolsDir = path.resolve(receiverToolsDir);
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
    if (!isReceiverInvocation(command, toolsDir)) continue;

    found.push({ pid, command });
  }

  return found;
}

/**
 * True when `command` is the gateway spawning a receiver of its own — i.e.
 * `bun <toolsDir>/<channel>/receiver-server.ts`, the script as the runtime's
 * first argument, with exactly one directory level for the channel.
 */
function isReceiverInvocation(command: string, toolsDir: string): boolean {
  const tokens = command.split(/\s+/);
  if (tokens.length < 2) return false;
  if (path.basename(tokens[0]) !== 'bun') return false;

  const script = tokens[1];
  const relative = path.relative(toolsDir, script);
  // Outside the tools directory (`..`) or on another root (absolute) — not ours.
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;

  const segments = relative.split(path.sep);
  return segments.length === 2 && segments[1] === 'receiver-server.ts';
}

/**
 * Terminate every orphaned receiver spawned from `receiverToolsDir`.
 *
 * Escalates SIGTERM → SIGKILL so a receiver wedged in an in-flight long-poll
 * cannot survive the sweep.
 *
 * Rejects if the process list cannot be read at all — the caller must decide
 * whether that is fatal (it is not: boot continues, loudly). Once the sweep is
 * under way it stops throwing, and anything it could not terminate is reported
 * in `failed` rather than silently counted as reclaimed.
 */
export async function sweepOrphanedReceivers(
  receiverToolsDir: string,
  deps: SweepDeps = {},
): Promise<SweepResult> {
  const listProcesses = deps.listProcesses ?? defaultListProcesses;
  const kill = deps.kill ?? defaultKill;
  const wait = deps.wait ?? defaultWait;

  const orphans = findOrphanedReceivers(await listProcesses(), receiverToolsDir);
  if (orphans.length === 0) return { reclaimed: [], forced: [], failed: [] };

  const failed = new Map<number, string>();

  for (const orphan of orphans) {
    try {
      kill(orphan.pid, 'SIGTERM');
    } catch (err) {
      // ESRCH: it exited between the listing and now — already reclaimed.
      // Anything else (EPERM in practice) means we cannot touch it at all.
      if (!isAlreadyGone(err)) failed.set(orphan.pid, describeKillError(err));
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
  } catch (err) {
    // The second listing failed even though the first succeeded. Skipping
    // escalation leaves a wedged receiver alive, which the next boot will retry;
    // guessing from stale pids could kill an unrelated process. Prefer the
    // recoverable failure — but report the survivors as unreclaimed, not as won.
    const reason = `escalation skipped: ${(err as Error).message}`;
    for (const orphan of orphans) {
      if (!failed.has(orphan.pid)) failed.set(orphan.pid, reason);
    }
    return finish(orphans, [], failed);
  }

  const forced: number[] = [];
  for (const orphan of orphans) {
    if (failed.has(orphan.pid)) continue; // could not be signalled at all
    if (!survivors.has(orphan.pid)) continue; // exited on SIGTERM, as expected
    try {
      kill(orphan.pid, 'SIGKILL');
      forced.push(orphan.pid);
    } catch (err) {
      if (!isAlreadyGone(err)) failed.set(orphan.pid, describeKillError(err));
    }
  }

  return finish(orphans, forced, failed);
}

function finish(
  orphans: OrphanedReceiver[],
  forced: number[],
  failed: Map<number, string>,
): SweepResult {
  return {
    reclaimed: orphans.filter((o) => !failed.has(o.pid)),
    forced,
    failed: [...failed].map(([pid, reason]) => ({ pid, reason })),
  };
}
