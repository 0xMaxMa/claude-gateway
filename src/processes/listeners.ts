import { promises as fsp } from 'fs';
import { redactLine, redactUntrustedItem } from '../cli/redact';
import { pathWithin } from '../utils/paths';

/** One listening TCP socket from /proc/net/tcp or tcp6. */
export interface ListenSocket {
  inode: string;
  address: string;
  port: number;
}

/** A process holding a listening socket. `cwd` is the real path of /proc/<pid>/cwd; absent when it cannot be read. */
export interface SocketOwner {
  pid: number;
  session?: number;
  /** Field 22 of /proc/<pid>/stat, the start time in clock ticks: with the pid it names one process, never a reused pid. */
  startTicks?: string;
  cwd?: string;
  command: string;
}

/** What `GET /v1/processes` reports per socket. */
export interface Listener {
  port: number;
  pids: number[];
  command: string;
  address: string;
}

export interface OwnedListener extends ListenSocket {
  owners: SocketOwner[];
}

const TCP_LISTEN = '0A';
export const MAX_COMMAND_CHARS = 200;

/** /proc/net/tcp stores an IPv4 address as one little-endian 32-bit word. */
function ipv4(hex: string): string {
  return [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.');
}

/** /proc/net/tcp6 stores four little-endian 32-bit words. */
function ipv6(hex: string): string {
  const bytes: number[] = [];
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8);
    for (const i of [6, 4, 2, 0]) bytes.push(parseInt(word.slice(i, i + 2), 16));
  }
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return `::ffff:${bytes.slice(12).join('.')}`;
  const groups = Array.from({ length: 8 }, (_, i) => ((bytes[2 * i] << 8) | bytes[2 * i + 1]).toString(16));
  let best = { start: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best.len && j - i > 1) best = { start: i, len: j - i };
    i = j;
  }
  if (best.start < 0) return groups.join(':');
  return `${groups.slice(0, best.start).join(':')}::${groups.slice(best.start + best.len).join(':')}`;
}

/** The LISTEN rows of one /proc/net/tcp or tcp6 file. */
export function parseProcNetTcp(text: string, v6: boolean): ListenSocket[] {
  return text.split('\n').slice(1).flatMap((line) => {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== TCP_LISTEN) return [];
    const [addr, port] = f[1].split(':');
    return [{ inode: f[9], address: v6 ? ipv6(addr) : ipv4(addr), port: parseInt(port, 16) }];
  });
}

export async function listeningSockets(): Promise<ListenSocket[]> {
  const read = (file: string) => fsp.readFile(file, 'utf8').catch(() => '');
  const [v4, v6] = await Promise.all([read('/proc/net/tcp'), read('/proc/net/tcp6')]);
  return [...parseProcNetTcp(v4, false), ...parseProcNetTcp(v6, true)];
}

export async function listeningPorts(): Promise<Set<number>> {
  return new Set((await listeningSockets()).map((s) => s.port));
}

/** argv joined by spaces, with secret-looking values masked and the result cut to {@link MAX_COMMAND_CHARS}. */
export function displayCommand(argv: string[]): string {
  const text = redactLine(argv.map(redactUntrustedItem).join(' '));
  return text.length > MAX_COMMAND_CHARS ? `${text.slice(0, MAX_COMMAND_CHARS - 1)}…` : text;
}

/** Field `n` (1-based, as proc(5) numbers them) of a /proc/<pid>/stat line; the comm in parentheses may hold spaces. */
export function statField(stat: string, n: number): string | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0 || n < 3) return undefined;
  return stat.slice(close + 2).split(' ')[n - 3] || undefined;
}

/** The start time of `pid` now, or undefined when it is gone. */
export async function readStartTicks(pid: number): Promise<string | undefined> {
  return statField(await fsp.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''), 22);
}

async function describeOwner(pid: number): Promise<SocketOwner> {
  const [cmdline, stat, cwd] = await Promise.all([
    fsp.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
    fsp.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''),
    fsp.realpath(`/proc/${pid}/cwd`).catch(() => undefined),
  ]);
  const session = Number(statField(stat, 6));
  const startTicks = statField(stat, 22);
  return {
    pid, cwd, command: displayCommand(cmdline.split('\0').filter(Boolean)),
    ...(Number.isInteger(session) ? { session } : {}),
    ...(startTicks ? { startTicks } : {}),
  };
}

/** Every listening socket with the processes whose fd table holds it. Processes the gateway may not inspect are left out. */
export async function collectListeners(): Promise<OwnedListener[]> {
  const sockets = await listeningSockets();
  const byInode = new Map(sockets.map((s) => [`socket:[${s.inode}]`, s]));
  const pidsByInode = new Map<string, number[]>();
  const pids = (await fsp.readdir('/proc')).filter((n) => /^\d+$/.test(n)).map(Number);
  await Promise.all(pids.map(async (pid) => {
    let fds: string[];
    try { fds = await fsp.readdir(`/proc/${pid}/fd`); } catch { return; }
    for (const fd of fds) {
      const link = await fsp.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      if (!byInode.has(link)) continue;
      const list = pidsByInode.get(link) ?? [];
      if (!list.includes(pid)) list.push(pid);
      pidsByInode.set(link, list);
    }
  }));
  const owners = new Map<number, Promise<SocketOwner>>();
  const ownerOf = (pid: number) => owners.get(pid) ?? owners.set(pid, describeOwner(pid)).get(pid)!;
  return Promise.all(sockets.map(async (s) => ({
    ...s,
    owners: await Promise.all((pidsByInode.get(`socket:[${s.inode}]`) ?? []).sort((a, b) => a - b).map(ownerOf)),
  })));
}

/** Listeners owned by a process working in `realDir` or a folder inside it, sorted by port then address. */
export function listenersIn(all: OwnedListener[], realDir: string): Listener[] {
  return all
    .filter((l) => l.owners.some((o) => o.cwd !== undefined && pathWithin(realDir, o.cwd)))
    .map((l) => {
      const owners = l.owners.filter((o) => o.cwd !== undefined && pathWithin(realDir, o.cwd));
      return { port: l.port, pids: owners.map((o) => o.pid), command: owners[0].command, address: l.address };
    })
    .sort((a, b) => a.port - b.port || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}
