import { execFile } from 'child_process';
import { darwinPlatform, linuxPlatform, parseDarwinPs, parsePsCpuTicks, parseWindowsSnapshot, processPlatform, setProcessPlatform, windowsPlatform, windowsTree, type ProcessPlatform } from '../../../src/orchestration/process-platform';
import { cleanupPersistedProcess, processSupervisorSupported, stopProcessGroup, workerSpawnDetached } from '../../../src/orchestration/process-supervisor';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));
const execFileMock = execFile as unknown as jest.Mock;
/** Answer each execFile by command line; unknown commands fail like a missing binary. */
function answer(table: (file: string, args: string[]) => string | undefined) {
  execFileMock.mockImplementation((file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    const stdout = table(file, args);
    setImmediate(() => stdout === undefined ? callback(Object.assign(new Error('exit 1'), { code: 1 }), '') : callback(null, stdout));
  });
}
afterEach(() => { execFileMock.mockReset(); setProcessPlatform(undefined); jest.restoreAllMocks(); });

describe('platform selection', () => {
  test('each supported OS gets its own backend; others have none', () => {
    const original = process.platform;
    try {
      for (const [os, name] of [['linux', 'linux'], ['darwin', 'darwin'], ['win32', 'win32'], ['freebsd', undefined]] as const) {
        Object.defineProperty(process, 'platform', { value: os });
        setProcessPlatform(undefined);
        expect(processPlatform()?.name).toBe(name);
        expect(processSupervisorSupported()).toBe(Boolean(name));
      }
    } finally { Object.defineProperty(process, 'platform', { value: original }); }
  });
  test('POSIX workers lead a process group; Windows workers stay attached to the hidden console', () => {
    for (const [platform, detached] of [[linuxPlatform, true], [darwinPlatform, true], [windowsPlatform(), false]] as const) {
      setProcessPlatform(platform);
      expect(workerSpawnDetached()).toBe(detached);
    }
    setProcessPlatform(null);
    expect(workerSpawnDetached()).toBe(false);
  });
});

describe('darwin (ps + sysctl)', () => {
  const PS = [
    '  100     1   100 Ss      0:00.50 Mon Sep 28 10:00:00 2026',
    '  101   100   100 S       1:02.25 Mon Sep 28 10:00:01 2026',
    '  102   101   100 Z       0:00.00 Mon Sep 28 10:00:02 2026',
    '  200     1   200 S       0:00.01 Mon Sep 28 09:00:00 2026',
  ].join('\n');
  test('BSD cpu time parses to 10ms ticks', () => {
    expect(parsePsCpuTicks('0:00.12')).toBe(12);
    expect(parsePsCpuTicks('1:02.25')).toBe(6225);
    expect(parsePsCpuTicks('1:00:00.00')).toBe(360000);
    expect(parsePsCpuTicks('2-00:00:01.00')).toBe(2 * 8640000 + 100);
    expect(parsePsCpuTicks('garbage')).toBe(0);
  });
  test('ps rows keep lstart as the start identity', () => {
    expect(parseDarwinPs(PS).get(101)).toEqual({ pid: 101, parent: 100, group: 100, state: 'S', start: 'Mon Sep 28 10:00:01 2026', cpu: 6225 });
  });
  test('group membership excludes zombies and other groups; ps failure is unprovable', async () => {
    answer((file, args) => file === 'ps' && args.join(' ') === '-A -o pid=,pgid=,stat=' ? '100 100 Ss\n101 100 S\n102 100 Z\n200 200 S\n' : undefined);
    expect(await darwinPlatform.groupMembers(100)).toEqual([100, 101]);
    answer(() => undefined);
    expect(await darwinPlatform.groupMembers(100)).toBeUndefined();
  });
  test('fingerprint needs a live group leader and a boot session', async () => {
    answer((file, args) => file === 'sysctl' ? 'BOOT-UUID\n' : file === 'ps' && args[0] === '-p' ? PS.split('\n').find(line => line.trim().startsWith(args[1] + ' ')) : undefined);
    expect(await darwinPlatform.fingerprint(100)).toEqual({ bootId: 'BOOT-UUID', startTicks: 'Mon Sep 28 10:00:00 2026' });
    expect(await darwinPlatform.fingerprint(101)).toBeUndefined(); // not a group leader
    expect(await darwinPlatform.fingerprint(102)).toBeUndefined(); // zombie (and not a leader)
    expect(await darwinPlatform.fingerprint(999)).toBeUndefined(); // ps exits 1
  });
  // lstart has 1s resolution. A PID reused inside the same second is still
  // rejected unless it also leads its own group (macOS PIDs wrap at 99999, so
  // that needs ~100k spawns in one second); boot session and start must match.
  test('persisted cleanup rejects PID reuse in the same lstart second, another second, or another boot', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    setProcessPlatform(darwinPlatform);
    const identity = { pid: 300, bootId: 'BOOT-A', startTicks: 'Mon Sep 28 10:00:00 2026' };
    const host = (row: string, boot = 'BOOT-A') => answer((file, args) => file === 'sysctl' ? boot + '\n'
      : file === 'ps' && args[0] === '-p' ? row : file === 'ps' ? row.replace(/^\s*(\d+)\s+\d+\s+(\d+)\s+(\S+).*$/, '$1 $2 $3') : undefined);
    host('  300     1   250 S       0:00.01 Mon Sep 28 10:00:00 2026'); // same second, but not our group: ours is gone
    expect(await cleanupPersistedProcess(identity)).toBe(true);
    host('  300     1   300 Ss      0:00.01 Mon Sep 28 10:00:01 2026'); // new leader, next second
    expect(await cleanupPersistedProcess(identity)).toBe(false);
    host('  300     1   300 Ss      0:00.01 Mon Sep 28 10:00:00 2026', 'BOOT-B'); // same clock, another boot
    expect(await cleanupPersistedProcess(identity)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    host('  300     1   300 Ss      0:00.01 Mon Sep 28 10:00:00 2026'); // the original worker
    let alive = true;
    kill.mockImplementation(() => { alive = false; return true; });
    answer((file, args) => file === 'sysctl' ? 'BOOT-A\n' : !alive ? '' : file === 'ps' && args[0] === '-p' ? '  300     1   300 Ss      0:00.01 Mon Sep 28 10:00:00 2026' : '300 300 Ss');
    expect(await cleanupPersistedProcess(identity)).toBe(true);
    expect(kill).toHaveBeenCalledWith(-300, 'SIGTERM');
  });
  test('signals go to the negative process group', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await darwinPlatform.signalGroup(100, 'SIGTERM')).toBe(true);
    expect(kill).toHaveBeenCalledWith(-100, 'SIGTERM');
    kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    expect(await darwinPlatform.signalGroup(100, 'SIGKILL')).toBe(true);
    kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(await darwinPlatform.signalGroup(100, 'SIGKILL')).toBe(false);
  });
});

describe('win32 (WMI process tree + taskkill)', () => {
  // pid ppid creation(FILETIME) cpu(100ns) read write
  const row = (pid: number, ppid: number, created: number, cpu = 0) => `${pid} ${ppid} ${created} ${cpu} 10 20`;
  const snap = (...rows: string[]) => parseWindowsSnapshot(rows.join('\r\n'));
  test('WMI rows parse to 10ms cpu ticks with transfer counters', () => {
    expect(snap(row(10, 4, 1000, 2_500_000)).get(10)).toEqual({ pid: 10, parent: 4, group: 0, state: 'R', start: '1000', cpu: 25, read: 10, write: 20 });
  });
  test('tree follows parents created no later than their children', () => {
    const processes = snap(row(10, 4, 1000), row(11, 10, 1001), row(12, 11, 1002), row(13, 10, 900), row(20, 4, 1000));
    expect([...windowsTree(processes, 10)!.keys()].sort()).toEqual([10, 11, 12]); // 13 predates its "parent": PID reuse
  });
  test('an orphan of an exited intermediate stays owned through remembered lineage', () => {
    const known = new Map([[10, '1000'], [11, '1001']]);
    expect([...windowsTree(snap(row(10, 4, 1000), row(12, 11, 1002)), 10, known)!.keys()].sort()).toEqual([10, 12]);
    // Root gone too: persisted start identity still anchors its direct orphans.
    expect([...windowsTree(snap(row(12, 10, 1002), row(30, 10, 500)), 10, new Map(), '1000')!.keys()]).toEqual([12]);
  });
  test('a live parent that is not ours never adopts children, and a reused root proves nothing', () => {
    const known = new Map([[10, '1000'], [11, '1001']]);
    expect([...windowsTree(snap(row(10, 4, 1000), row(11, 4, 5000), row(12, 11, 5001)), 10, known)!.keys()]).toEqual([10]);
    expect(windowsTree(snap(row(10, 4, 9000)), 10, known)).toBeUndefined();
    expect(windowsTree(snap(row(10, 4, 9000)), 10, new Map(), 'not-a-filetime')).toBeUndefined();
  });
  test('stop kills the tree with taskkill /T /F, then terminates survivors, and proves it empty', async () => {
    let alive = new Set([10, 11, 12]);
    const created: Record<number, [number, number]> = { 10: [4, 1000], 11: [10, 1001], 12: [11, 1002] };
    const calls: string[] = [];
    answer((file, args) => {
      calls.push(`${file} ${args.join(' ')}`.slice(0, 40));
      if (file === 'taskkill') { alive.delete(10); alive.delete(11); return 'SUCCESS'; } // 12 escapes the walk
      if (args.at(-1)!.includes('Win32_OperatingSystem')) return '133000000000000000';
      return [...alive].map(pid => row(pid, created[pid][0], created[pid][1])).join('\r\n');
    });
    const kill = jest.spyOn(process, 'kill').mockImplementation(((pid: number) => { alive.delete(pid); return true; }) as typeof process.kill);
    const platform = windowsPlatform('pwsh-mock');
    setProcessPlatform(platform);
    expect(await platform.fingerprint(10)).toEqual({ bootId: '133000000000000000', startTicks: '1000' });
    expect((await platform.groupMembers(10))!.sort()).toEqual([10, 11, 12]);
    expect(await stopProcessGroup(10)).toBe(true);
    expect(calls).toContain('taskkill /PID 10 /T /F');
    expect(kill).toHaveBeenCalledWith(12, 'SIGKILL');
    expect(await platform.groupMembers(10)).toEqual([]);
    // A new process that reuses the root PID is not adopted afterwards.
    alive = new Set([10]); created[10] = [4, 7777];
    expect(await platform.groupMembers(10)).toBeUndefined();
  });
  test('creation time is compared at 100ns, so a root reused in the same second is not adopted', () => {
    // FILETIME exceeds 2^53, so rows are built from strings (10_000_000 per second).
    const at = (pid: number, ppid: number, created: string) => `${pid} ${ppid} ${created} 0 10 20`;
    expect(windowsTree(snap(at(10, 4, '133000000000000001')), 10, new Map(), '133000000000000000')).toBeUndefined();
    expect([...windowsTree(snap(at(10, 4, '133000000000000000'), at(11, 10, '133000000000000001')), 10, new Map(), '133000000000000000')!.keys()]).toEqual([10, 11]);
    expect(windowsTree(snap(at(10, 4, '133000000000000000'), at(11, 10, '132999999999999999')), 10, new Map(), '133000000000000000')!.has(11)).toBe(false);
  });
  test('PowerShell failure is unprovable, never "stopped"', async () => {
    answer(() => undefined);
    setProcessPlatform(windowsPlatform('pwsh-mock'));
    expect(await stopProcessGroup(10)).toBe(false);
  });
});

describe('supervisor over a platform', () => {
  test('escalates to SIGKILL after the grace period and reports the final proof', async () => {
    const live = new Set([5, 6]);
    const signals: string[] = [];
    const fake: ProcessPlatform = { name: 'darwin', detachWorkers: true, termGraceMs: 30, pollMs: 5, killSettleMs: 1,
      groupMembers: async () => [...live], fingerprint: async () => undefined, snapshot: async () => undefined,
      signalGroup: async (_group, signal) => { signals.push(signal); if (signal === 'SIGKILL') live.clear(); return true; } };
    setProcessPlatform(fake);
    expect(await stopProcessGroup(5)).toBe(true);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    setProcessPlatform(null);
    expect(await stopProcessGroup(5)).toBe(false);
  });
});
