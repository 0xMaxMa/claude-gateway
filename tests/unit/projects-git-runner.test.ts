import * as childProcess from 'child_process';
import { execFileSync } from 'child_process';

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, execFile: jest.fn(actual.execFile) };
});
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { GitOutput, gitEnv, resetOperatorConfigCache, runGit, withProjectLock } from '../../src/projects/git-runner';
import { err, ok, Result } from '../../src/projects/paths';

// Names the gateway reads or interpolates for its own keys: config.template.json placeholders and the provider keys in src/.
const GATEWAY_SECRET_ENV = [
  'ADMIN_API_KEY', 'MY_API_KEY', 'ALFRED_BOT_TOKEN', 'BAERBEL_BOT_TOKEN', 'BAERBEL_LINE_CHANNEL_ACCESS_TOKEN',
  'BAERBEL_LINE_CHANNEL_SECRET', 'ELEVENLABS_API_KEY', 'DEEPGRAM_API_KEY', 'CARTESIA_API_KEY', 'PAXALABS_API_KEY',
  'OPENROUTER_API_KEY', 'IMAGE_API_KEY', 'VIDEO_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'GETPOD_BROWSER_API_KEY', 'GATEWAY_MCP_TOKEN_ENV_PATH',
];

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

  describe('operator config versus repo config', () => {
    let home: string;
    let saved: NodeJS.ProcessEnv;
    const script = (name: string, body = 'exit 1') => {
      const file = path.join(base, name);
      fs.writeFileSync(file, `#!/bin/sh\ntouch ${path.join(base, `${name}.ran`)}\n${body}\n`, { mode: 0o755 });
      return file;
    };
    const ran = (name: string) => fs.existsSync(path.join(base, `${name}.ran`));

    beforeEach(() => {
      saved = { ...process.env };
      home = path.join(base, 'home');
      fs.mkdirSync(home);
      process.env.HOME = home;
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.GIT_SSH_COMMAND;
      delete process.env.GIT_ASKPASS;
      delete process.env.GIT_CONFIG_GLOBAL;
    });
    afterEach(() => {
      process.env = saved;
    });

    it('uses the operator core.sshCommand and ignores the repo one', async () => {
      fs.writeFileSync(path.join(home, '.gitconfig'), `[core]\n\tsshCommand = ${script('user-ssh')}\n`);
      execFileSync('git', ['config', 'core.sshCommand', script('repo-ssh')], { cwd: repo });
      value(await runGit(repo, ['ls-remote', 'ssh://localhost:1/x'], { timeoutMs: 5000 }));
      expect(ran('user-ssh')).toBe(true);
      expect(ran('repo-ssh')).toBe(false);
    });

    it('falls back to a non-interactive ssh over the repo core.sshCommand when the operator set none', async () => {
      execFileSync('git', ['config', 'core.sshCommand', script('repo-ssh')], { cwd: repo });
      const r = value(await runGit(repo, ['config', '--get', 'core.sshCommand'], { timeoutMs: 3000 }));
      expect(r.stdout.trim()).toBe('ssh -o BatchMode=yes');
      value(await runGit(repo, ['ls-remote', 'ssh://localhost:1/x'], { timeoutMs: 5000 }));
      expect(ran('repo-ssh')).toBe(false);
    });

    it('uses the operator core.askPass and ignores the repo one', async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/r.git`;
        fs.writeFileSync(path.join(home, '.gitconfig'), `[core]\n\taskPass = ${script('user-ask', 'echo answer')}\n`);
        execFileSync('git', ['config', 'core.askPass', script('repo-ask', 'echo answer')], { cwd: repo });
        value(await runGit(repo, ['ls-remote', url], { timeoutMs: 8000 }));
        expect(ran('user-ask')).toBe(true);
        expect(ran('repo-ask')).toBe(false);
      } finally {
        server.close();
      }
    });
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
      ['status', ['status', '--porcelain=v2'], true],
      ['add', ['add', '-A'], false],
    ])('does not run a repo filter on %s', async (_n, args, readOnly) => {
      defineFilter();
      dirty();
      value(await runGit(repo, args as string[], { timeoutMs: 5000, readOnly }));
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('does not run a repo filter on commit', async () => {
      defineFilter();
      dirty();
      value(await runGit(repo, ['add', '-A'], { timeoutMs: 5000 }));
      value(await runGit(repo, [...ident, 'commit', '-qm', 'x'], { timeoutMs: 5000 }));
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('does not run a filter that an included file defines', async () => {
      const extra = path.join(repo, '.git', 'extra.cfg');
      execFileSync('git', ['config', '--file', extra, 'filter.evil.clean', script]);
      execFileSync('git', ['config', 'include.path', extra], { cwd: repo });
      dirty();
      value(await runGit(repo, ['status', '--porcelain=v2'], { timeoutMs: 5000, readOnly: true }));
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('keeps a filter from the operator config', async () => {
      fs.writeFileSync(path.join(process.env.HOME!, '.gitconfig'), `[filter "evil"]\n\tclean = ${script}\n`);
      dirty();
      value(await runGit(repo, ['add', '-A'], { timeoutMs: 5000 }));
      expect(fs.existsSync(marker)).toBe(true);
    });

    it('refuses a repo filter name that cannot be blanked', async () => {
      execFileSync('git', ['config', 'filter.a=b.clean', script], { cwd: repo });
      const r = await runGit(repo, ['status'], { timeoutMs: 5000, readOnly: true });
      expect(r.ok).toBe(false);
    });
  });

  describe('operator config lookup cost', () => {
    const lookups = () => lookup.mock.calls.filter((c) => (c[1] as string[]).includes('--get-regexp')).length;
    const lookup = childProcess.execFile as unknown as jest.Mock;
    beforeEach(() => {
      resetOperatorConfigCache();
      lookup.mockClear();
    });

    it('runs no lookup for read-only calls', async () => {
      value(await runGit(repo, ['status', '--porcelain=v2'], { timeoutMs: 3000, readOnly: true }));
      value(await runGit(repo, ['rev-parse', '--absolute-git-dir'], { timeoutMs: 3000 }));
      await runGit(repo, ['log', '-1'], { timeoutMs: 3000 });
      expect(lookups()).toBe(0);
    });

    it('runs one lookup per config environment for the rest', async () => {
      for (let i = 0; i < 3; i++) value(await runGit(repo, ['config', '--get', 'core.askPass'], { timeoutMs: 3000 }));
      expect(lookups()).toBe(1);
      const saved = process.env.HOME;
      process.env.HOME = path.join(base, 'elsewhere');
      try {
        value(await runGit(repo, ['config', '--get', 'core.askPass'], { timeoutMs: 3000 }));
      } finally {
        process.env.HOME = saved;
      }
      expect(lookups()).toBe(2);
    });
  });

  it('passes the credential-helper inputs and none of the gateway secrets', async () => {
    const saved = { ...process.env };
    const passes = ['GH_HOST', 'GH_CONFIG_DIR', 'XDG_RUNTIME_DIR', 'SSH_AGENT_PID', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'LANG'];
    for (const k of passes) process.env[k] = `v-${k}`;
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'foo.bar', GIT_CONFIG_VALUE_0: 'baz' });
    for (const k of GATEWAY_SECRET_ENV) process.env[k] = `leak-${k}`;
    try {
      const env = value(await runGit(repo, ['-c', 'alias.e=!env', 'e'], { timeoutMs: 3000 })).stdout;
      for (const k of passes) expect(env).toContain(`${k}=v-${k}`);
      for (const k of GATEWAY_SECRET_ENV) expect(env).not.toContain(`${k}=`);
      expect(env).not.toContain('leak-');
      expect(env).toContain('GIT_CONFIG_KEY_0=foo.bar');
      expect(env).toContain('GIT_TERMINAL_PROMPT=0');
    } finally {
      process.env = saved;
    }
  });

  describe('forge tokens', () => {
    const TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
    let saved: NodeJS.ProcessEnv;
    beforeEach(() => {
      saved = { ...process.env };
      for (const k of TOKENS) process.env[k] = `tok-${k}`;
    });
    afterEach(() => {
      process.env = saved;
    });

    it.each(['fetch', 'pull', 'push'])('reach %s', (sub) => {
      for (const k of TOKENS) expect(gitEnv(sub)[k]).toBe(`tok-${k}`);
    });
    it.each(['add', 'commit', 'status', 'init', 'log', 'merge', 'config', ''])('do not reach %s', (sub) => {
      for (const k of TOKENS) expect(gitEnv(sub)[k]).toBeUndefined();
    });

    it('do not reach a commit hook', async () => {
      const out = path.join(base, 'hook-env');
      const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
      fs.writeFileSync(hook, `#!/bin/sh\nenv > ${out}\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(repo, 'f'), 'x');
      value(await runGit(repo, ['add', 'f'], { timeoutMs: 5000 }));
      value(await runGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { timeoutMs: 5000 }));
      const env = fs.readFileSync(out, 'utf8');
      expect(env).toContain('GIT_TERMINAL_PROMPT=0');
      for (const k of TOKENS) expect(env).not.toContain(`${k}=`);
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
