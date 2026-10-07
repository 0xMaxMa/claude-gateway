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
    expect((await status('fresh')).body).toMatchObject({ branch: null, detached: false, has_commits: false, last_commit: null });

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
    const hook = path.join(base, 'slow-fsmonitor.sh');
    write(hook, '#!/bin/sh\nsleep 10\n');
    fs.chmodSync(hook, 0o755);
    git(slow, 'config', 'core.fsmonitor', hook);

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

  it.each(['init', 'fetch', 'identity'])('%s needs a write key', async (action) => {
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
