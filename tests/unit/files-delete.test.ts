import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createFilesRouter } from '../../src/api/files-router';
import { overlaps } from '../../src/files/paths';
import type { ApiKey } from '../../src/types';
import { silentLogger } from '../helpers/silent-logger';

const apiKeys: ApiKey[] = [
  { key: 'k-write', agents: '*', write: true, admin: true },
  { key: 'k-read', agents: '*' },
  { key: 'k-agent', agents: ['alfred'], write: true },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });

let base: string;
let root: string;
let outside: string;
/** Root-relative folders a chat works in. */
let chatting: Set<string>;

const app = (): express.Express => {
  const a = express();
  a.use(express.json());
  a.use('/api', createFilesRouter(apiKeys, root, { logger: silentLogger, inUse: (dir) => [...chatting].some((rel) => overlaps(fs.realpathSync(path.join(root, rel)), dir)) }));
  return a;
};
const del = (rel = 'api', body: object = { confirm: rel.split('/').pop() }, key = 'k-write') =>
  request(app()).delete('/api/v1/files').set(as(key)).send({ path: rel, ...body });
const listed = async (rel = '') => (await request(app()).get('/api/v1/files').query({ path: rel }).set(as('k-write'))).body.entries.map((e: { name: string }) => e.name);
const exists = (...p: string[]) => fs.existsSync(path.join(root, ...p));

beforeEach(() => {
  chatting = new Set();
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
  fs.rmSync(base, { recursive: true, force: true });
});

describe('DELETE /api/v1/files', () => {
  it('deletes a hidden folder while refusing delete trash and parent traversal', async () => {
    fs.mkdirSync(path.join(root, 'api', '.venv'));
    fs.writeFileSync(path.join(root, 'api', '.venv', 'data'), 'x');
    expect((await del('api/.venv')).status).toBe(200);
    expect(exists('api', '.venv')).toBe(false);
    fs.mkdirSync(path.join(root, '.deleting-old'));
    expect((await del('.deleting-old')).body.code).toBe('invalid_name');
    expect((await del('api/..')).body.code).toBe('invalid_name');
    expect(exists('.deleting-old')).toBe(true);
  });

  it('removes the folder and everything in it, and only that folder', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: 'api' });
    expect(exists('api')).toBe(false);
    expect(exists('keep')).toBe(true);
    expect(await listed()).toEqual(['keep']);
  });

  it('needs the exact last segment as confirmation', async () => {
    for (const body of [{}, { confirm: 'API' }, { confirm: 'keep' }, { confirm: true }, { confirm: '/api' }, { confirm: null }]) {
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
      (await request(app()).delete('/api/v1/files').send({ path: 'api', confirm: 'api' })).status,
    ).toBe(401);
    expect(exists('api')).toBe(true);
  });

  it('answers 404 for a folder that is not there and 400 for a bad name', async () => {
    expect((await del('ghost')).status).toBe(404);
    const bad = await del('a b', { confirm: 'a b' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_name');
  });

  it('refuses while a chat turn runs in the folder, and deletes once it ends', async () => {
    chatting.add('api');
    const blocked = await del();
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('in_use');
    expect(exists('api', 'src', 'index.js')).toBe(true);
    expect((await del('keep')).status).toBe(200);

    chatting.delete('api');
    const res = await del();
    expect(res.status).toBe(200);
    expect(exists('api')).toBe(false);
  });

  it('answers deleting to a second delete of the folder, by its name or through a symlink alias', async () => {
    fs.symlinkSync(path.join(root, 'api'), path.join(root, 'alias'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const atRename = new Promise<void>((resolve) => { reached = resolve; });
    const realRename = fs.promises.rename.bind(fs.promises);
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(to)).startsWith('.deleting-')) { reached(); await gate; }
      return realRename(from, to);
    });
    try {
      const first = Promise.resolve(del());
      await atRename;
      const again = await del();
      const viaAlias = await del('alias');
      release();
      expect([again.status, again.body.code]).toEqual([409, 'deleting']);
      expect([viaAlias.status, viaAlias.body.code]).toEqual([409, 'deleting']);
      expect((await first).status).toBe(200);
    } finally {
      release();
      rename.mockRestore();
    }
  });

  describe('when the busy check throws', () => {
    let failOn: (call: number) => boolean;
    let logged: string[];
    const throwingApp = (): express.Express => {
      const a = express();
      a.use(express.json());
      let calls = 0;
      const logger = { ...silentLogger, error: (m: string) => { logged.push(m); } };
      a.use('/api', createFilesRouter(apiKeys, root, {
        logger,
        inUse: (dir) => {
          if (failOn(++calls)) throw new Error(`store gone at ${dir} token=hunter2`);
          return false;
        },
      }));
      return a;
    };
    const delVia = (a: express.Express) => request(a).delete('/api/v1/files').set(as('k-write')).send({ path: 'api', confirm: 'api' });

    beforeEach(() => {
      failOn = () => true;
      logged = [];
    });

    it('answers 500 internal and removes nothing', async () => {
      const res = await delVia(throwingApp());
      expect([res.status, res.body]).toEqual([500, { error: 'Internal error', code: 'internal' }]);
      expect(exists('api', 'src', 'index.js')).toBe(true);
    });

    it('logs one line to the injected logger, without the message, and nothing to the console', async () => {
      const spies = (['error', 'warn', 'log', 'info'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
      try {
        await delVia(throwingApp());
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      expect(logged).toEqual(['files: DELETE /v1/files failed: Error']);
    });

    it('releases the deleting mark, so a later delete succeeds', async () => {
      failOn = (call) => call === 2;
      const a = throwingApp();
      expect((await delVia(a)).status).toBe(500);
      const res = await delVia(a);
      expect([res.status, res.body]).toEqual([200, { path: 'api' }]);
      expect(exists('api')).toBe(false);
    });
  });

  it('removes a link inside the folder without touching what it points to', async () => {
    fs.symlinkSync(outside, path.join(root, 'api', 'link-out'));
    expect((await del()).status).toBe(200);
    expect(exists('api')).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  (process.getuid?.() === 0 ? it.skip : it)('never leaves a half-deleted folder listed when a subfolder cannot be emptied', async () => {
    fs.writeFileSync(path.join(root, 'api', 'a.txt'), 'a');
    const locked = path.join(root, 'api', 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'b.txt'), 'b');
    fs.chmodSync(locked, 0o500);
    try {
      const res = await del();
      const names = await listed();
      if (res.status === 200) {
        expect(names).toEqual(['keep']);
        expect(exists('api')).toBe(false);
        expect(res.body).toEqual({ path: 'api', warning: expect.stringContaining('could not be removed') });
        expect((await request(app()).get('/api/v1/files').set(as('k-write'))).body.leftovers).toEqual([expect.stringMatching(/^\.deleting-api-/)]);
      } else {
        expect(names).toEqual(['api', 'keep']);
        expect(exists('api', 'a.txt')).toBe(true);
        expect(exists('api', 'src', 'index.js')).toBe(true);
        expect(exists('api', 'locked', 'b.txt')).toBe(true);
      }
    } finally {
      for (const e of fs.readdirSync(root)) {
        const sub = path.join(root, e, 'locked');
        if (fs.existsSync(sub)) fs.chmodSync(sub, 0o700);
      }
    }
  });

  it('will not follow a folder that is a link out of the root', async () => {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const res = await del('escape');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('path_escape');
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it.each([
    ['an empty path, which names the root', { path: '', confirm: '' }],
    ['no path', { confirm: 'api' }],
    ['an absolute path', { path: '/api', confirm: 'api' }],
    ['a trailing slash', { path: 'api/', confirm: '' }],
    ['a non-string path', { path: ['api'], confirm: 'api' }],
  ])('refuses %s with 400 invalid_path and removes nothing', async (_label, body) => {
    const res = await request(app()).delete('/api/v1/files').set(as('k-write')).send(body);
    expect([res.status, res.body.code]).toEqual([400, 'invalid_path']);
    expect(exists('api', 'src', 'index.js')).toBe(true);
    expect(exists('keep')).toBe(true);
  });

  it('refuses a link to the root itself, and leaves the link and the root in place', async () => {
    fs.symlinkSync('.', path.join(root, 'all'));
    fs.symlinkSync('..', path.join(root, 'api', 'up'));
    expect((await del('all')).body.code).toBe('path_escape');
    expect((await del('api/up')).body.code).toBe('path_escape');
    expect(fs.lstatSync(path.join(root, 'all')).isSymbolicLink()).toBe(true);
    expect(exists('api', 'src', 'index.js')).toBe(true);
  });

  it.each(['../outside', 'api/../../outside', '..', 'api/..', '%2e%2e', 'api/.deleting-x'])('refuses the traversal %j with 400 invalid_name', async (rel) => {
    const res = await del(rel);
    expect([res.status, res.body.code]).toEqual([400, 'invalid_name']);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(exists('api', 'src', 'index.js')).toBe(true);
  });

  describe('a nested path', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(root, 'api', 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(root, 'api', 'node_modules', 'pkg', 'index.js'), 'x');
    });

    it('removes only the named folder and keeps its parent and siblings', async () => {
      const res = await del('api/node_modules');
      expect([res.status, res.body]).toEqual([200, { path: 'api/node_modules' }]);
      expect(exists('api', 'node_modules')).toBe(false);
      expect(exists('api', 'src', 'index.js')).toBe(true);
      expect(await listed('api')).toEqual(['src']);
    });

    it('needs the last segment, not the whole path, as confirmation', async () => {
      const res = await del('api/node_modules', { confirm: 'api/node_modules' });
      expect([res.status, res.body.code]).toEqual([400, 'confirm_mismatch']);
      expect(exists('api', 'node_modules', 'pkg', 'index.js')).toBe(true);
    });

    it('refuses while a chat works in the folder holding it', async () => {
      chatting.add('api');
      const res = await del('api/node_modules');
      expect([res.status, res.body.code]).toEqual([409, 'in_use']);
      expect(exists('api', 'node_modules', 'pkg', 'index.js')).toBe(true);
    });

    it('refuses to delete a folder that holds a folder a chat works in', async () => {
      chatting.add('api/src');
      const res = await del('api');
      expect([res.status, res.body.code]).toEqual([409, 'in_use']);
      expect(exists('api', 'src', 'index.js')).toBe(true);
    });

    it('refuses a path through a symlinked folder and removes nothing behind the link', async () => {
      fs.symlinkSync(path.join(root, 'api'), path.join(root, 'alias'));
      const res = await del('alias/node_modules');
      expect([res.status, res.body.code]).toEqual([409, 'symlink_in_path']);
      expect(exists('api', 'node_modules', 'pkg', 'index.js')).toBe(true);
    });

    it('removes only a nested link, never what it points to inside the root', async () => {
      fs.symlinkSync(path.join(root, 'keep'), path.join(root, 'api', 'keep-link'));
      fs.writeFileSync(path.join(root, 'keep', 'k.txt'), 'k');
      expect((await del('api/keep-link')).status).toBe(200);
      expect(fs.existsSync(path.join(root, 'api', 'keep-link'))).toBe(false);
      expect(exists('keep', 'k.txt')).toBe(true);
    });

    it('refuses a nested link out of the root', async () => {
      fs.symlinkSync(outside, path.join(root, 'api', 'out'));
      const res = await del('api/out');
      expect([res.status, res.body.code]).toEqual([403, 'path_escape']);
      expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    });

    it('answers deleting to a delete of the parent while the child is being removed', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let reached!: () => void;
      const atRename = new Promise<void>((resolve) => { reached = resolve; });
      const realRename = fs.promises.rename.bind(fs.promises);
      const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (path.basename(String(to)).startsWith('.deleting-')) { reached(); await gate; }
        return realRename(from, to);
      });
      try {
        const first = Promise.resolve(del('api/node_modules'));
        await atRename;
        const parent = await del('api');
        release();
        expect([parent.status, parent.body.code]).toEqual([409, 'deleting']);
        expect((await first).status).toBe(200);
        expect(exists('api', 'src', 'index.js')).toBe(true);
      } finally {
        release();
        rename.mockRestore();
      }
    });
  });

  describe('another filesystem', () => {
    afterEach(() => jest.restoreAllMocks());

    it('refuses a folder on another device than its parent, and removes nothing', async () => {
      const target = path.join(root, 'api');
      const realLstat = fs.promises.lstat.bind(fs.promises);
      jest.spyOn(fs.promises, 'lstat').mockImplementation((async (p: fs.PathLike) => {
        const st = await realLstat(p);
        return String(p) === target ? Object.assign(st, { dev: st.dev + 1 }) : st;
      }) as typeof fs.promises.lstat);
      const res = await del('api');
      expect([res.status, res.body.code]).toEqual([409, 'cross_device']);
      expect(exists('api', 'src', 'index.js')).toBe(true);
    });

    it('refuses a nested folder on another device than its parent, and keeps the parent', async () => {
      const target = path.join(root, 'api', 'src');
      const realLstat = fs.promises.lstat.bind(fs.promises);
      jest.spyOn(fs.promises, 'lstat').mockImplementation((async (p: fs.PathLike) => {
        const st = await realLstat(p);
        return String(p) === target ? Object.assign(st, { dev: st.dev + 1 }) : st;
      }) as typeof fs.promises.lstat);
      const res = await del('api/src');
      expect([res.status, res.body.code]).toEqual([409, 'cross_device']);
      expect(exists('api', 'src', 'index.js')).toBe(true);
    });

    it('refuses a folder that holds a mount point, and removes nothing', async () => {
      const mounted = path.join(root, 'api', 'src');
      const realReadFile = fs.promises.readFile.bind(fs.promises);
      jest.spyOn(fs.promises, 'readFile').mockImplementation((async (p: fs.PathLike, opts?: unknown) =>
        String(p) === '/proc/self/mountinfo'
          ? `22 1 8:1 / / rw - ext4 /dev/sda1 rw\n99 22 0:50 / ${mounted.replace(/ /g, '\\040')} rw - tmpfs tmpfs rw\n`
          : realReadFile(p, opts as BufferEncoding)) as typeof fs.promises.readFile);
      const res = await del('api');
      expect([res.status, res.body.code]).toEqual([409, 'cross_device']);
      expect(exists('api', 'src', 'index.js')).toBe(true);
      expect((await del('keep')).status).toBe(200);
    });

    it('answers 409 cross_device, not 500, when the rename meets another filesystem', async () => {
      jest.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }));
      const res = await del('api');
      expect([res.status, res.body.code]).toEqual([409, 'cross_device']);
      expect(exists('api', 'src', 'index.js')).toBe(true);
    });
  });
});
