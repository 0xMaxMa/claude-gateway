import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createProjectsRouter } from '../../src/api/projects-router';
import { getRegisteredRoutes } from '../../src/api/route-registry';
import type { ApiKey } from '../../src/types';

const KEYS = {
  admin: { key: 'k-admin', agents: '*', admin: true },
  podWrite: { key: 'k-pod-write', agents: '*', write: true },
  podRead: { key: 'k-pod-read', agents: '*' },
  agentScoped: { key: 'k-agent', agents: ['alfred'], write: true },
} satisfies Record<string, ApiKey>;
const NON_ADMIN = [KEYS.podWrite, KEYS.podRead, KEYS.agentScoped];

let base: string;
let root: string;
let app: express.Express;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-admin-')));
  root = path.join(base, 'projects');
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  app = express();
  app.use(express.json());
  app.use('/api', createProjectsRouter(Object.values(KEYS), root));
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function projectRoutes() {
  createProjectsRouter([], '');
  return getRegisteredRoutes().filter((r) => r.path.startsWith('/v1/projects'));
}

const call = (method: string, route: string, key: ApiKey) =>
  (request(app) as unknown as Record<string, (u: string) => request.Test>)
    [method.toLowerCase()]!(`/api${route.replace(':name', 'app')}`)
    .set('Authorization', `Bearer ${key.key}`)
    .send({ name: 'created-by-test', confirm: 'app' });

describe('every /v1/projects route needs an admin key', () => {
  it('covers the routes the router registers', () => {
    const paths = projectRoutes().map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(expect.arrayContaining([
      'GET /v1/projects', 'POST /v1/projects', 'DELETE /v1/projects/:name', 'GET /v1/projects/:name/tree',
      'GET /v1/projects/:name/file', 'GET /v1/projects/git-summary', 'GET /v1/projects/running',
      'GET /v1/projects/:name/git', 'GET /v1/projects/:name/running',
      'POST /v1/projects/:name/running/stop', 'POST /v1/projects/:name/running/start',
    ]));
    expect(projectRoutes().every((r) => r.auth === 'admin')).toBe(true);
  });

  it.each(NON_ADMIN)('refuses $key on every route with 403 forbidden_key and touches nothing', async (key) => {
    for (const r of projectRoutes()) {
      const res = await call(r.method, r.path, key);
      expect([r.method, r.path, res.status, res.body.code]).toEqual([r.method, r.path, 403, 'forbidden_key']);
      expect(res.body.error).toMatch(/admin API key is required/);
    }
    expect(fs.readdirSync(root)).toEqual(['app']);
  });

  it('lets an admin key past the gate on every route', async () => {
    for (const r of projectRoutes()) {
      if (r.method === 'DELETE') continue;
      const res = await call(r.method, r.path, KEYS.admin);
      expect([r.method, r.path, res.status === 403 && res.body.code === 'forbidden_key']).toEqual([r.method, r.path, false]);
    }
    expect((await call('DELETE', '/v1/projects/:name', KEYS.admin)).status).toBe(200);
  });

  it('still answers a missing key with 401', async () => {
    expect((await request(app).get('/api/v1/projects')).status).toBe(401);
  });
});
