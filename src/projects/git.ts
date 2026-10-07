import { promises as fsp } from 'fs';
import * as path from 'path';
import { listProjects, resolveProjectDir } from './fs';
import { GIT_TIMEOUTS, runGit } from './git-runner';
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

export type GitErrorCode =
  | 'not_a_git_repo'
  | 'already_a_git_repo'
  | 'nothing_to_commit'
  | 'message_required'
  | 'identity_missing'
  | 'identity_already_set'
  | 'invalid_identity'
  | 'sensitive_files'
  | 'conflicts_present'
  | 'operation_in_progress'
  | 'not_fast_forward'
  | 'dirty_would_overwrite'
  | 'no_remote'
  | 'no_upstream'
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

export interface RepoState {
  status: GitStatus;
  config: RepoConfig;
}

/** Reads never take the project lock: GIT_OPTIONAL_LOCKS=0 keeps them off the index. */
export async function readRepo(dir: string): Promise<GitResult<RepoState>> {
  const opts = { timeoutMs: GIT_TIMEOUTS.read, readOnly: true };
  const runs = await Promise.all([
    runGit(dir, ['rev-parse', '--absolute-git-dir'], opts),
    runGit(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], opts),
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

export async function getStatus(root: string, name: ProjectName): Promise<GitResult<GitStatus>> {
  const dir = await projectDir(root, name);
  if (!dir.ok) return dir;
  const repo = await readRepo(dir.value);
  return repo.ok ? ok(repo.value.status) : repo;
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
    const status = await getStatus(root, p.name);
    return status.ok ? toSummary(status.value) : null;
  });
  return ok({ summaries: Object.fromEntries(repos.map((p, i) => [p.name, results[i]])) });
}
