import { ChildProcess, spawn } from 'child_process';
import express from 'express';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createProcessesRouter } from '../../src/api/processes-router';
import { listeningPorts, parseProcNetTcp, readStartTicks } from '../../src/processes/listeners';
import { signalIfSame, stopTargets } from '../../src/processes/stop';
import type { ApiKey } from '../../src/types';
import { silentLogger } from '../helpers/silent-logger';

const apiKeys: ApiKey[] = [
  { key: 'k-admin', agents: '*', admin: true },
  { key: 'k-read', agents: '*' },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });

/** A server that listens on $PORT, run by `exec` so the listener is the session leader `sh` became. */
const LISTEN_SCRIPT = `exec node -e "require('net').createServer().listen(Number(process.env.PORT), '127.0.0.1')"\n`;

let base: string;
let root: string;
let logDir: string;
let app: express.Express;
const children: ChildProcess[] = [];
const startedPids: number[] = [];

function makeApp(portRange: [number, number] = [41000, 41010], timeoutMs = 8000): void {
  app = express();
  app.use(express.json());
  app.use('/api', createProcessesRouter(apiKeys, root, {
    logger: silentLogger, start: { logDir, portRange, timeoutMs, pollMs: 50, scriptPath: '.pod/start.sh' }, stop: { termWaitMs: 300, pollMs: 50 },
  }));
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'processes-router-')));
  root = path.join(base, 'projects');
  logDir = path.join(base, 'state', 'process-logs');
  fs.mkdirSync(root);
  makeApp();
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const pid of startedPids.splice(0)) {
    for (const target of [-pid, pid]) try { process.kill(target, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(base, { recursive: true, force: true });
});

function project(name: string, script?: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (script !== undefined) {
    fs.mkdirSync(path.join(dir, '.pod'));
    fs.writeFileSync(path.join(dir, '.pod', 'start.sh'), script);
  }
  return dir;
}

/** A real child process working in `cwd` that listens on `port` (0 for a random one); resolves with the port. */
function listenIn(cwd: string, port = 0, extraArgs: string[] = [], prelude = ''): Promise<{ port: number; pid: number }> {
  const code = `${prelude}const s=require('net').createServer().listen(${port},'127.0.0.1',()=>console.log(s.address().port))`;
  const child = spawn(process.execPath, ['-e', code, '--', ...extraArgs], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', (d) => resolve({ port: Number(String(d).trim()), pid: child.pid! }));
    child.once('exit', () => reject(new Error('listener exited')));
  });
}

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

const get = (rel: unknown, key = 'k-admin') => request(app).get('/api/v1/processes').query(rel === undefined ? {} : { path: rel }).set(as(key));
const start = async (body: object, key = 'k-admin') => {
  const res = await request(app).post('/api/v1/processes/start').set(as(key)).send(body);
  if (res.status === 202) startedPids.push(res.body.pid);
  return res;
};

const stop = (body: object, key = 'k-admin') => request(app).post('/api/v1/processes/stop').set(as(key)).send(body);

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('parseProcNetTcp', () => {
  it('reads LISTEN rows only and decodes v4 and v6 addresses', () => {
    const v4 = 'sl local rem st\n 0: 0100007F:1F90 00000000:0000 0A 0:0 0:0 0 1000 0 111 1\n 1: 0100007F:1F91 0100007F:9999 01 0:0 0:0 0 1000 0 112 1\n';
    const v6 = 'sl local rem st\n 0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1000 0 113 1\n'
      + ' 1: 00000000000000000000000001000000:0BB9 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1000 0 114 1\n';
    expect(parseProcNetTcp(v4, false)).toEqual([{ inode: '111', address: '127.0.0.1', port: 8080 }]);
    expect(parseProcNetTcp(v6, true)).toEqual([
      { inode: '113', address: '::', port: 3000 },
      { inode: '114', address: '::1', port: 3001 },
    ]);
  });
});

describe('path rejection', () => {
  beforeEach(() => {
    project('app', LISTEN_SCRIPT);
    fs.mkdirSync(path.join(base, 'outside'));
    fs.symlinkSync(path.join(root, 'app'), path.join(root, 'alias'));
    fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'out'));
  });

  it.each([
    ['../outside', 400, 'invalid_name'],
    ['app/../..', 400, 'invalid_name'],
    ['/etc', 400, 'invalid_path'],
    ['', 400, 'invalid_path'],
    ['alias', 409, 'symlink_in_path'],
    ['out', 403, 'path_escape'],
    ['missing', 404, 'not_found'],
  ])('GET and start refuse %j with %i %s', async (rel, status, code) => {
    for (const res of [await get(rel), await start({ path: rel }), await stop({ path: rel })]) {
      expect([res.status, res.body.code]).toEqual([status, code]);
    }
  });

  it('refuses a path that is not a single string', async () => {
    const res = await request(app).get('/api/v1/processes?path=app&path=app').set(as('k-admin'));
    expect([res.status, res.body.code]).toEqual([400, 'invalid_path']);
  });
});

describe('GET /v1/processes', () => {
  it('returns listeners grouped by folder in one root-wide request', async () => {
    const first = project('first');
    const second = project('second');
    const hidden = project('.hidden');
    fs.mkdirSync(path.join(first, 'nested'));
    const a = await listenIn(path.join(first, 'nested'));
    const b = await listenIn(second);
    const c = await listenIn(hidden);
    const result = await get(undefined);
    expect(result.status).toBe(200);
    expect(result.body.processes).toEqual([
      expect.objectContaining({ path: '.hidden', listeners: [expect.objectContaining({ port: c.port })] }),
      expect.objectContaining({ path: 'first', listeners: [expect.objectContaining({ port: a.port })] }),
      expect.objectContaining({ path: 'second', listeners: [expect.objectContaining({ port: b.port })] }),
    ]);
    expect((await get(undefined, 'k-read')).status).toBe(403);
  });

  it('lists the listener of a process working in the folder or inside it, and only there', async () => {
    const dir = project('app');
    fs.mkdirSync(path.join(dir, 'server'));
    project('other');
    const { port, pid } = await listenIn(path.join(dir, 'server'), 0, ['api_key=abcdef123456', 'plain-arg']);

    const res = await get('app');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      path: 'app',
      running: true,
      listeners: [{ port, pids: [pid], address: '127.0.0.1', command: expect.any(String) }],
    });
    expect(res.body.listeners[0].command).toContain('plain-arg');
    expect(res.body.listeners[0].command).not.toContain('abcdef123456');

    expect((await get('other')).body).toEqual({ path: 'other', running: false, listeners: [] });
  });

  it('needs an admin key, so a read-only key cannot see what runs on the pod', async () => {
    project('app');
    const res = await get('app', 'k-read');
    expect([res.status, res.body.code]).toEqual([403, 'forbidden_key']);
  });

  it('truncates a long command', async () => {
    const dir = project('app');
    await listenIn(dir, 0, Array.from({ length: 12 }, (_, i) => `arg${i}-${'y'.repeat(20)}`));
    const [listener] = (await get('app')).body.listeners;
    expect(listener.command.length).toBeLessThanOrEqual(200);
    expect(listener.command.endsWith('…')).toBe(true);
  });
});

describe('POST /v1/processes/start', () => {
  it('uses the configured script path and refuses an unset script', async () => {
    const dir = project('app');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'serve.sh'), LISTEN_SCRIPT);
    app = express();
    app.use(express.json());
    app.use('/api', createProcessesRouter(apiKeys, root, { logger: silentLogger, start: { scriptPath: 'scripts/serve.sh', logDir, timeoutMs: 8000, pollMs: 50 } }));
    expect((await start({ path: 'app', port: await freePort() })).status).toBe(202);
    app = express();
    app.use(express.json());
    app.use('/api', createProcessesRouter(apiKeys, root, { logger: silentLogger }));
    expect((await start({ path: 'app' })).body.code).toBe('no_start_command');
  });

  it('needs an admin key', async () => {
    project('app', LISTEN_SCRIPT);
    const res = await start({ path: 'app' }, 'k-read');
    expect([res.status, res.body.code]).toEqual([403, 'forbidden_key']);
  });

  it('refuses a folder without .pod/start.sh', async () => {
    project('app');
    const res = await start({ path: 'app' });
    expect([res.status, res.body.code]).toEqual([422, 'no_start_command']);
  });

  it('refuses a symlinked .pod and a symlinked start.sh', async () => {
    const dir = project('app');
    fs.mkdirSync(path.join(base, 'pod'));
    fs.writeFileSync(path.join(base, 'pod', 'start.sh'), LISTEN_SCRIPT);
    fs.symlinkSync(path.join(base, 'pod'), path.join(dir, '.pod'));
    expect((await start({ path: 'app' })).body.code).toBe('no_start_command');

    const dir2 = project('app2');
    fs.mkdirSync(path.join(dir2, '.pod'));
    fs.symlinkSync(path.join(base, 'pod', 'start.sh'), path.join(dir2, '.pod', 'start.sh'));
    const res = await start({ path: 'app2' });
    expect([res.status, res.body.code]).toEqual([422, 'no_start_command']);
  });

  it('refuses a port outside 1024..65535', async () => {
    project('app', LISTEN_SCRIPT);
    for (const port of [80, 70000, '3000', 1.5]) {
      expect((await start({ path: 'app', port })).body.code).toBe('invalid_port');
    }
  });

  it('starts on the first free port of the range and the server is then listed', async () => {
    const busy = await listenIn(base);
    makeApp([busy.port, busy.port + 20]);
    const expected = await (async () => {
      const ports = await listeningPorts();
      for (let p = busy.port; ; p++) if (!ports.has(p)) return p;
    })();
    project('app', LISTEN_SCRIPT);

    const res = await start({ path: 'app' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ path: 'app', port: expected, pid: expect.any(Number), running: true });
    const listed = (await get('app')).body;
    expect(listed.running).toBe(true);
    expect(listed.listeners.map((l: { port: number }) => l.port)).toEqual([expected]);
    expect(listed.listeners[0].pids).toContain(res.body.pid);
    // The log is the gateway's, private, and nothing was written into the project.
    const [log] = fs.readdirSync(logDir);
    expect(log).toMatch(/^[0-9a-f]{64}\.log$/);
    expect(fs.statSync(path.join(logDir, log)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(root, 'app'))).toEqual(['.pod']);
    expect(fs.readdirSync(path.join(root, 'app', '.pod'))).toEqual(['start.sh']);
  });

  it('starts on a given free port', async () => {
    project('app', LISTEN_SCRIPT);
    const port = await freePort();
    const res = await start({ path: 'app', port });
    expect([res.status, res.body.port]).toEqual([202, port]);
  });

  it('answers 409 port_in_use for a given busy port', async () => {
    const busy = await listenIn(base);
    project('app', LISTEN_SCRIPT);
    const res = await start({ path: 'app', port: busy.port });
    expect([res.status, res.body.code, res.body.port]).toEqual([409, 'port_in_use', busy.port]);
  });

  it('answers 409 no_free_port when every port of the range is busy', async () => {
    const busy = await listenIn(base);
    makeApp([busy.port, busy.port]);
    project('app', LISTEN_SCRIPT);
    const res = await start({ path: 'app' });
    expect([res.status, res.body.code]).toEqual([409, 'no_free_port']);
  });

  it('answers 409 already_running with the port when the folder already listens', async () => {
    const dir = project('app', LISTEN_SCRIPT);
    const running = await listenIn(dir);
    const res = await start({ path: 'app' });
    expect([res.status, res.body.code, res.body.port]).toEqual([409, 'already_running', running.port]);
  });

  it('answers 502 start_failed with the masked log tail when the script exits, and passes only the env allowlist', async () => {
    process.env.PROCESSES_TEST_SENTINEL = 'leaked-into-child';
    try {
      project('app', 'env\necho "token=hunter2hunter2"\necho boom >&2\nexit 3\n');
      const res = await start({ path: 'app' });
      expect([res.status, res.body.code]).toEqual([502, 'start_failed']);
      expect(res.body.log).toContain('boom');
      expect(res.body.log).toMatch(/^PORT=\d+$/m);
      expect(res.body.log).not.toContain('hunter2hunter2');
      expect(res.body.log).not.toContain('PROCESSES_TEST_SENTINEL');
    } finally {
      delete process.env.PROCESSES_TEST_SENTINEL;
    }
  });

  it('kills a script that never listens and answers 502', async () => {
    makeApp([41000, 41010], 500);
    project('app', 'echo started\nexec sleep 30\n');
    const res = await start({ path: 'app' });
    expect([res.status, res.body.code]).toEqual([502, 'start_failed']);
    expect(res.body.log).toContain('started');
    // The whole session was killed: no process is left working in the folder.
    const left = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
      try { return fs.realpathSync(`/proc/${p}/cwd`) === path.join(root, 'app'); } catch { return false; }
    });
    expect(left).toEqual([]);
  });

  it('holds a per-folder lock: a concurrent second start gets 409 already_running while the first runs', async () => {
    project('app', `sleep 1\n${LISTEN_SCRIPT}`);
    const [a, b] = await Promise.all([start({ path: 'app' }), start({ path: 'app' })]);
    const [won, lost] = a.status === 202 ? [a, b] : [b, a];
    expect(won.status).toBe(202);
    expect([lost.status, lost.body.code, lost.body.starting]).toEqual([409, 'already_running', true]);
    // Once it listens, a later start reports the port instead.
    const again = await start({ path: 'app' });
    expect([again.status, again.body.code, again.body.port]).toEqual([409, 'already_running', won.body.port]);
  });
});

describe('POST /v1/processes/stop', () => {
  it('needs an admin key', async () => {
    project('app');
    expect((await stop({ path: 'app' }, 'k-read')).status).toBe(403);
  });

  it('answers 200 with empty lists for a folder with no listeners', async () => {
    project('app');
    const res = await stop({ path: 'app' });
    expect([res.status, res.body]).toEqual([200, { path: 'app', stopped: [], remaining: [], running: false }]);
  });

  it('stops a real child listening in the folder and leaves other folders alone', async () => {
    const dir = project('app');
    const other = await listenIn(project('other'));
    const { port, pid } = await listenIn(dir);
    const res = await stop({ path: 'app' });
    expect([res.status, res.body]).toEqual([200, { path: 'app', stopped: [{ port, pids: [pid] }], remaining: [], running: false }]);
    expect((await get('app')).body.running).toBe(false);
    expect((await get('other')).body.listeners.map((l: { port: number }) => l.port)).toEqual([other.port]);
  });

  it('SIGKILLs a process that ignores SIGTERM', async () => {
    const dir = project('app');
    const { port, pid } = await listenIn(dir, 0, [], "process.on('SIGTERM',()=>{});");
    const res = await stop({ path: 'app' });
    expect(res.body).toEqual({ path: 'app', stopped: [{ port, pids: [pid] }], remaining: [], running: false });
  });

  it('signals nothing when the recorded start time no longer matches the pid', async () => {
    const dir = project('app');
    const { port, pid } = await listenIn(dir);
    const ticks = await readStartTicks(pid);
    expect(ticks).toMatch(/^\d+$/);
    const reused = { pid, startTicks: String(Number(ticks) + 1) };
    expect(await signalIfSame(reused, 'SIGTERM')).toBe(false);
    await stopTargets([reused], { termWaitMs: 200, pollMs: 50 });
    expect(alive(pid)).toBe(true);
    expect((await get('app')).body.listeners.map((l: { port: number }) => l.port)).toEqual([port]);
  });
});
