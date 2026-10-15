import express from 'express';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createProjectsRouter } from '../../src/api/projects-router';
import { StopLimiter, systemSys } from '../../src/projects/running';
import type { Launcher } from '../../src/projects/start';

const keys = [{ key: 'k', agents: '*' as const, admin: true }];
const H = { Authorization: 'Bearer k' };

let base: string;
let root: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-delete-start-')));
  root = path.join(base, 'projects');
  fs.mkdirSync(path.join(root, 'site'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
});
afterEach(() => {
  jest.restoreAllMocks();
  child?.kill('SIGKILL');
  fs.rmSync(base, { recursive: true, force: true });
});

function appWith(launcher: Launcher, startWaitMs: number): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', createProjectsRouter(keys, root, {
    sys: systemSys(), limiter: new StopLimiter(0), launcher, startWaitMs, logDir: path.join(base, 'logs'), chatTurnActive: () => false,
  }));
  return app;
}

it('refuses a start that arrives while the delete is mid-rename, and launches nothing', async () => {
  const launched: string[] = [];
  const app = appWith(async (_cmd, cwd) => { launched.push(cwd); return { pid: 999999, exitCode: () => 1 }; }, 50);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atRename = new Promise<void>((resolve) => { reached = resolve; });
  const realRename = fs.promises.rename.bind(fs.promises);
  jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (path.basename(String(to)).startsWith('.deleting-')) { reached(); await gate; }
    return realRename(from, to);
  });
  const deleting = Promise.resolve(request(app).delete('/api/v1/projects/site').set(H).send({ confirm: 'site' }));
  await atRename;
  const start = await request(app).post('/api/v1/projects/site/running/start').set(H).send({});
  release();
  expect([start.status, start.body.code]).toEqual([409, 'project_deleting']);
  expect((await deleting).status).toBe(200);
  expect(launched).toEqual([]);
});

it('answers 409 project_running to a delete while a started project is still booting, and keeps the folder', async () => {
  const launcher: Launcher = async (_cmd, cwd) => {
    child = spawn('sleep', ['4'], { cwd, stdio: 'ignore' });
    return { pid: child.pid!, exitCode: () => child!.exitCode };
  };
  const app = appWith(launcher, 2000);
  const starting = Promise.resolve(request(app).post('/api/v1/projects/site/running/start').set(H).send({}));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const del = await request(app).delete('/api/v1/projects/site').set(H).send({ confirm: 'site' });
  expect([del.status, del.body.code]).toEqual([409, 'project_running']);
  expect(fs.existsSync(path.join(root, 'site', 'package.json'))).toBe(true);
  await starting;
});

it('releases the deleting mark when the guard throws', async () => {
  const app = express();
  app.use(express.json());
  let fail = true;
  app.use('/api', createProjectsRouter(keys, root, {
    sys: systemSys(), limiter: new StopLimiter(0),
    chatTurnActive: () => { if (fail) { fail = false; throw new Error('boom'); } return false; },
  }));
  expect((await request(app).delete('/api/v1/projects/site').set(H).send({ confirm: 'site' })).status).toBe(500);
  expect((await request(app).delete('/api/v1/projects/site').set(H).send({ confirm: 'site' })).status).toBe(200);
});
