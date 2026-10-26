/**
 * The uv runtime for connector sidecars whose command is `uv` or `uvx`.
 *
 * A host that already has uv (on PATH or in ~/.local/bin, where uv's own installer
 * puts it) uses that. Otherwise, on Linux, the gateway installs one pinned release
 * into a directory it owns: the PyPI wheel, checked against a sha256 written here,
 * so nothing it downloads runs unless it is byte-identical to the reviewed release.
 * No shell installer, no root. Other platforms must provide uv themselves.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inflateRawSync } from 'zlib';

export const UV_VERSION = '0.8.3';

interface UvWheel { url: string; sha256: string }

/** `uv-0.8.3-py3-none-manylinux_2_17_*.whl` on PyPI; the hashes are PyPI's published digests. */
const UV_WHEELS: Readonly<Record<string, UvWheel>> = {
  'linux-x64': {
    url: 'https://files.pythonhosted.org/packages/5e/62/0d1ba1c666c5492d3716d8d3fba425f65ed2acc6707544c3cbbd381f6cbe/uv-0.8.3-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
    sha256: 'f1eb7c896fc0d80ed534748aaf46697b6ebc8ce401f1c51666ce0b9923c3db9a',
  },
  'linux-arm64': {
    url: 'https://files.pythonhosted.org/packages/a3/76/6d2eb90936603756c4a71f9cf5de8d9214fa4d11dcb5a89117389acecd5e/uv-0.8.3-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl',
    sha256: '8b16f1bddfdf8f7470924ab34a7b55e4c372d5340c7c1e47e7fc84a743dc541f',
  },
};

const UV_COMMANDS = new Set(['uv', 'uvx']);

export function isUvCommand(command: string): boolean {
  return UV_COMMANDS.has(command);
}

export interface UvRuntimeOptions {
  /** Gateway-owned directory the pinned uv is installed under. */
  installRoot: string;
  /** Where to look for an existing uv; defaults to PATH plus ~/.local/bin. */
  searchPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Overrides the pinned wheel table (tests). */
  wheels?: Readonly<Record<string, UvWheel>>;
  fetchImpl?: typeof fetch;
  /** Abandons the download and the wait for another installer's lock (gateway shutdown). */
  signal?: AbortSignal;
}

/** An existing executable named `name` in one of the `searchPath` directories. */
function findExisting(name: string, searchPath: string): string | undefined {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return undefined;
}

const installs = new Map<string, Promise<void>>();

/**
 * Absolute path of `command` (`uv` or `uvx`), installing the pinned uv first when the
 * host has none. Rejects, and installs nothing, when the download does not match.
 */
export async function resolveUvCommand(command: string, options: UvRuntimeOptions): Promise<string> {
  const existing = findExisting(command, options.searchPath ?? [process.env.PATH ?? '', path.join(os.homedir(), '.local', 'bin')].join(path.delimiter));
  if (existing) return existing;
  const binDir = path.join(options.installRoot, `uv-${UV_VERSION}`, 'bin');
  const installed = path.join(binDir, command);
  if (fs.existsSync(installed)) return installed;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const wheel = (options.wheels ?? UV_WHEELS)[`${platform}-${arch}`];
  if (!wheel) throw new Error(`${command} is not on PATH and the gateway installs uv only on Linux x64/arm64; install uv ${UV_VERSION} on this host`);
  // One install per directory in this process; installUv's lock file covers other processes.
  let pending = installs.get(binDir);
  if (!pending) {
    pending = installUv(binDir, wheel, options.fetchImpl ?? fetch, options.signal).finally(() => installs.delete(binDir));
    installs.set(binDir, pending);
  }
  await pending;
  return installed;
}

const LOCK_STALE_MS = 10 * 60 * 1000;

/** False only when no process has this pid; EPERM means it exists under another user. */
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/**
 * Remove a lock whose installer is gone, and the staging directories it left. A
 * SIGKILLed gateway never runs installUv's finally, and waiting out LOCK_STALE_MS would
 * block every uvx sidecar for ten minutes.
 */
function clearStaleLock(lock: string): void {
  let stale: boolean;
  try {
    const holder = Number(fs.readFileSync(lock, 'utf8'));
    stale = (Number.isInteger(holder) && holder > 0 && !processExists(holder)) || Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch { return; /* released meanwhile */ }
  if (!stale) return;
  fs.rmSync(lock, { force: true });
  const parent = path.dirname(lock);
  for (const name of fs.readdirSync(parent)) {
    if (name.startsWith('.staging-')) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
  }
}

async function installUv(binDir: string, wheel: UvWheel, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<void> {
  const parent = path.dirname(binDir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const lock = path.join(parent, '.install.lock');
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (fs.existsSync(path.join(binDir, 'uv'))) return;
      signal?.throwIfAborted();
      clearStaleLock(lock);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  const staging = fs.mkdtempSync(path.join(parent, '.staging-'));
  try {
    if (fs.existsSync(path.join(binDir, 'uv'))) return;
    const timeout = AbortSignal.timeout(5 * 60 * 1000);
    const response = await fetchImpl(wheel.url, { redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
    if (!response.ok) throw new Error(`uv download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== wheel.sha256) throw new Error(`uv download sha256 mismatch: expected ${wheel.sha256}, got ${digest}`);
    const files = readZipEntries(archive, [`uv-${UV_VERSION}.data/scripts/uv`, `uv-${UV_VERSION}.data/scripts/uvx`]);
    const stagedBin = path.join(staging, 'bin');
    fs.mkdirSync(stagedBin, { mode: 0o700 });
    for (const [name, data] of files) fs.writeFileSync(path.join(stagedBin, path.basename(name)), data, { mode: 0o755 });
    // A rename is atomic, so a reader sees either no bin/ or a complete one.
    fs.renameSync(stagedBin, binDir);
    console.log(`connector-sidecar: installed uv ${UV_VERSION} to ${binDir}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(lock, { force: true });
  }
}

/** The named entries of a zip archive (stored or deflated), from its central directory. */
export function readZipEntries(archive: Buffer, names: string[]): Map<string, Buffer> {
  const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
  let eocd = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 0xffff); i--) {
    if (archive.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('uv archive is not a zip file');
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const wanted = new Set(names);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (archive.readUInt32LE(offset) !== CENTRAL) throw new Error('uv archive has a corrupt central directory');
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted.has(name)) continue;
    if (archive.readUInt32LE(localOffset) !== LOCAL) throw new Error(`uv archive entry ${name} is corrupt`);
    const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`uv archive entry ${name} uses unsupported compression ${method}`);
  }
  const missing = names.filter(name => !out.has(name));
  if (missing.length) throw new Error(`uv archive is missing ${missing.join(', ')}`);
  return out;
}
