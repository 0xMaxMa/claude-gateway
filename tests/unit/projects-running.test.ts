import {
  cwdInProject,
  Listener,
  listRunning,
  parseProcNetTcp,
  parseSs,
  ProcInfo,
  redactCommand,
  StopLimiter,
  stopRunning,
  Sys,
} from '../../src/projects/running';

describe('parseSs', () => {
  it('parses ipv4, ipv6, wildcard and zone-suffixed sockets with several pids', () => {
    const out = [
      'LISTEN 0      511          127.0.0.1:3000       0.0.0.0:*    users:(("node",pid=123,fd=19))',
      'LISTEN 0      4096              [::]:8080          [::]:*    users:(("nginx",pid=7,fd=6),("nginx",pid=8,fd=6))',
      'LISTEN 0      128                  *:22              *:*',
      'LISTEN 0      4096     127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=900,fd=14))',
      'LISTEN 0      5               [::1]:631          [::]:*    users:(("cupsd",pid=5,fd=7))',
      'ESTAB  0      0         127.0.0.1:1111    127.0.0.1:2222  users:(("x",pid=9,fd=1))',
      'garbage',
    ].join('\n');
    expect(parseSs(out)).toEqual<Listener[]>([
      { address: '127.0.0.1', port: 3000, pids: [123] },
      { address: '::', port: 8080, pids: [7, 8] },
      { address: '*', port: 22, pids: [] },
      { address: '127.0.0.53', port: 53, pids: [900] },
      { address: '::1', port: 631, pids: [5] },
    ]);
  });

  it('does not read a pid out of a process name', () => {
    const out = 'LISTEN 0 1 0.0.0.0:80 0.0.0.0:* users:(("a\\",pid=99,fd=1",pid=5,fd=3))';
    expect(parseSs(out)[0].pids).toEqual([5]);
  });
});

describe('parseProcNetTcp', () => {
  const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  it('reads LISTEN rows only, ipv4 and ipv6', () => {
    const v4 = head + '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0\n   1: 0100007F:1F90 0100007F:D000 01 00000000:00000000 00:00000000 00000000  1000        0 99 1 0\n';
    expect(parseProcNetTcp(v4, false)).toEqual([{ address: '127.0.0.1', port: 3000, inode: '4242' }]);
    const v6 = head + '   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 77 1 0\n';
    expect(parseProcNetTcp(v6, true)).toEqual([{ address: '::1', port: 8080, inode: '77' }]);
  });
});

describe('redactCommand', () => {
  it('redacts secret flag values in both forms and before truncating', () => {
    expect(redactCommand(['node', 's.js', '--token', 'abc', '--password=hunter2', '--api-key', 'k', '--port', '3000'])).toBe(
      'node s.js --token [redacted] --password=[redacted] --api-key [redacted] --port 3000',
    );
    const long = redactCommand(['node', 'x'.repeat(110), '--secret', 'topsecretvalue']);
    expect(long.length).toBe(120);
    expect(long).not.toContain('topsecret');
  });
});

describe('cwdInProject', () => {
  it('matches the project and below, never a sibling sharing the prefix', () => {
    expect(cwdInProject('/r/api', '/r/api')).toBe(true);
    expect(cwdInProject('/r/api', '/r/api/src')).toBe(true);
    expect(cwdInProject('/r/api', '/r/api-v2')).toBe(false);
    expect(cwdInProject('/r/api', '/r/api-v2/src')).toBe(false);
    expect(cwdInProject('/r/api', '/r/api/../api-v2')).toBe(false);
    expect(cwdInProject('/r/api', '/r/api/../other')).toBe(false);
    expect(cwdInProject('/r/api', '/r')).toBe(false);
  });
});

// ---- fake system for safety rules

interface FakeProc extends Partial<ProcInfo> {
  listens?: number;
  killedBy?: never;
}

function makeSys(procs: Record<number, FakeProc>, opts: { selfPid?: number; platform?: string } = {}) {
  const alive = new Set(Object.keys(procs).map(Number));
  const kills: Array<[number, string]> = [];
  const info = (pid: number): ProcInfo | null => {
    const p = procs[pid];
    if (!p || !alive.has(pid)) return null;
    return { ppid: 1, startTime: '100', uid: 1000, alive: true, comm: 'node', cwd: '/r/api', exe: 'node', ...p };
  };
  const sys: Sys = {
    platform: opts.platform ?? 'linux',
    selfPid: opts.selfPid ?? 50,
    selfUid: 1000,
    async listeners() {
      return Object.entries(procs)
        .filter(([pid, p]) => p.listens && alive.has(Number(pid)))
        .map(([pid, p]) => ({ address: '127.0.0.1', port: p.listens as number, pids: [Number(pid)] }));
    },
    async allPids() {
      return [...alive];
    },
    async proc(pid) {
      return info(pid);
    },
    async cmdline(pid) {
      return ['node', `srv${pid}.js`];
    },
    kill(pid, signal) {
      kills.push([pid, signal]);
      alive.delete(pid);
    },
    async sleep() {},
  };
  return { sys, kills, alive };
}

describe('candidate rules', () => {
  it('lists only listeners whose cwd is inside the project, sorted by port', async () => {
    const { sys } = makeSys({
      60: { listens: 4000 },
      61: { listens: 3000 },
      62: { listens: 5000, cwd: '/r/api-v2' },
      63: { listens: 5001, cwd: '/elsewhere' },
      64: { cwd: '/r/api' },
    });
    const res = await listRunning(sys, '/r/api');
    expect(res).toEqual({
      supported: true,
      processes: [
        { port: 3000, pids: [61], command: 'node srv61.js', address: '127.0.0.1' },
        { port: 4000, pids: [60], command: 'node srv60.js', address: '127.0.0.1' },
      ],
    });
  });

  it('never selects a process that does not listen', async () => {
    const { sys, kills } = makeSys({ 60: { cwd: '/r/api' }, 61: { listens: 3000 } });
    expect((await stopRunning(sys, '/r/api')).ok).toBe(true);
    expect(kills.map((k) => k[0])).toEqual([61]);
  });

  it('never selects the gateway pid, its ancestors, or pid 1', async () => {
    const { sys, kills } = makeSys(
      {
        1: { listens: 1000, ppid: 0 },
        10: { listens: 1001, ppid: 1 },
        20: { listens: 1002, ppid: 10 },
        50: { listens: 1003, ppid: 20 },
        60: { listens: 3000 },
      },
      { selfPid: 50 },
    );
    expect((await listRunning(sys, '/r/api')).processes.map((p) => p.port)).toEqual([3000]);
    await stopRunning(sys, '/r/api');
    expect(kills.map((k) => k[0])).toEqual([60]);
  });

  it('never selects the claude agent, by exe or by comm, even if it listens', async () => {
    const { sys, kills } = makeSys({
      60: { listens: 3000, exe: 'claude' },
      61: { listens: 3001, comm: 'claude', exe: 'node' },
      62: { listens: 3002 },
    });
    expect((await listRunning(sys, '/r/api')).processes.map((p) => p.port)).toEqual([3002]);
    await stopRunning(sys, '/r/api');
    expect(kills.map((k) => k[0])).toEqual([62]);
  });

  it('never selects another uid', async () => {
    const { sys, kills } = makeSys({ 60: { listens: 3000, uid: 0 }, 61: { listens: 3001 } });
    expect((await listRunning(sys, '/r/api')).processes.map((p) => p.port)).toEqual([3001]);
    await stopRunning(sys, '/r/api');
    expect(kills.map((k) => k[0])).toEqual([61]);
  });

  it('reports unsupported off Linux and when the host cannot be scanned', async () => {
    const mac = makeSys({ 60: { listens: 3000 } }, { platform: 'darwin' });
    expect(await listRunning(mac.sys, '/r/api')).toEqual({ supported: false, processes: [] });
    const blind = makeSys({});
    blind.sys.listeners = async () => null;
    expect(await listRunning(blind.sys, '/r/api')).toEqual({ supported: false, processes: [] });
  });
});

describe('stop', () => {
  it('reports nothing_running when nothing matches, or the port is not the project\'s', async () => {
    const { sys, kills } = makeSys({ 60: { listens: 3000 } });
    expect(await stopRunning(sys, '/r/api', 9999)).toEqual({ ok: false, error: 'nothing_running' });
    expect(kills).toEqual([]);
  });

  it('stops only the requested port', async () => {
    const { sys, kills } = makeSys({ 60: { listens: 3000 }, 61: { listens: 4000 } });
    const res = await stopRunning(sys, '/r/api', 3000);
    expect(kills).toEqual([[60, 'SIGTERM']]);
    expect(res).toEqual({ ok: true, value: { stopped: [{ port: 3000, pids: [60] }], remaining: [] } });
  });

  it('signals descendants of a listener, even ones that cd elsewhere, but not unrelated processes', async () => {
    const { sys, kills } = makeSys({
      60: { listens: 3000 },
      61: { ppid: 60, cwd: '/elsewhere' },
      62: { ppid: 61, cwd: '/elsewhere' },
      70: { ppid: 1, cwd: '/r/api' },
    });
    await stopRunning(sys, '/r/api');
    expect(kills.map((k) => k[0]).sort()).toEqual([60, 61, 62]);
  });

  it('does not take a descendant that is claude', async () => {
    const { sys, kills } = makeSys({
      60: { listens: 3000 },
      61: { ppid: 60, exe: 'claude' },
      62: { ppid: 60 },
    });
    await stopRunning(sys, '/r/api');
    expect(kills.map((k) => k[0]).sort()).toEqual([60, 62]);
  });

  it('refuses a listener that is an ancestor of the gateway, and so its whole tree', async () => {
    const { sys, kills } = makeSys({ 60: { listens: 3000 }, 61: { ppid: 60 }, 62: { ppid: 61 } }, { selfPid: 62 });
    expect(await stopRunning(sys, '/r/api')).toEqual({ ok: false, error: 'nothing_running' });
    expect(kills).toEqual([]);
  });

  it('sends SIGKILL only to survivors, after SIGTERM', async () => {
    const { sys, kills, alive } = makeSys({ 60: { listens: 3000 }, 61: { listens: 4000 } });
    sys.kill = (pid, signal) => {
      kills.push([pid, signal]);
      if (pid === 60 || signal === 'SIGKILL') alive.delete(pid);
    };
    const res = await stopRunning(sys, '/r/api');
    expect(kills).toEqual([[60, 'SIGTERM'], [61, 'SIGTERM'], [61, 'SIGKILL']]);
    expect(res.ok && res.value.remaining).toEqual([]);
  });

  it('only ever signals single positive pids, never a group', async () => {
    const { sys, kills } = makeSys({ 60: { listens: 3000 }, 61: { ppid: 60 } });
    await stopRunning(sys, '/r/api');
    expect(kills.every(([pid]) => Number.isInteger(pid) && pid > 1)).toBe(true);
  });

  it('skips a pid whose cwd changed between scan and signal (pid reuse)', async () => {
    const { sys, kills } = makeSys({ 60: { listens: 3000 }, 61: { listens: 4000 } });
    const inner = sys.proc;
    let moved = false;
    sys.proc = async (pid) => {
      const i = await inner(pid);
      if (i && pid === 60 && moved) return { ...i, cwd: '/elsewhere' };
      return i;
    };
    const realKill = sys.kill;
    sys.kill = (pid, s) => realKill(pid, s);
    const realListeners = sys.listeners;
    sys.listeners = async () => {
      const l = await realListeners();
      moved = true;
      return l;
    };
    await stopRunning(sys, '/r/api');
    expect(kills.map((k) => k[0])).toEqual([61]);
  });

  it('skips a pid that is now a different process (start time changed)', async () => {
    const { sys, kills } = makeSys({ 60: { listens: 3000 } });
    const inner = sys.proc;
    let scanned = false;
    const pids = sys.allPids;
    sys.allPids = async () => {
      scanned = true;
      return pids();
    };
    sys.proc = async (pid) => {
      const i = await inner(pid);
      return i && scanned ? { ...i, startTime: '999' } : i;
    };
    await stopRunning(sys, '/r/api');
    expect(kills).toEqual([]);
  });

  it('skips a pid that stopped listening before the signal', async () => {
    const { sys, kills } = makeSys({ 60: { listens: 3000 } });
    const inner = sys.listeners;
    let calls = 0;
    sys.listeners = async () => (++calls === 1 ? inner() : []);
    await stopRunning(sys, '/r/api');
    expect(kills).toEqual([]);
  });
});

describe('StopLimiter', () => {
  it('allows one stop per project per window', () => {
    let t = 0;
    const l = new StopLimiter(1000, () => t);
    expect(l.take('a')).toBe(true);
    expect(l.take('a')).toBe(false);
    expect(l.take('b')).toBe(true);
    t = 1000;
    expect(l.take('a')).toBe(true);
  });
});
