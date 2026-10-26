/**
 * Connector sidecars: an HTTP connector whose MCP server the gateway runs itself.
 *
 * A custom connector entry of type `http`/`streamable-http` may carry
 *
 *   sidecar: { command, args?, env?, path? = "/mcp", readyTimeoutMs? = 120000 }
 *
 * instead of a `url`. While the entry exists and is not paused, the supervisor below
 * keeps that command running on a loopback port it allocates and passes as `PORT`,
 * and resolve.ts points the entry's url at `http://127.0.0.1:<port><path>`. Agents
 * still reach it only through the loopback proxy (connectors/proxy.ts), which adds
 * the entry's `headers` per request, so the credential never enters the sidecar's
 * argv or environment, and a token-only update never restarts it.
 *
 * The desired set of sidecars is always "every sidecar entry in customConnectors that
 * is not paused": every write path calls `reconcile` with the whole map, so the
 * supervisor converges on the same state however many times, and in whatever order,
 * it is told.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { CustomConnectorEntry } from './types';
import { extractPlaceholders, isStreamableHttpType, customSecretKey } from './custom';
import { readTokenEnv } from './token-env';
import { isUvCommand, resolveUvCommand } from './uv-runtime';

export interface SidecarSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  path: string;
  readyTimeoutMs: number;
}

export type SidecarState = 'starting' | 'ready' | 'crashed';

/** What the connector status API reports. Never carries env values or headers. */
export interface SidecarStatus {
  state: SidecarState;
  pid?: number;
  restarts: number;
  lastError?: string;
}

const SIDECAR_FIELDS = new Set(['command', 'args', 'env', 'path', 'readyTimeoutMs']);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_PATH = '/mcp';
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const MAX_READY_TIMEOUT_MS = 600_000;

/**
 * The entry's sidecar spec, `undefined` when it has none, or the reason it is unusable.
 * Run at the API boundary (a 400) and again on every reconcile, since config.json can
 * also be edited by hand.
 */
export function parseSidecarSpec(config: Record<string, unknown>): SidecarSpec | { error: string } | undefined {
  const raw = config.sidecar;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'sidecar must be an object' };
  if (!isStreamableHttpType(config.type)) return { error: "sidecar requires config.type 'http' or 'streamable-http'" };
  if (config.url !== undefined) return { error: 'config.url must be omitted with sidecar: the gateway serves it on a loopback port it allocates' };
  if (config.headersHelper !== undefined || config.oauth !== undefined) return { error: 'sidecar cannot be combined with headersHelper or oauth' };
  const sidecar = raw as Record<string, unknown>;
  const unknown = Object.keys(sidecar).filter(key => !SIDECAR_FIELDS.has(key));
  if (unknown.length) return { error: `sidecar has unknown field(s): ${unknown.join(', ')}` };
  if (extractPlaceholders(sidecar).length) return { error: 'sidecar must not contain {placeholders}: secrets reach the sidecar only as request headers' };
  const { command, args = [], env = {}, path: mcpPath = DEFAULT_PATH, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS } = sidecar;
  if (typeof command !== 'string' || !command.trim()) return { error: 'sidecar.command must be a non-empty string' };
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) return { error: 'sidecar.args must be an array of strings' };
  if (!env || typeof env !== 'object' || Array.isArray(env)) return { error: 'sidecar.env must be an object of strings' };
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME_RE.test(name) || typeof value !== 'string') return { error: 'sidecar.env must map variable names to strings' };
    if (name === 'PORT') return { error: 'sidecar.env must not set PORT: the gateway assigns it' };
  }
  if (typeof mcpPath !== 'string' || !mcpPath.startsWith('/')) return { error: "sidecar.path must start with '/'" };
  if (typeof readyTimeoutMs !== 'number' || !Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 1000 || readyTimeoutMs > MAX_READY_TIMEOUT_MS) {
    return { error: `sidecar.readyTimeoutMs must be an integer from 1000 to ${MAX_READY_TIMEOUT_MS}` };
  }
  return { command: command.trim(), args: args as string[], env: env as Record<string, string>, path: mcpPath, readyTimeoutMs };
}

/** Equal for two specs exactly when restarting from one to the other changes nothing. */
function specKey(spec: SidecarSpec): string {
  return JSON.stringify([spec.command, spec.args, Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b)), spec.path, spec.readyTimeoutMs]);
}

type Phase =
  | { kind: 'starting'; child?: ChildProcess; port?: number }
  | { kind: 'ready'; child: ChildProcess; port: number; since: number }
  | { kind: 'backoff'; timer: NodeJS.Timeout }
  | { kind: 'invalid' }
  | { kind: 'stopped' };

interface Sidecar {
  id: string;
  key: string;
  spec?: SidecarSpec;
  phase: Phase;
  /** Consecutive failed starts or crashes; picks the backoff and resets once a run lasts. */
  failures: number;
  restarts: number;
  lastError?: string;
  lastPort?: number;
  /** Serialises start/stop for this id so a stop never races the start before it. */
  queue: Promise<void>;
  waiters: Set<() => void>;
}

export interface SidecarSupervisorOptions {
  /** Gateway-owned directory for the uv runtime and each sidecar's working directory. */
  runtimeRoot: string;
  backoffMs?: readonly number[];
  /** A run at least this long resets the backoff. */
  stableMs?: number;
  stopGraceMs?: number;
  /** The sidecar's PATH, and where an existing uv is looked for (default: the gateway's PATH, plus ~/.local/bin for uv). */
  searchPath?: string;
  log?: (line: string) => void;
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
const STDERR_LINES_PER_MINUTE = 120;
const MAX_LOG_LINE = 2000;

export class SidecarSupervisor {
  private readonly sidecars = new Map<string, Sidecar>();
  private readonly options: Required<Omit<SidecarSupervisorOptions, 'searchPath'>> & { searchPath?: string };
  private closed = false;

  constructor(options: SidecarSupervisorOptions) {
    this.options = {
      backoffMs: DEFAULT_BACKOFF_MS,
      stableMs: 30_000,
      stopGraceMs: 5000,
      log: line => console.error(line),
      ...options,
    };
  }

  /** Converge on one running sidecar per non-paused sidecar entry in `entries`. */
  reconcile(entries: Record<string, CustomConnectorEntry> | undefined): void {
    if (this.closed) return;
    const desired = new Map<string, SidecarSpec | { error: string }>();
    for (const [id, entry] of Object.entries(entries ?? {})) {
      if (!entry || entry.paused === true || !entry.config || typeof entry.config !== 'object') continue;
      const parsed = parseSidecarSpec(entry.config);
      if (parsed) desired.set(id, parsed);
    }
    for (const id of this.sidecars.keys()) if (!desired.has(id)) this.remove(id);
    for (const [id, parsed] of desired) {
      const key = 'error' in parsed ? `invalid:${parsed.error}` : specKey(parsed);
      const current = this.sidecars.get(id);
      if (current?.key === key) continue;
      const sidecar = current ?? this.create(id);
      sidecar.key = key;
      sidecar.failures = 0;
      if ('error' in parsed) {
        sidecar.spec = undefined;
        this.enqueue(sidecar, async () => {
          await this.halt(sidecar);
          sidecar.phase = { kind: 'invalid' };
          sidecar.lastError = parsed.error;
          this.options.log(`connector-sidecar: connector=${id} not started: ${parsed.error}`);
        });
        continue;
      }
      sidecar.spec = parsed;
      const restarting = current !== undefined;
      this.enqueue(sidecar, async () => {
        await this.halt(sidecar);
        if (restarting) sidecar.restarts++;
        await this.start(sidecar);
      });
    }
  }

  /** The upstream url while the sidecar is ready, else undefined. */
  urlOf(id: string): string | undefined {
    const sidecar = this.sidecars.get(id);
    if (!sidecar?.spec || sidecar.phase.kind !== 'ready') return undefined;
    return `http://127.0.0.1:${sidecar.phase.port}${sidecar.spec.path}`;
  }

  statusOf(id: string): SidecarStatus | undefined {
    const sidecar = this.sidecars.get(id);
    if (!sidecar) return undefined;
    const { phase } = sidecar;
    // A listed sidecar that is stopped is between a stop and its next start.
    const state: SidecarState = phase.kind === 'ready' ? 'ready' : phase.kind === 'starting' || phase.kind === 'stopped' ? 'starting' : 'crashed';
    const pid = phase.kind === 'ready' || phase.kind === 'starting' ? (phase as { child?: ChildProcess }).child?.pid : undefined;
    return {
      state,
      ...(pid !== undefined ? { pid } : {}),
      restarts: sidecar.restarts,
      ...(sidecar.lastError && state !== 'ready' ? { lastError: sidecar.lastError } : {}),
    };
  }

  /** Resolves with the url once ready; undefined when it fails first, after its readyTimeoutMs, or when it is not running. */
  waitUntilReady(id: string): Promise<string | undefined> {
    const sidecar = this.sidecars.get(id);
    if (!sidecar || sidecar.phase.kind === 'ready') return Promise.resolve(this.urlOf(id));
    if (!sidecar.spec || sidecar.phase.kind === 'invalid' || sidecar.phase.kind === 'stopped') return Promise.resolve(undefined);
    const timeoutMs = sidecar.spec.readyTimeoutMs;
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer);
        sidecar.waiters.delete(done);
        resolve(this.urlOf(id));
      };
      const timer = setTimeout(done, timeoutMs);
      sidecar.waiters.add(done);
    });
  }

  /** Stop every sidecar and refuse new ones: gateway shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sidecars.keys()].map(id => this.remove(id)));
  }

  /** Last-resort synchronous kill for process exit paths that cannot await. */
  killAllNow(): void {
    for (const sidecar of this.sidecars.values()) {
      const child = (sidecar.phase as { child?: ChildProcess }).child;
      if (child) signalGroup(child, 'SIGKILL');
    }
  }

  private create(id: string): Sidecar {
    const sidecar: Sidecar = { id, key: '', phase: { kind: 'stopped' }, failures: 0, restarts: 0, queue: Promise.resolve(), waiters: new Set() };
    this.sidecars.set(id, sidecar);
    return sidecar;
  }

  private remove(id: string): Promise<void> {
    const sidecar = this.sidecars.get(id);
    if (!sidecar) return Promise.resolve();
    this.sidecars.delete(id);
    sidecar.key = '';
    return this.enqueue(sidecar, async () => {
      await this.halt(sidecar);
      sidecar.phase = { kind: 'stopped' };
      this.notify(sidecar);
    });
  }

  private enqueue(sidecar: Sidecar, op: () => Promise<void>): Promise<void> {
    sidecar.queue = sidecar.queue.then(op).catch(err => {
      this.options.log(`connector-sidecar: connector=${sidecar.id} lifecycle error: ${(err as Error).message}`);
    });
    return sidecar.queue;
  }

  private notify(sidecar: Sidecar): void {
    for (const waiter of [...sidecar.waiters]) waiter();
  }

  private current(sidecar: Sidecar, key: string): boolean {
    return this.sidecars.get(sidecar.id) === sidecar && sidecar.key === key && !this.closed;
  }

  private async start(sidecar: Sidecar): Promise<void> {
    const spec = sidecar.spec;
    if (!spec) return;
    const key = sidecar.key;
    sidecar.phase = { kind: 'starting' };
    let child: ChildProcess;
    let port: number;
    try {
      const command = isUvCommand(spec.command)
        ? await resolveUvCommand(spec.command, { installRoot: this.options.runtimeRoot, searchPath: this.options.searchPath })
        : spec.command;
      if (!this.current(sidecar, key)) return;
      port = await allocatePort(sidecar.lastPort);
      sidecar.lastPort = port;
      const cwd = path.join(this.options.runtimeRoot, 'sidecars', sidecar.id);
      fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      child = spawn(command, spec.args, {
        cwd,
        env: this.childEnv(spec, command, port),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so stopping it also stops what it spawned (uvx runs python).
        detached: true,
      });
    } catch (err) {
      this.failed(sidecar, key, (err as Error).message);
      return;
    }
    sidecar.phase = { kind: 'starting', child, port };
    this.pipeOutput(sidecar, child);
    let exited = false;
    child.once('error', err => {
      exited = true;
      if (sidecar.phase.kind !== 'stopped' && (sidecar.phase as { child?: ChildProcess }).child === child) this.failed(sidecar, key, err.message);
    });
    child.once('exit', (code, signal) => {
      exited = true;
      if ((sidecar.phase as { child?: ChildProcess }).child !== child) return;
      // The leader is gone but what it started (uvx's python) may still hold the port.
      signalGroup(child, 'SIGKILL');
      const ranFor = sidecar.phase.kind === 'ready' ? Date.now() - sidecar.phase.since : 0;
      if (ranFor >= this.options.stableMs) sidecar.failures = 0;
      this.failed(sidecar, key, `exited ${signal ? `by ${signal}` : `with code ${code}`}`);
    });
    this.options.log(`connector-sidecar: connector=${sidecar.id} started pid=${child.pid} port=${port}`);
    // Not awaited: the queue must stay free for a stop while a slow server comes up.
    void this.awaitReady(sidecar, key, child, port, spec.readyTimeoutMs, () => exited);
  }

  private async awaitReady(sidecar: Sidecar, key: string, child: ChildProcess, port: number, timeoutMs: number, exited: () => boolean): Promise<void> {
    const running = (): boolean => !exited() && this.current(sidecar, key) && (sidecar.phase as { child?: ChildProcess }).child === child;
    const deadline = Date.now() + timeoutMs;
    while (running() && Date.now() < deadline) {
      if (await canConnect(port)) {
        if (!running()) return;
        sidecar.phase = { kind: 'ready', child, port, since: Date.now() };
        sidecar.lastError = undefined;
        this.options.log(`connector-sidecar: connector=${sidecar.id} ready on 127.0.0.1:${port}`);
        this.notify(sidecar);
        return;
      }
      await delay(250);
    }
    if (!running()) return;
    this.enqueue(sidecar, async () => {
      if (!running()) return;
      sidecar.phase = { kind: 'starting' };
      await stopChild(child, this.options.stopGraceMs);
      this.failed(sidecar, key, `not listening on its port within ${timeoutMs}ms`);
    });
  }

  /** Record a failed start or a crash and schedule the next attempt. */
  private failed(sidecar: Sidecar, key: string, error: string): void {
    sidecar.lastError = error;
    this.options.log(`connector-sidecar: connector=${sidecar.id} ${error}`);
    if (!this.current(sidecar, key)) return;
    const backoff = this.options.backoffMs;
    const wait = backoff[Math.min(sidecar.failures, backoff.length - 1)];
    sidecar.failures++;
    const timer = setTimeout(() => {
      if (!this.current(sidecar, key) || sidecar.phase.kind !== 'backoff' || sidecar.phase.timer !== timer) return;
      sidecar.restarts++;
      this.enqueue(sidecar, () => this.start(sidecar));
    }, wait);
    timer.unref();
    sidecar.phase = { kind: 'backoff', timer };
    this.notify(sidecar);
  }

  /** Stop whatever this sidecar is running or waiting to run. */
  private async halt(sidecar: Sidecar): Promise<void> {
    const phase = sidecar.phase;
    if (phase.kind === 'backoff') clearTimeout(phase.timer);
    const child = (phase as { child?: ChildProcess }).child;
    sidecar.phase = { kind: 'stopped' };
    if (child) {
      await stopChild(child, this.options.stopGraceMs);
      this.options.log(`connector-sidecar: connector=${sidecar.id} stopped pid=${child.pid}`);
    }
  }

  private searchPath(): string {
    return this.options.searchPath ?? process.env.PATH ?? '';
  }

  /** PATH, HOME and LANG from the gateway, then the spec's env, then PORT. Nothing else of the gateway's. */
  private childEnv(spec: SidecarSpec, command: string, port: number): Record<string, string> {
    const dirs = [path.dirname(command), ...this.searchPath().split(path.delimiter)].filter(dir => dir && dir !== '.');
    const env: Record<string, string> = { PATH: [...new Set(dirs)].join(path.delimiter), HOME: os.homedir() };
    if (process.env.LANG) env.LANG = process.env.LANG;
    return { ...env, ...spec.env, PORT: String(port) };
  }

  /**
   * Copy the sidecar's output to the gateway log, prefixed and rate-limited. Bearer
   * values and this connector's stored secrets are masked: a server that logs its
   * request headers must not put the credential in the gateway log.
   */
  private pipeOutput(sidecar: Sidecar, child: ChildProcess): void {
    const prefix = `connector-sidecar: connector=${sidecar.id}`;
    let windowStart = Date.now();
    let lines = 0;
    let suppressed = 0;
    let secrets: { at: number; values: string[] } | undefined;
    const secretValues = (): string[] => {
      if (!secrets || Date.now() - secrets.at > 10_000) {
        const env = readTokenEnv();
        const mark = customSecretKey(sidecar.id, '');
        secrets = { at: Date.now(), values: Object.entries(env).filter(([name, value]) => name.startsWith(mark) && value.length >= 8).map(([, value]) => value) };
      }
      return secrets.values;
    };
    const emit = (line: string): void => {
      if (!line.trim()) return;
      const now = Date.now();
      if (now - windowStart >= 60_000) {
        if (suppressed) this.options.log(`${prefix} output: ${suppressed} line(s) suppressed`);
        windowStart = now; lines = 0; suppressed = 0;
      }
      if (++lines > STDERR_LINES_PER_MINUTE) { suppressed++; return; }
      let masked = line.slice(0, MAX_LOG_LINE).replace(/(Bearer\s+)[^\s"',]+/gi, '$1[redacted]');
      for (const value of secretValues()) masked = masked.split(value).join('[redacted]');
      this.options.log(`${prefix} output: ${masked}`);
    };
    for (const stream of [child.stdout, child.stderr]) {
      let partial = '';
      stream?.on('data', (chunk: Buffer) => {
        const parts = (partial + chunk.toString('utf8')).split('\n');
        partial = parts.pop() ?? '';
        if (partial.length > MAX_LOG_LINE) { emit(partial); partial = ''; }
        for (const part of parts) emit(part);
      });
      stream?.on('end', () => { emit(partial); partial = ''; });
    }
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** SIGTERM the sidecar's process group, then SIGKILL it after `graceMs`. */
async function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { signalGroup(child, 'SIGKILL'); return; }
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  signalGroup(child, 'SIGTERM');
  const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), graceMs);
  await exited;
  clearTimeout(timer);
  // The leader exited; anything it left in its group goes with it.
  signalGroup(child, 'SIGKILL');
}

/** A free loopback port, preferring `preferred` so a restart keeps its address. */
async function allocatePort(preferred?: number): Promise<number> {
  const tryListen = (port: number): Promise<number | undefined> => new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(undefined));
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
  if (preferred) {
    const port = await tryListen(preferred);
    if (port) return port;
  }
  const port = await tryListen(0);
  if (!port) throw new Error('no free loopback port');
  return port;
}

function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let shared: SidecarSupervisor | undefined;

/** The gateway's one supervisor. `configure` replaces it (boot, tests). */
export const connectorSidecars = {
  configure(options: SidecarSupervisorOptions): SidecarSupervisor {
    shared = new SidecarSupervisor(options);
    return shared;
  },
  get(): SidecarSupervisor {
    shared ??= new SidecarSupervisor({ runtimeRoot: path.join(os.homedir(), '.claude-gateway', 'runtimes') });
    return shared;
  },
};
