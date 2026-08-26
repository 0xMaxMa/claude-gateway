import * as path from 'path';
import {
  findOrphanedReceivers,
  sweepOrphanedReceivers,
  ORPHAN_SIGKILL_GRACE_MS,
} from '../../src/utils/orphan-receivers';

// Realistic `ps -eo pid=,ppid=,args=` output. Column widths are right-aligned
// and variable, exactly as ps emits them.
const TOOLS = '/srv/gateway-a/mcp/tools';

function psLine(pid: number, ppid: number, args: string): string {
  return `${String(pid).padStart(7)} ${String(ppid).padStart(7)} ${args}`;
}

describe('orphaned receiver sweep (issue #405)', () => {
  // ── U-OR-405a: the core discriminator ──────────────────────────────────────
  it('U-OR-405a: matches receivers reparented to init and skips supervised ones', () => {
    const ps = [
      psLine(3383468, 1, `bun ${TOOLS}/telegram/receiver-server.ts`),
      psLine(3383599, 1, `bun ${TOOLS}/discord/receiver-server.ts`),
      // Still owned by a live gateway — must never be touched.
      psLine(4054791, 4054790, `bun ${TOOLS}/telegram/receiver-server.ts`),
      psLine(4054790, 1, 'node /srv/gateway-a/dist/index.js'),
    ].join('\n');

    const found = findOrphanedReceivers(ps, TOOLS);

    expect(found.map((o) => o.pid).sort()).toEqual([3383468, 3383599]);
  });

  // ── U-OR-405b: cross-installation safety ───────────────────────────────────
  it('U-OR-405b: never reclaims a receiver from a different installation', () => {
    const other = '/srv/gateway-b/mcp/tools';
    const ps = [
      psLine(2975492, 1, `bun ${other}/telegram/receiver-server.ts`),
      psLine(3383468, 1, `bun ${TOOLS}/telegram/receiver-server.ts`),
    ].join('\n');

    expect(findOrphanedReceivers(ps, TOOLS).map((o) => o.pid)).toEqual([3383468]);
    expect(findOrphanedReceivers(ps, other).map((o) => o.pid)).toEqual([2975492]);
  });

  // ── U-OR-405c: prefix collision ────────────────────────────────────────────
  it('U-OR-405c: a sibling install sharing a path prefix is not a match', () => {
    // `/opt/gw` must not swallow `/opt/gw-research` — the trailing separator is
    // what makes the prefix test exact rather than merely "starts with".
    const ps = psLine(4242, 1, 'bun /opt/gw-research/mcp/tools/telegram/receiver-server.ts');

    expect(findOrphanedReceivers(ps, '/opt/gw/mcp/tools')).toEqual([]);
    expect(findOrphanedReceivers(ps, '/opt/gw-research/mcp/tools').map((o) => o.pid)).toEqual([4242]);
  });

  // ── U-OR-405d: unrelated processes ─────────────────────────────────────────
  it('U-OR-405d: ignores non-receiver processes under the same tools directory', () => {
    const ps = [
      psLine(5001, 1, `bun ${TOOLS}/telegram/send.ts`),
      psLine(5002, 1, 'node /usr/lib/node_modules/npm/bin/npm-cli.js'),
      psLine(5003, 1, `grep -r receiver-server.ts ${TOOLS}/`),
      psLine(5005, 1, `bun test ${TOOLS}/telegram/receiver-server.ts`),
      psLine(5006, 1, `vim ${TOOLS}/telegram/receiver-server.ts`),
      psLine(5007, 1, `bun ${TOOLS}/telegram/deep/receiver-server.ts`),
      psLine(5004, 1, `bun ${TOOLS}/telegram/receiver-server.ts`),
    ].join('\n');

    expect(findOrphanedReceivers(ps, TOOLS).map((o) => o.pid)).toEqual([5004]);
  });

  it('U-OR-405e: tolerates blank lines and malformed rows without throwing', () => {
    const ps = ['', '   ', 'garbage without numbers', psLine(6001, 1, `bun ${TOOLS}/discord/receiver-server.ts`)].join('\n');

    expect(findOrphanedReceivers(ps, TOOLS).map((o) => o.pid)).toEqual([6001]);
  });

  it('U-OR-405f: accepts a non-normalised tools directory', () => {
    const ps = psLine(6100, 1, `bun ${TOOLS}/telegram/receiver-server.ts`);
    const messy = path.join(TOOLS, '..', 'tools');

    expect(findOrphanedReceivers(ps, messy).map((o) => o.pid)).toEqual([6100]);
  });

  // ── U-OR-405g: SIGTERM then SIGKILL escalation ─────────────────────────────
  it('U-OR-405g: escalates to SIGKILL only for orphans that survive SIGTERM', async () => {
    const ps = [
      psLine(7001, 1, `bun ${TOOLS}/telegram/receiver-server.ts`),
      psLine(7002, 1, `bun ${TOOLS}/discord/receiver-server.ts`),
    ].join('\n');

    // 7001 dies on SIGTERM; 7002 is wedged and only SIGKILL reaches it.
    const alive = new Set([7001, 7002]);
    const signals: Array<[number, string]> = [];
    const waited: number[] = [];
    const lines: Record<number, string> = {
      7001: psLine(7001, 1, `bun ${TOOLS}/telegram/receiver-server.ts`),
      7002: psLine(7002, 1, `bun ${TOOLS}/discord/receiver-server.ts`),
    };

    const result = await sweepOrphanedReceivers(TOOLS, {
      // Each listing reflects who is actually still alive at that moment.
      listProcesses: async () => [...alive].map((pid) => lines[pid]).join('\n'),
      kill: (pid, signal) => {
        if (!alive.has(pid)) {
          const err = new Error('ESRCH') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        signals.push([pid, signal]);
        if (signal === 'SIGTERM' && pid === 7001) alive.delete(pid);
        if (signal === 'SIGKILL') alive.delete(pid);
      },
      wait: async (ms) => { waited.push(ms); },
    });

    expect(signals).toEqual([
      [7001, 'SIGTERM'],
      [7002, 'SIGTERM'],
      [7002, 'SIGKILL'],
    ]);
    expect(waited).toEqual([ORPHAN_SIGKILL_GRACE_MS]);
    expect(result.reclaimed.map((o) => o.pid)).toEqual([7001, 7002]);
    expect(result.forced).toEqual([7002]);
    expect(alive.size).toBe(0);
  });

  it('U-OR-405h: does nothing — not even waiting — when there are no orphans', async () => {
    const kill = jest.fn();
    const wait = jest.fn(async () => {});

    const result = await sweepOrphanedReceivers(TOOLS, {
      listProcesses: async () => psLine(4054791, 4054790, `bun ${TOOLS}/telegram/receiver-server.ts`),
      kill,
      wait,
    });

    expect(result).toEqual({ reclaimed: [], forced: [], failed: [] });
    expect(kill).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it('U-OR-405i: a pid that exits between listing and SIGTERM is not reported as forced', async () => {
    const result = await sweepOrphanedReceivers(TOOLS, {
      listProcesses: async () => psLine(8001, 1, `bun ${TOOLS}/telegram/receiver-server.ts`),
      kill: () => {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      },
      wait: async () => {},
    });

    expect(result.reclaimed.map((o) => o.pid)).toEqual([8001]);
    expect(result.forced).toEqual([]);
  });

  it('U-OR-405j: propagates a process-listing failure so the caller can log it', async () => {
    await expect(
      sweepOrphanedReceivers(TOOLS, {
        listProcesses: async () => { throw new Error('ps: command not found'); },
        kill: () => { throw new Error('must not be called'); },
        wait: async () => {},
      }),
    ).rejects.toThrow('ps: command not found');
  });

  // ── U-OR-405k: pid reuse must not turn the sweep into a random killer ──────
  it('U-OR-405k: never SIGKILLs a pid that is no longer a matching orphan', async () => {
    const orphanLine = psLine(9001, 1, `bun ${TOOLS}/telegram/receiver-server.ts`);
    // After SIGTERM the pid is freed and immediately recycled by something else.
    const recycledLine = psLine(9001, 1234, '/usr/bin/postgres -D /var/lib/postgresql');

    let listing = 0;
    const signals: Array<[number, string]> = [];

    const result = await sweepOrphanedReceivers(TOOLS, {
      listProcesses: async () => (listing++ === 0 ? orphanLine : recycledLine),
      kill: (pid, signal) => { signals.push([pid, signal]); },
      wait: async () => {},
    });

    expect(signals).toEqual([[9001, 'SIGTERM']]);
    expect(result.forced).toEqual([]);
  });

  it('U-OR-405l: skips escalation rather than guessing when the re-listing fails', async () => {
    let listing = 0;
    const signals: Array<[number, string]> = [];

    const result = await sweepOrphanedReceivers(TOOLS, {
      listProcesses: async () => {
        if (listing++ === 0) return psLine(9100, 1, `bun ${TOOLS}/discord/receiver-server.ts`);
        throw new Error('ps disappeared mid-sweep');
      },
      kill: (pid, signal) => { signals.push([pid, signal]); },
      wait: async () => {},
    });

    expect(signals).toEqual([[9100, 'SIGTERM']]);
    expect(result.forced).toEqual([]);
    // Not reclaimed: escalation never happened, so it may still be alive. The
    // boot log must not claim a win it cannot back up.
    expect(result.reclaimed).toEqual([]);
    expect(result.failed).toEqual([
      { pid: 9100, reason: 'escalation skipped: ps disappeared mid-sweep' },
    ]);
  });

  // ── U-OR-405m: EPERM must never be counted as a win ────────────────────────
  it('U-OR-405m: reports an orphan owned by another user as failed, not reclaimed', async () => {
    const eperm = () => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };

    const result = await sweepOrphanedReceivers(TOOLS, {
      listProcesses: async () => psLine(9200, 1, `bun ${TOOLS}/telegram/receiver-server.ts`),
      kill: eperm,
      wait: async () => {},
    });

    // Pre-fix this returned reclaimed:[9200] and the boot log announced it as
    // reclaimed while the process was still alive and still polling its token.
    expect(result.reclaimed).toEqual([]);
    expect(result.forced).toEqual([]);
    expect(result.failed).toEqual([{ pid: 9200, reason: 'EPERM (owned by another user)' }]);
  });

  it('U-OR-405n: an EPERM orphan is not escalated to SIGKILL either', async () => {
    const line = psLine(9300, 1, `bun ${TOOLS}/discord/receiver-server.ts`);
    const signals: Array<[number, string]> = [];

    const result = await sweepOrphanedReceivers(TOOLS, {
      listProcesses: async () => line, // still there on the re-list
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      },
      wait: async () => {},
    });

    expect(signals).toEqual([[9300, 'SIGTERM']]); // no pointless SIGKILL
    expect(result.failed.map((f) => f.pid)).toEqual([9300]);
  });

  // ── U-OR-405o: argv shape, not substring ──────────────────────────────────
  it('U-OR-405o: only matches the exact `bun <toolsDir>/<channel>/receiver-server.ts` shape', () => {
    const cases: Array<[string, boolean]> = [
      [`bun ${TOOLS}/telegram/receiver-server.ts`, true],
      [`/home/u/.bun/bin/bun ${TOOLS}/discord/receiver-server.ts`, true],
      [`bun test ${TOOLS}/telegram/receiver-server.ts`, false],
      [`node ${TOOLS}/telegram/receiver-server.ts`, false],
      [`grep -r receiver-server.ts ${TOOLS}/`, false],
      [`bun ${TOOLS}/receiver-server.ts`, false],
      [`bun ${TOOLS}/telegram/nested/receiver-server.ts`, false],
      [`bun ${TOOLS}/telegram/receiver-server.ts.bak`, false],
      ['bun', false],
    ];

    for (const [command, shouldMatch] of cases) {
      const found = findOrphanedReceivers(psLine(1, 1, command), TOOLS);
      expect([command, found.length > 0]).toEqual([command, shouldMatch]);
    }
  });
});
