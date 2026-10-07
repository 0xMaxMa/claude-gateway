import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitOutput, runGit, withProjectLock } from '../../src/projects/git-runner';
import { err, ok, Result } from '../../src/projects/paths';

let base: string;
let repo: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-git-runner-')));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function value(r: Result<GitOutput, unknown>): GitOutput {
  if (!r.ok) throw new Error(`git failed: ${String(r.error)}`);
  return r.value;
}

describe('runGit', () => {
  it('ignores GIT_* variables from the parent and never prompts', async () => {
    const other = path.join(base, 'other');
    execFileSync('git', ['init', '-q', other]);
    const saved = { ...process.env };
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_SECRET_TEST = 'leak';
    try {
      const dir = value(await runGit(repo, ['rev-parse', '--absolute-git-dir'], { timeoutMs: 3000 }));
      expect(dir.stdout.trim()).toBe(path.join(repo, '.git'));
      const env = value(await runGit(repo, ['-c', 'alias.e=!env', 'e'], { timeoutMs: 3000, readOnly: true })).stdout;
      expect(env).toContain('GIT_TERMINAL_PROMPT=0');
      expect(env).toContain('GIT_OPTIONAL_LOCKS=0');
      expect(env).toContain('LC_ALL=C');
      expect(env).not.toContain('GIT_SECRET_TEST');
    } finally {
      process.env = saved;
    }
  });

  it('does not discover a repository above the project dir', async () => {
    const plain = path.join(repo, 'plain');
    fs.mkdirSync(plain);
    const r = value(await runGit(plain, ['rev-parse', '--show-toplevel'], { timeoutMs: 3000 }));
    expect(r.code).not.toBe(0);
  });

  it('reports a non-zero exit as data, not a failure', async () => {
    const r = value(await runGit(repo, ['rev-parse', '--verify', 'nope'], { timeoutMs: 3000 }));
    expect(r.code).toBe(128);
  });

  it('times out at the deadline even when a child process holds stdout open', async () => {
    const started = Date.now();
    const r = await runGit(repo, ['-c', 'alias.slow=!sleep 30 & sleep 30', 'slow'], { timeoutMs: 300 });
    expect(r).toEqual(err('timeout'));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('withProjectLock', () => {
  it('refuses a second mutation on the same project while the first runs, then frees the lock', async () => {
    let release!: () => void;
    const first = withProjectLock('/p/a', () => new Promise<Result<string, never>>((r) => (release = () => r(ok('first')))));
    expect(await withProjectLock('/p/a', async () => ok('second'))).toEqual(err('busy'));
    expect(await withProjectLock('/p/b', async () => ok('other project'))).toEqual(ok('other project'));
    release();
    expect(await first).toEqual(ok('first'));
    expect(await withProjectLock('/p/a', async () => ok('after'))).toEqual(ok('after'));
  });
});
