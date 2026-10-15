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

  it('neutralizes repo-configured fsmonitor and sshCommand on mutating commands', async () => {
    const marker = path.join(base, 'ran');
    const script = path.join(base, 'mark.sh');
    fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', script], { cwd: repo });
    execFileSync('git', ['config', 'core.sshCommand', script], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'f'), 'x');
    value(await runGit(repo, ['add', '-A'], { timeoutMs: 5000 }));
    value(await runGit(repo, ['ls-remote', 'ssh://localhost:1/x'], { timeoutMs: 5000 }));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('keeps operator auth env but hides the rest of the gateway env from git and its hooks', async () => {
    const saved = { ...process.env };
    process.env.GATEWAY_SECRET_TOKEN = 'leak';
    process.env.GIT_SSH_COMMAND = 'ssh -i /deploy/key';
    process.env.GIT_ASKPASS = '/bin/true';
    try {
      const env = value(await runGit(repo, ['-c', 'alias.e=!env', 'e'], { timeoutMs: 3000 })).stdout;
      expect(env).not.toContain('GATEWAY_SECRET_TOKEN');
      expect(env).toContain('GIT_SSH_COMMAND=ssh -i /deploy/key');
      expect(env).toContain('GIT_ASKPASS=/bin/true');
      expect(env).toContain('PATH=');
    } finally {
      process.env = saved;
    }
  });

  it('defaults to a non-interactive ssh when the operator set none', async () => {
    const saved = { ...process.env };
    delete process.env.GIT_SSH_COMMAND;
    try {
      const env = value(await runGit(repo, ['-c', 'alias.e=!env', 'e'], { timeoutMs: 3000 })).stdout;
      expect(env).toContain('GIT_SSH_COMMAND=ssh -o BatchMode=yes');
    } finally {
      process.env = saved;
    }
  });

  it('returns when git exits even if a hook left a background process holding the pipes', async () => {
    const hook = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nsleep 5 &\n', { mode: 0o755 });
    fs.writeFileSync(path.join(repo, 'f'), 'x');
    execFileSync('git', ['add', 'f'], { cwd: repo });
    const started = Date.now();
    const r = value(
      await runGit(repo, ['-c', 'user.name=a', '-c', 'user.email=a@b.c', 'commit', '-q', '-m', 'm'], { timeoutMs: 20_000 }),
    );
    expect(r.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
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

  const running = (pattern: string) => {
    try {
      return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };

  it('kills the whole process tree on timeout, not just git', async () => {
    const r = await runGit(repo, ['-c', 'alias.slow=!sleep 31.4159 & sleep 31.4159', 'slow'], { timeoutMs: 300 });
    expect(r).toEqual(err('timeout'));
    await new Promise((res) => setTimeout(res, 1500));
    expect(running('^sleep 31.4159$')).toBe('');
  });

  it('lets git remove its index.lock when a timeout interrupts it', async () => {
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.bin filter=slow\n');
    fs.writeFileSync(path.join(repo, 'a.bin'), 'x');
    const r = await runGit(repo, ['-c', 'filter.slow.clean=sleep 27.1828; cat', 'add', '-A'], { timeoutMs: 500 });
    expect(r).toEqual(err('timeout'));
    await new Promise((res) => setTimeout(res, 1500));
    expect(fs.existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false);
    expect(running('sleep 27.1828')).toBe('');
  });

  it('never runs core.fsmonitor on a read-only status', async () => {
    const marker = path.join(base, 'fsmonitor-ran');
    execFileSync('git', ['config', 'core.fsmonitor', `touch ${marker}; false`], { cwd: repo });
    value(await runGit(repo, ['status', '--porcelain=v2'], { timeoutMs: 3000, readOnly: true }));
    expect(fs.existsSync(marker)).toBe(false);
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
