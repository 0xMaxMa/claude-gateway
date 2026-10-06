import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProject, listDir, listProjects, readFileContent, TREE_ENTRY_LIMIT } from '../../src/projects/fs';
import { ProjectName, RelPath } from '../../src/projects/paths';

const name = (s: string) => s as ProjectName;
const rel = (s: string) => s as RelPath;

let base: string;
let root: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-fs-')));
  root = path.join(base, 'projects');
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

function makeProject(n: string, files: Record<string, string | Buffer> = {}): string {
  const dir = path.join(root, n);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

/** After realpath resolves a path ending in `suffix`, replace `<dir>/sub` with a symlink to `target`. */
function swapSubAfterRealpath(dir: string, suffix: string, target: string): void {
  const realRealpath = fs.promises.realpath;
  let swapped = false;
  jest.spyOn(fs.promises, 'realpath').mockImplementation(async (...args: Parameters<typeof realRealpath>) => {
    const resolved = await realRealpath(...args);
    if (!swapped && String(args[0]).endsWith(suffix)) {
      swapped = true;
      fs.rmSync(path.join(dir, 'sub'), { recursive: true });
      fs.symlinkSync(target, path.join(dir, 'sub'));
    }
    return resolved;
  });
}

describe('listProjects', () => {
  it('reports a missing root as exists:false without creating it', async () => {
    expect(await listProjects(root)).toEqual({ ok: true, value: { root, exists: false, projects: [] } });
    expect(fs.existsSync(root)).toBe(false);
  });

  it('lists directories and in-root dir symlinks sorted by name, skipping files and escaping links', async () => {
    makeProject('zeta');
    makeProject('alpha', { '.git/HEAD': 'ref: refs/heads/main\n' });
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    fs.symlinkSync(path.join(root, 'zeta'), path.join(root, 'link-in'));
    const outside = fs.mkdtempSync(path.join(base, 'outside-'));
    fs.symlinkSync(outside, path.join(root, 'link-out'));

    const res = await listProjects(root);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.exists).toBe(true);
    expect(res.value.projects.map((p) => [p.name, p.is_git, p.path])).toEqual([
      ['alpha', true, path.join(root, 'alpha')],
      ['link-in', false, path.join(root, 'link-in')],
      ['zeta', false, path.join(root, 'zeta')],
    ]);
    expect(Number.isNaN(Date.parse(res.value.projects[0].modified_at))).toBe(false);
  });
});

describe('createProject', () => {
  it('creates the root on demand and refuses a second create without touching the first', async () => {
    const first = await createProject(root, name('app'), false);
    if (!first.ok) throw new Error(first.error);
    expect(first.value).toEqual({
      project: { name: 'app', path: path.join(root, 'app'), modified_at: expect.any(String), is_git: false },
    });
    fs.writeFileSync(path.join(root, 'app', 'keep.txt'), 'precious');

    expect(await createProject(root, name('app'), false)).toEqual({ ok: false, error: 'project_exists' });
    expect(fs.readFileSync(path.join(root, 'app', 'keep.txt'), 'utf8')).toBe('precious');
  });

  it('runs git init when asked', async () => {
    const res = await createProject(root, name('repo'), true);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.warning).toBeUndefined();
    expect(res.value.project.is_git).toBe(true);
    expect(fs.statSync(path.join(root, 'repo', '.git')).isDirectory()).toBe(true);
  });

  it('creates the repository in the project even when GIT_* variables point elsewhere', async () => {
    const elsewhere = path.join(base, 'elsewhere.git');
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = elsewhere;
    process.env.GIT_WORK_TREE = base;
    try {
      const res = await createProject(root, name('g1'), true);
      if (!res.ok) throw new Error(res.error);
      expect(res.value.warning).toBeUndefined();
      expect(res.value.project.is_git).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(fs.existsSync(path.join(root, 'g1', '.git', 'HEAD'))).toBe(true);
    expect(fs.existsSync(elsewhere)).toBe(false);
  });

  it('keeps the directory and returns a warning when git is not on PATH', async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = fs.mkdtempSync(path.join(base, 'empty-bin-'));
    try {
      const res = await createProject(root, name('nogit'), true);
      if (!res.ok) throw new Error(res.error);
      expect(res.value.warning).toBe('git init failed (ENOENT)');
      expect(res.value.project.is_git).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(fs.statSync(path.join(root, 'nogit')).isDirectory()).toBe(true);
  });

  it.each([
    ['exit 3', 'git init failed (exit code 3)'],
    ['kill -TERM $$', 'git init failed (signal SIGTERM)'],
  ])('reports a failing git (%s) without echoing its stderr, which is only logged', async (ending, warning) => {
    const bin = fs.mkdtempSync(path.join(base, 'fake-bin-'));
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "SECRET-STDERR $HOME" >&2\n${ending}\n`, { mode: 0o755 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const res = await createProject(root, name('broken'), true);
      if (!res.ok) throw new Error(res.error);
      expect(res.value.warning).toBe(warning);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SECRET-STDERR'));
  });
});

describe('listDir', () => {
  it('lists one level, dirs first then by name, dotfiles included', async () => {
    makeProject('p', { 'b.txt': 'bb', '.env': 'x', 'src/index.ts': '', 'A/x': '' });
    const res = await listDir(root, name('p'), rel(''));
    if (!res.ok) throw new Error(res.error);
    expect(res.value.truncated).toBe(false);
    expect(res.value.entries.map((e) => [e.kind, e.path])).toEqual([
      ['dir', 'A'],
      ['dir', 'src'],
      ['file', '.env'],
      ['file', 'b.txt'],
    ]);
    expect(res.value.entries[3]).toEqual({
      kind: 'file', name: 'b.txt', path: 'b.txt', size: 2, modified_at: expect.any(String),
    });

    const sub = await listDir(root, name('p'), rel('src'));
    if (!sub.ok) throw new Error(sub.error);
    expect(sub.value.entries.map((e) => e.path)).toEqual(['src/index.ts']);
  });

  it('shows symlinks without following them, classifying the target', async () => {
    const dir = makeProject('p', { 'real.txt': 'r', 'sub/x': '' });
    fs.symlinkSync('/etc/passwd', path.join(dir, 'passwd'));
    fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'to-file'));
    fs.symlinkSync('sub', path.join(dir, 'to-dir'));
    fs.symlinkSync('missing', path.join(dir, 'dangling'));

    const res = await listDir(root, name('p'), rel(''));
    if (!res.ok) throw new Error(res.error);
    const links = Object.fromEntries(
      res.value.entries.filter((e) => e.kind === 'symlink').map((e) => [e.name, e.kind === 'symlink' && e.target_kind]),
    );
    expect(links).toEqual({ passwd: 'outside', 'to-file': 'file', 'to-dir': 'dir', dangling: 'dangling' });
  });

  it('caps a large directory and flags truncation', async () => {
    const dir = makeProject('big');
    for (let i = 0; i < 2500; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}`), '');
    const res = await listDir(root, name('big'), rel(''));
    if (!res.ok) throw new Error(res.error);
    expect(res.value.entries).toHaveLength(TREE_ENTRY_LIMIT);
    expect(res.value.truncated).toBe(true);
    expect(res.value.entries[0].name).toBe('f0000');
  });

  it('refuses a project dir that is itself a symlink escaping the root', async () => {
    fs.mkdirSync(root, { recursive: true });
    const outside = fs.mkdtempSync(path.join(base, 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret'), 's');
    fs.symlinkSync(outside, path.join(root, 'evil'));
    expect(await listDir(root, name('evil'), rel(''))).toEqual({ ok: false, error: 'path_escape' });
    expect(await readFileContent(root, name('evil'), rel('secret'))).toEqual({ ok: false, error: 'path_escape' });
  });

  it('refuses a directory symlink that escapes the project', async () => {
    const dir = makeProject('p');
    const outside = fs.mkdtempSync(path.join(base, 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret'), 's');
    fs.symlinkSync(outside, path.join(dir, 'out'));
    expect(await listDir(root, name('p'), rel('out'))).toEqual({ ok: false, error: 'path_escape' });
  });

  it('refuses a directory swapped for an escaping symlink after the realpath check', async () => {
    const dir = makeProject('p', { 'sub/x': '' });
    const outside = fs.mkdtempSync(path.join(base, 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret'), 's');
    swapSubAfterRealpath(dir, '/sub', outside);
    expect(await listDir(root, name('p'), rel('sub'))).toEqual({ ok: false, error: 'path_escape' });
  });

  it('maps a file path to not_a_directory and a missing one to not_found', async () => {
    makeProject('p', { 'a.txt': '' });
    expect(await listDir(root, name('p'), rel('a.txt'))).toEqual({ ok: false, error: 'not_a_directory' });
    expect(await listDir(root, name('p'), rel('nope'))).toEqual({ ok: false, error: 'not_found' });
    expect(await listDir(root, name('ghost'), rel(''))).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('readFileContent', () => {
  it('returns utf-8 text byte-exact, including leading spaces, BOM, and trailing newline', async () => {
    const body = '﻿  indented\n\tline two ✓\n';
    makeProject('p', { 'a.md': body });
    const res = await readFileContent(root, name('p'), rel('a.md'));
    expect(res).toEqual({
      ok: true,
      value: { kind: 'text', path: 'a.md', size: Buffer.byteLength(body), modified_at: expect.any(String), content: body },
    });
  });

  it('classifies PNG bytes and latin-1 text as binary', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    makeProject('p', { 'img.png': png, 'latin1.txt': Buffer.from('café', 'latin1') });
    for (const f of ['img.png', 'latin1.txt']) {
      const res = await readFileContent(root, name('p'), rel(f));
      if (!res.ok) throw new Error(res.error);
      expect(res.value).toEqual({ kind: 'binary', path: f, size: expect.any(Number), modified_at: expect.any(String) });
    }
  });

  it('returns too_large for a file over the limit without reading a byte', async () => {
    makeProject('p', { 'big.bin': Buffer.alloc(1024 * 1024 + 1, 0x61) });
    const realOpen = fs.promises.open;
    const reads: jest.SpyInstance[] = [];
    jest.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args);
      reads.push(jest.spyOn(handle, 'read'), jest.spyOn(handle, 'readFile'));
      return handle;
    });

    const res = await readFileContent(root, name('p'), rel('big.bin'));
    expect(res).toEqual({
      ok: true,
      value: { kind: 'too_large', path: 'big.bin', size: 1024 * 1024 + 1, modified_at: expect.any(String), limit: 1024 * 1024 },
    });
    expect(reads).toHaveLength(2);
    for (const spy of reads) expect(spy).not.toHaveBeenCalled();
  });

  it('reads a file of exactly the limit', async () => {
    makeProject('p', { 'edge.txt': Buffer.alloc(1024 * 1024, 0x61) });
    const res = await readFileContent(root, name('p'), rel('edge.txt'));
    if (!res.ok) throw new Error(res.error);
    expect(res.value.kind).toBe('text');
  });

  it('refuses a symlink to /etc/passwd inside a project', async () => {
    const dir = makeProject('p');
    fs.symlinkSync('/etc/passwd', path.join(dir, 'passwd'));
    expect(await readFileContent(root, name('p'), rel('passwd'))).toEqual({ ok: false, error: 'path_escape' });
  });

  it('refuses a symlink into a sibling project', async () => {
    makeProject('other', { 'secret.txt': 's' });
    const dir = makeProject('p');
    fs.symlinkSync(path.join(root, 'other', 'secret.txt'), path.join(dir, 'peek'));
    expect(await readFileContent(root, name('p'), rel('peek'))).toEqual({ ok: false, error: 'path_escape' });
  });

  (process.platform === 'linux' ? it : it.skip)(
    'refuses a file whose parent dir is swapped for an escaping symlink after the realpath check',
    async () => {
      const dir = makeProject('p', { 'sub/file': 'inside' });
      const outside = fs.mkdtempSync(path.join(base, 'outside-'));
      fs.writeFileSync(path.join(outside, 'file'), 'secret');
      swapSubAfterRealpath(dir, '/sub/file', outside);
      expect(await readFileContent(root, name('p'), rel('sub/file'))).toEqual({ ok: false, error: 'path_escape' });
    },
  );

  it('follows an in-project symlink to its real file', async () => {
    const dir = makeProject('p', { 'real.txt': 'hi' });
    fs.symlinkSync('real.txt', path.join(dir, 'alias'));
    const res = await readFileContent(root, name('p'), rel('alias'));
    if (!res.ok) throw new Error(res.error);
    expect(res.value).toMatchObject({ kind: 'text', path: 'alias', content: 'hi' });
  });

  it('refuses a FIFO as not_a_file without blocking on open', async () => {
    const dir = makeProject('p');
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    expect(await readFileContent(root, name('p'), rel('pipe'))).toEqual({ ok: false, error: 'not_a_file' });
  }, 5000);

  it('maps a directory to not_a_file', async () => {
    makeProject('p', { 'src/a': '' });
    expect(await readFileContent(root, name('p'), rel('src'))).toEqual({ ok: false, error: 'not_a_file' });
    expect(await readFileContent(root, name('p'), rel(''))).toEqual({ ok: false, error: 'not_a_file' });
  });
});
