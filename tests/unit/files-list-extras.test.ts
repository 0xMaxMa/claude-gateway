import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createFilesRouter } from '../../src/api/files-router';
import { silentLogger } from '../helpers/silent-logger';

const H = { Authorization: 'Bearer k' };
let base: string;
let root: string;
let outside: string;
let app: express.Express;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-list-extras-')));
  root = path.join(base, 'projects');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'good'), { recursive: true });
  fs.mkdirSync(outside);
  app = express();
  app.use(express.json());
  app.use('/api', createFilesRouter([{ key: 'k', agents: '*', admin: true }], root, { logger: silentLogger, inUse: () => false }));
});
afterEach(() => {
  for (const e of fs.readdirSync(root)) {
    const locked = path.join(root, e, 'locked');
    if (fs.existsSync(locked)) fs.chmodSync(locked, 0o700);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

const list = (rel = '') => request(app).get('/api/v1/files').query({ path: rel }).set(H);

describe('GET /api/v1/files skipped', () => {
  it('includes safe hidden folders only when requested', async () => {
    fs.mkdirSync(path.join(root, 'good', '.venv'));
    fs.mkdirSync(path.join(root, 'good', '.deleting-old'));
    const ordinary = await list('good');
    expect(ordinary.body.entries).toEqual([]);
    const hidden = await request(app).get('/api/v1/files').query({ path: 'good', include_hidden: 'true' }).set(H);
    expect(hidden.status).toBe(200);
    expect(hidden.body.entries.map((entry: { name: string }) => entry.name)).toEqual(['.venv']);
    expect(hidden.body.entries[0]).toEqual({
      name: '.venv', path: 'good/.venv', abs: path.join(root, 'good', '.venv'),
      type: 'dir', modified_at: expect.any(String), is_git: false, size: expect.any(Number),
    });
    expect(hidden.body.leftovers).toEqual(['.deleting-old']);
    expect((await request(app).get('/api/v1/files').query({ path: 'good/.venv', include_hidden: 'true' }).set(H)).status).toBe(200);
    expect((await request(app).get('/api/v1/files').query({ path: 'good/.venv' }).set(H)).body.code).toBe('invalid_name');
    expect((await request(app).get('/api/v1/files').query({ path: 'good', include_hidden: 'yes' }).set(H)).status).toBe(400);
  });
  it('is absent when every folder is listed, so old responses keep their shape', async () => {
    const res = await list();
    expect(Object.keys(res.body).sort()).toEqual(['abs', 'entries', 'exists', 'filesystem', 'path', 'root']);
  });

  it('names folders the name rules reject, and keeps the other entries unchanged', async () => {
    const bad = ['my project', 'café', '.hidden', '-dash', 'x'.repeat(65)];
    for (const name of bad) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, 'loose-file.txt'), 'x');
    const res = await list();
    expect(res.body.entries.map((p: { name: string }) => p.name)).toEqual(['good']);
    expect(res.body.skipped).toEqual(bad.map((name) => ({ name, reason: 'invalid_name' })).sort((a, b) => (a.name < b.name ? -1 : 1)));
  });

  it('names a symlink out of the root and a symlink to a file inside it', async () => {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    fs.symlinkSync('notes.txt', path.join(root, 'filelink'));
    const res = await list();
    expect(res.body.skipped).toEqual([
      { name: 'escape', reason: 'symlink_outside_root' },
      { name: 'filelink', reason: 'not_a_directory' },
    ]);
    expect(res.body.entries.map((p: { name: string }) => p.name)).toEqual(['good']);
  });

  it('lists at most 50 entries', async () => {
    for (let i = 0; i < 60; i++) fs.mkdirSync(path.join(root, `bad name ${String(i).padStart(2, '0')}`));
    const res = await list();
    expect(res.body.skipped).toHaveLength(50);
    expect(res.body.skipped[0]).toEqual({ name: 'bad name 00', reason: 'invalid_name' });
  });
});

describe('hidden .deleting-* leftovers', () => {
  it('are listed by folder name and are not reported as skipped', async () => {
    fs.mkdirSync(path.join(root, '.deleting-old-1234'));
    fs.mkdirSync(path.join(root, '.deleting-app-5678'));
    fs.mkdirSync(path.join(root, '.other'));
    const res = await list();
    expect(res.body.leftovers).toEqual(['.deleting-app-5678', '.deleting-old-1234']);
    expect(res.body.skipped).toEqual([{ name: '.other', reason: 'invalid_name' }]);
    expect(res.body.entries.map((p: { name: string }) => p.name)).toEqual(['good']);
  });

  (process.getuid?.() === 0 ? it.skip : it)('are reported after a delete that could not remove everything, and the warning names the folder to remove', async () => {
    const locked = path.join(root, 'good', 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'b.txt'), 'b');
    fs.chmodSync(locked, 0o500);
    const res = await request(app).delete('/api/v1/files').set(H).send({ path: 'good', confirm: 'good' });
    expect(res.status).toBe(200);
    const [leftover] = fs.readdirSync(root).filter((n) => n.startsWith('.deleting-good-'));
    expect(leftover).toBeDefined();
    expect(res.body.warning).toContain(path.join(root, leftover!));
    expect(res.body.warning).toMatch(/by hand/);
    expect((await list()).body.leftovers).toEqual([leftover]);
  });

  (process.getuid?.() === 0 ? it.skip : it)('of a nested delete are reported by the folder that held it', async () => {
    const locked = path.join(root, 'good', 'deps', 'locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, 'b.txt'), 'b');
    fs.chmodSync(locked, 0o500);
    try {
      const res = await request(app).delete('/api/v1/files').set(H).send({ path: 'good/deps', confirm: 'deps' });
      expect([res.status, res.body.path]).toEqual([200, 'good/deps']);
      const nested = await list('good');
      expect(nested.body.leftovers).toEqual([expect.stringMatching(/^\.deleting-deps-/)]);
      expect(nested.body.entries).toEqual([]);
      expect((await list()).body.leftovers).toBeUndefined();
    } finally {
      for (const e of fs.readdirSync(path.join(root, 'good'))) {
        const sub = path.join(root, 'good', e, 'locked');
        if (fs.existsSync(sub)) fs.chmodSync(sub, 0o700);
      }
    }
  });
});
