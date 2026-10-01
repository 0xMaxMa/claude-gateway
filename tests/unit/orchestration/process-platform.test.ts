import { execFile } from 'child_process';
import { darwinPlatform, windowsPowerShell, linuxPlatform, parseDarwinPs, parsePsCpuTicks, parseWindowsSnapshot, processPlatform, setProcessPlatform, windowsPlatform, windowsTree, type ProcessPlatform } from '../../../src/orchestration/process-platform';
import { cleanupPersistedProcess, processSupervisorSupported, recordProcessRoot, stopProcessGroup, terminateProbeTree, workerSpawnDetached } from '../../../src/orchestration/process-supervisor';
import { ProcessActivitySampler } from '../../../src/orchestration/process-activity';

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
const ORIGINAL_OS = process.platform;
const asOs = (os: string) => { Object.defineProperty(process, 'platform', { value: os }); setProcessPlatform(undefined); };
afterEach(() => { Object.defineProperty(process, 'platform', { value: ORIGINAL_OS }); });

describe('platform selection', () => {
  test('each supported OS gets its own backend; others have none', () => {
    asOs('linux'); expect(processPlatform()).toBe(linuxPlatform);
    asOs('darwin'); expect(processPlatform()).toBe(darwinPlatform);
    asOs('win32'); expect(processPlatform()).toMatchObject({ detachWorkers: false, pollMs: 500 });
    for (const os of ['linux', 'darwin', 'win32']) { asOs(os); expect(processSupervisorSupported()).toBe(true); }
    asOs('freebsd'); expect(processPlatform()).toBeUndefined(); expect(processSupervisorSupported()).toBe(false);
  });
  test('POSIX workers lead a process group; Windows workers stay attached to the hidden console', () => {
    for (const [platform, detached] of [[linuxPlatform, true], [darwinPlatform, true], [windowsPlatform(), false]] as const) {
      setProcessPlatform(platform);
      expect(workerSpawnDetached()).toBe(detached);
    }
  });
  test('without a supervisor, spawns keep the POSIX detached default; only Windows stays attached', () => {
    asOs('freebsd'); expect(workerSpawnDetached()).toBe(true);
    asOs('win32'); setProcessPlatform(null); expect(workerSpawnDetached()).toBe(false);
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
  test('ps rows keep lstart as the start identity, with an optional trailing comm', () => {
    expect(parseDarwinPs(PS).get(101)).toEqual({ pid: 101, parent: 100, group: 100, state: 'S', start: 'Mon Sep 28 10:00:01 2026', cpu: 6225 });
    expect(parseDarwinPs('  101   100   100 S       1:02.25 Mon Sep  8 10:00:01 2026 /Applications/My App/claude').get(101))
      .toEqual({ pid: 101, parent: 100, group: 100, state: 'S', start: 'Mon Sep 8 10:00:01 2026', cpu: 6225, command: '/Applications/My App/claude' });
  });
  test('group membership excludes zombies and other groups; ps failure is unprovable', async () => {
    answer((file, args) => file === '/bin/ps' && args.join(' ') === '-A -o pid=,pgid=,stat=' ? '100 100 Ss\n101 100 S\n102 100 Z\n200 200 S\n' : undefined);
    expect(await darwinPlatform.groupMembers(100)).toEqual([100, 101]);
    answer(() => undefined);
    expect(await darwinPlatform.groupMembers(100)).toBeUndefined();
  });
  test('fingerprint needs a live group leader and a boot session', async () => {
    answer((file, args) => file === '/usr/sbin/sysctl' ? 'BOOT-UUID\n' : file === '/bin/ps' && args[0] === '-p' && args[3].endsWith(',comm=')
      ? PS.split('\n').filter(line => line.trim().startsWith(args[1] + ' ')).map(line => `${line} /usr/local/bin/claude`)[0] : undefined);
    expect(await darwinPlatform.fingerprint(100)).toEqual({ bootId: 'BOOT-UUID', startTicks: 'Mon Sep 28 10:00:00 2026|/usr/local/bin/claude' });
    expect(await darwinPlatform.fingerprint(101)).toBeUndefined(); // not a group leader
    expect(await darwinPlatform.fingerprint(102)).toBeUndefined(); // zombie (and not a leader)
    expect(await darwinPlatform.fingerprint(999)).toBeUndefined(); // ps exits 1
  });
  // lstart has 1s resolution. A PID reused inside the same second is still
  // rejected unless it also leads its own group (macOS PIDs wrap at 99999, so
  // that needs ~100k spawns in one second) and runs the same executable; boot
  // session and start must match too.
  test('persisted cleanup rejects PID reuse in the same lstart second, another second, another executable, or another boot', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    setProcessPlatform(darwinPlatform);
    const identity = { pid: 300, bootId: 'BOOT-A', startTicks: 'Mon Sep 28 10:00:00 2026|/usr/local/bin/claude' };
    const host = (row: string, boot = 'BOOT-A') => answer((file, args) => file === '/usr/sbin/sysctl' ? boot + '\n'
      : file === '/bin/ps' && args[0] === '-p' ? row : file === '/bin/ps' ? row.replace(/^\s*(\d+)\s+\d+\s+(\d+)\s+(\S+).*$/, '$1 $2 $3') : undefined);
    host('  300     1   250 S       0:00.01 Mon Sep 28 10:00:00 2026 /usr/local/bin/claude'); // same second, but not our group: ours is gone
    expect(await cleanupPersistedProcess(identity)).toBe(true);
    host('  300     1   300 Ss      0:00.01 Mon Sep 28 10:00:01 2026 /usr/local/bin/claude'); // new leader, next second
    expect(await cleanupPersistedProcess(identity)).toBe(false);
    host('  300     1   300 Ss      0:00.01 Mon Sep 28 10:00:00 2026 /bin/sh'); // new leader, same second, other executable
    expect(await cleanupPersistedProcess(identity)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    // Another boot: nothing of ours survived a reboot, so the look-alike group
    // leader is someone else's. The task is stopped, and nothing is signalled.
    host('  300     1   300 Ss      0:00.01 Mon Sep 28 10:00:00 2026 /usr/local/bin/claude', 'BOOT-B');
    expect(await cleanupPersistedProcess(identity)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    let alive = true;
    kill.mockImplementation(() => { alive = false; return true; });
    answer((file, args) => file === '/usr/sbin/sysctl' ? 'BOOT-A\n' : !alive ? '' : file === '/bin/ps' && args[0] === '-p' ? '  300     1   300 Ss      0:00.01 Mon Sep 28 10:00:00 2026 /usr/local/bin/claude' : '300 300 Ss');
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

describe('win32 (WMI process tree)', () => {
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
  test('stop terminates every owned process individually, including an orphan, and proves it empty', async () => {
    let alive = new Set([10, 11, 12]);
    const created: Record<number, [number, number]> = { 10: [4, 1000], 11: [10, 1001], 12: [11, 1002] };
    const calls: string[] = [];
    answer((file, args) => {
      calls.push(file);
      if (args.at(-1)!.includes('Win32_OperatingSystem')) return '133000000000000000';
      return [...alive].map(pid => row(pid, created[pid][0], created[pid][1])).join('\r\n');
    });
    const kill = jest.spyOn(process, 'kill').mockImplementation(((pid: number) => { alive.delete(pid); return true; }) as typeof process.kill);
    const platform = windowsPlatform('pwsh-mock');
    setProcessPlatform(platform);
    expect(await platform.fingerprint(10)).toEqual({ bootId: '133000000000000000', startTicks: '1000' });
    expect((await platform.groupMembers(10))!.sort()).toEqual([10, 11, 12]);
    expect(await stopProcessGroup(10)).toBe(true);
    expect(calls).not.toContain('taskkill');
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([10, 11, 12]);
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
  test('stop polls at most every 500ms, and an orphan-only tree is snapshotted once per signal', async () => {
    expect(windowsPlatform().pollMs).toBeGreaterThanOrEqual(500);
    expect([linuxPlatform.pollMs, darwinPlatform.pollMs]).toEqual([25, 50]);
    let alive = new Set([12]);
    let snapshots = 0;
    answer((file, args) => {
      if (file === 'taskkill') throw new Error('taskkill must not run without a live root');
      if (args.at(-1)!.includes('Win32_Process')) snapshots++;
      return [...alive].map(pid => row(pid, 10, 1002)).join('\r\n');
    });
    jest.spyOn(process, 'kill').mockImplementation(((pid: number) => { alive.delete(pid); return true; }) as typeof process.kill);
    const platform = windowsPlatform('pwsh-mock');
    expect(await platform.groupMembers(10, '1000')).toEqual([12]);
    snapshots = 0;
    expect(await platform.signalGroup(10, 'SIGTERM')).toBe(true);
    expect(snapshots).toBe(1);
    expect(alive.size).toBe(0);
    alive = new Set();
  });
  test('PowerShell failure is unprovable, never "stopped"', async () => {
    answer(() => undefined);
    setProcessPlatform(windowsPlatform('pwsh-mock'));
    expect(await stopProcessGroup(10)).toBe(false);
  });
});

describe('win32 lineage, identity and kill scope (mocked WMI)', () => {
  // pid ppid creation(FILETIME) cpu(100ns) read write
  type Proc = [pid: number, ppid: number, created: number];
  let procs: Proc[] = [];
  let calls: string[] = [];
  let kill: jest.SpyInstance;
  beforeEach(() => {
    procs = []; calls = [];
    answer((file, args) => {
      calls.push(`${file} ${args.join(' ')}`.slice(0, 60));
      if (file === 'taskkill') { const root = Number(args[1]); procs = procs.filter(([pid, ppid]) => pid !== root && ppid !== root); return 'SUCCESS'; }
      if (args.at(-1)!.includes('Win32_OperatingSystem')) return '133000000000000000';
      return procs.map(([pid, ppid, created]) => `${pid} ${ppid} ${created} 0 10 20`).join('\r\n');
    });
    kill = jest.spyOn(process, 'kill').mockImplementation(((pid: number) => { procs = procs.filter(([p]) => p !== pid); return true; }) as typeof process.kill);
  });
  const spawned = async (platform: ProcessPlatform, pid: number) => { await platform.adopt?.(pid, () => true); await platform.groupMembers(pid); };
  const queries = (wmiClass: string) => execFileMock.mock.calls.filter(([, args]) => (args as string[]).at(-1)!.includes(wmiClass)).length;
  const killed = () => kill.mock.calls.map(([pid]) => pid);

  test('a dead member whose PID an unrelated process reused never adopts that process\'s children', async () => {
    const platform = windowsPlatform('pwsh-mock');
    setProcessPlatform(platform);
    procs = [[10, 4, 1000], [11, 10, 1001]];
    await spawned(platform, 10);
    expect((await platform.groupMembers(10))!.sort()).toEqual([10, 11]);
    // 11 exits; an unrelated app later reuses PID 11, starts 30, and exits.
    procs = [[10, 4, 1000]];
    expect(await platform.groupMembers(10)).toEqual([10]);
    procs = [[10, 4, 1000], [30, 11, 5001]];
    expect(await platform.groupMembers(10)).toEqual([10]);
    // Same when the reuse is observed alive first (different creation time).
    procs = [[10, 4, 1000], [11, 10, 1001]];
    await platform.groupMembers(10);
    procs = [[10, 4, 1000], [11, 4, 5000]];
    await platform.groupMembers(10);
    procs = [[10, 4, 1000], [31, 11, 5002]];
    expect(await platform.groupMembers(10)).toEqual([10]);
    expect(await stopProcessGroup(10)).toBe(true);
    expect(killed()).toEqual([10]);
    expect(procs).toEqual([[31, 11, 5002]]);
  });

  test('a stop reuses the activity sampler\'s lineage for an adopted root', async () => {
    const platform = windowsPlatform('pwsh-mock');
    setProcessPlatform(platform);
    procs = [[10, 4, 1000]];
    await spawned(platform, 10);
    const sampler = new ProcessActivitySampler(() => 10);
    procs = [[10, 4, 1000], [11, 10, 1001], [12, 11, 1002]];
    expect(await sampler.sample()).toMatchObject({ processCount: 3 });
    procs = [[10, 4, 1000], [12, 11, 1002]]; // 11 exited between samples and stop
    expect(await stopProcessGroup(10)).toBe(true);
    expect(killed()).toEqual([10, 12]);
  });

  test('a dead root with no recorded identity is unproven, never a successful stop', async () => {
    const platform = windowsPlatform('pwsh-mock');
    setProcessPlatform(platform);
    procs = [[12, 10, 1002]]; // an MCP server orphaned by worker 10
    expect(await platform.groupMembers(10)).toBeUndefined();
    expect(await platform.signalGroup(10, 'SIGKILL')).toBe(false);
    expect(await stopProcessGroup(10)).toBe(false);
    expect(killed()).toEqual([]);
  });

  test('a root recorded at spawn anchors its orphans after it exits', async () => {
    const platform = windowsPlatform('pwsh-mock');
    setProcessPlatform(platform);
    procs = [[10, 4, 1000]];
    platform.adopt?.(10, () => true);
    procs = [[12, 10, 1002], [13, 10, 900]]; // 13 predates the worker: stale PPID
    expect(await stopProcessGroup(10)).toBe(true);
    expect(killed()).toEqual([12]);
    // A root that exited before its identity was recorded proves nothing later.
    const late = windowsPlatform('pwsh-mock');
    setProcessPlatform(late);
    procs = [[20, 4, 2000]];
    late.adopt?.(20, () => false);
    expect(await late.groupMembers(20)).toBeUndefined();
  });

  test('a new worker that reuses an old worker\'s PID can be stopped; the old identity stays unproven', async () => {
    const platform = windowsPlatform('pwsh-mock');
    setProcessPlatform(platform);
    procs = [[10, 4, 1000]];
    await spawned(platform, 10);
    expect(await stopProcessGroup(10)).toBe(true);
    procs = [[10, 4, 7777], [11, 10, 7778]];
    await spawned(platform, 10);
    expect(await stopProcessGroup(10)).toBe(true);
    expect(killed()).toEqual([10, 10, 11]);
    procs = [[10, 4, 7777]];
    expect(await platform.groupMembers(10, '1000')).toBeUndefined();
  });

  test('a long-running worker stays resolvable while more than 256 later probes spawn alongside it', async () => {
    const platform = windowsPlatform('pwsh-mock');
    setProcessPlatform(platform);
    const worker: Proc = [10, 4, 1000];
    const probes: Proc[] = [];
    procs = [worker];
    await spawned(platform, 10);
    for (let pid = 100; pid < 400; pid++) {
      probes.push([pid, 4, 2000 + pid]);
      procs = [worker, ...probes];
      await spawned(platform, pid);
      if (pid % 50 === 0) expect(await platform.groupMembers(10)).toEqual([10]); // the worker is still supervised
    }
    // The worker exits and leaves an orphan; its recorded identity still anchors it.
    procs = [...probes, [12, 10, 1002]];
    expect(await platform.groupMembers(10)).toEqual([12]);
    expect(await platform.fingerprint(10)).toEqual({ bootId: '133000000000000000', startTicks: '1000' });
  });

  test('probes proven stopped retire their roots: they no longer evict a worker, and a reused PID stays refused', async () => {
    const platform = windowsPlatform('pwsh-mock');
    setProcessPlatform(platform);
    const worker: Proc = [10, 4, 1000];
    procs = [worker];
    await spawned(platform, 10);
    for (let pid = 100; pid < 400; pid++) {
      procs = [worker, [pid, 4, 2000 + pid]];
      await spawned(platform, pid);
      procs = [worker];
      expect(await platform.groupMembers(pid)).toEqual([]);
    }
    // An unrelated process reuses a recently stopped probe's PID: never adopted.
    procs = [worker, [399, 4, 9000]];
    expect(await platform.groupMembers(399)).toBeUndefined();
    expect(await platform.signalGroup(399, 'SIGKILL')).toBe(false);
    // The worker exits and an unrelated process reuses its PID: a stop is refused, nothing is killed.
    procs = [[10, 4, 9999]];
    expect(await stopProcessGroup(10)).toBe(false);
    expect(killed()).toEqual([]);
  });

  test('identity keeps the start recorded at spawn: a PID reused before identity() is never persisted', async () => {
    const platform = windowsPlatform('pwsh-mock');
    procs = [[10, 4, 1000]];
    const recorded = platform.adopt!(10, () => true);
    await recorded;
    procs = [[10, 4, 7777]]; // the worker exited and an unrelated process took its PID
    expect(await platform.fingerprint(10)).toEqual({ bootId: '133000000000000000', startTicks: '1000' });
    expect(await recorded).toBe('1000');
    // A root that exited before it was recorded has no identity at all.
    const early = windowsPlatform('pwsh-mock');
    procs = [[20, 4, 2000]];
    const unrecorded = early.adopt!(20, () => false);
    await unrecorded;
    expect(await early.fingerprint(20)).toBeUndefined();
    expect(await unrecorded).toBeUndefined();
    // A root known only from a snapshot must still be the process at that PID.
    const restarted = windowsPlatform('pwsh-mock');
    procs = [[30, 4, 3000]];
    await restarted.groupMembers(30, '3000');
    procs = [[30, 4, 9999]];
    expect(await restarted.fingerprint(30)).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  });

  test('identity at task start reuses the spawn snapshot and one boot query per gateway process', async () => {
    const platform = windowsPlatform('pwsh-mock');
    procs = [[10, 4, 1000]];
    await platform.adopt!(10, () => true);
    execFileMock.mockClear();
    expect(await platform.fingerprint(10)).toMatchObject({ startTicks: '1000' });
    expect(await platform.fingerprint(10)).toMatchObject({ startTicks: '1000' });
    expect(queries('Win32_Process')).toBe(0);
    expect(queries('Win32_OperatingSystem')).toBe(1);
    expect(await platform.bootId()).toBe('133000000000000000');
    expect(queries('Win32_OperatingSystem')).toBe(1);
  });

  test('a failed boot query is retried, not cached', async () => {
    const platform = windowsPlatform('pwsh-mock');
    const snapshotRows = execFileMock.getMockImplementation()!;
    execFileMock.mockImplementation((file: string, args: string[], options: unknown, callback: (error: Error | null, stdout: string) => void) =>
      args.at(-1)!.includes('Win32_OperatingSystem') ? setImmediate(() => callback(new Error('wmi down'), '')) : snapshotRows(file, args, options, callback));
    expect(await platform.bootId()).toBeUndefined();
    execFileMock.mockImplementation(snapshotRows);
    expect(await platform.bootId()).toBe('133000000000000000');
  });

  test('a probe recorded at spawn at a PID an earlier worker used has its whole tree killed', async () => {
    const platform = windowsPlatform('pwsh-mock');
    setProcessPlatform(platform);
    procs = [[10, 4, 1000]];
    await spawned(platform, 10);
    expect(await stopProcessGroup(10)).toBe(true);
    procs = [[10, 4, 7777]];
    const probe = { pid: 10, exitCode: null as number | null, signalCode: null, kill: jest.fn(() => true) };
    recordProcessRoot(probe);
    procs = [[10, 4, 7777], [11, 10, 7778]];
    await terminateProbeTree(probe, 'SIGTERM');
    await terminateProbeTree(probe, 'SIGKILL');
    expect(killed()).toEqual([10, 10, 11]);
    expect(probe.kill).not.toHaveBeenCalled();
  });

  test('stop kills only the creation-time-verified set, never a PPID-only tree walk', async () => {
    const platform = windowsPlatform('pwsh-mock');
    setProcessPlatform(platform);
    // 40 still names 10 as parent but predates it: its parent was an older PID 10.
    procs = [[10, 4, 1000], [11, 10, 1001], [40, 10, 500]];
    await spawned(platform, 10);
    expect(await stopProcessGroup(10)).toBe(true);
    expect(calls.some(call => call.startsWith('taskkill'))).toBe(false);
    expect(killed()).toEqual([10, 11]);
    expect(procs).toEqual([[40, 10, 500]]);
  });
});

describe('supervisor over a platform', () => {
  test('escalates to SIGKILL after the grace period and reports the final proof', async () => {
    const live = new Set([5, 6]);
    const signals: string[] = [];
    const fake: ProcessPlatform = { detachWorkers: true, termGraceMs: 30, pollMs: 5, killSettleMs: 1,
      groupMembers: async () => [...live], fingerprint: async () => undefined, bootId: async () => undefined, snapshot: async () => undefined,
      signalGroup: async (_group, signal) => { signals.push(signal); if (signal === 'SIGKILL') live.clear(); return true; } };
    setProcessPlatform(fake);
    expect(await stopProcessGroup(5)).toBe(true);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    setProcessPlatform(null);
    expect(await stopProcessGroup(5)).toBe(false);
  });
});

describe('persisted cleanup after a restart', () => {
  const fake = (boot: string | undefined) => {
    const platform: ProcessPlatform = { detachWorkers: true, termGraceMs: 0, pollMs: 0, killSettleMs: 0,
      groupMembers: jest.fn(async () => undefined), signalGroup: jest.fn(async () => true),
      fingerprint: jest.fn(async () => undefined), bootId: jest.fn(async () => boot), snapshot: async () => undefined };
    setProcessPlatform(platform);
    return platform;
  };
  test('another boot means the process is gone, before any membership or PID check', async () => {
    const platform = fake('BOOT-B');
    expect(await cleanupPersistedProcess({ pid: 300, bootId: 'BOOT-A', startTicks: '1' })).toBe(true);
    expect(platform.groupMembers).not.toHaveBeenCalled();
    expect(platform.signalGroup).not.toHaveBeenCalled();
  });
  test('the same boot, an unreadable boot, or no persisted boot keeps the membership proof', async () => {
    for (const [boot, identity] of [['BOOT-A', { pid: 300, bootId: 'BOOT-A', startTicks: '1' }], [undefined, { pid: 300, bootId: 'BOOT-A', startTicks: '1' }], ['BOOT-B', { pid: 300 }]] as const) {
      const platform = fake(boot);
      expect(await cleanupPersistedProcess(identity)).toBe(false); // membership unprovable
      expect(platform.groupMembers).toHaveBeenCalledTimes(1);
    }
  });
});

describe('absolute tool paths', () => {
  test('PowerShell comes from SystemRoot when it is a plain drive path', () => {
    expect(windowsPowerShell('C:\\Windows')).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(windowsPowerShell('D:\\WINDOWS\\')).toBe('D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    for (const unusable of ['', 'Windows', '\\\\server\\share', 'C:\\Win"dows', '/usr']) expect(windowsPowerShell(unusable, '')).toBe('powershell.exe');
  });
  test('without a usable SystemRoot, a plain windir is used before any PATH lookup', () => {
    expect(windowsPowerShell('', 'C:\\Windows')).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(windowsPowerShell('\\\\server\\share', 'E:\\WINDOWS\\')).toBe('E:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(windowsPowerShell('D:\\Windows', 'C:\\Windows')).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    for (const unusable of ['', 'Windows', '\\\\server\\share', 'C:\\Win"dows', '/usr']) expect(windowsPowerShell('', unusable)).toBe('powershell.exe');
  });
  test('macOS runs ps and sysctl by absolute path', async () => {
    answer((file) => file === '/bin/ps' ? '100 100 Ss\n' : file === '/usr/sbin/sysctl' ? 'BOOT\n' : undefined);
    expect(await darwinPlatform.groupMembers(100)).toEqual([100]);
    expect(await darwinPlatform.bootId()).toBe('BOOT');
  });
});

describe('worker spawn records the root identity', () => {
  test('the platform adopts the root with a liveness check tied to the child handle', () => {
    const adopt = jest.fn();
    setProcessPlatform({ detachWorkers: false, termGraceMs: 0, pollMs: 0, killSettleMs: 0, groupMembers: async () => [], signalGroup: async () => true,
      fingerprint: async () => undefined, bootId: async () => undefined, snapshot: async () => undefined, adopt });
    const child = { pid: 10, exitCode: null as number | null, signalCode: null };
    recordProcessRoot(child);
    expect(adopt).toHaveBeenCalledWith(10, expect.any(Function));
    expect(adopt.mock.calls[0][1]()).toBe(true);
    child.exitCode = 0;
    expect(adopt.mock.calls[0][1]()).toBe(false);
    recordProcessRoot({ pid: undefined, exitCode: null, signalCode: null });
    expect(adopt).toHaveBeenCalledTimes(1);
  });
});

describe('activity sampler ownership', () => {
  // pid ppid creation(FILETIME) cpu(100ns) read write
  const row = (pid: number, ppid: number, created: number, cpu = 0) => `${pid} ${ppid} ${created} ${cpu} 10 20`;
  test('on Windows it uses the creation-time-checked tree: a reused parent PID is not counted, an orphaned grandchild is', async () => {
    let rows: string[] = [];
    answer(() => rows.join('\r\n'));
    setProcessPlatform(windowsPlatform('pwsh-mock'));
    const sampler = new ProcessActivitySampler(() => 10);
    // 13 claims parent 10 but predates the worker: its real parent was an older process with that PID.
    rows = [row(10, 4, 1000), row(11, 10, 1001), row(12, 11, 1002), row(13, 10, 900, 5_000_000)];
    expect(await sampler.sample()).toMatchObject({ available: true, processCount: 3 });
    // 11 exits; 12 keeps its dead parent's PID and must still be counted.
    rows = [row(10, 4, 1000), row(12, 11, 1002, 3_000_000), row(13, 10, 900, 9_000_000)];
    expect(await sampler.sample()).toMatchObject({ available: true, processCount: 2, childCpuTicksDelta: 30 });
  });
});
