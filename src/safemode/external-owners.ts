import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SafemodeCli } from './native';

export interface ExternalOwnerOptions {
  cli: SafemodeCli;
  nativeSessionId?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Only native children whose ownership has already been verified by safemode. */
  ignorePids?: number[];
}

function vanished(error: unknown): boolean {
  return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || '');
}
export class ExternalOwnerFound extends Error {
  constructor(readonly pid: number) { super(`Busy: external native CLI process ${pid} may own this conversation. Close it before resuming; safemode will not stop an unmanaged process.`); }
}
function busy(pid: number): never {
  throw new ExternalOwnerFound(pid);
}
function startTime(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? undefined : fields[19];
  } catch (error) { if (vanished(error)) return undefined; throw error; }
}
function nativeName(value: string, cli: SafemodeCli): boolean {
  const base = path.basename(value).toLowerCase();
  return cli === 'claude' ? /^(claude|claude\.exe)$/.test(base) : /^(codex|codex\.exe)$/.test(base);
}

/**
 * A conservative preflight, NOT a cross-process lock. Native Claude --resume can
 * bypass safemode's lock. Recheck immediately before spawn and while running.
 * Native Codex versions with writer locks enforce their own atomic exclusion.
 * Only process/registry metadata is inspected; never auth, prompts or histories.
 */
function inspectExternalNativeOwner(options: ExternalOwnerOptions): void {
  if (process.platform !== 'linux') {
    throw new Error('Safemode cannot verify external native session ownership on this platform (Linux /proc is required).');
  }
  const ignored = new Set([process.pid, ...(options.ignorePids || [])]);
  // A native launcher can spawn its actual CLI; all verified managed descendants
  // share that managed ownership and must not be mistaken for external clients.
  const parents = new Map<number, number>();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch (error) { if (!vanished(error)) throw error; }
  }
  // Only child roots supplied explicitly, never every descendant of this supervisor.
  const managed = new Set(options.ignorePids || []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of parents) if (managed.has(parent) && !managed.has(pid)) { managed.add(pid); changed = true; }
  }
  for (const pid of managed) ignored.add(pid);
  const env = options.env || process.env;
  const home = env.HOME || os.homedir();
  const nativeHome = options.cli === 'claude'
    ? env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
    : env.CODEX_HOME || path.join(home, '.codex');
  const knownRegistry = new Map<number, { sessionId?: string; cwd?: string }>();
  if (options.cli === 'claude') {
    const registry = path.join(nativeHome, 'sessions');
    let files: string[] = [];
    try { files = fs.readdirSync(registry); } catch (error) {
      if (!vanished(error)) throw new Error('Cannot verify external Claude session ownership: registry is unreadable.');
    }
    for (const file of files) {
      if (!/^\d+\.json$/.test(file)) continue;
      const pid = Number(file.slice(0, -5));
      if (ignored.has(pid)) continue;
      const liveStart = startTime(pid);
      if (!liveStart) continue;
      let record: { pid?: number; procStart?: string; sessionId?: string; cwd?: string };
      try { record = JSON.parse(fs.readFileSync(path.join(registry, file), 'utf8')); }
      catch (error) {
        if (vanished(error)) continue;
        throw new Error(`Cannot verify external Claude session ownership for process ${pid}: registry is unreadable.`);
      }
      if (record.pid !== pid) throw new Error(`Cannot verify external Claude session ownership for process ${pid}: registry PID mismatch.`);
      // Older registries lacking a start identity cannot disprove a live owner.
      if (record.procStart !== undefined && String(record.procStart) !== liveStart) continue;
      knownRegistry.set(pid, record);
      if (options.nativeSessionId ? record.sessionId === options.nativeSessionId : record.cwd === options.cwd) busy(pid);
    }
  }
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (ignored.has(pid)) continue;
    const root = `/proc/${pid}`;
    try {
      if (typeof process.getuid === 'function' && fs.statSync(root).uid !== process.getuid()) continue;
      if (!startTime(pid)) continue;
      const argv = fs.readFileSync(path.join(root, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      // Filter before opening exe/environ/fds: unrelated same-user services can
      // deliberately make those files unreadable (e.g. non-dumpable daemons).
      const candidate = [argv[0] || '', argv[1] || ''].some(value => nativeName(value, options.cli));
      if (!candidate) continue;
      // Native homes are distinct stores, so the same UUID in another home is
      // not this conversation. Extract only these three routing keys; never
      // return, log or include process environment/arguments in errors.
      const routing: Record<string, string> = {};
      for (const field of fs.readFileSync(path.join(root, 'environ'), 'utf8').split('\0')) {
        const equals = field.indexOf('=');
        if (equals < 0) continue;
        const key = field.slice(0, equals);
        if (['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(key)) routing[key] = field.slice(equals + 1);
      }
      const processHome = options.cli === 'claude'
        ? routing.CLAUDE_CONFIG_DIR || (routing.HOME ? path.join(routing.HOME, '.claude') : undefined)
        : routing.CODEX_HOME || (routing.HOME ? path.join(routing.HOME, '.codex') : undefined);
      if (processHome && path.resolve(processHome) !== path.resolve(nativeHome)) continue;
      if (!processHome) throw new Error(`Cannot verify external native session ownership for process ${pid}: native home is unknown.`);
      const record = knownRegistry.get(pid);
      if (record && options.nativeSessionId && record.sessionId) continue;
      const cwd = fs.readlinkSync(path.join(root, 'cwd'));
      if (cwd === options.cwd) busy(pid);
      if (options.nativeSessionId) {
        for (let i = 0; i < argv.length; i++) {
          if (['--resume', '-r', '--session-id', 'resume'].includes(argv[i]) && argv[i + 1] === options.nativeSessionId) busy(pid);
          if (argv[i] === `--resume=${options.nativeSessionId}` || argv[i] === `--session-id=${options.nativeSessionId}`) busy(pid);
        }
        // Codex app-server and resume picker need no UUID in argv. A live file
        // descriptor proves access even when the CLI holds a kernel writer lock.
        for (const fd of fs.readdirSync(path.join(root, 'fd'))) {
          let target: string;
          try { target = fs.readlinkSync(path.join(root, 'fd', fd)).replace(/ \(deleted\)$/, ''); }
          catch (error) { if (vanished(error)) continue; throw error; }
          const name = path.basename(target);
          if ((target.startsWith(path.join(nativeHome, 'thread-writer-locks') + path.sep) && name === `${options.nativeSessionId}.lock`)
              || (target.startsWith(path.join(nativeHome, 'sessions') + path.sep) && name.endsWith(`-${options.nativeSessionId}.jsonl`))) busy(pid);
        }
        // Claude can switch conversations without changing argv. An unregistered
        // live Claude in this user context cannot be ruled out safely.
        if (options.cli === 'claude' && !record) {
          throw new Error(`Cannot verify external Claude session ownership for process ${pid}: no current native session registration. Close it before resuming.`);
        }
      }
    } catch (error) {
      if (vanished(error)) continue;
      if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(`Cannot verify external native session ownership for process ${pid}: process metadata is inaccessible.`);
      }
      throw error;
    }
  }
}

export function assertNoExternalNativeOwner(options: ExternalOwnerOptions): void {
  inspectExternalNativeOwner(options);
}

/** Minimal ownership evidence only; never expose native argv or transcript text. */
export function findExternalNativeOwners(options: ExternalOwnerOptions): Array<{ pid: number }> {
  const owners: Array<{ pid: number }> = [];
  const ignored = [...(options.ignorePids || [])];
  for (let count = 0; count < 64; count++) {
    try { inspectExternalNativeOwner({ ...options, ignorePids: ignored }); return owners; }
    catch (error) {
      if (!(error instanceof ExternalOwnerFound)) throw error;
      owners.push({ pid: error.pid });
      ignored.push(error.pid);
    }
  }
  throw new Error('Too many external native owners to verify safely.');
}
