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
    expect(p).toEqual({ oid: OID, head: 'main', upstream: 'origin/main', ahead: 2, behind: 3, changes: [] });
  });

  it('reads an unborn branch', () => {
    const p = parseStatusV2(z('# branch.oid (initial)', '# branch.head main', '? a.txt'));
    expect(p.oid).toBeNull();
    expect(p.head).toBe('main');
    expect(p.changes).toEqual([{ path: 'a.txt', staged: null, unstaged: 'untracked' }]);
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
    ['detached wins over everything', { detached: true, upstream: 'origin/main', ahead: 1, behind: 1, hasRemote: true }, 'detached'],
    ['in sync', { detached: false, upstream: 'origin/main', ahead: 0, behind: 0, hasRemote: true }, 'in_sync'],
    ['ahead', { detached: false, upstream: 'origin/main', ahead: 2, behind: 0, hasRemote: true }, 'ahead'],
    ['behind', { detached: false, upstream: 'origin/main', ahead: 0, behind: 2, hasRemote: true }, 'behind'],
    ['diverged', { detached: false, upstream: 'origin/main', ahead: 1, behind: 1, hasRemote: true }, 'diverged'],
    ['no upstream with a remote', { detached: false, upstream: null, ahead: 0, behind: 0, hasRemote: true }, 'no_upstream'],
    ['no remote', { detached: false, upstream: null, ahead: 0, behind: 0, hasRemote: false }, 'no_remote'],
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

describe('isSensitiveName', () => {
  it.each(['.env', '.env.local', 'cfg/.env.production', 'a.pem', 'k.key', 'id_rsa', 'id_ed25519', 'c.p12', 'c.pfx', '.npmrc', 'credentials.json', 'service-account-prod.json', '.netrc'])(
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

  it('caps changes but reports the true count', () => {
    const many = parseStatusV2(z(`# branch.oid ${OID}`, '# branch.head main', ...Array.from({ length: 250 }, (_, i) => `? f${i}`)));
    const s = buildStatus({ parsed: many, config: noConfig, lastCommit: null, operation: 'none' });
    expect([s.changes.length, s.change_count, s.truncated]).toEqual([CHANGES_LIMIT, 250, true]);
  });

  it('reports an unborn branch as null with no commits', () => {
    const s = buildStatus({ parsed: parseStatusV2(z('# branch.oid (initial)', '# branch.head main')), config: noConfig, lastCommit: null, operation: 'none' });
    expect([s.branch, s.detached, s.has_commits]).toEqual([null, false, false]);
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
