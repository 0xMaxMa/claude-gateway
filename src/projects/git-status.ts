export type GitHost = 'github' | 'gitlab' | 'bitbucket' | 'other';

export type GitSync =
  | 'in_sync'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'no_upstream'
  | 'upstream_gone'
  | 'upstream_mismatch'
  | 'no_remote'
  | 'detached';

export type GitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'untracked'
  | 'conflicted';

export interface GitFileChange {
  path: string;
  orig_path?: string;
  staged: GitChangeKind | null;
  unstaged: GitChangeKind | null;
}

export interface GitRemote {
  name: string;
  url: string;
  host: GitHost;
  web_url: string | null;
}

export type GitOperation = 'none' | 'merge' | 'rebase' | 'cherry_pick' | 'revert' | 'bisect';

export interface GitCommitInfo {
  sha: string;
  subject: string;
  author: string;
  committed_at: string;
}

export interface GitStatus {
  branch: string | null;
  detached: boolean;
  has_commits: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  sync: GitSync;
  remote: GitRemote | null;
  changes: GitFileChange[];
  change_count: number;
  conflicted_count: number;
  truncated: boolean;
  last_commit: GitCommitInfo | null;
  operation: GitOperation;
}

export interface GitSummary {
  branch: string | null;
  detached: boolean;
  sync: GitSync;
  ahead: number;
  behind: number;
  change_count: number;
  conflicted_count: number;
  remote_host: GitHost | null;
}

/** What `git status --porcelain=v2 --branch -z` says, before anything else is joined in. */
export interface ParsedStatus {
  /** null for an unborn branch (`branch.oid (initial)`). */
  oid: string | null;
  /** null when detached. */
  head: string | null;
  upstream: string | null;
  /**
   * The branch has commits and an upstream setting, but no remote-tracking branch: deleted and pruned, or never
   * fetched, which porcelain cannot tell apart. Never set on an unborn branch, where git prints no `branch.ab` either way.
   */
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
}

/** The repo config keys status needs, read in one `git config --get-regexp` call. */
export interface RepoConfig {
  remotes: Array<{ name: string; url: string }>;
  /** `branch.<name>.remote` and `branch.<name>.merge`, keyed by branch name. */
  branches: Record<string, { remote?: string; merge?: string }>;
}

export const CHANGES_LIMIT = 200;

const KIND_BY_CODE: Record<string, GitChangeKind | null> = {
  '.': null,
  M: 'modified',
  T: 'type_changed',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflicted',
};

function kindOf(code: string): GitChangeKind | null {
  return code in KIND_BY_CODE ? KIND_BY_CODE[code] : 'modified';
}

/** Splits off the first `n` space-separated fields; the remainder is the path, which may contain spaces. */
function fields(record: string, n: number): { parts: string[]; rest: string } {
  const parts: string[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const sp = record.indexOf(' ', at);
    parts.push(record.slice(at, sp));
    at = sp + 1;
  }
  return { parts, rest: record.slice(at) };
}

export function parseStatusV2(raw: string): ParsedStatus {
  const out: ParsedStatus = { oid: null, head: null, upstream: null, upstreamGone: false, ahead: 0, behind: 0, changes: [] };
  let sawAheadBehind = false;
  const records = raw.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec === '') continue;
    switch (rec[0]) {
      case '#': {
        const { parts, rest } = fields(rec, 2);
        const key = parts[1];
        if (key === 'branch.oid') out.oid = rest === '(initial)' ? null : rest;
        else if (key === 'branch.head') out.head = rest === '(detached)' ? null : rest;
        else if (key === 'branch.upstream') out.upstream = rest;
        else if (key === 'branch.ab') {
          const m = /^\+(\d+) -(\d+)$/.exec(rest);
          sawAheadBehind = true;
          if (m) [out.ahead, out.behind] = [Number(m[1]), Number(m[2])];
        }
        break;
      }
      case '1': {
        const { parts, rest } = fields(rec, 8);
        out.changes.push({ path: rest, staged: kindOf(parts[1][0]), unstaged: kindOf(parts[1][1]) });
        break;
      }
      case '2': {
        const { parts, rest } = fields(rec, 9);
        // The original path is the next NUL-separated record.
        out.changes.push({ path: rest, orig_path: records[++i], staged: kindOf(parts[1][0]), unstaged: kindOf(parts[1][1]) });
        break;
      }
      case 'u': {
        const { rest } = fields(rec, 10);
        out.changes.push({ path: rest, staged: 'conflicted', unstaged: 'conflicted' });
        break;
      }
      case '?':
        out.changes.push({ path: rec.slice(2), staged: null, unstaged: 'untracked' });
        break;
      // '!' (ignored) is never requested.
    }
  }
  out.upstreamGone = out.oid !== null && out.upstream !== null && !sawAheadBehind;
  return out;
}

export function parseRepoConfig(raw: string): RepoConfig {
  const cfg: RepoConfig = { remotes: [], branches: {} };
  for (const entry of raw.split('\0')) {
    const nl = entry.indexOf('\n');
    if (nl < 0) continue;
    const key = entry.slice(0, nl);
    const value = entry.slice(nl + 1);
    let m: RegExpExecArray | null;
    if ((m = /^remote\.(.+)\.url$/.exec(key))) {
      if (!cfg.remotes.some((r) => r.name === m![1])) cfg.remotes.push({ name: m[1], url: value });
    } else if ((m = /^branch\.(.+)\.(remote|merge)$/.exec(key))) {
      (cfg.branches[m[1]] ??= {})[m[2] as 'remote' | 'merge'] = value;
    }
  }
  return cfg;
}

export function deriveSync(s: {
  detached: boolean;
  hasCommits: boolean;
  upstream: string | null;
  upstreamGone: boolean;
  upstreamMismatch: boolean;
  ahead: number;
  behind: number;
  hasRemote: boolean;
}): GitSync {
  if (s.detached) return 'detached';
  if (s.upstream === null) return s.hasRemote ? 'no_upstream' : 'no_remote';
  if (s.upstreamMismatch) return 'upstream_mismatch';
  if (s.upstreamGone) return 'upstream_gone';
  // Unborn and nothing online to pull: in sync would claim it is published.
  if (!s.hasCommits && s.behind === 0) return 'no_upstream';
  if (s.ahead > 0 && s.behind > 0) return 'diverged';
  if (s.ahead > 0) return 'ahead';
  if (s.behind > 0) return 'behind';
  return 'in_sync';
}

const SECRET_PARAM = /([?&#;](?:[\w.-]*(?:token|password|passwd|secret|sig|signature|auth|credential)|api[_-]?key|key)=)[^&#\s'"]+/gi;

/** `https://user:token@host/x?token=s` becomes `https://host/x?token=[redacted]`, anywhere in `text`. */
export function redactCredentials(text: string): string {
  return text.replace(/:\/\/[^\s/]*@/g, '://').replace(SECRET_PARAM, '$1[redacted]');
}

const KNOWN_HOSTS: Record<string, GitHost> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
};

/** Host and `owner/repo` path from an https, ssh:// or scp-style (`git@host:owner/repo`) URL. */
function hostAndPath(url: string): { host: string; repoPath: string } | null {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(url);
  if (scheme) return { host: scheme[1].toLowerCase(), repoPath: scheme[2] };
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.*)$/.exec(url);
  if (scp) return { host: scp[1].toLowerCase(), repoPath: scp[2] };
  return null;
}

/** The remote's hostname alone, or null when it is not a plain DNS name. */
export function remoteHostname(url: string): string | null {
  const host = hostAndPath(redactCredentials(url))?.host;
  return host && /^[a-z0-9.-]+$/.test(host) ? host : null;
}

export function describeRemote(name: string, rawUrl: string): GitRemote {
  const url = redactCredentials(rawUrl);
  const parsed = hostAndPath(url);
  const host = (parsed && KNOWN_HOSTS[parsed.host]) ?? 'other';
  const repoPath = parsed?.repoPath.replace(/[?#].*$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const web_url = host !== 'other' && repoPath ? `https://${parsed!.host}/${repoPath}` : null;
  return { name, url, host, web_url };
}

/** The upstream's remote, else "origin", else the only remote. */
export function pickRemote(cfg: RepoConfig, branch: string | null): { name: string; url: string } | null {
  const upstreamRemote = branch ? cfg.branches[branch]?.remote : undefined;
  return (
    cfg.remotes.find((r) => r.name === upstreamRemote) ??
    cfg.remotes.find((r) => r.name === 'origin') ??
    (cfg.remotes.length === 1 ? cfg.remotes[0] : null)
  );
}

/**
 * The upstream is not a same-named branch on a configured remote: `checkout -b feature origin/main`, or a branch
 * tracking a local one (remote "."). Publishing there would move someone else's branch.
 */
function tracksAnotherBranch(config: RepoConfig, head: string | null, upstream: string | null): boolean {
  if (head === null || upstream === null) return false;
  const tracking = config.branches[head];
  return tracking?.merge !== `refs/heads/${head}` || !config.remotes.some((r) => r.name === tracking.remote);
}

/** Sort rank: conflicted, staged, unstaged, untracked. */
function rank(c: GitFileChange): number {
  if (c.staged === 'conflicted') return 0;
  if (c.staged !== null) return 1;
  if (c.unstaged !== 'untracked') return 2;
  return 3;
}

export function buildStatus(input: {
  parsed: ParsedStatus;
  config: RepoConfig;
  lastCommit: GitCommitInfo | null;
  operation: GitOperation;
}): GitStatus {
  const { parsed, config } = input;
  const detached = parsed.head === null;
  const picked = pickRemote(config, parsed.head);
  const sorted = [...parsed.changes].sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    branch: parsed.head,
    detached,
    has_commits: parsed.oid !== null,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    sync: deriveSync({
      detached,
      hasCommits: parsed.oid !== null,
      upstream: parsed.upstream,
      upstreamGone: parsed.upstreamGone,
      upstreamMismatch: tracksAnotherBranch(config, parsed.head, parsed.upstream),
      ahead: parsed.ahead,
      behind: parsed.behind,
      hasRemote: config.remotes.length > 0,
    }),
    remote: picked ? describeRemote(picked.name, picked.url) : null,
    changes: sorted.slice(0, CHANGES_LIMIT),
    change_count: sorted.length,
    conflicted_count: sorted.filter((c) => c.staged === 'conflicted').length,
    truncated: sorted.length > CHANGES_LIMIT,
    last_commit: input.lastCommit,
    operation: input.operation,
  };
}

export function toSummary(s: GitStatus): GitSummary {
  return {
    branch: s.branch,
    detached: s.detached,
    sync: s.sync,
    ahead: s.ahead,
    behind: s.behind,
    change_count: s.change_count,
    conflicted_count: s.conflicted_count,
    remote_host: s.remote?.host ?? null,
  };
}
