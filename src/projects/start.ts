import { spawn } from 'child_process';
import { closeSync, openSync, promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { redactLines } from '../cli/redact';
import { redactCredentials } from './git-status';
import { err, ok, Result } from './paths';
import { RunningPort, scanProject, Sys } from './running';

export type StartErrorCode = 'no_start_command' | 'already_running' | 'port_in_use' | 'no_free_port' | 'start_failed' | 'start_timeout' | 'invalid_port';

export interface StartError {
  code: StartErrorCode;
  /** Redacted tail of what the process printed, when it printed anything. */
  log?: string;
}

export interface StartResult {
  port: number;
  pid: number;
  command: string;
}

export const PORT_MIN = 3000;
export const PORT_MAX = 3099;
const START_WAIT_MS = 20_000;
const POLL_MS = 250;
const LOG_TAIL_BYTES = 2000;

/** What the project's own files let us run without asking anyone. */
export interface StartFacts {
  packageJson: string | null;
  rootNames: ReadonlySet<string>;
  mainPy: string | null;
  appPy: string | null;
}

export interface StartCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/** A way to run the project, and the command it makes for a port. */
export interface StartPlan {
  /** What a person would type, for display and logs. */
  display: (port: number) => string;
  command: (port: number) => StartCommand;
}

const LOCKFILE_RUNNERS: ReadonlyArray<readonly [string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];

/** Flags that pin the port and the host for the dev servers whose script text names them. */
const FRAMEWORK_FLAGS: ReadonlyArray<readonly [RegExp, (port: number) => string[]]> = [
  [/\bvite\b/, (p) => ['--port', String(p), '--strictPort', '--host', '0.0.0.0']],
  [/\bastro\b/, (p) => ['--port', String(p), '--host', '0.0.0.0']],
  [/\bnext\b/, (p) => ['-p', String(p), '-H', '0.0.0.0']],
];

function nodePlan(facts: StartFacts): StartPlan | null {
  if (facts.packageJson === null) return null;
  let scripts: unknown;
  try {
    scripts = (JSON.parse(facts.packageJson) as { scripts?: unknown } | null)?.scripts;
  } catch {
    return null;
  }
  if (typeof scripts !== 'object' || scripts === null) return null;
  const table = scripts as Record<string, unknown>;
  const name = ['dev', 'start'].find((n) => typeof table[n] === 'string');
  if (!name) return null;
  const text = table[name] as string;
  const runner = LOCKFILE_RUNNERS.find(([lock]) => facts.rootNames.has(lock))?.[1] ?? 'npm';
  const flags = FRAMEWORK_FLAGS.find(([re]) => re.test(text))?.[1];
  const forward = runner === 'yarn' || runner === 'bun' ? [] : ['--'];
  return {
    display: (port) => (flags ? [runner, 'run', name, ...forward, ...flags(port)].join(' ') : `PORT=${port} ${runner} run ${name}`),
    command: (port) => ({
      file: runner,
      args: flags ? ['run', name, ...forward, ...flags(port)] : ['run', name],
      env: { PORT: String(port) },
    }),
  };
}

function uvicornPlan(facts: StartFacts): StartPlan | null {
  if (!facts.rootNames.has('.venv')) return null;
  const candidates: Array<[string | null, string]> = [
    [facts.mainPy, 'main'],
    [facts.appPy, 'app'],
  ];
  const hit = candidates.find(([text]) => text !== null && /^app\s*=\s*FastAPI\(/m.test(text));
  if (!hit) return null;
  const target = `${hit[1]}:app`;
  return {
    display: (port) => `.venv/bin/uvicorn ${target} --host 0.0.0.0 --port ${port}`,
    command: (port) => ({ file: '.venv/bin/uvicorn', args: [target, '--host', '0.0.0.0', '--port', String(port)], env: {} }),
  };
}

/** Null when the files do not name a way to run the project that we know how to pin to a port. */
export function planStart(facts: StartFacts): StartPlan | null {
  return nodePlan(facts) ?? uvicornPlan(facts);
}

export async function readStartFacts(realProject: string): Promise<StartFacts> {
  const text = (name: string) => fsp.readFile(path.join(realProject, name), 'utf8').then((t) => (t.length <= 1_000_000 ? t : null), () => null);
  const names = await fsp.readdir(realProject).catch(() => [] as string[]);
  const [packageJson, mainPy, appPy] = await Promise.all([text('package.json'), text('main.py'), text('app.py')]);
  return { packageJson, rootNames: new Set(names), mainPy, appPy };
}

/** The first port from 3000 up to 3099 nobody listens on, or `wanted` when it is free. */
export function pickPort(taken: ReadonlySet<number>, wanted?: number): Result<number, 'port_in_use' | 'no_free_port' | 'invalid_port'> {
  if (wanted !== undefined) {
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) return err('invalid_port');
    return taken.has(wanted) ? err('port_in_use') : ok(wanted);
  }
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!taken.has(p)) return ok(p);
  return err('no_free_port');
}

/** Only what a dev server needs. The gateway's own environment carries keys that no project server should inherit. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra, TERM: 'dumb', FORCE_COLOR: '0' };
}

export interface Launched {
  pid: number;
  /** Null while it runs. */
  exitCode(): number | null;
}

export type Launcher = (cmd: StartCommand, cwd: string, logPath: string) => Promise<Launched>;

/** Detached, so it outlives the gateway request, with its output in a log file under the gateway's state. */
export const systemLauncher: Launcher = async (cmd, cwd, logPath) => {
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'w');
  let code: number | null = null;
  const file = cmd.file.includes('/') ? path.resolve(cwd, cmd.file) : cmd.file;
  const child = spawn(file, cmd.args, { cwd, env: cleanEnv(cmd.env), detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const spawned = await new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  if (!spawned || child.pid === undefined) throw new Error('spawn failed');
  child.on('exit', (c, signal) => {
    code = c ?? (signal ? 128 : 1);
  });
  child.unref();
  return { pid: child.pid, exitCode: () => code };
};

export function logPathFor(name: string): string {
  return path.join(os.homedir(), '.claude-gateway', 'logs', 'projects', `${name}.log`);
}

async function logTail(logPath: string): Promise<string | undefined> {
  const raw = await fsp.readFile(logPath, 'utf8').catch(() => '');
  const tail = redactLines(redactCredentials(raw.slice(-LOG_TAIL_BYTES)).split('\n')).join('\n').trim();
  return tail === '' ? undefined : tail;
}

async function descendantPids(sys: Sys, root: number): Promise<number[]> {
  const children = new Map<number, number[]>();
  for (const pid of await sys.allPids().catch(() => [] as number[])) {
    const info = await sys.proc(pid);
    if (info?.alive) children.set(info.ppid, [...(children.get(info.ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length) for (const c of children.get(queue.shift() as number) ?? []) (out.push(c), queue.push(c));
  return out;
}

/** The process we just started that never came up: the one thing the gateway signals that no scan found. */
async function abandon(sys: Sys, launched: Launched): Promise<void> {
  for (const pid of [...(await descendantPids(sys, launched.pid)), launched.pid]) {
    try {
      sys.kill(pid, 'SIGTERM');
    } catch {
      // gone already
    }
  }
}

const listening = (ports: RunningPort[] | null, port: number) => !!ports?.some((p) => p.port === port);

/**
 * Runs the project the way its files say, on a free port, and answers once something listens on
 * that port from inside the project. Nothing the caller sends becomes part of the command.
 */
export async function startProject(
  sys: Sys,
  launch: Launcher,
  input: { realProject: string; name: string; port?: number; waitMs?: number; logPath?: string },
): Promise<Result<StartResult, StartError>> {
  const plan = planStart(await readStartFacts(input.realProject));
  if (!plan) return err({ code: 'no_start_command' });
  if (((await scanProject(sys, input.realProject)) ?? []).length > 0) return err({ code: 'already_running' });

  const taken = new Set(((await sys.listeners()) ?? []).map((l) => l.port));
  const picked = pickPort(taken, input.port);
  if (!picked.ok) return err({ code: picked.error });
  const port = picked.value;

  const logPath = input.logPath ?? logPathFor(input.name);
  let launched: Launched;
  try {
    launched = await launch(plan.command(port), input.realProject, logPath);
  } catch {
    return err({ code: 'start_failed' });
  }

  const deadline = (input.waitMs ?? START_WAIT_MS) / POLL_MS;
  for (let i = 0; i < deadline; i++) {
    if (listening(await scanProject(sys, input.realProject), port)) return ok({ port, pid: launched.pid, command: plan.display(port) });
    const code = launched.exitCode();
    // Exit 0 can be a dev server that backgrounds itself, so only a failing exit ends the wait.
    if (code !== null && code !== 0) return err({ code: 'start_failed', log: await logTail(logPath) });
    await sys.sleep(POLL_MS);
  }
  await abandon(sys, launched);
  return err({ code: 'start_timeout', log: await logTail(logPath) });
}

/** Rule 6 for starting: one start per project at a time, so two clicks never race two servers. */
export class StartGuard {
  private busy = new Set<string>();

  has(project: string): boolean {
    return this.busy.has(project);
  }

  /** Runs `fn` unless a start for `project` (its real folder) is in flight; null when it is. */
  async run<T>(project: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.busy.has(project)) return null;
    this.busy.add(project);
    try {
      return await fn();
    } finally {
      this.busy.delete(project);
    }
  }
}
