import { ChildProcess, spawn } from 'child_process';
import express from 'express';
import * as fs from 'fs';
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
const SERVER = "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log('LISTENING'));setInterval(()=>{},1e6)";

let base: string;
let root: string;
let outside: string;
const children: ChildProcess[] = [];

const app = (): express.Express => {
  const a = express();
  a.use(express.json());
  a.use('/api', createProjectsRouter(apiKeys, root, { sys: systemSys(), limiter: new StopLimiter(0) }));
  return a;
};
const del = (name = 'api', body: object = { confirm: name }, key = 'k-write') =>
  request(app()).delete(`/api/v1/projects/${name}`).set(as(key)).send(body);
const exists = (...p: string[]) => fs.existsSync(path.join(root, ...p));

function listen(cwd: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', SERVER], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout?.on('data', (d: Buffer) => d.toString().includes('LISTENING') && resolve(child));
    child.on('error', reject);
    child.on('exit', () => reject(new Error('child exited early')));
  });
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-')));
  root = path.join(base, 'projects');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'api', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'api', 'src', 'index.js'), 'x');
  fs.mkdirSync(path.join(root, 'keep'));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
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

describe('DELETE /api/v1/projects/:name', () => {
  it('removes the project and everything in it, and only that project', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'api' });
    expect(exists('api')).toBe(false);
    expect(exists('keep')).toBe(true);
    const list = await request(app()).get('/api/v1/projects').set(as('k-read'));
    expect(list.body.projects.map((p: { name: string }) => p.name)).toEqual(['keep']);
  });

  it('needs the exact name as confirmation', async () => {
    for (const body of [{}, { confirm: 'API' }, { confirm: 'keep' }, { confirm: true }]) {
      const res = await del('api', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('confirm_mismatch');
    }
    expect(exists('api', 'src', 'index.js')).toBe(true);
  });

  it('needs a key that can write and reach the whole pod', async () => {
    expect((await del('api', { confirm: 'api' }, 'k-read')).status).toBe(403);
    expect((await del('api', { confirm: 'api' }, 'k-agent')).status).toBe(403);
    expect(
      (await request(app()).delete('/api/v1/projects/api').send({ confirm: 'api' })).status,
    ).toBe(401);
    expect(exists('api')).toBe(true);
  });

  it('answers 404 for a project that is not there and 400 for a bad name', async () => {
    expect((await del('ghost')).status).toBe(404);
    const bad = await del('a b', { confirm: 'a b' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_name');
  });

  it('refuses while something listens from inside the project, and deletes once it stops', async () => {
    const child = await listen(path.join(root, 'api'));
    const blocked = await del();
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('project_running');
    expect(exists('api', 'src', 'index.js')).toBe(true);

    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    const res = await del();
    expect(res.status).toBe(200);
    expect(exists('api')).toBe(false);
  });

  it('removes a link inside the project without touching what it points to', async () => {
    fs.symlinkSync(outside, path.join(root, 'api', 'link-out'));
    expect((await del()).status).toBe(200);
    expect(exists('api')).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('will not follow a project that is a link out of the root', async () => {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const res = await del('escape');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('path_escape');
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
  });
});
