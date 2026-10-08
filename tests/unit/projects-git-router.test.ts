import { execFileSync } from 'child_process';
import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createProjectsRouter } from '../../src/api/projects-router';
import type { ApiKey } from '../../src/types';

const apiKeys: ApiKey[] = [
  { key: 'k-pod-write', agents: '*', write: true },
  { key: 'k-pod-read', agents: '*' },
  { key: 'k-agent', agents: ['alfred'], write: true },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });
const POD = as('k-pod-write');

let base: string;
let root: string;
let remote: string;
let app: express.Express;
const savedEnv = { ...process.env };

/** Fixture git: its own identity, never the server's env or the user's ~/.gitconfig. */
function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  });
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A repo under the root with one commit on main. */
function makeRepo(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  write(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

/** Pushes `dir`'s main to a fresh bare remote as origin with upstream set. */
function addRemote(dir: string): void {
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
}

/** Commits on the remote from a separate clone, so `dir` falls behind once it fetches. */
function commitUpstream(file: string, content: string): void {
  const other = path.join(base, `clone-${Date.now()}-${Math.random()}`);
  git(base, 'clone', '-q', remote, other);
  write(path.join(other, file), content);
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', `upstream ${file}`);
  git(other, 'push', '-q', 'origin', 'main');
}

function setIdentity(dir: string): void {
  git(dir, 'config', 'user.name', 'Dev');
  git(dir, 'config', 'user.email', 'dev@example.com');
}

const status = (name: string, key = POD) => request(app).get(`/api/v1/projects/${name}/git`).set(key);

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

/**
 * Puts a `git` first on PATH that runs the real one, but sleeps SHIM_SLOW_STATUS seconds before
 * every `status`, and once a `SHIM_BREAK_AFTER` command succeeds makes every later `status` fail.
 */
function shimGit(): void {
  const bin = path.join(base, 'shim-bin');
  write(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      `flag="${path.join(base, 'shim-broken')}"`,
      'for a in "$@"; do',
      '  if [ "$a" = status ]; then',
      '    [ -n "$SHIM_SLOW_STATUS" ] && sleep "$SHIM_SLOW_STATUS"',
      '    [ -e "$flag" ] && exit 1',
      '  fi',
      'done',
      `"${REAL_GIT}" "$@"; code=$?`,
      'for a in "$@"; do',
      '  [ $code -eq 0 ] && [ -n "$SHIM_BREAK_AFTER" ] && [ "$a" = "$SHIM_BREAK_AFTER" ] && touch "$flag"',
      'done',
      'exit $code',
    ].join('\n'),
  );
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-git-')));
  root = path.join(base, 'projects');
  remote = path.join(base, 'remote.git');
  fs.mkdirSync(root);
  // An empty HOME so the user's ~/.gitconfig identity never leaks into identity tests.
  process.env.HOME = path.join(base, 'home');
  process.env.XDG_CONFIG_HOME = path.join(base, 'home', '.config');
  fs.mkdirSync(process.env.HOME);
  app = express();
  app.use(express.json());
  app.use('/api', createProjectsRouter(apiKeys, root));
});

afterEach(() => {
  process.env = { ...savedEnv };
  fs.rmSync(base, { recursive: true, force: true });
});

describe('GET /api/v1/projects/:name/git', () => {
  it('reports a clean repo in sync with its upstream', async () => {
    addRemote(makeRepo('app'));
    const res = await status('app');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      branch: 'main',
      detached: false,
      has_commits: true,
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      sync: 'in_sync',
      remote: { name: 'origin', url: remote, host: 'other', web_url: null },
      changes: [],
      change_count: 0,
      conflicted_count: 0,
      truncated: false,
      last_commit: { sha: expect.stringMatching(/^[0-9a-f]{40}$/), subject: 'initial', author: 'Fixture', committed_at: expect.any(String) },
      operation: 'none',
      identity_configured: false,
      sensitive_untracked: [],
    });
  });

  it('reads ahead, behind and diverged from real refs', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    write(path.join(dir, 'local.txt'), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'local');
    expect((await status('app')).body).toMatchObject({ ahead: 1, behind: 0, sync: 'ahead' });

    commitUpstream('up.txt', 'y');
    git(dir, 'fetch', '-q');
    expect((await status('app')).body).toMatchObject({ ahead: 1, behind: 1, sync: 'diverged' });
  });

  it('reports untracked, staged and renamed changes with secrets flagged', async () => {
    const dir = makeRepo('app');
    write(path.join(dir, 'config', '.env'), 'SECRET=1');
    write(path.join(dir, '.env.example'), 'SECRET=');
    git(dir, 'mv', 'README.md', 'READ ME.md');
    const res = await status('app');
    expect(res.body.changes).toEqual([
      { path: 'READ ME.md', orig_path: 'README.md', staged: 'renamed', unstaged: null },
      { path: '.env.example', staged: null, unstaged: 'untracked' },
      { path: 'config/.env', staged: null, unstaged: 'untracked' },
    ]);
    expect(res.body.sensitive_untracked).toEqual(['config/.env']);
    expect(res.body.sync).toBe('no_remote');
  });

  it('reports an unborn branch and a detached HEAD', async () => {
    const fresh = path.join(root, 'fresh');
    fs.mkdirSync(fresh);
    git(fresh, 'init', '-q', '-b', 'main');
    expect((await status('fresh')).body).toMatchObject({ branch: 'main', detached: false, has_commits: false, last_commit: null });
    git(fresh, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
    expect((await status('fresh')).body).toMatchObject({ branch: 'trunk', detached: false, has_commits: false });

    const dir = makeRepo('app');
    git(dir, 'checkout', '-q', '--detach');
    expect((await status('app')).body).toMatchObject({ branch: null, detached: true, sync: 'detached' });
  });

  it('reports a merge conflict and the merge in progress', async () => {
    const dir = makeRepo('app');
    git(dir, 'checkout', '-q', '-b', 'side');
    write(path.join(dir, 'README.md'), 'side\n');
    git(dir, 'commit', '-q', '-am', 'side');
    git(dir, 'checkout', '-q', 'main');
    write(path.join(dir, 'README.md'), 'main\n');
    git(dir, 'commit', '-q', '-am', 'main');
    expect(() => git(dir, 'merge', '-q', 'side')).toThrow();
    const res = await status('app');
    expect(res.body).toMatchObject({ conflicted_count: 1, operation: 'merge' });
    expect(res.body.changes[0]).toEqual({ path: 'README.md', staged: 'conflicted', unstaged: 'conflicted' });
  });

  it('strips credentials from the remote URL', async () => {
    const dir = makeRepo('app');
    git(dir, 'remote', 'add', 'origin', 'https://bob:s3cret-token@github.com/acme/app.git');
    const res = await status('app');
    expect(res.body.remote).toEqual({ name: 'origin', url: 'https://github.com/acme/app.git', host: 'github', web_url: 'https://github.com/acme/app' });
    expect(res.body.sync).toBe('no_upstream');
    expect(JSON.stringify(res.body)).not.toContain('s3cret');
  });

  it('409s not_a_git_repo for a plain folder, even inside a repository', async () => {
    git(root, 'init', '-q');
    fs.mkdirSync(path.join(root, 'plain'));
    const res = await status('plain');
    expect([res.status, res.body.code]).toEqual([409, 'not_a_git_repo']);
  });

  it('refuses a project that is a symlink to a repository outside the root', async () => {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    git(outside, 'init', '-q');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const res = await status('escape');
    expect([res.status, res.body.code]).toEqual([403, 'path_escape']);
    const summary = await request(app).get('/api/v1/projects/git-summary').set(POD);
    expect(summary.body.summaries).toEqual({});
  });

  it('allows a read-only pod key and refuses an agent-scoped key', async () => {
    makeRepo('app');
    expect((await status('app', as('k-pod-read'))).status).toBe(200);
    expect((await status('app', as('k-agent'))).body.code).toBe('forbidden_key');
    expect((await request(app).get('/api/v1/projects/git-summary').set(as('k-agent'))).body.code).toBe('forbidden_key');
  });
});

describe('GET /api/v1/projects/git-summary', () => {
  it('summarises every repository, omits plain folders, and nulls a repo whose status times out', async () => {
    addRemote(makeRepo('app'));
    fs.mkdirSync(path.join(root, 'plain'));
    const slow = makeRepo('slow');
    // Opening a FIFO with no writer blocks every git that reads this repo's config.
    const fifo = path.join(base, 'blocking-include');
    execFileSync('mkfifo', [fifo]);
    git(slow, 'config', 'include.path', fifo);

    const res = await request(app).get('/api/v1/projects/git-summary').set(as('k-pod-read'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      summaries: {
        app: { branch: 'main', detached: false, sync: 'in_sync', ahead: 0, behind: 0, change_count: 0, conflicted_count: 0, remote_host: 'other' },
        slow: null,
      },
    });
  }, 15_000);
});

const post = (name: string, action: string, body?: object, key = POD) =>
  request(app).post(`/api/v1/projects/${name}/git/${action}`).set(key).send(body ?? {});

describe('POST git/init', () => {
  it('initialises a plain folder once, then 409s already_a_git_repo', async () => {
    fs.mkdirSync(path.join(root, 'plain'));
    const res = await post('plain', 'init');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ has_commits: false, sync: 'no_remote', changes: [] });
    expect(fs.existsSync(path.join(root, 'plain', '.git', 'HEAD'))).toBe(true);
    const again = await post('plain', 'init');
    expect([again.status, again.body.code]).toEqual([409, 'already_a_git_repo']);
  });

  it.each(['init', 'fetch', 'identity', 'commit', 'pull', 'push'])('%s needs a write key', async (action) => {
    fs.mkdirSync(path.join(root, 'plain'));
    const res = await post('plain', action, { name: 'n', email: 'e@x', message: 'm' }, as('k-pod-read'));
    expect([res.status, res.body.code]).toEqual([403, 'forbidden_key']);
    expect(fs.existsSync(path.join(root, 'plain', '.git'))).toBe(false);
  });
});

describe('POST git/fetch', () => {
  it('fetches so a remote commit shows as behind', async () => {
    addRemote(makeRepo('app'));
    commitUpstream('up.txt', 'y');
    expect((await status('app')).body.sync).toBe('in_sync');
    const res = await post('app', 'fetch');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sync: 'behind', behind: 1 });
  });

  it('409s no_remote without a remote', async () => {
    makeRepo('app');
    const res = await post('app', 'fetch');
    expect([res.status, res.body.code]).toEqual([409, 'no_remote']);
  });

  it('never returns credentials from the remote URL, even when the remote is unreachable', async () => {
    const dir = makeRepo('app');
    git(dir, 'remote', 'add', 'origin', 'https://bob:s3cret-token@127.0.0.1:9/acme/app.git');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post('app', 'fetch');
    expect([res.status, res.body.code]).toEqual([502, 'network']);
    expect(JSON.stringify(res.body)).not.toContain('s3cret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('s3cret');
    warn.mockRestore();
  });
});

describe('POST git/identity', () => {
  it.each([
    [{}],
    [{ name: '', email: 'a@b.c' }],
    [{ name: 'A <evil>', email: 'a@b.c' }],
    [{ name: 'Line\nbreak', email: 'a@b.c' }],
    [{ name: 'Ann', email: 'not-an-email' }],
    [{ name: 'Ann', email: 'a b@c.d' }],
  ])('400s invalid_identity for %p', async (body) => {
    makeRepo('app');
    const res = await post('app', 'identity', body);
    expect([res.status, res.body.code]).toEqual([400, 'invalid_identity']);
  });

  it('writes a repo-local identity once, then 409s identity_already_set', async () => {
    const dir = makeRepo('app');
    const res = await post('app', 'identity', { name: ' Ann Dev ', email: 'ann@example.com' });
    expect([res.status, res.body.identity_configured]).toEqual([200, true]);
    expect(git(dir, 'config', '--local', 'user.name').trim()).toBe('Ann Dev');
    expect(git(dir, 'config', '--local', 'user.email').trim()).toBe('ann@example.com');
    const again = await post('app', 'identity', { name: 'Other', email: 'o@example.com' });
    expect([again.status, again.body.code]).toEqual([409, 'identity_already_set']);
    expect(git(dir, 'config', '--local', 'user.name').trim()).toBe('Ann Dev');
  });
});

function hook(dir: string, name: string, script: string): void {
  const file = path.join(dir, '.git', 'hooks', name);
  write(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
}

const head = (dir: string) => git(dir, 'rev-parse', 'HEAD').trim();

describe('POST git/commit', () => {
  it('stages everything, commits, and returns the commit with a clean status', async () => {
    const dir = makeRepo('app');
    setIdentity(dir);
    write(path.join(dir, 'README.md'), 'changed\n');
    write(path.join(dir, 'src', 'new.ts'), 'export {};\n');
    const res = await post('app', 'commit', { message: '  Add new module \n' });
    expect(res.status).toBe(201);
    expect(res.body.commit).toEqual({ sha: head(dir), subject: 'Add new module', author: 'Dev', committed_at: expect.any(String) });
    expect(res.body.status).toMatchObject({ change_count: 0, last_commit: res.body.commit });
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['README.md', 'src/new.ts']);
  });

  it('commits the first commit on an unborn branch', async () => {
    fs.mkdirSync(path.join(root, 'fresh'));
    await post('fresh', 'init');
    setIdentity(path.join(root, 'fresh'));
    write(path.join(root, 'fresh', 'a.txt'), 'a');
    const res = await post('fresh', 'commit', { message: 'first' });
    expect(res.status).toBe(201);
    expect(res.body.status).toMatchObject({ has_commits: true, change_count: 0 });
  });

  it('409s nothing_to_commit on a clean tree', async () => {
    setIdentity(makeRepo('app'));
    const res = await post('app', 'commit', { message: 'noop' });
    expect([res.status, res.body.code]).toEqual([409, 'nothing_to_commit']);
  });

  it.each([[{}], [{ message: '' }], [{ message: '   \n' }], [{ message: 42 }], [{ message: 'a\0b' }]])(
    '400s message_required for %p and stages nothing',
    async (body) => {
      const dir = makeRepo('app');
      setIdentity(dir);
      write(path.join(dir, 'new.txt'), 'x');
      const res = await post('app', 'commit', body);
      expect([res.status, res.body.code]).toEqual([400, 'message_required']);
      expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
    },
  );

  it('409s identity_missing, then commits once the identity is set', async () => {
    const dir = makeRepo('app');
    const before = head(dir);
    write(path.join(dir, 'new.txt'), 'x');
    const missing = await post('app', 'commit', { message: 'try' });
    expect([missing.status, missing.body.code]).toEqual([409, 'identity_missing']);
    expect(head(dir)).toBe(before);

    expect((await post('app', 'identity', { name: 'Ann', email: 'ann@example.com' })).status).toBe(200);
    const res = await post('app', 'commit', { message: 'try again' });
    expect(res.status).toBe(201);
    expect(res.body.commit.author).toBe('Ann');
  });

  it('422s hook_failed with redacted output truncated to 2000 bytes', async () => {
    const dir = makeRepo('app');
    setIdentity(dir);
    git(dir, 'remote', 'add', 'origin', 'https://bob:s3cret-token@example.com/acme/app.git');
    hook(dir, 'pre-commit', `echo "lint failed for $(git remote get-url origin)"\nhead -c 5000 /dev/zero | tr '\\0' x\nexit 1`);
    const before = head(dir);
    write(path.join(dir, 'new.txt'), 'x');
    const res = await post('app', 'commit', { message: 'blocked' });
    expect([res.status, res.body.code]).toEqual([422, 'hook_failed']);
    expect(res.body.detail).toMatch(/^lint failed for https:\/\/example\.com\/acme\/app\.git\nxxx/);
    expect(Buffer.byteLength(res.body.detail)).toBe(2000);
    expect(JSON.stringify(res.body)).not.toContain('s3cret');
    expect(head(dir)).toBe(before);
  });

  it('blocks untracked secrets until each is confirmed in allow_sensitive, but not ignored ones', async () => {
    const dir = makeRepo('app');
    setIdentity(dir);
    write(path.join(dir, '.gitignore'), 'ignored.pem\n');
    write(path.join(dir, 'ignored.pem'), 'key');
    write(path.join(dir, 'config', '.env'), 'SECRET=1');
    write(path.join(dir, '.env.example'), 'SECRET=');
    const before = head(dir);

    const blocked = await post('app', 'commit', { message: 'with secrets' });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toEqual({ error: expect.any(String), code: 'sensitive_files', paths: ['config/.env'] });
    expect(head(dir)).toBe(before);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');

    const allowed = await post('app', 'commit', { message: 'with secrets', allow_sensitive: ['config/.env'] });
    expect(allowed.status).toBe(201);
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD')).toContain('config/.env');
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD')).not.toContain('ignored.pem');
  });

  it('flags staged, intent-to-add and renamed-in secrets, with no cap on the list', async () => {
    const dir = makeRepo('app');
    setIdentity(dir);
    write(path.join(dir, 'notes.txt'), 'n');
    git(dir, 'add', 'notes.txt');
    git(dir, 'commit', '-q', '-m', 'notes');
    write(path.join(dir, '.env'), 'SECRET=1');
    git(dir, 'add', '.env');
    write(path.join(dir, 'id_rsa'), 'key');
    git(dir, 'add', '-N', 'id_rsa');
    git(dir, 'mv', 'notes.txt', 'server.pem');
    const many = Array.from({ length: 25 }, (_, i) => `keys/k${String(i).padStart(2, '0')}.key`);
    for (const f of many) write(path.join(dir, f), 'k');
    const expected = ['.env', 'id_rsa', 'server.pem', ...many].sort();

    const res = await status('app');
    expect([...res.body.sensitive_untracked].sort()).toEqual(expected);
    const blocked = await post('app', 'commit', { message: 'secrets' });
    expect(blocked.body.code).toBe('sensitive_files');
    expect([...blocked.body.paths].sort()).toEqual(expected);
  });

  it('commits only when every current secret is confirmed, and lists the unconfirmed ones', async () => {
    const dir = makeRepo('app');
    setIdentity(dir);
    write(path.join(dir, '.env'), 'A=1');
    write(path.join(dir, 'deploy.pem'), 'k');
    const before = head(dir);

    const partial = await post('app', 'commit', { message: 'm', allow_sensitive: ['.env', 'gone.key'] });
    expect([partial.status, partial.body.code, partial.body.paths]).toEqual([409, 'sensitive_files', ['deploy.pem']]);
    expect(head(dir)).toBe(before);

    const all = await post('app', 'commit', { message: 'm', allow_sensitive: ['.env', 'deploy.pem'] });
    expect(all.status).toBe(201);
  });

  it.each([[true], [false], ['.env'], [[1]], [{ '.env': true }]])('400s invalid_allow_sensitive for %p and stages nothing', async (allow) => {
    const dir = makeRepo('app');
    setIdentity(dir);
    write(path.join(dir, '.env'), 'A=1');
    const res = await post('app', 'commit', { message: 'm', allow_sensitive: allow });
    expect([res.status, res.body.code]).toEqual([400, 'invalid_allow_sensitive']);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('409s conflicts_present during a conflicted merge', async () => {
    const dir = makeRepo('app');
    setIdentity(dir);
    git(dir, 'checkout', '-q', '-b', 'side');
    write(path.join(dir, 'README.md'), 'side\n');
    git(dir, 'commit', '-q', '-am', 'side');
    git(dir, 'checkout', '-q', 'main');
    write(path.join(dir, 'README.md'), 'main\n');
    git(dir, 'commit', '-q', '-am', 'main');
    expect(() => git(dir, 'merge', '-q', 'side')).toThrow();
    const res = await post('app', 'commit', { message: 'resolve' });
    expect([res.status, res.body.code]).toEqual([409, 'conflicts_present']);
  });

  it('answers busy to a second mutation while the first runs, and still serves reads', async () => {
    const dir = makeRepo('app');
    setIdentity(dir);
    hook(dir, 'pre-commit', 'sleep 1');
    write(path.join(dir, 'new.txt'), 'x');
    const first = post('app', 'commit', { message: 'slow' }).then((r) => r);
    await new Promise((r) => setTimeout(r, 300));
    const second = await post('app', 'commit', { message: 'racing' });
    expect([second.status, second.body.code]).toEqual([409, 'busy']);
    expect((await post('app', 'fetch')).body.code).toBe('busy');
    expect((await status('app')).status).toBe(200);
    expect((await first).status).toBe(201);
    expect(git(dir, 'log', '--format=%s', '-2').trim().split('\n')).toEqual(['slow', 'initial']);
  });
});

const remoteHead = (branch = 'main') => git(remote, 'rev-parse', `refs/heads/${branch}`).trim();

function commitLocal(dir: string, file: string, content: string): void {
  write(path.join(dir, file), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `local ${file}`);
}

describe('POST git/pull', () => {
  it('fast-forwards to the upstream', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    commitUpstream('up.txt', 'from upstream');
    const res = await post('app', 'pull');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('fast_forwarded');
    expect(res.body.status).toMatchObject({ sync: 'in_sync', ahead: 0, behind: 0 });
    expect(fs.readFileSync(path.join(dir, 'up.txt'), 'utf8')).toBe('from upstream');
    expect(head(dir)).toBe(remoteHead());
  });

  it('reports up_to_date when there is nothing new', async () => {
    addRemote(makeRepo('app'));
    const res = await post('app', 'pull');
    expect([res.status, res.body.result]).toEqual([200, 'up_to_date']);
  });

  it('409s dirty_would_overwrite and keeps the local edit', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    commitUpstream('README.md', 'upstream edit\n');
    write(path.join(dir, 'README.md'), 'my unsaved edit\n');
    const before = head(dir);
    const res = await post('app', 'pull');
    expect([res.status, res.body.code]).toEqual([409, 'dirty_would_overwrite']);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('my unsaved edit\n');
    expect(head(dir)).toBe(before);
  });

  it('409s not_fast_forward when diverged, without creating a merge', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    commitUpstream('up.txt', 'y');
    commitLocal(dir, 'local.txt', 'x');
    const before = head(dir);
    const res = await post('app', 'pull');
    expect([res.status, res.body.code]).toEqual([409, 'not_fast_forward']);
    expect(head(dir)).toBe(before);
    expect((await status('app')).body.sync).toBe('diverged');
  });

  it('409s conflicts_present mid-merge', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    git(dir, 'checkout', '-q', '-b', 'side');
    commitLocal(dir, 'README.md', 'side\n');
    git(dir, 'checkout', '-q', 'main');
    commitLocal(dir, 'README.md', 'main\n');
    expect(() => git(dir, 'merge', '-q', 'side')).toThrow();
    const res = await post('app', 'pull');
    expect([res.status, res.body.code]).toEqual([409, 'conflicts_present']);
  });

  it('409s no_upstream, no_remote and detached_head', async () => {
    const dir = makeRepo('app');
    expect((await post('app', 'pull')).body.code).toBe('no_remote');
    git(dir, 'remote', 'add', 'origin', remote);
    expect((await post('app', 'pull')).body.code).toBe('no_upstream');
    git(dir, 'checkout', '-q', '--detach');
    expect((await post('app', 'pull')).body.code).toBe('detached_head');
  });
});

describe('POST git/push', () => {
  it('pushes a fast-forward to the upstream', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    commitLocal(dir, 'local.txt', 'x');
    const res = await post('app', 'push');
    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({ sync: 'in_sync', ahead: 0 });
    expect(remoteHead()).toBe(head(dir));
  });

  it('publishes a branch with no upstream to the only remote and sets the upstream', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitLocal(dir, 'f.txt', 'x');
    expect((await status('app')).body.sync).toBe('no_upstream');
    const res = await post('app', 'push');
    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({ branch: 'feature', upstream: 'origin/feature', sync: 'in_sync' });
    expect(remoteHead('feature')).toBe(head(dir));
  });

  it('409s upstream_mismatch and leaves the remote alone when the branch tracks a differently named branch', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    git(dir, 'checkout', '-q', '-b', 'feature', 'origin/main');
    commitLocal(dir, 'f.txt', 'x');
    const before = remoteHead();
    const res = await post('app', 'push');
    expect([res.status, res.body.code]).toEqual([409, 'upstream_mismatch']);
    expect(remoteHead()).toBe(before);
    expect(() => remoteHead('feature')).toThrow();
  });

  it('publishes to the status remote when there are several remotes', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    const fork = path.join(base, 'fork.git');
    git(base, 'init', '-q', '--bare', fork);
    git(dir, 'remote', 'add', 'fork', fork);
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitLocal(dir, 'f.txt', 'x');
    expect((await status('app')).body.remote.name).toBe('origin');
    const res = await post('app', 'push');
    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({ upstream: 'origin/feature', sync: 'in_sync' });
    expect(remoteHead('feature')).toBe(head(dir));
    expect(() => git(fork, 'rev-parse', '--verify', 'refs/heads/feature')).toThrow();
  });

  it('409s no_upstream when several remotes leave no status remote to publish to', async () => {
    const dir = makeRepo('app');
    git(base, 'init', '-q', '--bare', remote);
    git(dir, 'remote', 'add', 'one', remote);
    git(dir, 'remote', 'add', 'two', remote);
    expect((await status('app')).body.remote).toBeNull();
    const res = await post('app', 'push');
    expect([res.status, res.body.code]).toEqual([409, 'no_upstream']);
    expect(() => remoteHead()).toThrow();
  });

  it('never forces: a non-fast-forward is rejected even with a forcing refspec configured', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    git(dir, 'config', 'remote.origin.push', '+refs/heads/*:refs/heads/*');
    commitUpstream('up.txt', 'y');
    const upstream = remoteHead();
    commitLocal(dir, 'local.txt', 'x');
    const res = await post('app', 'push');
    expect([res.status, res.body.code]).toEqual([409, 'not_fast_forward']);
    expect(remoteHead()).toBe(upstream);
  });

  it('409s no_remote and detached_head', async () => {
    const dir = makeRepo('app');
    expect((await post('app', 'push')).body.code).toBe('no_remote');
    addRemote(dir);
    git(dir, 'checkout', '-q', '--detach');
    expect((await post('app', 'push')).body.code).toBe('detached_head');
  });

  it.each(['pull', 'push'])('%s never returns credentials from an unreachable remote URL', async (action) => {
    const dir = makeRepo('app');
    git(dir, 'remote', 'add', 'origin', 'https://bob:s3cret-token@127.0.0.1:9/acme/app.git');
    git(dir, 'config', 'branch.main.remote', 'origin');
    git(dir, 'config', 'branch.main.merge', 'refs/heads/main');
    const res = await post('app', action);
    expect([res.status, res.body.code]).toEqual([502, 'network']);
    expect(JSON.stringify(res.body)).not.toContain('s3cret');
  });
});

describe('mutation reads', () => {
  it('gives the pre-check a mutation-sized timeout while GET still times out at 3 seconds', async () => {
    const dir = makeRepo('app');
    setIdentity(dir);
    write(path.join(dir, 'new.txt'), 'x');
    shimGit();
    process.env.SHIM_SLOW_STATUS = '4';
    expect([(await status('app')).status, (await status('app')).body.code]).toEqual([504, 'timeout']);
    const res = await post('app', 'commit', { message: 'slow status' });
    expect(res.status).toBe(201);
    expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('slow status');
  }, 30_000);

  it('commit answers 201 with status null when only the read after it fails', async () => {
    const dir = makeRepo('app');
    setIdentity(dir);
    write(path.join(dir, 'new.txt'), 'x');
    shimGit();
    process.env.SHIM_BREAK_AFTER = 'commit';
    const res = await post('app', 'commit', { message: 'landed' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ commit: { sha: head(dir), subject: 'landed', author: 'Dev', committed_at: expect.any(String) }, status: null });
  });

  it('pull answers 200 with its result and status null when only the read after it fails', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    commitUpstream('up.txt', 'y');
    shimGit();
    process.env.SHIM_BREAK_AFTER = 'merge';
    const res = await post('app', 'pull');
    expect([res.status, res.body]).toEqual([200, { result: 'fast_forwarded', status: null }]);
    expect(head(dir)).toBe(remoteHead());
  });

  it('push answers 200 with status null when only the read after it fails', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    commitLocal(dir, 'l.txt', 'x');
    shimGit();
    process.env.SHIM_BREAK_AFTER = 'push';
    const res = await post('app', 'push');
    expect([res.status, res.body]).toEqual([200, { status: null }]);
    expect(remoteHead()).toBe(head(dir));
  });

  it('fetch answers 200 with a null body when only the read after it fails', async () => {
    addRemote(makeRepo('app'));
    shimGit();
    process.env.SHIM_BREAK_AFTER = 'fetch';
    const res = await post('app', 'fetch');
    expect([res.status, res.body]).toEqual([200, null]);
  });
});

describe('git-summary counts', () => {
  it('counts an untracked folder once, while the detail status lists every file in it', async () => {
    const dir = makeRepo('app');
    for (const f of ['a', 'b', 'c']) write(path.join(dir, 'build', f), f);
    const summary = await request(app).get('/api/v1/projects/git-summary').set(POD);
    expect(summary.body.summaries.app.change_count).toBe(1);
    expect((await status('app')).body.change_count).toBe(3);
  });
});

describe('an upstream branch deleted on the remote', () => {
  function goneFeature(prune: boolean): string {
    const dir = makeRepo('app');
    addRemote(dir);
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitLocal(dir, 'f.txt', 'x');
    git(dir, 'push', '-q', '-u', 'origin', 'feature');
    git(remote, 'branch', '-q', '-D', 'feature');
    if (prune) git(dir, 'fetch', '-q', '--prune');
    return dir;
  }

  it('reports sync upstream_gone once fetch has pruned it', async () => {
    goneFeature(true);
    expect((await status('app')).body).toMatchObject({ branch: 'feature', upstream: 'origin/feature', sync: 'upstream_gone', ahead: 0, behind: 0 });
  });

  it.each([[true], [false]])('pull 409s no_upstream (pruned before: %p)', async (prune) => {
    const dir = goneFeature(prune);
    const before = head(dir);
    const res = await post('app', 'pull');
    expect([res.status, res.body.code]).toEqual([409, 'no_upstream']);
    expect(head(dir)).toBe(before);
  });

  it('push publishes the branch to the same remote again', async () => {
    const dir = goneFeature(true);
    const res = await post('app', 'push');
    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({ upstream: 'origin/feature', sync: 'in_sync' });
    expect(remoteHead('feature')).toBe(head(dir));
  });
});
