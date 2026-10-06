import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createProjectsRouter } from '../../src/api/projects-router';
import type { ApiKey } from '../../src/types';

const apiKeys: ApiKey[] = [
  { key: 'k-admin', agents: ['alfred'], admin: true },
  { key: 'k-pod-write', agents: '*', write: true },
  { key: 'k-pod-read', agents: '*' },
  { key: 'k-agent', agents: ['alfred'], write: true },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });
const POD = as('k-pod-write');

let base: string;
let root: string;
let app: express.Express;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-router-')));
  root = path.join(base, 'projects');
  app = express();
  app.use(express.json());
  app.use('/api', createProjectsRouter(apiKeys, root));
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function seed(): void {
  fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'README.md'), '# hi\n');
}

describe('auth', () => {
  const routes: Array<[string, (a: request.Agent | ReturnType<typeof request>) => request.Test]> = [
    ['GET /projects', (r) => r.get('/api/v1/projects')],
    ['POST /projects', (r) => r.post('/api/v1/projects').send({ name: 'x' })],
    ['GET tree', (r) => r.get('/api/v1/projects/app/tree')],
    ['GET file', (r) => r.get('/api/v1/projects/app/file?path=README.md')],
  ];

  it.each(routes)('%s refuses an agent-scoped key with 403 forbidden_key', async (_label, call) => {
    seed();
    const res = await call(request(app)).set(as('k-agent'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden_key');
  });

  it.each(routes)('%s requires a key', async (_label, call) => {
    expect((await call(request(app))).status).toBe(401);
  });

  it('a pod key without write can read but not create', async () => {
    seed();
    const read = as('k-pod-read');
    expect((await request(app).get('/api/v1/projects').set(read)).status).toBe(200);
    expect((await request(app).get('/api/v1/projects/app/tree').set(read)).status).toBe(200);
    expect((await request(app).get('/api/v1/projects/app/file?path=README.md').set(read)).status).toBe(200);
    const res = await request(app).post('/api/v1/projects').set(read).send({ name: 'new' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden_key');
    expect(fs.existsSync(path.join(root, 'new'))).toBe(false);
  });

  it('an admin key may create', async () => {
    const res = await request(app).post('/api/v1/projects').set(as('k-admin')).send({ name: 'new' });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/v1/projects', () => {
  it('reports a missing root without creating it', async () => {
    const res = await request(app).get('/api/v1/projects').set(POD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root, exists: false, projects: [] });
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe('POST /api/v1/projects', () => {
  it('creates, then 409s a duplicate while keeping the first project intact', async () => {
    const first = await request(app).post('/api/v1/projects').set(POD).send({ name: 'app' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      project: { name: 'app', path: path.join(root, 'app'), modified_at: expect.any(String), is_git: false },
    });
    fs.writeFileSync(path.join(root, 'app', 'work.txt'), 'unsaved work');

    const second = await request(app).post('/api/v1/projects').set(POD).send({ name: 'app', git_init: true });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: expect.any(String), code: 'project_exists' });
    expect(fs.readFileSync(path.join(root, 'app', 'work.txt'), 'utf8')).toBe('unsaved work');
    expect(fs.existsSync(path.join(root, 'app', '.git'))).toBe(false);
  });

  it('git_init creates a repository', async () => {
    const res = await request(app).post('/api/v1/projects').set(POD).send({ name: 'repo', git_init: true });
    expect(res.status).toBe(201);
    expect(res.body.project.is_git).toBe(true);
    expect(res.body.warning).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'repo', '.git', 'HEAD'))).toBe(true);
  });

  it.each(['../x', 'a/b', '.', 'a'.repeat(65), '', undefined])('rejects name %p with 400 invalid_name', async (name) => {
    const res = await request(app).post('/api/v1/projects').set(POD).send({ name });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_name');
    expect(fs.existsSync(path.join(base, 'x'))).toBe(false);
  });
});

describe('GET /api/v1/projects/:name/tree and /file', () => {
  it.each(['../../etc/passwd', '%2e%2e/%2e%2e/etc/passwd', '%2Fetc%2Fpasswd', 'a%00b', 'src/../..'])(
    'rejects path=%s with 400 invalid_path',
    async (p) => {
      seed();
      for (const route of ['tree', 'file']) {
        const res = await request(app).get(`/api/v1/projects/app/${route}?path=${p}`).set(POD);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_path');
      }
    },
  );

  it('rejects an encoded traversal in the project name', async () => {
    const res = await request(app).get('/api/v1/projects/..%2F..%2Fetc/file?path=passwd').set(POD);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_name');
  });

  it('refuses to read a symlink to /etc/passwd and shows it as an outside symlink', async () => {
    seed();
    fs.symlinkSync('/etc/passwd', path.join(root, 'app', 'passwd'));

    const file = await request(app).get('/api/v1/projects/app/file?path=passwd').set(POD);
    expect(file.status).toBe(403);
    expect(file.body.code).toBe('path_escape');
    expect(JSON.stringify(file.body)).not.toContain('root:');

    const tree = await request(app).get('/api/v1/projects/app/tree').set(POD);
    expect(tree.body.entries).toContainEqual({ kind: 'symlink', name: 'passwd', path: 'passwd', target_kind: 'outside' });
  });

  it('refuses a project directory that is itself a symlink out of the root', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync('/etc', path.join(root, 'etc'));
    const file = await request(app).get('/api/v1/projects/etc/file?path=passwd').set(POD);
    expect(file.status).toBe(403);
    expect(file.body.code).toBe('path_escape');
    const list = await request(app).get('/api/v1/projects').set(POD);
    expect(list.body.projects).toEqual([]);
  });

  it('maps errors to the contract status codes', async () => {
    seed();
    const cases: Array<[string, number, string]> = [
      ['/api/v1/projects/ghost/tree', 404, 'not_found'],
      ['/api/v1/projects/app/tree?path=README.md', 400, 'not_a_directory'],
      ['/api/v1/projects/app/file?path=src', 400, 'not_a_file'],
      ['/api/v1/projects/app/file?path=nope.txt', 404, 'not_found'],
    ];
    for (const [url, status, code] of cases) {
      const res = await request(app).get(url).set(POD);
      expect([url, res.status, res.body.code]).toEqual([url, status, code]);
    }
  });

  it('returns file content byte-exact as JSON', async () => {
    seed();
    const body = '  leading spaces\nsecond line\n';
    fs.writeFileSync(path.join(root, 'app', 'src', 'a.ts'), body);
    const res = await request(app).get('/api/v1/projects/app/file?path=src/a.ts').set(POD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'text', path: 'src/a.ts', size: body.length, modified_at: expect.any(String), content: body });
  });
});
