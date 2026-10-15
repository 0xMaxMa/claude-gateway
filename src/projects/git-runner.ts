import { spawn } from 'child_process';
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

const PASSTHROUGH_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TZ', 'TMPDIR', 'TERM',
  'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]);

/** Operator-set git settings that are credentials or config sources, not repository selectors. */
const OPERATOR_GIT_ENV = new Set([
  'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_SSL_CAINFO',
]);

/**
 * The environment git and its hooks run with: an allowlist of process.env, so a hook never sees the gateway's secrets,
 * and no GIT_DIR/GIT_WORK_TREE that would aim git at another repository. Built from process.env explicitly: jest gives
 * tests a copy that child_process ignores. GIT_SSH_COMMAND and GIT_ASKPASS always end up set: they outrank the repo's
 * core.sshCommand and core.askPass, which are commands from a possibly untrusted config.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => PASSTHROUGH_ENV.has(k) || OPERATOR_GIT_ENV.has(k) || k.startsWith('LC_')),
  );
  return {
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    GIT_ASKPASS: 'true',
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

export interface RunOptions {
  timeoutMs: number;
  /** Status-style reads must not take .git/index.lock away from a concurrent mutation. */
  readOnly?: boolean;
  env?: Record<string, string>;
}

/** How long a timed-out git gets to clean up its lock files after SIGTERM before the group is killed. */
/** After git exits, how long its pipes get to deliver the rest of the output. */
const EXIT_DRAIN_MS = 200;

const KILL_GRACE_MS = 1_000;

/**
 * Runs git in the project dir `cwd`. Discovery stops at `cwd`, so a folder inside some
 * other repository never reads as a repo itself.
 */
export function runGit(cwd: string, args: string[], opts: RunOptions): Promise<Result<GitOutput, GitRunFailure>> {
  const env: NodeJS.ProcessEnv = { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(cwd), ...opts.env };
  if (opts.readOnly) env.GIT_OPTIONAL_LOCKS = '0';
  // core.fsmonitor is a command from the repo's config; add, commit and status all run it.
  const argv = ['-c', 'core.fsmonitor=false', ...args];
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
