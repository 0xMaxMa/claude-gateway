import { execFile, spawn } from 'child_process';
import { promises as fsp } from 'fs';
import * as os from 'os';
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
 * What git, credential helpers and hooks may inherit. Anything not named here is dropped, so the gateway's own
 * API keys, bot tokens and provider keys never reach a hook.
 */
const PASSTHROUGH_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TERM',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GNUPGHOME', 'GPG_TTY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  // Inputs of the usual credential helpers (`gh auth git-credential`, `git-credential-libsecret`).
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR',
  // Operator-set git settings that are credentials or config sources, not repository selectors.
  'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT', 'GIT_SSL_CAINFO',
]);

const passesThrough = (k: string) => PASSTHROUGH_ENV.has(k) || k.startsWith('LC_') || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k);

/**
 * The environment git and its hooks run with: an allowlist of process.env, and no GIT_DIR/GIT_WORK_TREE that would
 * aim git at another repository. Built from process.env explicitly: jest gives tests a copy that child_process ignores.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => passesThrough(k)));
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

const NON_INTERACTIVE_SSH = 'ssh -o BatchMode=yes';
const USER_CONFIG_TIMEOUT_MS = 3_000;

/**
 * `-c` overrides that put the operator's core.sshCommand and core.askPass (system, global, GIT_CONFIG_*) back on top of
 * the repository's. Both keys run a command from config, and a cloned repo can set them. A command-line value outranks
 * every config file, and unlike GIT_SSH_COMMAND or GIT_ASKPASS it leaves the operator's value in charge. With none set,
 * ssh gets BatchMode and askpass answers empty, so neither can wait for input. Git's own environment variables still
 * outrank these; they come only from the operator's environment.
 */
async function trustedCommandConfig(env: NodeJS.ProcessEnv): Promise<string[]> {
  const key = JSON.stringify(Object.entries(env).filter(([k]) => CONFIG_SOURCE_ENV.test(k)).sort());
  let cached = operatorConfigCache.get(key);
  if (!cached) {
    cached = lookUpOperatorCommands(env);
    operatorConfigCache.set(key, cached);
  }
  return cached;
}

/** What decides which config files git reads outside the repository. */
const CONFIG_SOURCE_ENV = /^(HOME|XDG_CONFIG_HOME|GIT_CONFIG_.*)$/;
const operatorConfigCache = new Map<string, Promise<string[]>>();

/** Subcommands that never start ssh or an askpass program. */
const NO_REMOTE_SUBCOMMANDS = new Set(['status', 'rev-parse', 'log', 'rev-list']);

/** Forget the resolved operator values; for tests that rewrite a gitconfig under the same HOME. */
export function resetOperatorConfigCache(): void {
  operatorConfigCache.clear();
}

async function lookUpOperatorCommands(env: NodeJS.ProcessEnv): Promise<string[]> {
  const found = await new Promise<string>((resolve) => {
    // A git dir that does not exist keeps the repository's config out of the lookup.
    execFile(
      'git',
      ['--git-dir=/nonexistent/none', 'config', '-z', '--get-regexp', '^core\\.(sshcommand|askpass)$'],
      { cwd: os.tmpdir(), env, timeout: USER_CONFIG_TIMEOUT_MS },
      (e, stdout) => resolve(e ? '' : stdout),
    );
  });
  const values: Record<string, string> = {};
  for (const entry of found.split('\0')) {
    const nl = entry.indexOf('\n');
    if (nl > 0 && entry.length > nl + 1) values[entry.slice(0, nl)] = entry.slice(nl + 1);
  }
  return [
    '-c', `core.sshCommand=${values['core.sshcommand'] ?? NON_INTERACTIVE_SSH}`,
    '-c', `core.askPass=${values['core.askpass'] ?? 'true'}`,
  ];
}

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
export async function runGit(cwd: string, args: string[], opts: RunOptions): Promise<Result<GitOutput, GitRunFailure>> {
  const env: NodeJS.ProcessEnv = { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(cwd), ...opts.env };
  if (opts.readOnly) env.GIT_OPTIONAL_LOCKS = '0';
  // core.fsmonitor is a command from the repo's config; add, commit and status all run it.
  const remoteCapable = !opts.readOnly && !NO_REMOTE_SUBCOMMANDS.has(args[0] ?? '');
  const filters = NO_FILTER_SUBCOMMANDS.has(args[0] ?? '') ? [] : await repoFilterOverrides(cwd, env);
  if (!filters) return err('git_failed');
  const argv = ['-c', 'core.fsmonitor=false', ...filters, ...(remoteCapable ? await trustedCommandConfig(env) : []), ...args];
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
