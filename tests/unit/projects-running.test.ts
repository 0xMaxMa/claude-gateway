import * as path from 'path';
import {
  argvPaths,
  cwdInProject,
  Listener,
  listRunning,
  parseProcNetTcp,
  parseSs,
  ProcInfo,
  redactCommand,
  scanProjects,
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

  it.each([
    [['app', '--auth', 'sk-live-123'], 'app --auth [redacted]'],
    [['app', '--auth=sk-live-123'], 'app --auth=[redacted]'],
    [['app', '--credentials', 'c1'], 'app --credentials [redacted]'],
    [['app', '--bearer', 'b1'], 'app --bearer [redacted]'],
    [['mysql', '-u', 'root', '-p', 'pw123'], 'mysql -u root -p [redacted]'],
    [['mysql', '-ppw123'], 'mysql -p[redacted]'],
    [['app', 'postgres://u:hunter2@db/x'], 'app postgres://db/x'],
    [['app', '--db=postgres://u:hunter2@db/x'], 'app --db=postgres://db/x'],
  ])('redacts %j', (argv, shown) => {
    expect(redactCommand(argv)).toBe(shown);
  });

  it('keeps flags that only look like secret flags', () => {
    expect(redactCommand(['vite', '--port', '5173', '--host', '0.0.0.0', 'https://example.com/a'])).toBe(
      'vite --port 5173 --host 0.0.0.0 https://example.com/a',
    );
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
  argv?: string[];
}

function makeSys(procs: Record<number, FakeProc>, opts: { selfPid?: number; platform?: string; links?: Record<string, string> } = {}) {
  const alive = new Set(Object.keys(procs).map(Number));
  const kills: Array<[number, string]> = [];
  const info = (pid: number): ProcInfo | null => {
    const p = procs[pid];
    if (!p || !alive.has(pid)) return null;
    const { listens: _l, argv: _a, ...rest } = p;
    return { ppid: 1, startTime: '100', uid: 1000, alive: true, comm: 'node', cwd: '/r/api', exe: 'node', ...rest };
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
      return procs[pid]?.argv ?? ['node', `srv${pid}.js`];
    },
    async realpath(p) {
      const abs = path.resolve(p);
      for (const [from, to] of Object.entries(opts.links ?? {})) {
        if (abs === from || abs.startsWith(from + '/')) return to + abs.slice(from.length);
      }
      return abs;
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
        { port: 3000, pids: [61], command: 'node srv61.js', address: '127.0.0.1', via: 'cwd' },
        { port: 4000, pids: [60], command: 'node srv60.js', address: '127.0.0.1', via: 'cwd' },
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


describe('argvPaths', () => {
  it('keeps absolute paths, strips a leading --flag=, drops relative values and flags', () => {
    expect(argvPaths(['python3', '-m', 'http.server', '3000', '--directory', '/r/api', '--root=/r/x', './rel', 'rel/p', '--opt=rel', '-C/r/c', 'a/b'])).toEqual(['/r/api', '/r/x']);
  });
});

describe('argv-matched listeners', () => {
  const away = { cwd: '/tmp' };
  const srv = (argv: string[], extra: FakeProc = {}): FakeProc => ({ listens: 3000, ...away, argv, ...extra });

  it('lists a listener with cwd elsewhere when an absolute argv path is in the project, via=argv', async () => {
    const { sys } = makeSys({
      60: srv(['python3', '-m', 'http.server', '3000', '--directory', '/r/api']),
      61: srv(['node', '/r/api/src/server.js'], { listens: 3001 }),
      62: srv(['vite', '--root=/r/api'], { listens: 3002 }),
      63: { listens: 3003 },
    });
    const res = await listRunning(sys, '/r/api');
    expect(res.processes.map((p) => [p.port, p.via])).toEqual([[3000, 'argv'], [3001, 'argv'], [3002, 'argv'], [3003, 'cwd']]);
  });

  it('stops an argv-matched listener exactly like a cwd-matched one, with its descendants', async () => {
    const { sys, kills } = makeSys({ 60: srv(['serve', '/r/api']), 61: { ppid: 60, cwd: '/tmp' } });
    const res = await stopRunning(sys, '/r/api');
    expect(res).toEqual({ ok: true, value: { stopped: [{ port: 3000, pids: [60] }], remaining: [] } });
    expect(kills.map((k) => k[0]).sort()).toEqual([60, 61]);
  });

  it('does not match a sibling sharing the name prefix', async () => {
    const { sys, kills } = makeSys({ 60: srv(['node', '/r/api-v2/server.js']), 61: srv(['serve', '--directory=/r/api-v2'], { listens: 3001 }) });
    expect((await listRunning(sys, '/r/api')).processes).toEqual([]);
    expect(await stopRunning(sys, '/r/api')).toEqual({ ok: false, error: 'nothing_running' });
    expect(kills).toEqual([]);
  });

  it('does not match relative paths, project names alone, or substrings', async () => {
    const { sys } = makeSys({
      60: srv(['node', 'api/server.js']),
      61: srv(['node', './server.js', '--directory', 'r/api'], { listens: 3001 }),
      62: srv(['node', 'x', 'see/r/api/x', '--note=r/api'], { listens: 3002 }),
      63: srv(['sh', '-c', 'cd /r/api && node s.js'], { listens: 3003 }),
    });
    expect((await listRunning(sys, '/r/api')).processes).toEqual([]);
  });

  it('does not match a path that escapes through .. or a symlink', async () => {
    const { sys } = makeSys(
      { 60: srv(['node', '/r/api/../other/s.js']), 61: srv(['serve', '/x/link'], { listens: 3001 }), 62: srv(['serve', '/x/inlink'], { listens: 3002 }) },
      { links: { '/x/link': '/r/other', '/x/inlink': '/r/api/sub' } },
    );
    expect((await listRunning(sys, '/r/api')).processes.map((p) => p.port)).toEqual([3002]);
  });

  it('ignores a process with the project in argv that does not listen', async () => {
    const { sys, kills } = makeSys({ 60: { cwd: '/tmp', argv: ['node', '/r/api/agent.js'] }, 61: srv(['serve', '/r/api'], { listens: 3001 }) });
    await stopRunning(sys, '/r/api');
    expect(kills.map((k) => k[0])).toEqual([61]);
  });

  it('never selects claude by exe or comm even when it listens with the path in argv', async () => {
    const { sys } = makeSys({
      60: srv(['claude', '--add-dir', '/r/api'], { exe: 'claude' }),
      61: srv(['x', '/r/api'], { comm: 'claude', listens: 3001 }),
    });
    expect((await listRunning(sys, '/r/api')).processes).toEqual([]);
  });

  it('never selects the gateway, its ancestors or pid 1 even when argv names the project', async () => {
    const { sys } = makeSys(
      {
        1: srv(['init', '/r/api'], { ppid: 0, listens: 1000 }),
        10: srv(['sup', '/r/api'], { ppid: 1, listens: 1001 }),
        50: srv(['gw', '/r/api'], { ppid: 10, listens: 1002 }),
        60: srv(['serve', '/r/api']),
      },
      { selfPid: 50 },
    );
    expect((await listRunning(sys, '/r/api')).processes.map((p) => p.port)).toEqual([3000]);
  });

  it('applies the uid rule to argv matches', async () => {
    const { sys } = makeSys({ 60: srv(['serve', '/r/api'], { uid: 0 }) });
    expect((await listRunning(sys, '/r/api')).processes).toEqual([]);
  });

  it('re-verifies before signalling: argv no longer names the project, or it stopped listening, or the start time changed', async () => {
    for (const mutate of ['argv', 'listen', 'start'] as const) {
      const { sys, kills } = makeSys({ 60: srv(['serve', '/r/api']) });
      let scanned = false;
      const allPids = sys.allPids;
      sys.allPids = async () => ((scanned = true), allPids());
      if (mutate === 'argv') {
        const cmd = sys.cmdline;
        sys.cmdline = async (pid) => (scanned ? ['serve', '/r/other'] : cmd(pid));
      } else if (mutate === 'listen') {
        const l = sys.listeners;
        let calls = 0;
        sys.listeners = async () => (++calls === 1 ? l() : []);
      } else {
        const pr = sys.proc;
        sys.proc = async (pid) => {
          const i = await pr(pid);
          return i && scanned ? { ...i, startTime: '999' } : i;
        };
      }
      await stopRunning(sys, '/r/api');
      expect([mutate, kills]).toEqual([mutate, []]);
    }
  });

  it('redacts secrets in the command of an argv match', async () => {
    const { sys } = makeSys({ 60: srv(['serve', '/r/api', '--token', 'hunter2']) });
    const cmd = (await listRunning(sys, '/r/api')).processes[0].command;
    expect(cmd).toBe('serve /r/api --token [redacted]');
  });
});

describe('scanProjects, every project in one pass', () => {
  const dirs = [
    { name: 'api', dir: '/r/api' },
    { name: 'api-v2', dir: '/r/api-v2' },
    { name: 'web', dir: '/r/web' },
    { name: 'idle', dir: '/r/idle' },
  ];

  it('attributes each listener to its project by cwd or argv, drops projects with none, sorts by name then port', async () => {
    const { sys } = makeSys({
      60: { listens: 4000, cwd: '/r/web' },
      61: { listens: 3000, cwd: '/tmp', argv: ['serve', '/r/api', '--token', 'hunter2'] },
      62: { listens: 3001, cwd: '/r/api-v2' },
      63: { listens: 3002, cwd: '/r/web/sub' },
      64: { listens: 5000, cwd: '/elsewhere' },
      65: { cwd: '/r/idle' },
      66: { listens: 5001, cwd: '/r/apixyz' },
    });
    const res = await scanProjects(sys, dirs);
    expect(res).toEqual({
      supported: true,
      projects: {
        api: [{ port: 3000, pids: [61], command: 'serve /r/api --token [redacted]', address: '127.0.0.1', via: 'argv' }],
        'api-v2': [{ port: 3001, pids: [62], command: 'node srv62.js', address: '127.0.0.1', via: 'cwd' }],
        web: [
          { port: 3002, pids: [63], command: 'node srv63.js', address: '127.0.0.1', via: 'cwd' },
          { port: 4000, pids: [60], command: 'node srv60.js', address: '127.0.0.1', via: 'cwd' },
        ],
      },
    });
    expect(Object.keys(res.projects)).toEqual(['api', 'api-v2', 'web']);
  });

  it('applies the per-project exclusions: claude, gateway and ancestors, pid 1, other uid', async () => {
    const { sys } = makeSys(
      {
        1: { listens: 1000, ppid: 0 },
        20: { listens: 1001, ppid: 1 },
        50: { listens: 1002, ppid: 20 },
        60: { listens: 3000, exe: 'claude' },
        61: { listens: 3001, comm: 'claude' },
        62: { listens: 3002, uid: 0 },
        63: { listens: 3003 },
      },
      { selfPid: 50 },
    );
    expect(await scanProjects(sys, dirs)).toEqual({
      supported: true,
      projects: { api: [{ port: 3003, pids: [63], command: 'node srv63.js', address: '127.0.0.1', via: 'cwd' }] },
    });
  });

  it('gives a listener matching nested projects to the deepest one only', async () => {
    const nested = [
      { name: 'outer', dir: '/r/outer' },
      { name: 'inner', dir: '/r/outer/inner' },
    ];
    const { sys } = makeSys({
      60: { listens: 3000, cwd: '/r/outer/inner/src' },
      61: { listens: 3001, cwd: '/tmp', argv: ['serve', '/r/outer/inner'] },
      62: { listens: 3002, cwd: '/r/outer' },
    });
    const res = await scanProjects(sys, nested);
    expect(Object.fromEntries(Object.entries(res.projects).map(([k, v]) => [k, v.map((p) => p.port)]))).toEqual({
      inner: [3000, 3001],
      outer: [3002],
    });
  });

  it('scans listeners once and reads each pid once, whatever the number of projects', async () => {
    const { sys } = makeSys({ 60: { listens: 3000, cwd: '/r/web' }, 61: { listens: 3001, cwd: '/r/api' } });
    let scans = 0;
    const procReads = new Map<number, number>();
    const listeners = sys.listeners;
    const proc = sys.proc;
    sys.listeners = async () => (scans++, listeners());
    sys.proc = async (pid) => (procReads.set(pid, (procReads.get(pid) ?? 0) + 1), proc(pid));
    await scanProjects(sys, dirs);
    expect(scans).toBe(1);
    expect([procReads.get(60), procReads.get(61)]).toEqual([1, 1]);
  });

  it('reports unsupported off Linux and when the host cannot be scanned', async () => {
    const mac = makeSys({ 60: { listens: 3000 } }, { platform: 'darwin' });
    expect(await scanProjects(mac.sys, dirs)).toEqual({ supported: false, projects: {} });
    const blind = makeSys({ 60: { listens: 3000 } });
    blind.sys.listeners = async () => null;
    expect(await scanProjects(blind.sys, dirs)).toEqual({ supported: false, projects: {} });
  });

  it('never signals anything', async () => {
    const { sys, kills } = makeSys({ 60: { listens: 3000 } });
    await scanProjects(sys, dirs);
    expect(kills).toEqual([]);
  });
});

describe('scanProjects, aliases', () => {
  it('lists a listener once when a symlinked project name aliases a real folder', async () => {
    const { sys } = makeSys({ 60: { listens: 3000, cwd: '/r/api' } });
    const res = await scanProjects(sys, [
      { name: 'alias', dir: '/r/api' },
      { name: 'api', dir: '/r/api' },
    ]);
    expect(Object.keys(res.projects)).toEqual(['api']);
  });
});
