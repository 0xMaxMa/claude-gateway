import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { redactCredentials } from './git-status';
import { err, ok, Result } from './paths';

export type RunningErrorCode = 'nothing_running' | 'invalid_port';

export interface Listener {
  address: string;
  port: number;
  pids: number[];
}

/** One project listener port, as the wire shape plus the identity needed to signal it safely. */
export interface RunningPort {
  port: number;
  address: string;
  pids: number[];
  command: string;
  via: Via;
  members: Member[];
}

/** How a listener was tied to the project: its working directory, or an absolute path in its argv. */
export type Via = 'cwd' | 'argv';

export interface Member {
  pid: number;
  startTime: string;
  via: Via;
}

export interface RunningProcess {
  port: number;
  pids: number[];
  command: string;
  address: string;
  via: Via;
}

export type RunningList = { supported: true; processes: RunningProcess[] } | { supported: false; processes: [] };

export interface PortPids {
  port: number;
  pids: number[];
}

export interface StopResult {
  stopped: PortPids[];
  remaining: PortPids[];
}

const COMMAND_LIMIT = 120;
const TERM_WAIT_MS = 3000;
const POLL_MS = 100;
const KILL_WAIT_MS = 1000;
const MAX_ANCESTOR_DEPTH = 64;

// ---------------------------------------------------------------- pure parsing

const USERS_ENTRY = /\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g;

function splitHostPort(local: string): { address: string; port: number } | null {
  const i = local.lastIndexOf(':');
  if (i < 0) return null;
  const port = Number(local.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const address = local.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  return { address, port };
}

/** Parses `ss -H -ltnp` output. Lines that are not a LISTEN row with a valid port are dropped. */
export function parseSs(output: string): Listener[] {
  const out: Listener[] = [];
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'LISTEN' || cols.length < 5) continue;
    const local = splitHostPort(cols[3]);
    if (!local) continue;
    const pids = [...line.matchAll(USERS_ENTRY)].map((m) => Number(m[2]));
    out.push({ ...local, pids: [...new Set(pids)] });
  }
  return out;
}

export interface NetSocket {
  address: string;
  port: number;
  inode: string;
}

function hexIp4(hex: string): string {
  const b = hex.match(/../g) ?? [];
  return b.reverse().map((x) => parseInt(x, 16)).join('.');
}

function hexIp6(hex: string): string {
  const words: string[] = [];
  for (let w = 0; w < 4; w++) {
    const bytes = (hex.slice(w * 8, w * 8 + 8).match(/../g) ?? []).reverse();
    words.push(bytes.slice(0, 2).join(''), bytes.slice(2).join(''));
  }
  const groups = words.map((g) => parseInt(g, 16).toString(16));
  const joined = groups.join(':');
  if (joined === '0:0:0:0:0:0:0:0') return '::';
  if (joined === '0:0:0:0:0:0:0:1') return '::1';
  return joined;
}

/** Parses /proc/net/tcp or tcp6, keeping only LISTEN (0A) sockets. */
export function parseProcNetTcp(text: string, v6: boolean): NetSocket[] {
  const out: NetSocket[] = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;
    const [ip, portHex] = f[1].split(':');
    if (!ip || !portHex || ip.length !== (v6 ? 32 : 8)) continue;
    const port = parseInt(portHex, 16);
    if (!Number.isInteger(port) || port < 1) continue;
    out.push({ address: v6 ? hexIp6(ip) : hexIp4(ip), port, inode: f[9] });
  }
  return out;
}

const SECRET_WORD = /token|password|passwd|secret|key|auth|credential|bearer/i;
const REDACTED = '[redacted]';

const isKeyChar = (c: string) => /[\w.-]/.test(c);

/** The `[\w.-]` run that ends just before index `end`. Scanned by hand: a regex over untrusted argv would backtrack quadratically. */
function keyBefore(s: string, end: number): string {
  let start = end;
  while (start > 0 && isKeyChar(s[start - 1])) start--;
  return s.slice(start, end);
}

/** `NAME=value` at any `=` in the arg (`--env=API_KEY=x`, `--token=x`, `SECRET=x`) when NAME looks secret; everything after it goes. */
function redactAssignment(a: string): string | null {
  for (let i = a.indexOf('='); i > 0; i = a.indexOf('=', i + 1)) {
    if (SECRET_WORD.test(keyBefore(a, i))) return `${a.slice(0, i + 1)}${REDACTED}`;
  }
  return null;
}

/** `Authorization: Bearer x`, `X-Api-Key: x`. */
function redactHeader(a: string): string | null {
  const colon = a.indexOf(':');
  if (colon <= 0 || !/^[\w-]+$/.test(a.slice(0, colon)) || !SECRET_WORD.test(a.slice(0, colon))) return null;
  return `${a.slice(0, colon + 1)} ${REDACTED}`;
}

const isSecretFlag = (a: string) => /^--[\w-]+$/.test(a) && SECRET_WORD.test(a);

/** Joins argv for display. Secret values and URL credentials are replaced before truncation, so a cut never leaks one. */
export function redactCommand(args: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = redactCredentials(args[i]);
    const redacted = redactHeader(a) ?? redactAssignment(a);
    if (redacted !== null) {
      out.push(redacted);
    } else if (isSecretFlag(a)) {
      out.push(a);
      if (i + 1 < args.length) {
        out.push(REDACTED);
        i++;
      }
    } else if (/^-p(?!\d+$)./.test(a)) {
      // mysql-style -p<password>, attached with no space.
      out.push(`-p${REDACTED}`);
    } else {
      out.push(a);
    }
  }
  return out.join(' ').slice(0, COMMAND_LIMIT);
}

/** True when `cwd` lies at or below `project`. Compared with a trailing separator, so `api` never matches `api-v2`. */
export function cwdInProject(realProject: string, cwd: string): boolean {
  const c = path.resolve(cwd);
  const p = path.resolve(realProject);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

const FLAG_PREFIX = /^--[^=]+=/;
const MAX_ARGV_PATHS = 64;

/**
 * Absolute paths named in argv, in order. A leading `--flag=` is stripped. Relative values never count.
 * A value token after `--directory`, `--dir`, `-C`, `--cwd`, `--prefix` or `--root` is its own argv
 * element, so the generic rule already covers it.
 */
export function argvPaths(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    const v = a.replace(FLAG_PREFIX, '');
    if (v.startsWith('/')) out.push(v);
    if (out.length >= MAX_ARGV_PATHS) break;
  }
  return out;
}

// --------------------------------------------------------------------- effects

export interface ProcInfo {
  ppid: number;
  startTime: string;
  uid: number;
  alive: boolean;
  comm: string;
  /** Real path of the working directory, or null when unreadable. */
  cwd: string | null;
  /** Basename of the executable, or null when unreadable. */
  exe: string | null;
}

export interface Sys {
  platform: string;
  selfPid: number;
  selfUid: number;
  /** Null means this host cannot be scanned. */
  listeners(): Promise<Listener[] | null>;
  allPids(): Promise<number[]>;
  proc(pid: number): Promise<ProcInfo | null>;
  cmdline(pid: number): Promise<string[]>;
  /** Symlink-resolved path, or null when it does not exist. */
  realpath(p: string): Promise<string | null>;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  sleep(ms: number): Promise<void>;
}

function runSs(): Promise<string | null | 'absent'> {
  return new Promise((resolve) => {
    execFile('ss', ['-H', '-ltnp'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => {
      if (!e) return resolve(stdout);
      resolve((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null);
    });
  });
}

async function listenersFromProc(pids: number[]): Promise<Listener[] | null> {
  const read = (f: string) => fsp.readFile(f, 'utf8').catch(() => '');
  const sockets = [...parseProcNetTcp(await read('/proc/net/tcp'), false), ...parseProcNetTcp(await read('/proc/net/tcp6'), true)];
  const byInode = new Map<string, number[]>();
  for (const pid of pids) {
    const fds = await fsp.readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
    for (const fd of fds) {
      const link = await fsp.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m) byInode.set(m[1], [...(byInode.get(m[1]) ?? []), pid]);
    }
  }
  return sockets.map((s) => ({ address: s.address, port: s.port, pids: [...new Set(byInode.get(s.inode) ?? [])] }));
}

function parseStat(stat: string): { comm: string; state: string; ppid: number; startTime: string } | null {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = stat.slice(close + 2).split(' ');
  const ppid = Number(rest[1]);
  if (!Number.isInteger(ppid) || !rest[19]) return null;
  return { comm: stat.slice(open + 1, close), state: rest[0], ppid, startTime: rest[19] };
}

export function systemSys(over: Partial<Pick<Sys, 'platform' | 'selfPid'>> = {}): Sys {
  const sys: Sys = {
    platform: over.platform ?? process.platform,
    selfPid: over.selfPid ?? process.pid,
    selfUid: process.getuid?.() ?? -1,
    async listeners() {
      if (sys.platform !== 'linux') return null;
      const pids = await sys.allPids().catch(() => null);
      if (!pids) return null;
      const ss = await runSs();
      if (ss === 'absent') return listenersFromProc(pids);
      return ss === null ? null : parseSs(ss);
    },
    async allPids() {
      return (await fsp.readdir('/proc')).filter((n) => /^\d+$/.test(n)).map(Number);
    },
    async proc(pid) {
      const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8').then(parseStat, () => null);
      if (!stat) return null;
      const st = await fsp.stat(`/proc/${pid}`).catch(() => null);
      if (!st) return null;
      const cwd = await fsp.realpath(`/proc/${pid}/cwd`).catch(() => null);
      const exe = await fsp.readlink(`/proc/${pid}/exe`).then((l) => path.basename(l.replace(/ \(deleted\)$/, '')), () => null);
      return { ppid: stat.ppid, startTime: stat.startTime, uid: st.uid, alive: stat.state !== 'Z' && stat.state !== 'X', comm: stat.comm, cwd, exe };
    },
    async cmdline(pid) {
      const raw = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      return raw.split('\0').filter((s) => s !== '');
    },
    realpath: (p) => fsp.realpath(p).catch(() => null),
    kill(pid, signal) {
      process.kill(pid, signal);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  return sys;
}

// ----------------------------------------------------------------------- logic

/** The gateway, everything above it, and init. None of these is ever signalled. */
async function protectedPids(sys: Sys): Promise<Set<number>> {
  const set = new Set<number>([1, sys.selfPid]);
  let pid = sys.selfPid;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
    const info = await sys.proc(pid);
    if (!info || info.ppid <= 0) break;
    set.add(info.ppid);
    pid = info.ppid;
  }
  return set;
}

/** The claude CLI, also when the native build is started by its own `claude.exe` path. */
const AGENT_NAMES = new Set(['claude', 'claude.exe']);

function isAgent(info: ProcInfo): boolean {
  return AGENT_NAMES.has(info.exe ?? '') || AGENT_NAMES.has(info.comm);
}

/** A live, same-uid, non-agent, unprotected process, with the paths that can tie it to a project. */
interface Owner {
  pid: number;
  startTime: string;
  argv: string[];
  cwd: string | null;
  /** Real paths of the absolute paths in argv; unresolvable ones are dropped. */
  argvReals: string[];
}

async function argvReals(sys: Sys, argv: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of argvPaths(argv)) {
    const real = await sys.realpath(p);
    if (real !== null) out.push(real);
  }
  return out;
}

/** How the owner belongs to the project: its cwd first, else an absolute argv path. */
function viaFor(realProject: string, o: Pick<Owner, 'cwd' | 'argvReals'>): Via | null {
  if (o.cwd !== null && cwdInProject(realProject, o.cwd)) return 'cwd';
  return o.argvReals.some((r) => cwdInProject(realProject, r)) ? 'argv' : null;
}

/** Rules 2 and 5 for one listener pid. */
async function owner(sys: Sys, protectedSet: Set<number>, pid: number): Promise<Owner | null> {
  if (!Number.isInteger(pid) || pid <= 1 || protectedSet.has(pid)) return null;
  const info = await sys.proc(pid);
  if (!info || !info.alive || info.uid !== sys.selfUid || isAgent(info)) return null;
  const argv = await sys.cmdline(pid);
  return { pid, startTime: info.startTime, argv, cwd: info.cwd, argvReals: await argvReals(sys, argv) };
}

/** The deepest project the owner belongs to. Sibling folders never nest, so this only matters defensively. */
function attribute(realProjects: string[], o: Owner): { project: string; via: Via } | null {
  let best: { project: string; via: Via } | null = null;
  for (const project of realProjects) {
    const via = viaFor(project, o);
    if (via && (!best || project.length > best.project.length)) best = { project, via };
  }
  return best;
}

/**
 * Listening sockets grouped by the project their owner runs inside, from one listener scan.
 * Projects with no listener are absent. Null when this host cannot be scanned.
 */
async function scanAll(sys: Sys, realProjects: string[]): Promise<Map<string, RunningPort[]> | null> {
  if (sys.platform !== 'linux') return null;
  const listeners = await sys.listeners();
  if (!listeners) return null;
  const protectedSet = await protectedPids(sys);
  const owners = new Map<number, { owner: Owner; project: string; via: Via } | null>();
  const byProject = new Map<string, Map<number, RunningPort>>();
  for (const l of listeners) {
    for (const pid of l.pids) {
      if (!owners.has(pid)) {
        const o = await owner(sys, protectedSet, pid);
        const match = o && attribute(realProjects, o);
        owners.set(pid, o && match ? { owner: o, ...match } : null);
      }
      const hit = owners.get(pid);
      if (!hit) continue;
      const ports = byProject.get(hit.project) ?? new Map<number, RunningPort>();
      byProject.set(hit.project, ports);
      let entry = ports.get(l.port);
      if (!entry) {
        entry = { port: l.port, address: l.address, pids: [], command: redactCommand(hit.owner.argv), via: hit.via, members: [] };
        ports.set(l.port, entry);
      }
      if (!entry.pids.includes(pid)) {
        entry.pids.push(pid);
        entry.members.push({ pid, startTime: hit.owner.startTime, via: hit.via });
      }
    }
  }
  const out = new Map<string, RunningPort[]>();
  for (const [project, ports] of byProject) {
    const sorted = [...ports.values()].sort((a, b) => a.port - b.port);
    for (const p of sorted) p.pids.sort((a, b) => a - b);
    out.set(project, sorted);
  }
  return out;
}

/** Listening sockets whose owner runs inside the project. Null when this host cannot be scanned. */
export async function scanProject(sys: Sys, realProject: string): Promise<RunningPort[] | null> {
  const all = await scanAll(sys, [realProject]);
  return all && (all.get(realProject) ?? []);
}

function toWire(ports: RunningPort[]): RunningProcess[] {
  return ports.map(({ port, pids, command, address, via }) => ({ port, pids, command, address, via }));
}

export async function listRunning(sys: Sys, realProject: string): Promise<RunningList> {
  const ports = await scanProject(sys, realProject);
  if (!ports) return { supported: false, processes: [] };
  return { supported: true, processes: toWire(ports) };
}

export interface ProjectDir {
  name: string;
  /** Real path of the project folder. */
  dir: string;
}

export type RunningByProject =
  | { supported: true; projects: Record<string, RunningProcess[]> }
  | { supported: false; projects: Record<string, never> };

/** Every project's listeners from one scan, keyed by name in name order, projects without a listener left out. Sends no signal. */
export async function scanProjects(sys: Sys, projects: ProjectDir[]): Promise<RunningByProject> {
  const all = await scanAll(sys, projects.map((p) => p.dir));
  if (!all) return { supported: false, projects: {} };
  const named = [...projects].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // A symlinked alias shares its target's dir; the listener belongs to the folder itself, else the first name.
  const nameOf = new Map<string, string>();
  for (const p of named) if (!nameOf.has(p.dir) || path.basename(p.dir) === p.name) nameOf.set(p.dir, p.name);
  const out: Record<string, RunningProcess[]> = {};
  for (const p of named) {
    const ports = all.get(p.dir);
    if (ports?.length && nameOf.get(p.dir) === p.name) out[p.name] = toWire(ports);
  }
  return { supported: true, projects: out };
}

interface Target {
  pid: number;
  startTime: string;
  kind: 'listener' | 'descendant';
}

async function descendantsOf(sys: Sys, roots: number[]): Promise<Target[]> {
  const children = new Map<number, Array<{ pid: number; startTime: string }>>();
  for (const pid of await sys.allPids().catch(() => [] as number[])) {
    const info = await sys.proc(pid);
    if (!info?.alive) continue;
    children.set(info.ppid, [...(children.get(info.ppid) ?? []), { pid, startTime: info.startTime }]);
  }
  const out: Target[] = [];
  const seen = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length) {
    for (const c of children.get(queue.shift() as number) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push({ ...c, kind: 'descendant' });
      queue.push(c.pid);
    }
  }
  return out;
}

/** Rule 4: the pid still is the process we scanned, and still qualifies. Sends nothing itself. */
async function stillSafe(sys: Sys, realProject: string, protectedSet: Set<number>, t: Target): Promise<boolean> {
  if (t.pid <= 1 || protectedSet.has(t.pid)) return false;
  const info = await sys.proc(t.pid);
  if (!info || !info.alive || info.startTime !== t.startTime || info.uid !== sys.selfUid || isAgent(info)) return false;
  if (t.kind === 'descendant') return true;
  const argv = await sys.cmdline(t.pid);
  if (!viaFor(realProject, { cwd: info.cwd, argvReals: await argvReals(sys, argv) })) return false;
  const listeners = await sys.listeners();
  return !!listeners?.some((l) => l.pids.includes(t.pid));
}

async function signalAll(sys: Sys, realProject: string, targets: Target[], signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const protectedSet = await protectedPids(sys);
  for (const t of targets) {
    if (!(await stillSafe(sys, realProject, protectedSet, t))) continue;
    try {
      sys.kill(t.pid, signal);
    } catch {
      // already gone
    }
  }
}

async function anyAlive(sys: Sys, targets: Target[]): Promise<boolean> {
  for (const t of targets) {
    const info = await sys.proc(t.pid);
    if (info?.alive && info.startTime === t.startTime) return true;
  }
  return false;
}

async function waitUntilGone(sys: Sys, targets: Target[], ms: number): Promise<void> {
  for (let waited = 0; waited < ms && (await anyAlive(sys, targets)); waited += POLL_MS) await sys.sleep(POLL_MS);
}

function toPortPids(ports: RunningPort[]): PortPids[] {
  return ports.map((p) => ({ port: p.port, pids: p.pids }));
}

/**
 * SIGTERM the project's listeners and their descendants, wait, SIGKILL survivors, rescan.
 * Signals go to individual pids only, never to a process group or session.
 */
export async function stopRunning(
  sys: Sys,
  realProject: string,
  port?: number,
): Promise<Result<StopResult, RunningErrorCode>> {
  const scanned = await scanProject(sys, realProject);
  const matched = (scanned ?? []).filter((p) => port === undefined || p.port === port);
  if (matched.length === 0) return err('nothing_running');

  const members = new Map(matched.flatMap((p) => p.members).map((m) => [m.pid, m] as const));
  const listeners: Target[] = [...members.values()].map((m) => ({ pid: m.pid, startTime: m.startTime, kind: 'listener' }));
  const targets = [...listeners, ...(await descendantsOf(sys, listeners.map((l) => l.pid)))];

  await signalAll(sys, realProject, targets, 'SIGTERM');
  await waitUntilGone(sys, targets, TERM_WAIT_MS);
  await signalAll(sys, realProject, targets, 'SIGKILL');
  await waitUntilGone(sys, targets, KILL_WAIT_MS);

  const after = ((await scanProject(sys, realProject)) ?? []).filter((p) => port === undefined || p.port === port);
  const stillListening = new Set(after.flatMap((p) => p.pids.map((pid) => `${p.port}:${pid}`)));
  const stopped = matched
    .map((p) => ({ port: p.port, pids: p.pids.filter((pid) => !stillListening.has(`${p.port}:${pid}`)) }))
    .filter((p) => p.pids.length > 0);
  return ok({ stopped, remaining: toPortPids(after) });
}

/** Rule 6: at most one stop per project per window. */
export class StopLimiter {
  private last = new Map<string, number>();
  constructor(private windowMs = 1000, private now: () => number = Date.now) {}

  /** True when the stop may proceed. */
  take(project: string): boolean {
    const t = this.now();
    const prev = this.last.get(project);
    if (prev !== undefined && t - prev < this.windowMs) return false;
    this.last.set(project, t);
    return true;
  }
}
