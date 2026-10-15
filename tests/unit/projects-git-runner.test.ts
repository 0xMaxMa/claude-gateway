import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitOutput, runGit } from '../../src/projects/git-runner';
import { err, Result } from '../../src/projects/paths';

const GATEWAY_SECRET_ENV = ['ADMIN_API_KEY', 'ANTHROPIC_API_KEY', 'ALFRED_BOT_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'GIT_SSH_COMMAND'];

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
      const env = value(await runGit(repo, ['-c', 'alias.e=!env', 'e'], { timeoutMs: 3000 })).stdout;
      expect(env).toContain('GIT_TERMINAL_PROMPT=0');
      expect(env).toContain('GIT_OPTIONAL_LOCKS=0');
      expect(env).toContain('LC_ALL=C');
      expect(env).not.toContain('GIT_SECRET_TEST');
    } finally {
      process.env = saved;
    }
  });

  it('passes only the allowlisted environment, and no credential or network variable', async () => {
    const saved = { ...process.env };
    for (const k of GATEWAY_SECRET_ENV) process.env[k] = `leak-${k}`;
    Object.assign(process.env, { XDG_CONFIG_HOME: '/xdg', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'foo.bar', GIT_CONFIG_VALUE_0: 'baz' });
    try {
      const env = value(await runGit(repo, ['-c', 'alias.e=!env', 'e'], { timeoutMs: 3000 })).stdout;
      expect(env).not.toContain('leak-');
      expect(env).not.toContain('GIT_CONFIG_KEY_0');
      for (const kept of ['PATH=', 'HOME=', 'XDG_CONFIG_HOME=/xdg', 'GIT_CONFIG_NOSYSTEM=1', 'GIT_TERMINAL_PROMPT=0']) expect(env).toContain(kept);
    } finally {
      process.env = saved;
    }
  });

  describe('repository filter drivers', () => {
    const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    let marker: string;
    let script: string;
    let saved: NodeJS.ProcessEnv;
    beforeEach(() => {
      saved = { ...process.env };
      process.env.HOME = path.join(base, 'home');
      fs.mkdirSync(process.env.HOME);
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.GIT_CONFIG_GLOBAL;
      marker = path.join(base, 'filter-ran');
      script = path.join(base, 'filter.sh');
      fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
      fs.writeFileSync(path.join(repo, 'b.txt'), 'one\n');
      fs.writeFileSync(path.join(repo, '.gitattributes'), 'a.txt filter=evil\n');
      fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'b.txt filter=evil\n');
      execFileSync('git', [...ident, 'add', '-A'], { cwd: repo });
      execFileSync('git', [...ident, 'commit', '-qm', 'init'], { cwd: repo });
    });
    afterEach(() => {
      process.env = saved;
    });

    const dirty = () => {
      for (const f of ['a.txt', 'b.txt']) {
        fs.writeFileSync(path.join(repo, f), 'two\n');
        fs.utimesSync(path.join(repo, f), new Date('2001-01-01'), new Date('2001-01-01'));
      }
    };
    const defineFilter = (extra: string[] = []) => {
      for (const key of ['clean', 'smudge']) execFileSync('git', ['config', ...extra, `filter.evil.${key}`, script], { cwd: repo });
    };

    it.each([
      ['status', ['status', '--porcelain=v2']],
    ])('does not run a repo filter on %s', async (_n, args) => {
      defineFilter();
      dirty();
      value(await runGit(repo, args as string[], { timeoutMs: 5000 }));
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('does not run a filter that an included file defines', async () => {
      const extra = path.join(repo, '.git', 'extra.cfg');
      execFileSync('git', ['config', '--file', extra, 'filter.evil.clean', script]);
      execFileSync('git', ['config', 'include.path', extra], { cwd: repo });
      dirty();
      value(await runGit(repo, ['status', '--porcelain=v2'], { timeoutMs: 5000 }));
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('keeps a filter from the operator config', async () => {
      fs.writeFileSync(path.join(process.env.HOME!, '.gitconfig'), `[filter "evil"]\n\tclean = ${script}\n`);
      dirty();
      value(await runGit(repo, ['status', '--porcelain=v2'], { timeoutMs: 5000 }));
      expect(fs.existsSync(marker)).toBe(true);
    });

    it('refuses a repo filter name that cannot be blanked', async () => {
      execFileSync('git', ['config', 'filter.a=b.clean', script], { cwd: repo });
      const r = await runGit(repo, ['status'], { timeoutMs: 5000 });
      expect(r.ok).toBe(false);
    });
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
    value(await runGit(repo, ['status', '--porcelain=v2'], { timeoutMs: 3000 }));
    expect(fs.existsSync(marker)).toBe(false);
  });
});
