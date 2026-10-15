import { execFile, spawn } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { err, ok, Result } from './paths';
import { redactCredentials } from './git-status';

export const GIT_READ_TIMEOUT_MS = 3_000;

const MAX_OUTPUT = 32 * 1024 * 1024;

export interface GitOutput {
  /** Exit code; a non-zero exit is data for the caller to classify, not a failure here. */
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunFailure = 'timeout' | 'git_failed';

/**
 * What git and the operator's filters may inherit. Anything not named here is dropped, so the gateway's own API keys
 * and bot tokens never reach a filter program. No network call is made, so no proxy, credential or ssh variables pass.
 * `HOME`, `XDG_CONFIG_HOME` and the three `GIT_CONFIG_*` selectors decide which operator config files git reads
 * (filters such as `git lfs install`, `safe.directory`).
 */
const PASSTHROUGH_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']);

/** The git subcommand in `args`, past any leading `-c key=value` pairs. */
export function subcommandOf(args: readonly string[]): string {
  let i = 0;
  while (args[i] === '-c') i += 2;
  return args[i] ?? '';
}

/**
 * The environment git runs with: an allowlist of process.env, and no GIT_DIR/GIT_WORK_TREE that would aim git at
 * another repository. Built from process.env explicitly: jest gives tests a copy that child_process ignores.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => PASSTHROUGH_ENV.has(k)));
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

const USER_CONFIG_TIMEOUT_MS = 3_000;

const FILTER_SECTION = /^\s*\[\s*filter(?:\s+"((?:[^"\\\n]|\\.)*)"|\.([^\s\]]+))\s*\]/gim;
const INCLUDE_SECTION = /^\s*\[\s*include(?:if)?\b/im;
const FILTER_KEYS = ['clean', 'smudge', 'process'] as const;

/** Filter names a repo's own config defines, or null when an include could add more and git must be asked. */
async function repoFilterNames(cwd: string): Promise<string[] | null> {
  let text = '';
  for (const file of ['config', 'config.worktree']) {
    try {
      text += `\n${await fsp.readFile(path.join(cwd, '.git', file), 'utf8')}`;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && file === 'config') return [];
      if (code !== 'ENOENT') return null;
    }
  }
  if (INCLUDE_SECTION.test(text)) return null;
  const names = new Set<string>();
  for (const m of text.matchAll(FILTER_SECTION)) names.add(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? '').toLowerCase());
  return [...names];
}

async function repoFilterNamesFromGit(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const out = await new Promise<string>((resolve) => {
    execFile('git', ['config', '--show-scope', '--name-only', '-z', '--get-regexp', '^filter\\.'], { cwd, env, timeout: USER_CONFIG_TIMEOUT_MS }, (e, stdout) => resolve(e ? '' : stdout));
  });
  const fields = out.split('\0');
  const names = new Set<string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i + 1]!;
    if ((fields[i] === 'local' || fields[i] === 'worktree') && key.startsWith('filter.') && key.includes('.', 7)) names.add(key.slice(7, key.lastIndexOf('.')));
  }
  return [...names];
}

/**
 * `-c` overrides that blank every filter command the repository's own config defines. status runs a filter's clean
 * command on a file that looks modified, and add, commit and merge run it too, so a clone could otherwise run a command
 * when the project is listed. Filters from the operator's config stay.
 */
async function repoFilterOverrides(cwd: string, env: NodeJS.ProcessEnv): Promise<string[] | null> {
  const names = (await repoFilterNames(cwd)) ?? (await repoFilterNamesFromGit(cwd, env));
  // `-c name=value` splits at the first `=`, so a filter name holding one cannot be blanked.
  if (names.some((name) => name.includes('='))) return null;
  return names.flatMap((name) => [
    ...FILTER_KEYS.flatMap((key) => ['-c', `filter.${name}.${key}=`]),
    '-c', `filter.${name}.required=false`,
  ]);
}

/** Subcommands that never run a filter. */
const NO_FILTER_SUBCOMMANDS = new Set(['rev-parse', 'log', 'rev-list', 'config', 'init']);

export interface RunOptions {
  timeoutMs: number;
}

/** How long a timed-out git gets to clean up its lock files after SIGTERM before the group is killed. */
/** After git exits, how long its pipes get to deliver the rest of the output. */
const EXIT_DRAIN_MS = 200;

const KILL_GRACE_MS = 1_000;

/**
 * Runs git in the project dir `cwd`. Discovery stops at `cwd`, so a folder inside some
 * other repository never reads as a repo itself.
 */
export async function runGit(cwd: string, args: string[], opts: RunOptions): Promise<Result<GitOutput, GitRunFailure>> {
  const sub = subcommandOf(args);
  // GIT_OPTIONAL_LOCKS keeps status off .git/index.lock, which a concurrent git run by the user may hold.
  const env: NodeJS.ProcessEnv = { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(cwd), GIT_OPTIONAL_LOCKS: '0' };
  // core.fsmonitor is a command from the repo's config; status runs it.
  const filters = NO_FILTER_SUBCOMMANDS.has(sub) ? [] : await repoFilterOverrides(cwd, env);
  if (!filters) return err('git_failed');
  const argv = ['-c', 'core.fsmonitor=false', ...filters, ...args];
  return new Promise((resolve) => {
    // Its own process group, so a timeout also reaches the hooks, filters and ssh that git started.
    const child = spawn('git', argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // The group has already exited.
      }
    };
    let settled = false;
    const settle = (r: Result<GitOutput, GitRunFailure>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        signalGroup('SIGKILL');
        return settle(err('git_failed'));
      }
      into.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));

    child.on('error', (e) => {
      console.warn(`projects: git ${args[0]} in ${cwd} failed: ${redactCredentials(e.message)}`);
      settle(err('git_failed'));
    });
    const finish = (code: number | null) => {
      if (code === null) return settle(err('git_failed'));
      settle(ok({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    };
    child.on('close', finish);
    // A hook's backgrounded child keeps the pipes open long after git is done; take what arrived and let go.
    child.on('exit', (code) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }, EXIT_DRAIN_MS).unref();
    });

    const timer = setTimeout(() => {
      // TERM first: git removes its index.lock on TERM but leaves it behind on KILL.
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS).unref();
      // An orphan that escaped the group can still hold the pipes open; let go of them now.
      child.stdout.destroy();
      child.stderr.destroy();
      settle(err('timeout'));
    }, opts.timeoutMs);
  });
}
