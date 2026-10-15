import { execFileSync } from 'child_process';
import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createProjectsRouter } from '../../src/api/projects-router';
import type { ApiKey } from '../../src/types';

const apiKeys: ApiKey[] = [
  { key: 'k-pod-write', agents: '*', write: true, admin: true },
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

  it('reports untracked, staged and renamed changes', async () => {
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

  it('refuses a read-only pod key and an agent-scoped key', async () => {
    makeRepo('app');
    expect((await status('app', as('k-pod-read'))).body.code).toBe('forbidden_key');
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

    const res = await request(app).get('/api/v1/projects/git-summary').set(POD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      summaries: {
        app: { branch: 'main', detached: false, sync: 'in_sync', ahead: 0, behind: 0, change_count: 0, conflicted_count: 0, remote_host: 'other' },
        slow: null,
      },
    });
  }, 15_000);
});


function commitLocal(dir: string, file: string, content: string): void {
  write(path.join(dir, file), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `local ${file}`);
}

describe('upstream_mismatch', () => {
  it('reports sync upstream_mismatch with ahead and behind', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    git(dir, 'checkout', '-q', '-b', 'feature', 'origin/main');
    commitLocal(dir, 'f.txt', 'x');
    expect((await status('app')).body).toMatchObject({ branch: 'feature', upstream: 'origin/main', sync: 'upstream_mismatch', ahead: 1, behind: 0 });
  });

  it('reports a branch tracking a local branch as upstream_mismatch', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    git(dir, 'checkout', '-q', '-b', 'feature', '--track', 'main');
    commitLocal(dir, 'f.txt', 'x');
    expect((await status('app')).body).toMatchObject({ upstream: 'main', sync: 'upstream_mismatch', ahead: 1 });
  });

  it('reports no_upstream, with the remote, when branch.<name>.remote names a remote that no longer exists', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitLocal(dir, 'f.txt', 'x');
    git(dir, 'config', 'branch.feature.remote', 'removed');
    git(dir, 'config', 'branch.feature.merge', 'refs/heads/feature');
    expect((await status('app')).body).toMatchObject({ upstream: null, sync: 'no_upstream', remote: { name: 'origin' } });
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
  it('reports sync upstream_gone once the tracking ref is pruned', async () => {
    const dir = makeRepo('app');
    addRemote(dir);
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitLocal(dir, 'f.txt', 'x');
    git(dir, 'push', '-q', '-u', 'origin', 'feature');
    git(remote, 'branch', '-q', '-D', 'feature');
    git(dir, 'fetch', '-q', '--prune');
    expect((await status('app')).body).toMatchObject({ branch: 'feature', upstream: 'origin/feature', sync: 'upstream_gone', ahead: 0, behind: 0 });
  });
});

describe('a clone of an empty remote', () => {
  function emptyClone(): string {
    git(base, 'init', '-q', '-b', 'main', '--bare', remote);
    git(root, 'clone', '-q', remote, 'app');
    return path.join(root, 'app');
  }

  it('reports no_upstream, not upstream_gone, while neither side has commits', async () => {
    emptyClone();
    expect((await status('app')).body).toMatchObject({ branch: 'main', has_commits: false, upstream: 'origin/main', sync: 'no_upstream', ahead: 0, behind: 0 });
  });

  it('reports behind once the remote has commits', async () => {
    const dir = emptyClone();
    commitUpstream('up.txt', 'from upstream');
    git(dir, 'fetch', '-q');
    expect((await status('app')).body).toMatchObject({ has_commits: false, sync: 'behind', ahead: 0, behind: 1 });
  });

  it('reports upstream_gone after a local commit', async () => {
    const dir = emptyClone();
    commitLocal(dir, 'a.txt', 'a');
    expect((await status('app')).body).toMatchObject({ has_commits: true, upstream: 'origin/main', sync: 'upstream_gone' });
  });
});

describe('git write routes', () => {
  it.each(['init', 'fetch', 'identity', 'commit', 'pull', 'push'])('POST git/%s is not served', async (action) => {
    makeRepo('app');
    const res = await request(app).post(`/api/v1/projects/app/git/${action}`).set(POD).send({});
    expect(res.status).toBe(404);
  });
});
