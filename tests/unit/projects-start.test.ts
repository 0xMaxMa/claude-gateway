import express from 'express';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createProjectsRouter } from '../../src/api/projects-router';
import { StopLimiter, systemSys } from '../../src/projects/running';
import { pickPort } from '../../src/projects/start';
import type { ApiKey } from '../../src/types';

const apiKeys: ApiKey[] = [
  { key: 'k-write', agents: '*', write: true, admin: true },
  { key: 'k-read', agents: '*' },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });

const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });
const SCRIPT = '.pod/start.sh';
const serve = 'exec node server.js\n';

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
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name, f)), { recursive: true });
      fs.writeFileSync(path.join(root, name, f), text);
    }
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
      // The start route runs the command detached, so it leads its own process group. Killing only the sh
      // pid leaves its `node server.js` child listening on a port in 3000-3099 after the suite ends.
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {
          // gone
        }
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('starts the project on the port, answers once it listens, and stop then ends it', async () => {
    project('web', { [SCRIPT]: serve, 'server.js': SERVER });
    const a = app();
    const port = await freePort();

    const res = await start(a, 'web', { port });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ port, command: `PORT=${port} sh .pod/start.sh` });
    pids.push(res.body.pid);

    const running = await request(a).get('/api/v1/projects/web/running').set(as('k-write'));
    expect(running.body.processes.map((p: { port: number }) => p.port)).toEqual([port]);

    const stopped = await request(a).post('/api/v1/projects/web/running/stop').set(as('k-write')).send({});
    expect(stopped.status).toBe(200);
    expect(stopped.body.remaining).toEqual([]);
    expect(alive(res.body.pid)).toBe(false);
  }, 20000);

  it('picks a free port itself when none is asked for', async () => {
    project('web', { [SCRIPT]: serve, 'server.js': SERVER });
    const res = await start(app(), 'web');
    expect(res.status).toBe(200);
    pids.push(res.body.pid);
    expect(res.body.port).toBeGreaterThanOrEqual(3000);
    expect(res.body.port).toBeLessThanOrEqual(3099);
  }, 20000);

  it('says already_running instead of starting a second server', async () => {
    project('web', { [SCRIPT]: serve, 'server.js': SERVER });
    const a = app();
    const first = await start(a, 'web', { port: await freePort() });
    pids.push(first.body.pid);
    const second = await start(a, 'web');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('already_running');
  }, 20000);

  it('refuses a port something else holds', async () => {
    project('web', { [SCRIPT]: serve, 'server.js': SERVER });
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

  it('has no command for a folder without a start script, even with a package.json that has one', async () => {
    project('site', { 'index.html': '<h1>hi</h1>', 'package.json': pkg({ start: 'node server.js' }) });
    const res = await start(app(), 'site');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('no_start_command');
    expect(res.body.error ?? res.body.message).toContain('no start script');
  });

  it('answers start_failed with what the process printed, credentials redacted', async () => {
    project('bad', {
      [SCRIPT]: 'exec node boom.js\n',
      'boom.js': "console.log('cannot bind, token ghp_abcdefghijklmnopqrstuvwxyz0123456789'); process.exit(1)",
    });
    const res = await start(app(), 'bad', { port: await freePort() });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('start_failed');
    expect(res.body.log).toContain('cannot bind');
    expect(res.body.log).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  }, 20000);

  it('says why a start failed before the process ran: a log folder that cannot be created', async () => {
    project('site', { [SCRIPT]: serve, 'server.js': SERVER });
    fs.writeFileSync(logs, 'a file where the log folder should be');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await start(app(), 'site', { port: await freePort() });
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ code: 'start_failed', reason: expect.stringMatching(/^E[A-Z]+$/) });
      expect(JSON.stringify(res.body)).not.toContain(base);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('start site failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('stops what it started when nothing listens in time', async () => {
    project('idle', { [SCRIPT]: 'exec node idle.js\n', 'idle.js': "console.log('up');setInterval(()=>{},1e6)" });
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

  it('tells GET /running whether the project has a start script', async () => {
    project('web', { [SCRIPT]: serve, 'index.html': 'x' });
    project('site', { 'index.html': 'x', 'package.json': pkg({ dev: 'vite' }) });
    const a = app();
    const web = await request(a).get('/api/v1/projects/web/running').set(as('k-write'));
    expect(web.body.start).toEqual({ command: 'sh .pod/start.sh' });
    const site = await request(a).get('/api/v1/projects/site/running').set(as('k-write'));
    expect(site.body.start).toBeNull();
  });

  it('hands the script PORT, and runs it from the project folder', async () => {
    project('web', { [SCRIPT]: 'echo "$PORT $(pwd)" > seen.txt\nexec node server.js\n', 'server.js': SERVER });
    const port = await freePort();
    const res = await start(app(), 'web', { port });
    expect(res.status).toBe(200);
    pids.push(res.body.pid);
    expect(fs.readFileSync(path.join(root, 'web', 'seen.txt'), 'utf8').trim()).toBe(`${port} ${path.join(root, 'web')}`);
  }, 20000);

  it('refuses a script that is a symlink, even to a file inside the project', async () => {
    project('web', { 'real.sh': serve, 'server.js': SERVER });
    fs.mkdirSync(path.join(root, 'web', '.pod'));
    fs.symlinkSync(path.join(root, 'web', 'real.sh'), path.join(root, 'web', SCRIPT));
    const a = app();
    expect((await start(a, 'web')).body.code).toBe('no_start_command');
    expect((await request(a).get('/api/v1/projects/web/running').set(as('k-write'))).body.start).toBeNull();
  });

  it('refuses a script over 64 KiB and accepts one at the limit', async () => {
    const pad = (n: number) => `${serve}#${'x'.repeat(n - serve.length - 1)}`;
    project('big', { [SCRIPT]: pad(64 * 1024 + 1), 'server.js': SERVER });
    expect((await start(app(), 'big')).body.code).toBe('no_start_command');
    project('edge', { [SCRIPT]: pad(64 * 1024), 'server.js': SERVER });
    const res = await start(app(), 'edge', { port: await freePort() });
    expect(res.status).toBe(200);
    pids.push(res.body.pid);
  }, 20000);

  it('refuses a script whose folder is a symlink out of the project', async () => {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'start.sh'), serve);
    project('web', { 'server.js': SERVER });
    fs.symlinkSync(outside, path.join(root, 'web', '.pod'));
    expect((await start(app(), 'web')).body.code).toBe('no_start_command');
  });

  it('needs a write key, and a name that exists', async () => {
    project('web', { [SCRIPT]: serve, 'server.js': SERVER });
    expect((await start(app(), 'web', {}, 'k-read')).status).toBe(403);
    expect((await start(app(), 'ghost')).status).toBe(404);
  });
});
