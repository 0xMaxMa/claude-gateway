import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { createProject } from '../../src/projects/fs';
import { getStatus, getSummaries } from '../../src/projects/git';
import { parseProjectName, ProjectName } from '../../src/projects/paths';

/**
 * A project folder is untrusted: it may have been cloned from anywhere. Every fixture here plants a command that
 * touches a marker file, and each test asserts that the marker is absent after the gateway has read the repository.
 * `controlRuns` first proves the plant works, by running plain git on it.
 */

let base: string;
let root: string;
let marker: string;
let script: string;
let filterScript: string;
const savedEnv = { ...process.env };

const name = (n: string): ProjectName => {
  const r = parseProjectName(n);
  if (!r.ok) throw new Error(n);
  return r.value;
};

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.com', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.com' },
  });
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A repo under the root with committed a.txt and b.txt. */
function makeRepo(n: string): string {
  const dir = path.join(root, n);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  write(path.join(dir, 'a.txt'), 'one\n');
  write(path.join(dir, 'b.bin'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

/** Same size, other mtime: status must run a clean filter to learn whether the content changed. */
function touchAll(dir: string): void {
  for (const f of ['a.txt', 'b.bin']) {
    write(path.join(dir, f), 'two\n');
    fs.utimesSync(path.join(dir, f), new Date('2001-01-01'), new Date('2001-01-01'));
  }
}

const planted = () => fs.existsSync(marker);
const reset = () => fs.rmSync(marker, { force: true });

/** Plain git, no hardening: the control that tells a test its plant is live. Async, so a test's own http server can answer. */
async function controlRuns(dir: string, ...args: string[]): Promise<boolean> {
  reset();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  await new Promise<void>((resolve) => {
    execFile('git', args.length ? args : ['status', '--porcelain=v2'], { cwd: dir, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 20_000 }, () => resolve()).stdin?.end();
  });
  const ran = planted();
  reset();
  return ran;
}

/** Reads the repository both ways and says whether anything ran. */
async function gatewayRuns(n: string) {
  reset();
  const detail = await getStatus(root, name(n));
  const summary = await getSummaries(root);
  const ran = planted();
  reset();
  return { ran, detail, summary };
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-git-hostile-')));
  root = path.join(base, 'projects');
  fs.mkdirSync(root);
  marker = path.join(base, 'ran');
  script = path.join(base, 'plant.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
  filterScript = path.join(base, 'filter.sh');
  fs.writeFileSync(filterScript, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
  process.env.HOME = path.join(base, 'home');
  process.env.XDG_CONFIG_HOME = path.join(base, 'home', '.config');
  fs.mkdirSync(process.env.HOME);
});

afterEach(() => {
  process.env = { ...savedEnv };
  fs.rmSync(base, { recursive: true, force: true });
});

describe('a partial clone that wants to fetch during a read', () => {
  /** HEAD's a.txt blob is missing and staged as a rename, so status needs it for rename detection and git tries to fetch it. */
  function promisor(remoteUrl: string, config: Array<[string, string]>): string {
    const src = path.join(base, 'src');
    fs.mkdirSync(src);
    git(src, 'init', '-q', '-b', 'main');
    write(path.join(src, 'a.txt'), 'hello\n');
    git(src, 'add', '-A');
    git(src, 'commit', '-q', '-m', 'init');
    git(src, 'config', 'uploadpack.allowFilter', 'true');
    git(src, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const dir = path.join(root, 'promisor');
    git(root, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${src}`, 'promisor');
    git(dir, 'read-tree', 'HEAD');
    const similar = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'hello\nworld\n', encoding: 'utf8' }).trim();
    git(dir, 'update-index', '--force-remove', 'a.txt');
    git(dir, 'update-index', '--add', '--cacheinfo', `100644,${similar},b.txt`);
    git(dir, 'config', 'remote.origin.url', remoteUrl);
    for (const [k, v] of config) git(dir, 'config', k, v);
    fs.rmSync(src, { recursive: true, force: true });
    return dir;
  }

  const cases: Array<[string, () => string]> = [
    ['core.sshCommand on an ssh remote', () => promisor('ssh://evil.invalid/x.git', [['core.sshCommand', script], ['protocol.ssh.allow', 'always']])],
    ['core.askPass and credential.helper on an http remote that asks for credentials', () => promisor(`http://127.0.0.1:${(server.address() as AddressInfo).port}/x.git`, [['core.askPass', script], ['credential.helper', `!${script}`], ['protocol.http.allow', 'always']])],
    ['remote.origin.uploadpack on a local remote', () => promisor(path.join(base, 'nowhere.git'), [['remote.origin.uploadpack', script], ['protocol.file.allow', 'always']])],
    ['an ext:: remote', () => promisor(`ext::${script} %S`, [['protocol.ext.allow', 'always']])],
    ['a per-protocol allow=always over protocol.allow=never', () => promisor('ssh://evil.invalid/x.git', [['core.sshCommand', script], ['protocol.allow', 'never'], ['protocol.ssh.allow', 'always']])],
  ];

  let server: http.Server;
  let connections: number;
  beforeEach(async () => {
    connections = 0;
    server = http.createServer((_req, res) => res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end());
    server.on('connection', () => connections++);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it.each(cases)('runs nothing and connects nowhere for %s', async (_label, build) => {
    build();
    expect(await controlRuns(path.join(root, 'promisor'))).toBe(true);
    connections = 0;
    const { ran, detail, summary } = await gatewayRuns('promisor');
    expect(ran).toBe(false);
    expect(connections).toBe(0);
    expect(detail.ok).toBe(false);
    expect(summary).toEqual({ ok: true, value: { summaries: { promisor: null } } });
  });
});

describe('filter drivers the repository defines', () => {
  const filterConfig = (dir: string, n = 'evil', file?: string) => {
    const target = file ? ['--file', file] : [];
    for (const key of ['clean', 'smudge', 'process']) git(dir, 'config', ...target, `filter.${n}.${key}`, filterScript);
    git(dir, 'config', ...target, `filter.${n}.required`, 'true');
  };
  const attributes = (dir: string, driver = 'evil') => write(path.join(dir, '.gitattributes'), `*.txt filter=${driver}\n*.bin filter=${driver}\n`);

  const variants: Array<[string, (dir: string) => string | void]> = [
    ['.git/config and .gitattributes', (dir) => { filterConfig(dir); attributes(dir); }],
    ['.git/config and .git/info/attributes', (dir) => { filterConfig(dir); write(path.join(dir, '.git', 'info', 'attributes'), '*.txt filter=evil\n*.bin filter=evil\n'); }],
    ['an absolute include of .git/config', (dir) => {
      const extra = path.join(base, 'extra.cfg');
      filterConfig(dir, 'evil', extra);
      git(dir, 'config', 'include.path', extra);
      attributes(dir);
    }],
    ['an includeIf gitdir', (dir) => {
      const extra = path.join(base, 'cond.cfg');
      filterConfig(dir, 'evil', extra);
      git(dir, 'config', `includeIf.gitdir:${dir}/.git.path`, extra);
      attributes(dir);
    }],
    ['a nested include', (dir) => {
      const inner = path.join(base, 'inner.cfg');
      const outer = path.join(base, 'outer.cfg');
      filterConfig(dir, 'evil', inner);
      git(dir, 'config', '--file', outer, 'include.path', inner);
      git(dir, 'config', 'include.path', outer);
      attributes(dir);
    }],
    ['the worktree config', (dir) => {
      git(dir, 'config', 'extensions.worktreeConfig', 'true');
      filterConfig(dir, 'evil', path.join(dir, '.git', 'config.worktree'));
      attributes(dir);
    }],
    ['a driver name holding "="', (dir) => { filterConfig(dir, 'a=b'); attributes(dir, 'a=b'); }],
    ['a driver name holding quotes and dots', (dir) => { filterConfig(dir, 'we"ird.x'); attributes(dir, 'we"ird.x'); }],
    ['a driver with an empty name (config "filter..clean", attribute "filter=")', (dir) => {
      for (const key of ['clean', 'smudge', 'process']) git(dir, 'config', `filter..${key}`, filterScript);
      write(path.join(dir, '.git', 'info', 'attributes'), '* filter=\n');
    }],
    ['an empty-named [filter ""] section written by hand', (dir) => {
      fs.appendFileSync(path.join(dir, '.git', 'config'), `[filter ""]\n\tclean = ${filterScript}\n`);
      write(path.join(dir, '.git', 'info', 'attributes'), '* filter=\n');
    }],
    ['a driver name holding dots (filter.a.b.clean and filter.a.b.smudge)', (dir) => {
      filterConfig(dir, 'a.b');
      attributes(dir, 'a.b');
    }],
    ['a .git file that points to another git dir', (dir) => {
      const moved = path.join(base, 'moved-git');
      fs.renameSync(path.join(dir, '.git'), moved);
      write(path.join(dir, '.git'), `gitdir: ${moved}\n`);
      git(dir, 'config', 'core.worktree', dir);
      filterConfig(dir);
      attributes(dir);
    }],
    ['a driver header on the same line as another section header', (dir) => {
      fs.appendFileSync(path.join(dir, '.git', 'config'), `[core][filter "evil"]\n\tclean = ${filterScript}\n`);
      attributes(dir);
    }],
    ['a config reached through .git/commondir', (dir) => {
      const hidden = path.join(base, 'hidden.git');
      fs.mkdirSync(hidden);
      fs.writeFileSync(path.join(hidden, 'config'), `[core]\n\trepositoryformatversion = 0\n[filter "evil"]\n\tclean = ${filterScript}\n`);
      fs.writeFileSync(path.join(dir, '.git', 'commondir'), hidden);
      for (const d of ['objects', 'refs']) fs.cpSync(path.join(dir, '.git', d), path.join(hidden, d), { recursive: true });
      fs.rmSync(path.join(dir, '.git', 'config'));
      attributes(dir);
    }],
    ['a linked worktree whose main repository defines the driver', (dir) => {
      attributes(dir);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'attrs');
      git(dir, 'worktree', 'add', '-q', path.join(root, 'linked'));
      filterConfig(dir);
      return 'linked';
    }],
    ['a git-lfs style driver, required, with a process filter', (dir) => {
      filterConfig(dir, 'lfs');
      write(path.join(dir, '.gitattributes'), '*.txt filter=lfs diff=lfs merge=lfs -text\n*.bin filter=lfs diff=lfs merge=lfs -text\n');
    }],
  ];

  it.each(variants)('runs nothing for %s, and the status still reads', async (_label, plant) => {
    const main = makeRepo('hostile');
    const project = plant(main) ?? 'hostile';
    const dir = path.join(root, project);
    touchAll(dir);
    expect(await controlRuns(dir)).toBe(true);
    touchAll(dir);
    const { ran, detail, summary } = await gatewayRuns(project);
    expect(ran).toBe(false);
    expect(detail.ok).toBe(true);
    expect(summary).toMatchObject({ ok: true, value: { summaries: expect.objectContaining({ [project]: expect.objectContaining({ branch: expect.anything() }) }) } });
  });

  it('keeps the operator filters from ~/.gitconfig', async () => {
    const dir = makeRepo('hostile');
    write(path.join(process.env.HOME!, '.gitconfig'), `[filter "op"]\n\tclean = ${filterScript}\n`);
    attributes(dir, 'op');
    touchAll(dir);
    await getStatus(root, name('hostile'));
    expect(planted()).toBe(true);
  });

  it('refuses, as git_unreadable, a repository with a driver name too long to blank, and keeps the others in the list', async () => {
    makeRepo('good');
    const dir = makeRepo('bad');
    git(dir, 'config', `filter.${'x'.repeat(2000)}.clean`, filterScript);
    const res = await getStatus(root, name('bad'));
    expect(res).toEqual({ ok: false, error: { code: 'git_unreadable' } });
    const summary = await getSummaries(root);
    expect(summary).toMatchObject({ ok: true, value: { summaries: { good: expect.objectContaining({ branch: 'main' }), bad: null } } });
  });

  describe('bytes that are not valid UTF-8', () => {
    const NAMES: Array<[string, Buffer]> = [
      ['a lone latin-1 byte', Buffer.from('caf\xe9', 'latin1')],
      ['0xff', Buffer.from([0x61, 0xff, 0x62])],
      ['a truncated sequence', Buffer.from([0x61, 0xc3])],
      ['a CESU-8 surrogate', Buffer.from([0x61, 0xed, 0xa0, 0x80])],
    ];
    const bytesIn = (dir: string, file: string, parts: Array<string | Buffer>) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.appendFileSync(path.join(dir, file), Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p))));
    };

    it.each(NAMES)('runs nothing for a filter driver named with %s, and reports the repository unreadable', async (_label, driver) => {
      const dir = makeRepo('hostile');
      bytesIn(dir, '.git/config', ['[filter "', driver, `"]\n\tclean = ${filterScript}\n\tsmudge = ${filterScript}\n`]);
      bytesIn(dir, '.git/info/attributes', ['* filter=', driver, '\n']);
      touchAll(dir);
      expect(await controlRuns(dir)).toBe(true);
      touchAll(dir);
      const { ran, detail, summary } = await gatewayRuns('hostile');
      expect(ran).toBe(false);
      expect(detail).toEqual({ ok: false, error: { code: 'git_unreadable' } });
      expect(summary).toMatchObject({ ok: true, value: { summaries: { hostile: null } } });
    });

    it('still reads a repository whose include path and attribute files hold invalid UTF-8, and blanks its valid-named driver', async () => {
      const dir = makeRepo('hostile');
      const odd = Buffer.from('caf\xe9', 'latin1');
      const included = Buffer.concat([Buffer.from(base + '/inc-'), odd, Buffer.from('.cfg')]);
      fs.writeFileSync(included, `[filter "evil"]\n\tclean = ${filterScript}\n`);
      bytesIn(dir, '.git/config', ['[include]\n\tpath = ', included, '\n']);
      const attrFile = Buffer.concat([Buffer.from(base + '/attr-'), odd]);
      fs.writeFileSync(attrFile, Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from('.txt filter=evil\n*.txt filter=evil\n*.bin filter=evil\n')]));
      bytesIn(dir, '.git/config', ['[core]\n\tattributesFile = ', attrFile, '\n']);
      bytesIn(dir, '.git/info/attributes', [Buffer.from([0x63, 0xe9]), '.bin filter=evil\n*.bin filter=evil\n']);
      touchAll(dir);
      expect(await controlRuns(dir)).toBe(true);
      touchAll(dir);
      const { ran, detail } = await gatewayRuns('hostile');
      expect(ran).toBe(false);
      expect(detail.ok).toBe(true);
    });
  });

  it('refuses a repository that defines more drivers than it blanks', async () => {
    const dir = makeRepo('many');
    for (let i = 0; i < 80; i++) git(dir, 'config', `filter.f${i}.clean`, filterScript);
    expect(await getStatus(root, name('many'))).toEqual({ ok: false, error: { code: 'git_unreadable' } });
  });

  it('lists the other repositories when one is hostile', async () => {
    makeRepo('good');
    const dir = makeRepo('evil');
    filterConfig(dir);
    attributes(dir);
    touchAll(dir);
    const summary = await getSummaries(root);
    expect(planted()).toBe(false);
    expect(summary).toMatchObject({ ok: true, value: { summaries: { good: expect.objectContaining({ branch: 'main' }), evil: expect.objectContaining({ branch: 'main' }) } } });
  });
});

describe('other config that names a command', () => {
  it('does not run gpg.program for log.showSignature on a signed HEAD', async () => {
    const dir = makeRepo('signed');
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}').trim();
    const parent = git(dir, 'rev-parse', 'HEAD').trim();
    const body = `tree ${tree}\nparent ${parent}\nauthor a <a@b> 1 +0000\ncommitter a <a@b> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n`;
    const commit = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: dir, input: body, encoding: 'utf8' }).trim();
    git(dir, 'update-ref', 'HEAD', commit);
    git(dir, 'config', 'log.showSignature', 'true');
    git(dir, 'config', 'gpg.program', script);
    expect(await controlRuns(dir, 'log', '-1')).toBe(true);
    const res = await getStatus(root, name('signed'));
    expect(planted()).toBe(false);
    expect(res).toMatchObject({ ok: true, value: { last_commit: { subject: 'signed' } } });
  });

  it('does not run the filters of a submodule with a checked-out worktree', async () => {
    const sub = path.join(base, 'sub');
    fs.mkdirSync(sub);
    git(sub, 'init', '-q', '-b', 'main');
    write(path.join(sub, 'f.txt'), 'one\n');
    git(sub, 'add', '-A');
    git(sub, 'commit', '-q', '-m', 's');
    const dir = makeRepo('super');
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm');
    git(dir, 'commit', '-q', '-m', 'add submodule');
    git(path.join(dir, 'sm'), 'config', 'filter.evil.clean', filterScript);
    write(path.join(dir, 'sm', '.gitattributes'), 'f.txt filter=evil\n');
    write(path.join(dir, 'sm', 'f.txt'), 'two\n');
    fs.utimesSync(path.join(dir, 'sm', 'f.txt'), new Date('2001-01-01'), new Date('2001-01-01'));
    expect(await controlRuns(dir)).toBe(true);
    fs.utimesSync(path.join(dir, 'sm', 'f.txt'), new Date('2001-01-02'), new Date('2001-01-02'));
    const { ran, detail } = await gatewayRuns('super');
    expect(ran).toBe(false);
    expect(detail.ok).toBe(true);
  });

  it('does not run core.fsmonitor', async () => {
    const dir = makeRepo('fsm');
    git(dir, 'config', 'core.fsmonitor', script);
    const { ran, detail } = await gatewayRuns('fsm');
    expect(ran).toBe(false);
    expect(detail.ok).toBe(true);
  });
});

describe('a repository with many files', () => {
  it('reads, or times out cleanly, without taking the whole read budget twice', async () => {
    const dir = makeRepo('big');
    for (let i = 0; i < 20_000; i++) write(path.join(dir, 'src', `d${i % 100}`, `f${i}.txt`), `${i}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'many');
    for (let i = 0; i < 50; i++) write(path.join(dir, 'src', `d${i}`, `f${i}.txt`), 'changed\n');
    const started = Date.now();
    const res = await getStatus(root, name('big'));
    expect(Date.now() - started).toBeLessThan(7_000);
    if (res.ok) expect(res.value.change_count).toBe(50);
    else expect(res.error.code).toBe('timeout');
  }, 60_000);
});

describe('errors that say what is wrong', () => {
  /** Runs the real git, but as if another user owned every repository, which git checks for itself. */
  function otherOwner(): void {
    const bin = path.join(base, 'owner-bin');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    write(path.join(bin, 'git'), `#!/bin/sh\nGIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec "${real}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  }

  it('reports a repository owned by another user as git_unsafe_owner, not as a missing repository', async () => {
    makeRepo('theirs');
    otherOwner();
    expect(await getStatus(root, name('theirs'))).toEqual({ ok: false, error: { code: 'git_unsafe_owner' } });
  });

  it('keeps the list working: the other-owner repository is null, the rest read', async () => {
    makeRepo('theirs');
    otherOwner();
    expect(await getSummaries(root)).toEqual({ ok: true, value: { summaries: { theirs: null } } });
  });

  it('still says not_a_git_repo for a plain folder', async () => {
    fs.mkdirSync(path.join(root, 'plain'));
    expect(await getStatus(root, name('plain'))).toEqual({ ok: false, error: { code: 'not_a_git_repo' } });
  });

  const nonRoot = process.getuid?.() !== 0;
  (nonRoot ? it : it.skip)('reports a .git git cannot open as git_unreadable', async () => {
    const dir = makeRepo('locked');
    fs.chmodSync(path.join(dir, '.git'), 0o000);
    try {
      expect(await getStatus(root, name('locked'))).toEqual({ ok: false, error: { code: 'git_unreadable' } });
    } finally {
      fs.chmodSync(path.join(dir, '.git'), 0o755);
    }
  });

  it('reports a .git file that points nowhere as git_unreadable', async () => {
    fs.mkdirSync(path.join(root, 'dangling'));
    write(path.join(root, 'dangling', '.git'), 'gitdir: /nonexistent/nowhere\n');
    expect(await getStatus(root, name('dangling'))).toEqual({ ok: false, error: { code: 'git_unreadable' } });
  });
});

describe('git init on project creation', () => {
  it('runs with the same hardening as the reads: no transport, no fsmonitor, no gateway secrets', async () => {
    const bin = path.join(base, 'spy-bin');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const seen = path.join(base, 'seen');
    write(path.join(bin, 'git'), `#!/bin/sh\n{ echo "ARGS $*"; env; } > ${seen}\nexec "${real}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.GATEWAY_SECRET_TOKEN = 'leak';
    const res = await createProject(root, name('fresh'), true);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.project.is_git).toBe(true);
    const out = fs.readFileSync(seen, 'utf8');
    expect(out).toContain('core.fsmonitor=false');
    expect(out).toContain('--no-optional-locks');
    expect(out).toMatch(/^GIT_ALLOW_PROTOCOL=$/m);
    expect(out).not.toContain('GATEWAY_SECRET_TOKEN');
  });
});
