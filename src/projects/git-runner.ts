import { execFile } from 'child_process';
import * as path from 'path';
import { err, ok, Result } from './paths';
import { redactCredentials } from './git-status';

export const GIT_TIMEOUTS = { read: 3_000, local: 10_000, network: 60_000, commit: 60_000 } as const;

const MAX_OUTPUT = 32 * 1024 * 1024;

export interface GitOutput {
  /** Exit code; a non-zero exit is data for the caller to classify, not a failure here. */
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunFailure = 'timeout' | 'git_failed';

/**
 * process.env without any GIT_* variable: GIT_DIR, GIT_WORK_TREE and friends would aim git at
 * another repository. Built from process.env explicitly: jest gives tests a copy that child_process ignores.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

export interface RunOptions {
  timeoutMs: number;
  /** Status-style reads must not take .git/index.lock away from a concurrent mutation. */
  readOnly?: boolean;
  env?: Record<string, string>;
}

/**
 * Runs git in the project dir `cwd`. Discovery stops at `cwd`, so a folder inside some
 * other repository never reads as a repo itself.
 */
export function runGit(cwd: string, args: string[], opts: RunOptions): Promise<Result<GitOutput, GitRunFailure>> {
  const env: NodeJS.ProcessEnv = { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(cwd), ...opts.env };
  if (opts.readOnly) env.GIT_OPTIONAL_LOCKS = '0';
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile('git', args, { cwd, env, maxBuffer: MAX_OUTPUT, encoding: 'utf8' }, (e, stdout, stderr) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (!e) return resolve(ok({ code: 0, stdout, stderr }));
      const code = (e as { code?: unknown }).code;
      if (typeof code === 'number') return resolve(ok({ code, stdout, stderr }));
      console.warn(`projects: git ${args[0]} in ${cwd} failed: ${redactCredentials(e.message)}`);
      resolve(err('git_failed'));
    });
    // Resolve at the deadline rather than on exit: a hook's orphaned child can hold stdout open long after git dies.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      resolve(err('timeout'));
    }, opts.timeoutMs);
  });
}

const locked = new Set<string>();

/** One in-flight mutation per project: git's own index.lock would fail the second one midway instead. */
export async function withProjectLock<T, E>(key: string, fn: () => Promise<Result<T, E>>): Promise<Result<T, E | 'busy'>> {
  if (locked.has(key)) return err('busy');
  locked.add(key);
  try {
    return await fn();
  } finally {
    locked.delete(key);
  }
}
