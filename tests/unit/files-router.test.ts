import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createFilesRouter } from '../../src/api/files-router';
import { createGitRouter } from '../../src/api/git-router';
import { resolveFilesRoot } from '../../src/files/config';
import type { ApiKey, GatewayConfig } from '../../src/types';
import { silentLogger } from '../helpers/silent-logger';

const apiKeys: ApiKey[] = [
  { key: 'k-admin', agents: ['alfred'], admin: true },
  { key: 'k-pod-write', agents: '*', write: true, admin: true },
  { key: 'k-pod-read', agents: '*' },
  { key: 'k-agent', agents: ['alfred'], write: true },
  { key: 'k-star-list', agents: ['*'], write: true },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });
const POD = as('k-pod-write');

let base: string;
let root: string;
let outside: string;
let app: express.Express;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-router-')));
  root = path.join(base, 'projects');
  outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  app = express();
  app.use(express.json());
  app.use('/api', createFilesRouter(apiKeys, root, { logger: silentLogger }));
  app.use('/api', createGitRouter(apiKeys, root, silentLogger));
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function seed(): void {
  fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'README.md'), '# hi\n');
}

const list = (rel?: string, key = 'k-pod-write') => request(app).get('/api/v1/files').query(rel === undefined ? {} : { path: rel }).set(as(key));
const mkdir = (body: object, key = 'k-pod-write') => request(app).post('/api/v1/files/mkdir').set(as(key)).send(body);

describe('auth', () => {
  const routes: Array<[string, (r: ReturnType<typeof request>) => request.Test]> = [
    ['GET /files', (r) => r.get('/api/v1/files')],
    ['POST /files/mkdir', (r) => r.post('/api/v1/files/mkdir').send({ path: 'x' })],
    ['DELETE /files', (r) => r.delete('/api/v1/files').send({ path: 'app', confirm: 'app' })],
    ['GET /git/status', (r) => r.get('/api/v1/git/status?path=app')],
    ['GET /git/summary', (r) => r.get('/api/v1/git/summary')],
  ];

  it.each(['k-agent', 'k-star-list', 'k-pod-read'])('%s may read but not create', async (key) => {
    seed();
    expect((await list(undefined, key)).status).toBe(200);
    expect((await request(app).get('/api/v1/git/summary').set(as(key))).status).toBe(200);
    const res = await mkdir({ path: 'x' }, key);
    expect([res.status, res.body.code]).toEqual([403, 'forbidden_key']);
    expect(fs.existsSync(path.join(root, 'x'))).toBe(false);
  });

  it.each(routes)('%s requires a key', async (_label, call) => {
    seed();
    expect((await call(request(app))).status).toBe(401);
    expect(fs.existsSync(path.join(root, 'app'))).toBe(true);
  });

  it('an admin key may create', async () => {
    expect((await mkdir({ path: 'new' }, 'k-admin')).status).toBe(201);
  });
});

describe('GET /api/v1/files', () => {
  it('reports a missing root without creating it', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root, exists: false, path: '', abs: root, entries: [] });
    expect(fs.existsSync(root)).toBe(false);
  });

  it('lists the root by default and a nested folder by path, with relative and absolute paths', async () => {
    seed();
    const top = await list();
    expect(top.body).toEqual({
      root, exists: true, path: '', abs: root,
      filesystem: { total: expect.any(Number), free: expect.any(Number), available: expect.any(Number) },
      entries: [{ name: 'app', path: 'app', abs: path.join(root, 'app'), type: 'dir', modified_at: expect.any(String), is_git: false, size: expect.any(Number) }],
    });
    const nested = await list('app');
    expect(nested.body).toMatchObject({ path: 'app', abs: path.join(root, 'app'), entries: [{ name: 'src', path: 'app/src', abs: path.join(root, 'app', 'src') }] });
  });

  it.each(['../outside', 'app/../../outside', '..', '%2e%2e', '..%2F..%2Fetc', 'app/./src'])('refuses the traversal %j with 400 and lists nothing', async (rel) => {
    seed();
    const res = await list(rel);
    expect([res.status, res.body.code]).toEqual([400, 'invalid_name']);
    expect(res.body.entries).toBeUndefined();
  });

  it.each(['/etc', 'app/', 'a//b'])('refuses the malformed path %j with 400 invalid_path', async (rel) => {
    seed();
    const res = await list(rel);
    expect([res.status, res.body.code]).toEqual([400, 'invalid_path']);
  });

  it('refuses a path given twice', async () => {
    seed();
    const res = await request(app).get('/api/v1/files?path=app&path=app').set(POD);
    expect([res.status, res.body.code]).toEqual([400, 'invalid_path']);
  });

  it('refuses to list through a symlink out of the root, on every read route', async () => {
    fs.mkdirSync(root);
    fs.symlinkSync(outside, path.join(root, 'escape'));
    for (const url of ['/api/v1/files?path=escape', '/api/v1/git/status?path=escape', '/api/v1/git/summary?path=escape']) {
      const res = await request(app).get(url).set(POD);
      expect([url, res.status, res.body.code]).toEqual([url, 403, 'path_escape']);
      expect(JSON.stringify(res.body)).not.toContain('secret.txt');
    }
    const top = await list();
    expect(top.body.entries).toEqual([]);
    expect(top.body.skipped).toEqual([{ name: 'escape', reason: 'symlink_outside_root' }]);
  });

  it('answers HTTP 404 not_found for a missing folder under an existing root, on the list and on git status', async () => {
    seed();
    const listed = await list('ghost');
    expect([listed.status, listed.body.code]).toEqual([404, 'not_found']);
    const status = await request(app).get('/api/v1/git/status').query({ path: 'ghost' }).set(POD);
    expect([status.status, status.body.code]).toEqual([404, 'not_found']);
  });
});

describe('a root that is a regular file', () => {
  it.each([
    ['GET /files', () => request(app).get('/api/v1/files')],
    ['POST /files/mkdir', () => request(app).post('/api/v1/files/mkdir').send({ path: 'x' })],
    ['GET /git/status', () => request(app).get('/api/v1/git/status?path=x')],
  ])('%s returns 400 not_a_directory', async (_label, call) => {
    fs.writeFileSync(root, 'not a dir');
    const res = await call().set(POD);
    expect([res.status, res.body.code]).toEqual([400, 'not_a_directory']);
    expect(fs.readFileSync(root, 'utf8')).toBe('not a dir');
  });
});

describe('POST /api/v1/files/mkdir', () => {
  it('creates, then 409s a duplicate while keeping the first folder intact', async () => {
    const first = await mkdir({ path: 'app' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ entry: { name: 'app', path: 'app', abs: path.join(root, 'app'), type: 'dir', modified_at: expect.any(String), is_git: false, size: expect.any(Number) } });
    fs.writeFileSync(path.join(root, 'app', 'work.txt'), 'unsaved work');

    const second = await mkdir({ path: 'app', git_init: true });
    expect([second.status, second.body]).toEqual([409, { error: expect.any(String), code: 'already_exists' }]);
    expect(fs.readFileSync(path.join(root, 'app', 'work.txt'), 'utf8')).toBe('unsaved work');
    expect(fs.existsSync(path.join(root, 'app', '.git'))).toBe(false);
  });

  it('answers 409 already_exists for a case-only collision', async () => {
    await mkdir({ path: 'Site' });
    const res = await mkdir({ path: 'site' });
    expect([res.status, res.body.code]).toEqual([409, 'already_exists']);
    expect(fs.readdirSync(root)).toEqual(['Site']);
  });

  it('git_init creates a repository, and only the boolean true asks for one', async () => {
    const res = await mkdir({ path: 'repo', git_init: true });
    expect([res.status, res.body.entry.is_git, res.body.warning]).toEqual([201, true, undefined]);
    expect(fs.existsSync(path.join(root, 'repo', '.git', 'HEAD'))).toBe(true);
    expect((await mkdir({ path: 'repo2', git_init: 'true' })).body.entry.is_git).toBe(false);
  });

  it('creates one level under an existing folder and never a missing parent', async () => {
    seed();
    const res = await mkdir({ path: 'app/web' });
    expect([res.status, res.body.entry.path, res.body.entry.abs]).toEqual([201, 'app/web', path.join(root, 'app', 'web')]);
    const deep = await mkdir({ path: 'app/a/b' });
    expect([deep.status, deep.body.code]).toEqual([404, 'not_found']);
    expect(fs.existsSync(path.join(root, 'app', 'a'))).toBe(false);
  });

  it('refuses to create under a symlink out of the root', async () => {
    fs.mkdirSync(root);
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const res = await mkdir({ path: 'escape/new' });
    expect([res.status, res.body.code]).toEqual([403, 'path_escape']);
    expect(fs.readdirSync(outside)).toEqual(['secret.txt']);
  });

  it('refuses to create under a symlinked parent inside the root with 409 symlink_in_path, as DELETE does', async () => {
    seed();
    fs.symlinkSync(path.join(root, 'app'), path.join(root, 'parentlink'));
    for (const rel of ['parentlink/viakid', 'parentlink/src/viakid']) {
      const res = await mkdir({ path: rel });
      expect([rel, res.status, res.body.code]).toEqual([rel, 409, 'symlink_in_path']);
    }
    expect(fs.readdirSync(path.join(root, 'app')).sort()).toEqual(['README.md', 'src']);
    expect(fs.readdirSync(path.join(root, 'app', 'src'))).toEqual([]);
    expect((await mkdir({ path: 'app/viakid' })).status).toBe(201);
  });

  it.each(['../x', '.', '..', '.git', '.hidden', 'a'.repeat(65), 'app/../x', 'app/.git'])('rejects path %p with 400 invalid_name', async (rel) => {
    seed();
    const res = await mkdir({ path: rel });
    expect([res.status, res.body.code]).toEqual([400, 'invalid_name']);
    expect(fs.existsSync(path.join(base, 'x'))).toBe(false);
  });

  it.each(['', undefined, null, 42, '/x', 'x/'])('rejects path %p with 400 invalid_path', async (rel) => {
    const res = await mkdir({ path: rel });
    expect([res.status, res.body.code]).toEqual([400, 'invalid_path']);
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe('unknown and removed routes', () => {
  it.each(apiKeys.map((k) => k.key))('%s gets a plain 404 and no file content from routes the gateway does not serve', async (key) => {
    seed();
    for (const [method, url] of [
      ['get', '/api/v1/projects'], ['get', '/api/v1/projects/app/git'], ['get', '/api/v1/projects/git-summary'],
      ['get', '/api/v1/files/tree?path=app'], ['get', '/api/v1/files/content?path=app/README.md'], ['post', '/api/v1/files'],
      ['get', '/api/v1/git/log?path=app'], ['post', '/api/v1/git/commit'],
    ] as const) {
      const res = await request(app)[method](url).set(as(key));
      expect([url, res.status]).toEqual([url, 404]);
      expect(res.text).not.toContain('# hi');
      expect(res.body?.code).toBeUndefined();
    }
  });
});

describe('resolveFilesRoot', () => {
  const config = (files?: { root?: string }) => ({ gateway: { files }, agents: [] }) as unknown as GatewayConfig;

  it('uses the configured root, expanding ~/', () => {
    expect(resolveFilesRoot(config({ root: '/srv/projects' }))).toBe('/srv/projects');
    expect(resolveFilesRoot(config({ root: '~/code' }))).toBe(path.join(os.homedir(), 'code'));
  });

  it('falls back to ~/projects when unset', () => {
    expect(resolveFilesRoot(config())).toBe(path.join(os.homedir(), 'projects'));
    expect(resolveFilesRoot(config({}))).toBe(path.join(os.homedir(), 'projects'));
  });
});
