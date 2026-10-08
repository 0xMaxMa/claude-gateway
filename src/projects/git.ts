import { constants as fsConstants, promises as fsp } from 'fs';
import * as path from 'path';
import { listProjects, resolveProjectDir } from './fs';
import { GIT_TIMEOUTS, GitOutput, runGit, withProjectLock } from './git-runner';
import {
  buildStatus,
  GitCommitInfo,
  GitOperation,
  GitStatus,
  GitSummary,
  parseRepoConfig,
  parseStatusV2,
  redactCredentials,
  RepoConfig,
  toSummary,
} from './git-status';
import { err, ok, ProjectName, ProjectsErrorCode, Result } from './paths';

export type GitErrorCode =
  | 'not_a_git_repo'
  | 'already_a_git_repo'
  | 'nothing_to_commit'
  | 'message_required'
  | 'identity_missing'
  | 'identity_already_set'
  | 'invalid_identity'
  | 'sensitive_files'
  | 'invalid_allow_sensitive'
  | 'conflicts_present'
  | 'operation_in_progress'
  | 'not_fast_forward'
  | 'remote_rejected'
  | 'dirty_would_overwrite'
  | 'no_remote'
  | 'no_upstream'
  | 'upstream_mismatch'
  | 'detached_head'
  | 'auth_failed'
  | 'network'
  | 'timeout'
  | 'hook_failed'
  | 'busy'
  | 'index_locked'
  | 'git_failed';

/** The error body beyond `code`: only sensitive_files and hook_failed carry extra fields. */
export type GitError =
  | { code: Exclude<GitErrorCode, 'sensitive_files' | 'hook_failed'> | ProjectsErrorCode }
  | { code: 'sensitive_files'; paths: string[] }
  | { code: 'hook_failed'; detail: string };

export type GitResult<T> = Result<T, GitError>;

const fail = (code: Exclude<GitErrorCode, 'sensitive_files' | 'hook_failed'> | ProjectsErrorCode) => err({ code });

const SUMMARY_CONCURRENCY = 4;
const CONFIG_KEYS = '^(remote\\..*\\.url|user\\.(name|email)|core\\.sshcommand|branch\\..*\\.(remote|merge))$';
const COMMIT_FORMAT = '%H%x00%s%x00%an%x00%cI';

/** First match wins: a rebase also leaves files a merge would. */
const OPERATION_MARKERS: Array<[string, GitOperation]> = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry_pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
];

async function operationIn(gitDir: string): Promise<GitOperation> {
  for (const [marker, op] of OPERATION_MARKERS) {
    if (await fsp.lstat(path.join(gitDir, marker)).then(() => true, () => false)) return op;
  }
  return 'none';
}

export function parseCommitInfo(stdout: string): GitCommitInfo | null {
  const [sha, subject, author, committed_at] = stdout.replace(/\n$/, '').split('\0');
  return sha && committed_at ? { sha, subject, author, committed_at } : null;
}

interface RepoState {
  status: GitStatus;
  config: RepoConfig;
}

interface ReadOptions {
  timeoutMs: number;
  /** `all` lists every file in an untracked folder, which the secret check needs; `normal` lists the folder once. */
  untracked: 'all' | 'normal';
}

const DETAIL_READ: ReadOptions = { timeoutMs: GIT_TIMEOUTS.read, untracked: 'all' };
const SUMMARY_READ: ReadOptions = { timeoutMs: GIT_TIMEOUTS.read, untracked: 'normal' };
/** A mutation already waits on git for seconds; failing its reads at the GET limit would refuse work that can finish. */
const MUTATION_READ: ReadOptions = { timeoutMs: GIT_TIMEOUTS.local, untracked: 'all' };

/** Reads never take the project lock: GIT_OPTIONAL_LOCKS=0 keeps them off the index. */
async function readRepo(dir: string, read: ReadOptions): Promise<GitResult<RepoState>> {
  const opts = { timeoutMs: read.timeoutMs, readOnly: true };
  const runs = await Promise.all([
    runGit(dir, ['rev-parse', '--absolute-git-dir'], opts),
    runGit(dir, ['status', '--porcelain=v2', '--branch', '-z', `--untracked-files=${read.untracked}`], opts),
    runGit(dir, ['config', '-z', '--get-regexp', CONFIG_KEYS], opts),
    runGit(dir, ['log', '-1', '-z', `--format=${COMMIT_FORMAT}`], opts),
  ]);
  for (const r of runs) if (!r.ok) return fail(r.error);
  const [gitDir, status, config, log] = runs.map((r) => (r.ok ? r.value : null!));
  if (gitDir.code !== 0) return fail('not_a_git_repo');
  if (status.code !== 0) return fail('git_failed');
  // get-regexp exits 1 when nothing matches, which is an empty config, not a failure.
  const cfg = parseRepoConfig(config.code === 0 ? config.stdout : '');
  const parsed = parseStatusV2(status.stdout);
  return ok({
    config: cfg,
    status: buildStatus({
      parsed,
      config: cfg,
      lastCommit: log.code === 0 ? parseCommitInfo(log.stdout) : null,
      operation: await operationIn(gitDir.stdout.trim()),
    }),
  });
}

export async function projectDir(root: string, name: ProjectName): Promise<GitResult<string>> {
  const dir = await resolveProjectDir(root, name);
  return dir.ok ? dir : fail(dir.error);
}

async function readStatus(root: string, name: ProjectName, read: ReadOptions): Promise<GitResult<GitStatus>> {
  const dir = await projectDir(root, name);
  if (!dir.ok) return dir;
  const repo = await readRepo(dir.value, read);
  return repo.ok ? ok(repo.value.status) : repo;
}

export function getStatus(root: string, name: ProjectName): Promise<GitResult<GitStatus>> {
  return readStatus(root, name, DETAIL_READ);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Every project with a `.git`; null when its status timed out or failed. Non-git folders are left out. */
export async function getSummaries(root: string): Promise<GitResult<{ summaries: Record<string, GitSummary | null> }>> {
  const list = await listProjects(root);
  if (!list.ok) return fail(list.error);
  const repos = list.value.projects.filter((p) => p.is_git);
  const results = await mapLimit(repos, SUMMARY_CONCURRENCY, async (p) => {
    const status = await readStatus(root, p.name, SUMMARY_READ);
    return status.ok ? toSummary(status.value) : null;
  });
  return ok({ summaries: Object.fromEntries(repos.map((p, i) => [p.name, results[i]])) });
}

/** Ordered: the first pattern found in git's output names the failure. Raw output never reaches the client. */
const OUTPUT_CODES: Array<[RegExp, Exclude<GitErrorCode, 'sensitive_files' | 'hook_failed'>]> = [
  [/index\.lock'?: File exists/i, 'index_locked'],
  // A server hook or branch protection; its message is free text and must not read as a network or auth failure.
  [/\[remote rejected\]/i, 'remote_rejected'],
  [/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|error: 40[13]/i, 'auth_failed'],
  [/Could not resolve host|Connection refused|Connection timed out|Network is unreachable|Failed to connect|unable to access|does not appear to be a git repository|Could not read from remote repository/i, 'network'],
  [/\[rejected\]|non-fast-forward|fetch first|Not possible to fast-forward/i, 'not_fast_forward'],
  [/would be overwritten by merge/i, 'dirty_would_overwrite'],
  [/nothing to commit|no changes added to commit/i, 'nothing_to_commit'],
];

function classify(out: GitOutput): GitError {
  const text = `${out.stderr}\n${out.stdout}`;
  const hit = OUTPUT_CODES.find(([re]) => re.test(text));
  return { code: hit ? hit[1] : 'git_failed' };
}

async function git(dir: string, args: string[], timeoutMs: number, env?: Record<string, string>): Promise<GitResult<GitOutput>> {
  const r = await runGit(dir, args, { timeoutMs, env });
  return r.ok ? r : fail(r.error);
}

/** Network commands must fail rather than ask for an ssh passphrase or host-key confirmation. */
function sshEnv(cfg: RepoConfig): Record<string, string> {
  return cfg.sshCommand ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
}

/** Runs `fn` on the project's real dir under its mutation lock. */
async function mutate<T>(root: string, name: ProjectName, fn: (dir: string) => Promise<GitResult<T>>): Promise<GitResult<T>> {
  const dir = await projectDir(root, name);
  if (!dir.ok) return dir;
  const r = await withProjectLock(dir.value, () => fn(dir.value));
  return !r.ok && r.error === 'busy' ? fail('busy') : (r as GitResult<T>);
}

/** The status after a mutation that succeeded; null when it cannot be read, since failing here would report work that happened as not done. */
async function statusAfter(dir: string): Promise<GitStatus | null> {
  const repo = await readRepo(dir, MUTATION_READ);
  return repo.ok ? repo.value.status : null;
}

export function initRepo(root: string, name: ProjectName): Promise<GitResult<GitStatus | null>> {
  return mutate(root, name, async (dir) => {
    const probe = await git(dir, ['rev-parse', '--absolute-git-dir'], GIT_TIMEOUTS.local);
    if (!probe.ok) return probe;
    if (probe.value.code === 0) return fail('already_a_git_repo');
    const init = await git(dir, ['init', '-q'], GIT_TIMEOUTS.local);
    if (!init.ok) return init;
    if (init.value.code !== 0) return err(classify(init.value));
    return ok(await statusAfter(dir));
  });
}

export function fetchRemote(root: string, name: ProjectName): Promise<GitResult<GitStatus | null>> {
  return mutate(root, name, async (dir) => {
    const repo = await readRepo(dir, MUTATION_READ);
    if (!repo.ok) return repo;
    const { status, config } = repo.value;
    if (!status.remote) return fail('no_remote');
    const fetch = await git(dir, ['fetch', '--prune', '--', status.remote.name], GIT_TIMEOUTS.network, sshEnv(config));
    if (!fetch.ok) return fetch;
    if (fetch.value.code !== 0) return err(classify(fetch.value));
    return ok(await statusAfter(dir));
  });
}

export type GitIdentity = { readonly name: string; readonly email: string } & { readonly __brand: 'GitIdentity' };

const IDENTITY_NAME_MAX = 100;
const EMAIL_MAX = 254;

export function parseIdentity(body: unknown): GitResult<GitIdentity> {
  const { name, email } = (body ?? {}) as { name?: unknown; email?: unknown };
  if (typeof name !== 'string' || typeof email !== 'string') return fail('invalid_identity');
  const n = name.trim();
  const e = email.trim();
  // git drops <, > and newlines from identities, so a value containing them would not round-trip.
  if (n === '' || n.length > IDENTITY_NAME_MAX || /[<>\x00-\x1f\x7f]/.test(n)) return fail('invalid_identity');
  if (e.length > EMAIL_MAX || !/^[^\s<>@]+@[^\s<>@]+$/.test(e)) return fail('invalid_identity');
  return ok({ name: n, email: e } as GitIdentity);
}

export function setIdentity(root: string, name: ProjectName, id: GitIdentity): Promise<GitResult<GitStatus | null>> {
  return mutate(root, name, async (dir) => {
    const repo = await readRepo(dir, MUTATION_READ);
    if (!repo.ok) return repo;
    if (repo.value.status.identity_configured) return fail('identity_already_set');
    for (const [key, value] of [['user.name', id.name], ['user.email', id.email]]) {
      const set = await git(dir, ['config', '--local', key, value], GIT_TIMEOUTS.local);
      if (!set.ok) return set;
      if (set.value.code !== 0) return err(classify(set.value));
    }
    return ok(await statusAfter(dir));
  });
}

/** Refuses work while the tree is mid-merge, mid-rebase or detached; the user resolves those in an editor. */
function blockedBy(status: GitStatus): GitResult<never> | null {
  if (status.conflicted_count > 0) return fail('conflicts_present');
  if (status.operation !== 'none') return fail('operation_in_progress');
  if (status.detached) return fail('detached_head');
  return null;
}

export type CommitMessage = string & { readonly __brand: 'CommitMessage' };

export interface CommitRequest {
  message: CommitMessage;
  /** The secret-looking paths the user confirmed; a path that appears after they looked is not in here. */
  allowSensitive: ReadonlySet<string>;
}

export function parseCommitRequest(body: unknown): GitResult<CommitRequest> {
  const { message, allow_sensitive = [] } = (body ?? {}) as { message?: unknown; allow_sensitive?: unknown };
  // A NUL cannot be passed in argv; it is never part of a real message.
  if (typeof message !== 'string' || message.trim() === '' || message.includes('\0')) return fail('message_required');
  if (!Array.isArray(allow_sensitive) || !allow_sensitive.every((p) => typeof p === 'string')) return fail('invalid_allow_sensitive');
  return ok({ message: message.trim() as CommitMessage, allowSensitive: new Set(allow_sensitive) });
}

const COMMIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg'];
const HOOK_DETAIL_MAX_BYTES = 2000;

/** Whether a commit hook could have produced the failure; honours core.hooksPath. */
async function hasCommitHook(dir: string): Promise<boolean> {
  const paths = await git(dir, ['rev-parse', ...COMMIT_HOOKS.flatMap((h) => ['--git-path', `hooks/${h}`])], GIT_TIMEOUTS.local);
  if (!paths.ok || paths.value.code !== 0) return false;
  for (const p of paths.value.stdout.split('\n').filter(Boolean)) {
    if (await fsp.access(path.resolve(dir, p), fsConstants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

function hookDetail(out: GitOutput): string {
  const text = redactCredentials(`${out.stdout}${out.stderr}`.trim());
  // A cut through a multi-byte character decodes to U+FFFD, which would push past the byte cap.
  return Buffer.from(text).subarray(0, HOOK_DETAIL_MAX_BYTES).toString().replace(/\uFFFD$/, '');
}

export function commitAll(
  root: string,
  name: ProjectName,
  req: CommitRequest,
): Promise<GitResult<{ commit: GitCommitInfo | null; status: GitStatus | null }>> {
  return mutate(root, name, async (dir) => {
    const repo = await readRepo(dir, MUTATION_READ);
    if (!repo.ok) return repo;
    const { status } = repo.value;
    const blocked = blockedBy(status);
    if (blocked) return blocked;
    if (status.change_count === 0) return fail('nothing_to_commit');
    if (!status.identity_configured) return fail('identity_missing');
    const unconfirmed = status.sensitive_untracked.filter((p) => !req.allowSensitive.has(p));
    if (unconfirmed.length > 0) return err({ code: 'sensitive_files', paths: unconfirmed });

    const add = await git(dir, ['add', '-A'], GIT_TIMEOUTS.commit);
    if (!add.ok) return add;
    if (add.value.code !== 0) return err(classify(add.value));
    const commit = await git(dir, ['commit', '-q', '-m', req.message], GIT_TIMEOUTS.commit);
    if (!commit.ok) return commit;
    if (commit.value.code !== 0) {
      // A hook's output is free text: a lint that prints "Could not resolve host" must not read as a network failure.
      if (await hasCommitHook(dir)) return err({ code: 'hook_failed', detail: hookDetail(commit.value) });
      return err(classify(commit.value));
    }

    const after = await statusAfter(dir);
    return ok({ commit: after?.last_commit ?? (await lastCommit(dir)), status: after });
  });
}

async function lastCommit(dir: string): Promise<GitCommitInfo | null> {
  const log = await git(dir, ['log', '-1', '-z', `--format=${COMMIT_FORMAT}`], GIT_TIMEOUTS.local);
  return log.ok && log.value.code === 0 ? parseCommitInfo(log.value.stdout) : null;
}

export type PullResult = 'up_to_date' | 'fast_forwarded';

/** Fetch, then merge --ff-only rather than `git pull`, so pull.rebase and similar config cannot change what runs. */
export function pullFastForward(root: string, name: ProjectName): Promise<GitResult<{ result: PullResult; status: GitStatus | null }>> {
  return mutate(root, name, async (dir) => {
    const repo = await readRepo(dir, MUTATION_READ);
    if (!repo.ok) return repo;
    const { status, config } = repo.value;
    const blocked = blockedBy(status);
    if (blocked) return blocked;
    if (!status.remote) return fail('no_remote');
    if (!status.upstream) return fail('no_upstream');

    const fetch = await git(dir, ['fetch', '--prune', '--', status.remote.name], GIT_TIMEOUTS.network, sshEnv(config));
    if (!fetch.ok) return fetch;
    if (fetch.value.code !== 0) return err(classify(fetch.value));
    const merge = await git(dir, ['merge', '--ff-only', '@{upstream}'], GIT_TIMEOUTS.network);
    if (!merge.ok) return merge;
    // The upstream branch was deleted on the remote, and the fetch above pruned its tracking ref.
    if (merge.value.code !== 0 && /@\{upstream\} - not something we can merge/.test(merge.value.stderr)) return fail('no_upstream');
    if (merge.value.code !== 0) return err(classify(merge.value));

    // LC_ALL=C keeps this message stable.
    const result: PullResult = /^Already up.to.date/m.test(merge.value.stdout) ? 'up_to_date' : 'fast_forwarded';
    return ok({ result, status: await statusAfter(dir) });
  });
}

/**
 * Pushes the branch to its same-named upstream, or with no upstream publishes it with -u to the status remote.
 * Every refspec is explicit and unforced, so a `+` refspec in remote.<name>.push never applies.
 */
export function pushBranch(root: string, name: ProjectName): Promise<GitResult<{ status: GitStatus | null }>> {
  return mutate(root, name, async (dir) => {
    const repo = await readRepo(dir, MUTATION_READ);
    if (!repo.ok) return repo;
    const { status, config } = repo.value;
    const blocked = blockedBy(status);
    if (blocked) return blocked;
    if (config.remotes.length === 0) return fail('no_remote');

    const branchRef = `refs/heads/${status.branch}`;
    const tracking = status.branch ? config.branches[status.branch] : undefined;
    let args: string[];
    if (tracking?.remote && tracking.merge) {
      // A branch made with `checkout -b feature origin/main` tracks main; pushing there would move someone else's branch.
      if (tracking.merge !== branchRef || !config.remotes.some((r) => r.name === tracking.remote)) return fail('upstream_mismatch');
      args = ['push', '--porcelain', tracking.remote, `${branchRef}:${branchRef}`];
    } else if (status.remote && status.branch) {
      // The remote fetch uses, so publishing and checking for updates talk to the same place.
      args = ['push', '--porcelain', '-u', status.remote.name, `${branchRef}:${branchRef}`];
    } else {
      return fail('no_upstream');
    }
    const push = await git(dir, args, GIT_TIMEOUTS.network, sshEnv(config));
    if (!push.ok) return push;
    if (push.value.code !== 0) return err(classify(push.value));

    return ok({ status: await statusAfter(dir) });
  });
}
