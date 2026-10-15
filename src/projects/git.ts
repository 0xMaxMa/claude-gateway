import { promises as fsp } from 'fs';
import * as path from 'path';
import { listProjects, mapLimit, resolveProjectDir } from './fs';
import { GIT_READ_TIMEOUT_MS, runGit } from './git-runner';
import {
  buildStatus,
  GitCommitInfo,
  GitOperation,
  GitStatus,
  GitSummary,
  parseRepoConfig,
  parseStatusV2,
  RepoConfig,
  toSummary,
} from './git-status';
import { err, ok, ProjectName, ProjectsErrorCode, Result } from './paths';

export type GitErrorCode = 'not_a_git_repo' | 'timeout' | 'git_failed';

export type GitError = { code: GitErrorCode | ProjectsErrorCode };

export type GitResult<T> = Result<T, GitError>;

const fail = (code: GitErrorCode | ProjectsErrorCode) => err({ code });

const SUMMARY_CONCURRENCY = 4;
const CONFIG_KEYS = '^(remote\\..*\\.url|branch\\..*\\.(remote|merge))$';
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
  /** `all` lists every file in an untracked folder; `normal` lists the folder once, which is cheaper. */
  untracked: 'all' | 'normal';
  /** Without it `last_commit` is null and `operation` is `none`, and the read spawns two git processes instead of four. */
  commitAndOperation: boolean;
}

const DETAIL_READ: ReadOptions = { timeoutMs: GIT_READ_TIMEOUT_MS, untracked: 'all', commitAndOperation: true };
const SUMMARY_READ: ReadOptions = { timeoutMs: GIT_READ_TIMEOUT_MS, untracked: 'normal', commitAndOperation: false };

async function readRepo(dir: string, read: ReadOptions): Promise<GitResult<RepoState>> {
  const opts = { timeoutMs: read.timeoutMs };
  const skipped = Promise.resolve(ok({ code: 0, stdout: '', stderr: '' }));
  const full = read.commitAndOperation;
  const runs = await Promise.all([
    full ? runGit(dir, ['rev-parse', '--absolute-git-dir'], opts) : skipped,
    runGit(dir, ['status', '--porcelain=v2', '--branch', '-z', `--untracked-files=${read.untracked}`], opts),
    runGit(dir, ['config', '-z', '--get-regexp', CONFIG_KEYS], opts),
    full ? runGit(dir, ['log', '-1', '-z', `--format=${COMMIT_FORMAT}`], opts) : skipped,
  ]);
  for (const r of runs) if (!r.ok) return fail(r.error);
  const [gitDir, status, config, log] = runs.map((r) => (r.ok ? r.value : null!));
  if (gitDir.code !== 0) return fail('not_a_git_repo');
  if (status.code !== 0) return fail('git_failed');
  // get-regexp exits 1 when nothing matches, which is an empty config, not a failure.
  const cfg = parseRepoConfig(config.code === 0 ? config.stdout : '');
  const parsed = parseStatusV2(status.stdout);
  if (parsed.oid === null && parsed.upstream !== null) parsed.behind = await unbornBehind(dir, opts);
  return ok({
    config: cfg,
    status: buildStatus({
      parsed,
      config: cfg,
      lastCommit: full && log.code === 0 ? parseCommitInfo(log.stdout) : null,
      operation: full ? await operationIn(gitDir.stdout.trim()) : 'none',
    }),
  });
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
  const repo = await readRepo(dir.value, read);
  return repo.ok ? ok(repo.value.status) : repo;
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
  const results = await mapLimit(repos, SUMMARY_CONCURRENCY, async (p) => {
    const status = await readStatus(root, p.name, SUMMARY_READ);
    return status.ok ? toSummary(status.value) : null;
  });
  return ok({ summaries: Object.fromEntries(repos.map((p, i) => [p.name, results[i]])) });
}
