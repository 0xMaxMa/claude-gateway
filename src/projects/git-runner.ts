import { spawn } from 'child_process';
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

/**
 * The environment git runs with: an allowlist of process.env, and no GIT_DIR/GIT_WORK_TREE that would aim git at
 * another repository. Built from process.env explicitly: jest gives tests a copy that child_process ignores.
 *
 * `GIT_ALLOW_PROTOCOL` set empty allows no transport at all, and unlike `protocol.<name>.allow` in the repository's
 * config it cannot be overridden by the repository. Git can start a fetch on its own during a read, to fetch a missing
 * object of a partial clone, so this is what keeps a repository's `core.sshCommand`, `uploadpack`, `ext::` URL or
 * credential helper from ever running. `GIT_NO_LAZY_FETCH` (git 2.44 and later) stops that fetch from being tried.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => PASSTHROUGH_ENV.has(k)));
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' };
}

/** `filter.*` keys a status read may blank; more than this, or a longer key, and the repository is refused. */
export const MAX_BLANKED_FILTER_KEYS = 64;
export const MAX_FILTER_KEY = 1024;

/**
 * `GIT_CONFIG_COUNT/KEY_n/VALUE_n` entries that empty each named `filter.*` key. Every key is taken whole as git
 * printed it, never split into driver name and variable, so no name (empty, dotted, holding `=`) can slip past a
 * parser. Unlike `-c name=value` they take the key whole, and they rank as command-line config, above every file.
 * An empty clean, smudge or process command runs nothing, and an empty `required` is false.
 */
function blankFilterEnv(keys: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(keys.length) };
  keys.forEach((key, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = '';
  });
  return env;
}

/**
 * The command line and environment every git call of the gateway uses, reads and `git init` alike. `core.fsmonitor`
 * is a command from the repository's config, so it is turned off for every call. A call that can run a clean filter
 * (status) names the repository's `filter.*` keys in `blankFilterKeys` so no driver runs.
 */
export function hardenedGit(cwd: string, args: string[], blankFilterKeys: readonly string[] = []): { argv: string[]; env: NodeJS.ProcessEnv } {
  return {
    argv: ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
    env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(cwd), ...blankFilterEnv(blankFilterKeys) },
  };
}

export interface RunOptions {
  timeoutMs: number;
  /** The repository's own `filter.*` keys, to blank for this call. */
  blankFilterKeys?: readonly string[];
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
  const { argv, env } = hardenedGit(cwd, args, opts.blankFilterKeys);
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
