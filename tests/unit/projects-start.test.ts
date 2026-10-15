import express from 'express';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createProjectsRouter } from '../../src/api/projects-router';
import { StopLimiter, systemSys } from '../../src/projects/running';
import { pickPort, planStart, StartFacts } from '../../src/projects/start';
import type { ApiKey } from '../../src/types';

const apiKeys: ApiKey[] = [
  { key: 'k-write', agents: '*', write: true, admin: true },
  { key: 'k-read', agents: '*' },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });

const facts = (over: Partial<Omit<StartFacts, 'rootNames'>> & { names?: string[] } = {}): StartFacts => ({
  packageJson: over.packageJson ?? null,
  rootNames: new Set(over.names ?? []),
  mainPy: over.mainPy ?? null,
  appPy: over.appPy ?? null,
});
const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

describe('planStart', () => {
  it('pins the port and host for vite, astro and next, by what the script runs', () => {
    expect(planStart(facts({ packageJson: pkg({ dev: 'vite' }) }))?.command(3001)).toEqual({
      file: 'npm',
      args: ['run', 'dev', '--', '--port', '3001', '--strictPort', '--host', '0.0.0.0'],
      env: { PORT: '3001' },
    });
    expect(planStart(facts({ packageJson: pkg({ dev: 'astro dev' }) }))?.command(3001).args).toEqual(['run', 'dev', '--', '--port', '3001', '--host', '0.0.0.0']);
    expect(planStart(facts({ packageJson: pkg({ dev: 'next dev' }) }))?.command(3001).args).toEqual(['run', 'dev', '--', '-p', '3001', '-H', '0.0.0.0']);
  });

  it('gives an unknown script only PORT, and never an argument it might choke on', () => {
    const plan = planStart(facts({ packageJson: pkg({ start: 'node server.js' }) }));
    expect(plan?.command(3005)).toEqual({ file: 'npm', args: ['run', 'start'], env: { PORT: '3005' } });
    expect(plan?.display(3005)).toBe('PORT=3005 npm run start');
  });

  it('prefers dev over start, and uses the lockfile runner without npm-style --', () => {
    const plan = planStart(facts({ packageJson: pkg({ start: 'node .', dev: 'vite' }), names: ['yarn.lock'] }));
    expect(plan?.command(3001)).toMatchObject({ file: 'yarn', args: ['run', 'dev', '--port', '3001', '--strictPort', '--host', '0.0.0.0'] });
  });

  it('runs a FastAPI app in its .venv, and only then', () => {
    const main = 'from fastapi import FastAPI\napp = FastAPI()\n';
    expect(planStart(facts({ mainPy: main, names: ['.venv', 'main.py'] }))?.command(3002)).toEqual({
      file: '.venv/bin/uvicorn',
      args: ['main:app', '--host', '0.0.0.0', '--port', '3002'],
      env: {},
    });
    expect(planStart(facts({ mainPy: main, names: ['main.py'] }))).toBeNull();
    expect(planStart(facts({ mainPy: 'print("hi")', names: ['.venv'] }))).toBeNull();
  });

  it('has no plan for what only says it exists: notes, a static page, build-only scripts, broken json', () => {
    expect(planStart(facts())).toBeNull();
    expect(planStart(facts({ names: ['index.html', 'README.md'] }))).toBeNull();
    expect(planStart(facts({ packageJson: pkg({ build: 'tsc', test: 'jest' }) }))).toBeNull();
    expect(planStart(facts({ packageJson: '{nope' }))).toBeNull();
    expect(planStart(facts({ packageJson: '{"scripts":{"dev":5}}' }))).toBeNull();
  });
});

describe('pickPort', () => {
  it('takes the first free port from 3000, skipping the taken ones', () => {
    expect(pickPort(new Set())).toEqual({ ok: true, value: 3000 });
    expect(pickPort(new Set([3000, 3001, 3003]))).toEqual({ ok: true, value: 3002 });
  });

  it('refuses a wanted port that is taken, and a range with nothing free', () => {
    expect(pickPort(new Set([4000]), 4000)).toEqual({ ok: false, error: 'port_in_use' });
    expect(pickPort(new Set(), 70000)).toEqual({ ok: false, error: 'invalid_port' });
    const all = new Set(Array.from({ length: 100 }, (_, i) => 3000 + i));
    expect(pickPort(all)).toEqual({ ok: false, error: 'no_free_port' });
  });
});

describe('POST /v1/projects/:name/running/start', () => {
  let base: string;
  let root: string;
  let logs: string;
  const pids: number[] = [];

  const SERVER = "require('http').createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');";

  const app = (startWaitMs = 8000) => {
    const a = express();
    a.use(express.json());
    a.use('/api', createProjectsRouter(apiKeys, root, { sys: systemSys(), limiter: new StopLimiter(0), logDir: logs, startWaitMs }));
    return a;
  };
  const project = (name: string, files: Record<string, string>) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name, f), text);
  };
  const start = (a: express.Express, name: string, body: object = {}, key = 'k-write') =>
    request(a).post(`/api/v1/projects/${name}/running/start`).set(as(key)).send(body);
  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as net.AddressInfo;
        s.close(() => resolve(port));
      });
    });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z';
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'start-')));
    root = path.join(base, 'projects');
    logs = path.join(base, 'logs');
    fs.mkdirSync(root);
  });

  afterEach(async () => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('starts the project on the port, answers once it listens, and stop then ends it', async () => {
    project('web', { 'package.json': pkg({ start: 'node server.js' }), 'server.js': SERVER });
    const a = app();
    const port = await freePort();

    const res = await start(a, 'web', { port });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ port, command: `PORT=${port} npm run start` });
    pids.push(res.body.pid);

    const running = await request(a).get('/api/v1/projects/web/running').set(as('k-write'));
    expect(running.body.processes.map((p: { port: number }) => p.port)).toEqual([port]);

    const stopped = await request(a).post('/api/v1/projects/web/running/stop').set(as('k-write')).send({});
    expect(stopped.status).toBe(200);
    expect(stopped.body.remaining).toEqual([]);
    expect(alive(res.body.pid)).toBe(false);
  }, 20000);

  it('picks a free port itself when none is asked for', async () => {
    project('web', { 'package.json': pkg({ start: 'node server.js' }), 'server.js': SERVER });
    const res = await start(app(), 'web');
    expect(res.status).toBe(200);
    pids.push(res.body.pid);
    expect(res.body.port).toBeGreaterThanOrEqual(3000);
    expect(res.body.port).toBeLessThanOrEqual(3099);
  }, 20000);

  it('says already_running instead of starting a second server', async () => {
    project('web', { 'package.json': pkg({ start: 'node server.js' }), 'server.js': SERVER });
    const a = app();
    const first = await start(a, 'web', { port: await freePort() });
    pids.push(first.body.pid);
    const second = await start(a, 'web');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('already_running');
  }, 20000);

  it('refuses a port something else holds', async () => {
    project('web', { 'package.json': pkg({ start: 'node server.js' }), 'server.js': SERVER });
    const held = net.createServer();
    await new Promise<void>((r) => held.listen(0, '0.0.0.0', r));
    const { port } = held.address() as net.AddressInfo;
    try {
      const res = await start(app(), 'web', { port });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('port_in_use');
    } finally {
      held.close();
    }
  });

  it('has no command for a folder whose files do not say how to run it', async () => {
    project('site', { 'index.html': '<h1>hi</h1>' });
    const res = await start(app(), 'site');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('no_start_command');
  });

  it('answers start_failed with what the process printed, credentials redacted', async () => {
    project('bad', {
      'package.json': pkg({ start: 'node boom.js' }),
      'boom.js': "console.log('cannot bind, token ghp_abcdefghijklmnopqrstuvwxyz0123456789'); process.exit(1)",
    });
    const res = await start(app(), 'bad', { port: await freePort() });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('start_failed');
    expect(res.body.log).toContain('cannot bind');
    expect(res.body.log).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  }, 20000);

  it('stops what it started when nothing listens in time', async () => {
    project('idle', { 'package.json': pkg({ start: 'node idle.js' }), 'idle.js': "console.log('up');setInterval(()=>{},1e6)" });
    const res = await start(app(1000), 'idle', { port: await freePort() });
    expect(res.status).toBe(504);
    expect(res.body.code).toBe('start_timeout');
    expect(res.body.log).toContain('up');
    await new Promise((r) => setTimeout(r, 500));
    const procs = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
    const leftover = procs.filter((pid) => {
      try {
        return fs.readlinkSync(`/proc/${pid}/cwd`) === path.join(root, 'idle');
      } catch {
        return false;
      }
    });
    expect(leftover.filter((pid) => alive(Number(pid)))).toEqual([]);
  }, 20000);

  it('tells GET /running whether the project can be started, and how', async () => {
    project('web', { 'package.json': pkg({ dev: 'vite' }) });
    project('site', { 'index.html': 'x' });
    const a = app();
    const web = await request(a).get('/api/v1/projects/web/running').set(as('k-write'));
    expect(web.body.start).toEqual({ command: 'npm run dev -- --port 3000 --strictPort --host 0.0.0.0' });
    const site = await request(a).get('/api/v1/projects/site/running').set(as('k-write'));
    expect(site.body.start).toBeNull();
  });

  it('needs a write key, and a name that exists', async () => {
    project('web', { 'package.json': pkg({ start: 'node server.js' }), 'server.js': SERVER });
    expect((await start(app(), 'web', {}, 'k-read')).status).toBe(403);
    expect((await start(app(), 'ghost')).status).toBe(404);
  });
});
