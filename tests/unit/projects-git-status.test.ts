import { hookDetail } from '../../src/projects/git';
import {
  buildStatus,
  CHANGES_LIMIT,
  deriveSync,
  describeRemote,
  GitSync,
  isSensitiveName,
  parseRepoConfig,
  parseStatusV2,
  redactCredentials,
  RepoConfig,
} from '../../src/projects/git-status';

const z = (...records: string[]) => records.join('\0') + '\0';
const OID = 'f07dfbfee2ce06e378dac2f416a12cd82cad3aee';
const H = '5e6775136ae8952f8f3d416f648e964ef25d68ee';
const noConfig: RepoConfig = { remotes: [], userName: null, userEmail: null, sshCommand: null, branches: {} };

describe('parseStatusV2', () => {
  it('reads branch headers with upstream and ahead/behind', () => {
    const p = parseStatusV2(z(`# branch.oid ${OID}`, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3'));
    expect(p).toEqual({ oid: OID, head: 'main', upstream: 'origin/main', upstreamGone: false, ahead: 2, behind: 3, changes: [] });
  });

  it('reads an upstream without ahead/behind as gone', () => {
    const p = parseStatusV2(z(`# branch.oid ${OID}`, '# branch.head feature', '# branch.upstream origin/feature'));
    expect([p.upstream, p.upstreamGone, p.ahead, p.behind]).toEqual(['origin/feature', true, 0, 0]);
  });

  it('reads an unborn branch', () => {
    const p = parseStatusV2(z('# branch.oid (initial)', '# branch.head main', '? a.txt'));
    expect(p.oid).toBeNull();
    expect(p.head).toBe('main');
    expect(p.changes).toEqual([{ path: 'a.txt', staged: null, unstaged: 'untracked' }]);
  });

  it('never reads an unborn branch with an upstream as gone: git prints no ahead/behind for it either way', () => {
    const p = parseStatusV2(z('# branch.oid (initial)', '# branch.head main', '# branch.upstream origin/main'));
    expect([p.upstream, p.upstreamGone]).toEqual(['origin/main', false]);
  });

  it('reads a detached HEAD', () => {
    const p = parseStatusV2(z(`# branch.oid ${OID}`, '# branch.head (detached)'));
    expect(p.head).toBeNull();
    expect(p.upstream).toBeNull();
  });

  it('reads ordinary changes, keeping spaces in paths', () => {
    const p = parseStatusV2(
      z(
        `# branch.oid ${OID}`,
        '# branch.head main',
        `1 M. N... 100644 100644 100644 ${H} ${H} src/a b.ts`,
        `1 .D N... 100644 100644 000000 ${H} ${H} gone.txt`,
        `1 AM N... 000000 100644 100644 ${'0'.repeat(40)} ${H} new.txt`,
        `1 .T N... 100644 100644 120000 ${H} ${H} link`,
      ),
    );
    expect(p.changes).toEqual([
      { path: 'src/a b.ts', staged: 'modified', unstaged: null },
      { path: 'gone.txt', staged: null, unstaged: 'deleted' },
      { path: 'new.txt', staged: 'added', unstaged: 'modified' },
      { path: 'link', staged: null, unstaged: 'type_changed' },
    ]);
  });

  it('reads a rename with its original path as the next record', () => {
    const p = parseStatusV2(
      z(`# branch.oid ${OID}`, '# branch.head main', `2 RM N... 100644 100644 100644 ${H} ${H} R100 h i`, 'f', '? a b'),
    );
    expect(p.changes).toEqual([
      { path: 'h i', orig_path: 'f', staged: 'renamed', unstaged: 'modified' },
      { path: 'a b', staged: null, unstaged: 'untracked' },
    ]);
  });

  it('reads conflicts as conflicted on both sides', () => {
    const p = parseStatusV2(
      z(`# branch.oid ${OID}`, '# branch.head main', `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} c.txt`),
    );
    expect(p.changes).toEqual([{ path: 'c.txt', staged: 'conflicted', unstaged: 'conflicted' }]);
  });
});

describe('deriveSync', () => {
  const table: Array<[string, Parameters<typeof deriveSync>[0], GitSync]> = [
    ['detached wins over everything', { detached: true, hasCommits: true, upstream: 'origin/main', ahead: 1, behind: 1, upstreamGone: false, upstreamMismatch: false, hasRemote: true }, 'detached'],
    ['in sync', { detached: false, hasCommits: true, upstream: 'origin/main', ahead: 0, behind: 0, upstreamGone: false, upstreamMismatch: false, hasRemote: true }, 'in_sync'],
    ['ahead', { detached: false, hasCommits: true, upstream: 'origin/main', ahead: 2, behind: 0, upstreamGone: false, upstreamMismatch: false, hasRemote: true }, 'ahead'],
    ['behind', { detached: false, hasCommits: true, upstream: 'origin/main', ahead: 0, behind: 2, upstreamGone: false, upstreamMismatch: false, hasRemote: true }, 'behind'],
    ['diverged', { detached: false, hasCommits: true, upstream: 'origin/main', ahead: 1, behind: 1, upstreamGone: false, upstreamMismatch: false, hasRemote: true }, 'diverged'],
    ['no upstream with a remote', { detached: false, hasCommits: true, upstream: null, ahead: 0, behind: 0, upstreamGone: false, upstreamMismatch: false, hasRemote: true }, 'no_upstream'],
    ['upstream gone', { detached: false, hasCommits: true, upstream: 'origin/feature', upstreamGone: true, upstreamMismatch: false, ahead: 0, behind: 0, hasRemote: true }, 'upstream_gone'],
    ['no remote', { detached: false, hasCommits: true, upstream: null, ahead: 0, behind: 0, upstreamGone: false, upstreamMismatch: false, hasRemote: false }, 'no_remote'],
    ['unborn with an upstream and nothing online', { detached: false, hasCommits: false, upstream: 'origin/main', ahead: 0, behind: 0, upstreamGone: false, upstreamMismatch: false, hasRemote: true }, 'no_upstream'],
    ['unborn with an upstream that has commits', { detached: false, hasCommits: false, upstream: 'origin/main', ahead: 0, behind: 3, upstreamGone: false, upstreamMismatch: false, hasRemote: true }, 'behind'],
  ];
  it.each(table)('%s', (_label, input, expected) => expect(deriveSync(input)).toBe(expected));
});

describe('parseRepoConfig', () => {
  it('reads remotes, identity, sshCommand and branch tracking from get-regexp -z output', () => {
    const raw = z(
      'user.email\nme@example.com',
      'user.name\nMe',
      'core.sshcommand\nssh -v',
      'remote.My.Remote.url\nhttps://u:p@h/x',
      'branch.feat.x.remote\nMy.Remote',
      'branch.feat.x.merge\nrefs/heads/feat.x',
    );
    expect(parseRepoConfig(raw)).toEqual({
      remotes: [{ name: 'My.Remote', url: 'https://u:p@h/x' }],
      userName: 'Me',
      userEmail: 'me@example.com',
      sshCommand: 'ssh -v',
      branches: { 'feat.x': { remote: 'My.Remote', merge: 'refs/heads/feat.x' } },
    });
  });
});

describe('describeRemote and redactCredentials', () => {
  it.each([
    ['https://user:tok@github.com/o/r.git', 'https://github.com/o/r.git', 'github', 'https://github.com/o/r'],
    ['git@gitlab.com:group/sub/r.git', 'git@gitlab.com:group/sub/r.git', 'gitlab', 'https://gitlab.com/group/sub/r'],
    ['ssh://git@bitbucket.org:22/o/r.git', 'ssh://bitbucket.org:22/o/r.git', 'bitbucket', 'https://bitbucket.org/o/r'],
    ['https://tok@git.example.com/o/r', 'https://git.example.com/o/r', 'other', null],
    ['/srv/git/r.git', '/srv/git/r.git', 'other', null],
  ])('%s', (raw, url, host, web_url) => {
    expect(describeRemote('origin', raw)).toEqual({ name: 'origin', url, host, web_url });
  });

  it('strips credentials from every URL inside free text', () => {
    const text = "fatal: unable to access 'https://bob:s3cret@h.example/x.git/' and http://t0k@h2/y";
    expect(redactCredentials(text)).toBe("fatal: unable to access 'https://h.example/x.git/' and http://h2/y");
  });

  it('strips a password that contains an unencoded @', () => {
    expect(redactCredentials('https://bob:p@ss@h.example/x.git')).toBe('https://h.example/x.git');
  });
});

describe('secrets in remote query strings', () => {
  it.each([
    'https://github.com/a/b.git?token=SECRETVAL',
    'https://github.com/a/b.git?x=1&access_token=SECRETVAL',
    'https://github.com/a/b.git?key=SECRETVAL#frag',
    'https://github.com/a/b.git#access_token=SECRETVAL',
    'https://u:SECRETVAL@github.com/a/b.git?sig=SECRETVAL',
    'git@github.com:a/b.git?password=SECRETVAL',
  ])('%s', (raw) => {
    const r = describeRemote('origin', raw);
    expect(JSON.stringify(r)).not.toContain('SECRETVAL');
    expect(r.web_url).toBe('https://github.com/a/b');
  });

  it('keeps harmless query parameters in free text', () => {
    expect(redactCredentials('https://h/x?page=2&secret=abc')).toBe('https://h/x?page=2&secret=[redacted]');
  });
});

describe('redactCredentials cost', () => {
  it('stays linear on adversarial dotted text', () => {
    const t0 = Date.now();
    redactCredentials('a.'.repeat(50_000));
    redactCredentials('a://'.repeat(25_000));
    redactCredentials('?' + 'a.'.repeat(50_000));
    redactCredentials('&a'.repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('hookDetail cuts before redacting', () => {
    const t0 = Date.now();
    const detail = hookDetail({ code: 1, stdout: 'a.'.repeat(500_000), stderr: '' });
    expect(Date.now() - t0).toBeLessThan(100);
    expect(detail.length).toBeLessThanOrEqual(2000);
  });

  it('hookDetail leaks no part of a credential that straddles the 64K cut', () => {
    const cut = 64 * 1024;
    for (const offset of [1, 3, 8, 12, 20]) {
      const url = 'https://user:SUPERSECRETTOKEN@host/x';
      const filler = `://${'a'.repeat(997)}@ `.repeat(Math.ceil(cut / 1000));
      const text = `${filler.slice(0, cut - offset)}${url}`;
      const detail = hookDetail({ code: 1, stdout: text, stderr: '' });
      expect(detail).not.toContain('SUPERSECRET');
      expect(detail).not.toContain('user:');
    }
  });
});

describe('isSensitiveName', () => {
  it.each(['.env', '.env.local', 'cfg/.env.production', 'a.pem', 'k.key', 'id_rsa', 'id_ed25519', 'c.p12', 'c.pfx', '.npmrc', 'credentials.json', 'service-account-prod.json', '.netrc', '.ENV', '.Env.Local', 'ID_RSA', 'Server.PEM', 'id_ecdsa', 'id_dsa', '.git-credentials'])(
    '%s is sensitive',
    (f) => expect(isSensitiveName(f)).toBe(true),
  );
  it.each(['.env.example', '.env.sample', '.env.template', 'env.ts', 'id_rsa.pub', 'keys.json', 'my.envrc'])('%s is not', (f) =>
    expect(isSensitiveName(f)).toBe(false),
  );
});

describe('buildStatus', () => {
  const parsed = parseStatusV2(
    z(
      `# branch.oid ${OID}`,
      '# branch.head main',
      '? z/.env',
      '? .env.example',
      `1 .M N... 100644 100644 100644 ${H} ${H} b.txt`,
      `1 M. N... 100644 100644 100644 ${H} ${H} c.txt`,
      `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} d.txt`,
    ),
  );

  it('sorts conflicted, staged, unstaged, untracked and counts conflicts and secrets', () => {
    const s = buildStatus({ parsed, config: noConfig, lastCommit: null, operation: 'merge' });
    expect(s.changes.map((c) => c.path)).toEqual(['d.txt', 'c.txt', 'b.txt', '.env.example', 'z/.env']);
    expect([s.change_count, s.conflicted_count, s.truncated]).toEqual([5, 1, false]);
    expect(s.sensitive_untracked).toEqual(['z/.env']);
    expect([s.branch, s.sync, s.identity_configured]).toEqual(['main', 'no_remote', false]);
  });

  it('flags only secret paths that HEAD lacks and git add -A would commit', () => {
    const s = buildStatus({
      parsed: parseStatusV2(
        z(
          `# branch.oid ${OID}`,
          '# branch.head main',
          `1 M. N... 100644 100644 100644 ${H} ${H} tracked.pem`,
          `1 AD N... 000000 100644 000000 ${'0'.repeat(40)} ${H} added-then-deleted.key`,
          `1 A. N... 000000 100644 100644 ${'0'.repeat(40)} ${H} staged.key`,
          `1 .A N... 000000 000000 100644 ${'0'.repeat(40)} ${'0'.repeat(40)} ita.key`,
          `2 R. N... 100644 100644 100644 ${H} ${H} R100 renamed.key`,
          'notes.txt',
        ),
      ),
      config: noConfig,
      lastCommit: null,
      operation: 'none',
    });
    expect([...s.sensitive_untracked].sort()).toEqual(['ita.key', 'renamed.key', 'staged.key']);
  });

  it('caps changes but reports the true count', () => {
    const many = parseStatusV2(z(`# branch.oid ${OID}`, '# branch.head main', ...Array.from({ length: 250 }, (_, i) => `? f${i}`)));
    const s = buildStatus({ parsed: many, config: noConfig, lastCommit: null, operation: 'none' });
    expect([s.changes.length, s.change_count, s.truncated]).toEqual([CHANGES_LIMIT, 250, true]);
  });

  it('names an unborn branch, with no commits', () => {
    const s = buildStatus({ parsed: parseStatusV2(z('# branch.oid (initial)', '# branch.head main')), config: noConfig, lastCommit: null, operation: 'none' });
    expect([s.branch, s.detached, s.has_commits]).toEqual(['main', false, false]);
  });

  it('reports upstream_mismatch when the upstream branch name differs or its remote is not configured', () => {
    const tracking = parseStatusV2(z(`# branch.oid ${OID}`, '# branch.head feature', '# branch.upstream origin/main', '# branch.ab +1 -2'));
    const remotes = [{ name: 'origin', url: 'https://github.com/up/r' }];
    const sync = (branches: RepoConfig['branches']) =>
      buildStatus({ parsed: tracking, config: { ...noConfig, remotes, branches }, lastCommit: null, operation: 'none' });
    expect(sync({ feature: { remote: 'origin', merge: 'refs/heads/main' } })).toMatchObject({ sync: 'upstream_mismatch', ahead: 1, behind: 2 });
    expect(sync({ feature: { remote: '.', merge: 'refs/heads/feature' } }).sync).toBe('upstream_mismatch');
    expect(sync({ feature: { remote: 'origin', merge: 'refs/heads/feature' } }).sync).toBe('diverged');
  });

  it('picks the upstream remote, then origin, then the only remote', () => {
    const remotes = [
      { name: 'fork', url: 'https://github.com/me/r' },
      { name: 'origin', url: 'https://github.com/up/r' },
    ];
    const pick = (config: RepoConfig) => buildStatus({ parsed, config, lastCommit: null, operation: 'none' }).remote?.name ?? null;
    expect(pick({ ...noConfig, remotes, branches: { main: { remote: 'fork' } } })).toBe('fork');
    expect(pick({ ...noConfig, remotes })).toBe('origin');
    expect(pick({ ...noConfig, remotes: [remotes[0]] })).toBe('fork');
    expect(pick({ ...noConfig, remotes: [remotes[0], { name: 'other', url: 'x' }] })).toBeNull();
  });
});
