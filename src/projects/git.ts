import { promises as fsp } from 'fs';
import * as path from 'path';
import { listProjects, mapLimit, resolveProjectDir } from './fs';
import { GIT_READ_TIMEOUT_MS, GitOutput, MAX_BLANKED_FILTER_KEYS, MAX_FILTER_KEY, runGit } from './git-runner';
import {
  buildStatus,
  GitCommitInfo,
  GitOperation,
  GitStatus,
  GitSummary,
  parseConfigList,
  parseStatusV2,
  toSummary,
} from './git-status';
import { err, ok, ProjectName, ProjectsErrorCode, Result } from './paths';

export type GitErrorCode =
  | 'not_a_git_repo'
  /** git refuses a repository that another user owns (`safe.directory`). */
  | 'git_unsafe_owner'
  /** There is a `.git` that git cannot read: permissions, damage, a bad config, or a filter setup the gateway cannot make safe. */
  | 'git_unreadable'
  | 'timeout'
  /** git is not installed or not on the gateway's PATH. */
  | 'git_unavailable'
  | 'git_failed';

export type GitError = { code: GitErrorCode | ProjectsErrorCode };

export type GitResult<T> = Result<T, GitError>;

const fail = (code: GitErrorCode | ProjectsErrorCode) => err({ code });

const SUMMARY_CONCURRENCY = 4;
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

interface ReadOptions {
  timeoutMs: number;
  /** `all` lists every file in an untracked folder; `normal` lists the folder once, which is cheaper. */
  untracked: 'all' | 'normal';
  /** Without it `last_commit` is null and `operation` is `none`, and the read spawns two git processes instead of four. */
  commitAndOperation: boolean;
}

const DETAIL_READ: ReadOptions = { timeoutMs: GIT_READ_TIMEOUT_MS, untracked: 'all', commitAndOperation: true };
const SUMMARY_READ: ReadOptions = { timeoutMs: GIT_READ_TIMEOUT_MS, untracked: 'normal', commitAndOperation: false };

/** What git said when it could not read the repository, in words the client can act on. LC_ALL=C keeps these messages stable. */
async function readFailure(dir: string, out: GitOutput): Promise<GitError> {
  if (/detected dubious ownership/.test(out.stderr)) return { code: 'git_unsafe_owner' };
  if (/not a git repository/.test(out.stderr)) {
    // A `.git` entry git cannot open reads as "not a repository": say it is there but unreadable.
    return { code: (await fsp.lstat(path.join(dir, '.git')).then(() => true, () => false)) ? 'git_unreadable' : 'not_a_git_repo' };
  }
  if (/permission denied|cannot (open|read|access)|unable to (open|read|access)|operation not permitted|bad config/i.test(out.stderr)) return { code: 'git_unreadable' };
  return { code: 'git_failed' };
}

/**
 * The config is listed first, by git itself, so the includes, the worktree config and the scopes are git's reading and
 * not ours. Every filter driver the repository's own config defines is then blanked for the status call, which would
 * otherwise run a driver's clean command on any file whose stat changed. A driver that cannot be blanked safely makes
 * the repository unreadable rather than risking the run.
 */
async function readRepo(dir: string, read: ReadOptions): Promise<GitResult<GitStatus>> {
  const started = Date.now();
  const listed = await runGit(dir, ['config', '--list', '-z', '--show-scope'], { timeoutMs: read.timeoutMs });
  if (!listed.ok) return fail(listed.error);
  if (listed.value.code !== 0) return err(await readFailure(dir, listed.value));
  const { config, filterKeys } = parseConfigList(listed.value.stdout);
  if (filterKeys.length > MAX_BLANKED_FILTER_KEYS || filterKeys.some((k) => k.length > MAX_FILTER_KEY)) return fail('git_unreadable');

  const opts = { timeoutMs: Math.max(read.timeoutMs - (Date.now() - started), 1), blankFilterKeys: filterKeys };
  const skipped = Promise.resolve(ok({ code: 0, stdout: '', stderr: '' }));
  const full = read.commitAndOperation;
  const runs = await Promise.all([
    full ? runGit(dir, ['rev-parse', '--absolute-git-dir'], opts) : skipped,
    // Submodules are compared by commit only: checking their worktrees would run git, and its filters, inside each one.
    runGit(dir, ['status', '--porcelain=v2', '--branch', '-z', '--ignore-submodules=dirty', `--untracked-files=${read.untracked}`], opts),
    // --no-show-signature: log.showSignature would run the repository's gpg.program.
    full ? runGit(dir, ['log', '-1', '-z', '--no-show-signature', `--format=${COMMIT_FORMAT}`], opts) : skipped,
  ]);
  for (const r of runs) if (!r.ok) return fail(r.error);
  const [gitDir, status, log] = runs.map((r) => (r.ok ? r.value : null!));
  if (gitDir.code !== 0) return err(await readFailure(dir, gitDir));
  if (status.code !== 0) return err(await readFailure(dir, status));
  const parsed = parseStatusV2(status.stdout);
  if (parsed.oid === null && parsed.upstream !== null) parsed.behind = await unbornBehind(dir, opts);
  return ok(
    buildStatus({
      parsed,
      config,
      lastCommit: full && log.code === 0 ? parseCommitInfo(log.stdout) : null,
      operation: full ? await operationIn(gitDir.stdout.trim()) : 'none',
    }),
  );
}

/** git prints no `branch.ab` for an unborn branch, so count what a pull would bring: every commit the tracking branch has, or 0 without one. */
async function unbornBehind(dir: string, opts: { timeoutMs: number }): Promise<number> {
  const count = await runGit(dir, ['rev-list', '--count', '@{upstream}', '--'], opts);
  return count.ok && count.value.code === 0 ? Number(count.value.stdout.trim()) || 0 : 0;
}

export async function projectDir(root: string, name: ProjectName): Promise<GitResult<string>> {
  const dir = await resolveProjectDir(root, name);
  return dir.ok ? dir : fail(dir.error);
}

async function readStatus(root: string, name: ProjectName, read: ReadOptions): Promise<GitResult<GitStatus>> {
  const dir = await projectDir(root, name);
  if (!dir.ok) return dir;
  return readRepo(dir.value, read);
}

export function getStatus(root: string, name: ProjectName): Promise<GitResult<GitStatus>> {
  return readStatus(root, name, DETAIL_READ);
}

/** The cheaper read for a chat's context note: an untracked folder counts once, no secret check needs its files, and no last commit or operation. */
export function getStatusSummary(root: string, name: ProjectName): Promise<GitResult<GitStatus>> {
  return readStatus(root, name, SUMMARY_READ);
}

/** Every project with a `.git`; null when its status timed out or failed. Non-git folders are left out. */
export async function getSummaries(root: string): Promise<GitResult<{ summaries: Record<string, GitSummary | null> }>> {
  const list = await listProjects(root);
  if (!list.ok) return fail(list.error);
  const repos = list.value.projects.filter((p) => p.is_git);
  const reads = await mapLimit(repos, SUMMARY_CONCURRENCY, (p) => readStatus(root, p.name, SUMMARY_READ));
  const noGit = reads.find((r) => !r.ok && r.error.code === 'git_unavailable');
  if (noGit && !noGit.ok) return fail(noGit.error.code);
  const results = reads.map((r) => (r.ok ? toSummary(r.value) : null));
  return ok({ summaries: Object.fromEntries(repos.map((p, i) => [p.name, results[i]])) });
}
