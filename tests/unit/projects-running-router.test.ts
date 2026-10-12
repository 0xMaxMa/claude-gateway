import { ChildProcess, spawn, spawnSync } from 'child_process';
import express from 'express';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createProjectsRouter } from '../../src/api/projects-router';
import { StopLimiter, systemSys } from '../../src/projects/running';
import type { ApiKey } from '../../src/types';

const apiKeys: ApiKey[] = [
  { key: 'k-write', agents: '*', write: true },
  { key: 'k-read', agents: '*' },
  { key: 'k-agent', agents: ['alfred'], write: true },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });

const SERVER = "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log('PORT '+s.address().port));setInterval(()=>{},1e6)";
const IDLE = "console.log('READY');setInterval(()=>{},1e6)";

let base: string;
let root: string;
let outside: string;
const children: ChildProcess[] = [];

function start(cmd: string, args: string[], cwd: string, opts: { detached?: boolean } = {}): Promise<{ child: ChildProcess; port: number | null }> {
  const child = spawn(cmd, args, { cwd, detached: opts.detached ?? false, stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /PORT (\d+)/.exec(buf);
      if (m) resolve({ child, port: Number(m[1]) });
      else if (buf.includes('READY')) resolve({ child, port: null });
    });
    child.on('error', reject);
    child.on('exit', () => reject(new Error('child exited early: ' + buf)));
  });
}

const alive = (pid: number | undefined): boolean => {
  try {
    process.kill(pid as number, 0);
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z';
  } catch {
    return false;
  }
};

const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
  });

function app(sys = systemSys(), limiter = new StopLimiter(0)): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/api', createProjectsRouter(apiKeys, root, { sys, limiter }));
  return a;
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'running-')));
  root = path.join(base, 'projects');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'api'), { recursive: true });
  fs.mkdirSync(path.join(root, 'api-v2'));
  fs.mkdirSync(outside);
});

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      process.kill(c.pid as number, 'SIGKILL');
    } catch {
      // gone
    }
  }
  fs.rmSync(base, { recursive: true, force: true });
});

const get = (a: express.Express, name = 'api', key = 'k-read') => request(a).get(`/api/v1/projects/${name}/running`).set(as(key));
const stop = (a: express.Express, body: object = {}, name = 'api', key = 'k-write') =>
  request(a).post(`/api/v1/projects/${name}/running/stop`).set(as(key)).send(body);

const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  for (let t = 0; t < ms; t += 50) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

const hasPython = spawnSync('python3', ['--version']).status === 0;
const PY = (dir: string) => ['-m', 'http.server', '0', '--bind', '127.0.0.1', '--directory', dir];
const NODE_ARGV = (extra: string) => ['-e', SERVER, extra];

async function listOf(a: express.Express) {
  return (await get(a)).body.processes as Array<{ port: number; pids: number[]; via: string; command: string }>;
}

describe('running routes, argv-matched listeners', () => {
  it('lists and stops a node server with cwd /tmp that names the project by a plain absolute path', async () => {
    const dir = path.join(root, 'api');
    const { child, port } = await start('node', NODE_ARGV(dir), outside);
    const a = app();
    const listed = await listOf(a);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ port, pids: [child.pid], via: 'argv' });
    const res = await stop(a, { port });
    expect(res.body).toEqual({ stopped: [{ port, pids: [child.pid] }], remaining: [] });
    expect(await until(() => !alive(child.pid))).toBe(true);
    expect(await portOpen(port as number)).toBe(false);
  });

  (hasPython ? it : it.skip)('lists and stops python -m http.server --directory <project> started from another cwd', async () => {
    const dir = path.join(root, 'api');
    const child = spawn('python3', PY(dir), { cwd: outside, stdio: 'ignore' });
    children.push(child);
    const a = app();
    expect(await until(async () => (await listOf(a)).length === 1)).toBe(true);
    const [entry] = await listOf(a);
    expect(entry).toMatchObject({ pids: [child.pid], via: 'argv' });
    expect((await stop(a, { port: entry.port })).body.remaining).toEqual([]);
    expect(await until(() => !alive(child.pid))).toBe(true);
  });

  it('does not match a sibling project whose name shares the prefix', async () => {
    const { child } = await start('node', NODE_ARGV(path.join(root, 'api-v2')), outside);
    const a = app();
    expect(await listOf(a)).toEqual([]);
    expect((await stop(a)).status).toBe(409);
    expect(alive(child.pid)).toBe(true);
  });

  it('does not match a relative path or a .. escape', async () => {
    const rel = await start('node', NODE_ARGV('api/x'), root);
    const esc = await start('node', NODE_ARGV(path.join(root, 'api', '..', 'api-v2')), outside);
    const a = app();
    expect(await listOf(a)).toEqual([]);
    expect((await stop(a)).status).toBe(409);
    expect(alive(rel.child.pid) && alive(esc.child.pid)).toBe(true);
  });

  it('follows a symlink only when its realpath is inside the project', async () => {
    fs.symlinkSync(path.join(root, 'api'), path.join(outside, 'into'));
    fs.symlinkSync(outside, path.join(root, 'api', 'out'));
    const inside = await start('node', NODE_ARGV(path.join(outside, 'into')), outside);
    const leaving = await start('node', NODE_ARGV(path.join(root, 'api', 'out')), outside);
    const a = app();
    expect((await listOf(a)).map((p) => p.pids)).toEqual([[inside.child.pid]]);
    await stop(a);
    expect(await until(() => !alive(inside.child.pid))).toBe(true);
    expect(alive(leaving.child.pid)).toBe(true);
  });

  it('leaves a non-listening process with the project in argv untouched', async () => {
    const idle = await start('node', ['-e', IDLE, path.join(root, 'api')], outside);
    const a = app();
    expect(await listOf(a)).toEqual([]);
    expect((await stop(a)).status).toBe(409);
    expect(alive(idle.child.pid)).toBe(true);
  });

  it('leaves a listener named claude untouched when argv names the project', async () => {
    const bin = path.join(base, 'claude');
    fs.copyFileSync(process.execPath, bin);
    fs.chmodSync(bin, 0o755);
    const { child } = await start(bin, NODE_ARGV(path.join(root, 'api')), outside);
    const a = app();
    expect(await listOf(a)).toEqual([]);
    expect((await stop(a)).status).toBe(409);
    expect(alive(child.pid)).toBe(true);
  });

  it('never selects the gateway pid when argv names the project', async () => {
    const { child } = await start('node', NODE_ARGV(path.join(root, 'api')), outside);
    const a = app(systemSys({ selfPid: child.pid }));
    expect(await listOf(a)).toEqual([]);
    expect((await stop(a)).status).toBe(409);
    expect(alive(child.pid)).toBe(true);
  });

  it('redacts secrets in the command of an argv match', async () => {
    const script = path.join(base, 's.js');
    fs.writeFileSync(script, SERVER);
    await start('node', [script, path.join(root, 'api'), '--token', 'hunter2'], outside);
    const [entry] = await listOf(app());
    expect(entry.command).toContain('--token [redacted]');
    expect(entry.command).not.toContain('hunter2');
  });
});

describe('running routes', () => {
  it('lists a real listener in the project and stop ends it and closes the port', async () => {
    const { child, port } = await start('node', ['-e', SERVER], path.join(root, 'api'));
    const a = app();
    const res = await get(a);
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(true);
    expect(res.body.processes).toEqual([{ port, pids: [child.pid], command: `node -e ${SERVER}`.slice(0, 120), address: '127.0.0.1', via: 'cwd' }]);

    const stopped = await stop(a, { port });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ stopped: [{ port, pids: [child.pid] }], remaining: [] });
    expect(await until(() => !alive(child.pid))).toBe(true);
    expect(await portOpen(port as number)).toBe(false);
  });

  it('stops all of the project listeners when no port is given, with their descendants', async () => {
    const script = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(IDLE)}],{stdio:'inherit'});console.log('child '+c.pid);${SERVER}`;
    const { child, port } = await start('node', ['-e', script], path.join(root, 'api'));
    const kids = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(' ').map(Number);
    expect(kids).toHaveLength(1);
    const res = await stop(app());
    expect(res.body.stopped).toEqual([{ port, pids: [child.pid] }]);
    expect(await until(() => !alive(child.pid) && !alive(kids[0]))).toBe(true);
  });

  it('leaves a listener whose cwd is outside the project untouched', async () => {
    const { child } = await start('node', ['-e', SERVER], outside);
    const a = app();
    expect((await get(a)).body.processes).toEqual([]);
    expect((await stop(a)).status).toBe(409);
    expect(alive(child.pid)).toBe(true);
  });

  it('leaves a sibling project sharing the name prefix untouched', async () => {
    const { child } = await start('node', ['-e', SERVER], path.join(root, 'api-v2'));
    const a = app();
    expect((await get(a)).body.processes).toEqual([]);
    expect(await stop(a)).toMatchObject({ status: 409, body: { code: 'nothing_running' } });
    expect(alive(child.pid)).toBe(true);
  });

  it('does not follow a symlink inside the project to a listener running outside', async () => {
    fs.symlinkSync(outside, path.join(root, 'api', 'link'));
    const { child } = await start('node', ['-e', SERVER], path.join(root, 'api', 'link'));
    const a = app();
    expect((await get(a)).body.processes).toEqual([]);
    expect((await stop(a)).status).toBe(409);
    expect(alive(child.pid)).toBe(true);
  });

  it('leaves a non-listening process in the project (the chat agent) untouched', async () => {
    const agent = await start('node', ['-e', IDLE], path.join(root, 'api'));
    const srv = await start('node', ['-e', SERVER], path.join(root, 'api'));
    const a = app();
    expect((await get(a)).body.processes.map((p: { port: number }) => p.port)).toEqual([srv.port]);
    await stop(a);
    expect(await until(() => !alive(srv.child.pid))).toBe(true);
    expect(alive(agent.child.pid)).toBe(true);
    expect((await stop(a)).status).toBe(409);
    expect(alive(agent.child.pid)).toBe(true);
  });

  it('never signals an agent binary named claude, even when it listens in the project', async () => {
    const bin = path.join(base, 'claude');
    fs.copyFileSync(process.execPath, bin);
    fs.chmodSync(bin, 0o755);
    const { child } = await start(bin, ['-e', SERVER], path.join(root, 'api'));
    const a = app();
    expect((await get(a)).body.processes).toEqual([]);
    expect((await stop(a)).status).toBe(409);
    expect(alive(child.pid)).toBe(true);
  });

  it('never selects the gateway pid even if it listens in the project', async () => {
    const { child } = await start('node', ['-e', SERVER], path.join(root, 'api'));
    const a = app(systemSys({ selfPid: child.pid }));
    expect((await get(a)).body.processes).toEqual([]);
    expect((await stop(a)).status).toBe(409);
    expect(alive(child.pid)).toBe(true);
  });

  it('signals the listener pid, not its process group', async () => {
    const script = `cd ${path.join(root, 'api')} && node -e "${SERVER.replace(/"/g, '\\"')}" & sleep 60`;
    const { child: leader, port } = await start('sh', ['-c', script], outside, { detached: true });
    expect(port).not.toBeNull();
    const a = app();
    const listed = (await get(a)).body.processes;
    expect(listed).toHaveLength(1);
    const srvPid = listed[0].pids[0];
    expect(srvPid).not.toBe(leader.pid);
    await stop(a);
    expect(await until(() => !alive(srvPid))).toBe(true);
    expect(alive(leader.pid)).toBe(true);
  });

  it('SIGKILLs a listener that ignores SIGTERM', async () => {
    const stubborn = "process.on('SIGTERM',()=>{});" + SERVER;
    const { child, port } = await start('node', ['-e', stubborn], path.join(root, 'api'));
    const res = await stop(app(), { port });
    expect(res.body).toEqual({ stopped: [{ port, pids: [child.pid] }], remaining: [] });
    expect(await until(() => !alive(child.pid))).toBe(true);
  });

  it('ignores a second stop inside the rate window', async () => {
    const a = app(systemSys(), new StopLimiter(60_000));
    const first = await start('node', ['-e', SERVER], path.join(root, 'api'));
    expect((await stop(a)).status).toBe(200);
    expect(await until(() => !alive(first.child.pid))).toBe(true);
    const second = await start('node', ['-e', SERVER], path.join(root, 'api'));
    const res = await stop(a);
    expect(res.status).toBe(200);
    expect(res.body.stopped).toEqual([]);
    expect(res.body.remaining).toEqual([{ port: second.port, pids: [second.child.pid] }]);
    expect(alive(second.child.pid)).toBe(true);
  });

  it('reports unsupported on a non-Linux platform and does not stop anything', async () => {
    const { child } = await start('node', ['-e', SERVER], path.join(root, 'api'));
    const a = app(systemSys({ platform: 'darwin' }));
    expect((await get(a)).body).toEqual({ supported: false, processes: [] });
    expect((await stop(a)).status).toBe(409);
    expect(alive(child.pid)).toBe(true);
  });

  it('applies the project route guards', async () => {
    const a = app();
    expect((await get(a, '..%2Fx')).status).toBe(400);
    expect((await get(a, 'nope')).status).toBe(404);
    expect((await get(a, 'api', 'k-agent')).status).toBe(403);
    expect((await get(a, "api", "bad")).status).toBe(403);
    expect((await stop(a, {}, 'api', 'k-read')).status).toBe(403);
    expect((await stop(a, {}, 'api', 'k-agent')).status).toBe(403);
    expect((await stop(a, {}, 'nope')).status).toBe(404);
    expect((await stop(a, { port: 'x' })).body.code).toBe('invalid_port');
    expect((await stop(a, { port: 70000 })).status).toBe(400);
    expect((await get(a, 'api')).body).toEqual({ supported: true, processes: [] });
  });

  it('refuses a project that is a symlink out of the root', async () => {
    fs.symlinkSync(outside, path.join(root, 'sneaky'));
    const { child } = await start('node', ['-e', SERVER], outside);
    const a = app();
    expect((await get(a, 'sneaky')).status).toBe(403);
    expect((await stop(a, {}, 'sneaky')).status).toBe(403);
    expect(alive(child.pid)).toBe(true);
  });
});
