/**
 * The pinned uv a sidecar's `uvx` command falls back to: verified against a fixed
 * sha256 before anything is written, installed once, and never on a platform the
 * table does not cover.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deflateRawSync } from 'zlib';
import { readZipEntries, resolveUvCommand, UV_VERSION } from '../../src/connectors/uv-runtime';

/** A minimal zip archive: one local header + data per entry, a central directory, the end record. */
function zip(entries: Record<string, Buffer>, method: 0 | 8 = 8): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = method === 8 ? deflateRawSync(content) : content;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const WHEEL = zip({
  [`uv-${UV_VERSION}.dist-info/METADATA`]: Buffer.from('Name: uv'),
  [`uv-${UV_VERSION}.data/scripts/uv`]: Buffer.from('#!/bin/sh\necho uv\n'),
  [`uv-${UV_VERSION}.data/scripts/uvx`]: Buffer.from('#!/bin/sh\necho uvx\n'),
});
const WHEEL_SHA = createHash('sha256').update(WHEEL).digest('hex');

let root: string;
let empty: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-uv-'));
  empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-uv-path-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

function fakeFetch(body: Buffer): jest.Mock {
  return jest.fn(async () => new Response(new Uint8Array(body)));
}

const linux = (sha256: string, fetchImpl: jest.Mock) => ({
  installRoot: root,
  searchPath: empty,
  platform: 'linux' as const,
  arch: 'x64',
  wheels: { 'linux-x64': { url: 'https://files.example/uv.whl', sha256 } },
  fetchImpl: fetchImpl as unknown as typeof fetch,
});

it('installs uv and uvx from a wheel whose sha256 matches', async () => {
  const fetchImpl = fakeFetch(WHEEL);
  const uvx = await resolveUvCommand('uvx', linux(WHEEL_SHA, fetchImpl));
  expect(uvx).toBe(path.join(root, `uv-${UV_VERSION}`, 'bin', 'uvx'));
  expect(fs.readFileSync(uvx, 'utf8')).toBe('#!/bin/sh\necho uvx\n');
  expect(fs.statSync(uvx).mode & 0o111).toBeTruthy();
  expect(fs.existsSync(path.join(root, `uv-${UV_VERSION}`, 'bin', 'uv'))).toBe(true);
  expect(fetchImpl).toHaveBeenCalledWith('https://files.example/uv.whl', expect.objectContaining({ redirect: 'error' }));
  // Installed once; later resolutions reuse it.
  await resolveUvCommand('uv', linux(WHEEL_SHA, fetchImpl));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('fails closed on a sha256 mismatch: nothing is installed and the lock is released', async () => {
  const tampered = zip({
    [`uv-${UV_VERSION}.data/scripts/uv`]: Buffer.from('#!/bin/sh\necho owned\n'),
    [`uv-${UV_VERSION}.data/scripts/uvx`]: Buffer.from('#!/bin/sh\necho owned\n'),
  });
  await expect(resolveUvCommand('uvx', linux(WHEEL_SHA, fakeFetch(tampered)))).rejects.toThrow(`uv download sha256 mismatch: expected ${WHEEL_SHA}`);
  expect(fs.readdirSync(path.join(root, `uv-${UV_VERSION}`))).toEqual([]);
  // A correct download afterwards still installs.
  await expect(resolveUvCommand('uvx', linux(WHEEL_SHA, fakeFetch(WHEEL)))).resolves.toContain('/bin/uvx');
});

it('shares one download between concurrent starts', async () => {
  const fetchImpl = fakeFetch(WHEEL);
  const results = await Promise.all([resolveUvCommand('uvx', linux(WHEEL_SHA, fetchImpl)), resolveUvCommand('uv', linux(WHEEL_SHA, fetchImpl))]);
  expect(results.map(p => path.basename(p))).toEqual(['uvx', 'uv']);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('uses a uv already on the search path without downloading', async () => {
  const existing = path.join(empty, 'uvx');
  fs.writeFileSync(existing, '#!/bin/sh\n', { mode: 0o755 });
  const fetchImpl = fakeFetch(WHEEL);
  await expect(resolveUvCommand('uvx', linux(WHEEL_SHA, fetchImpl))).resolves.toBe(existing);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('never downloads on a platform without a pinned wheel', async () => {
  const fetchImpl = fakeFetch(WHEEL);
  await expect(resolveUvCommand('uvx', { ...linux(WHEEL_SHA, fetchImpl), platform: 'darwin', arch: 'arm64' }))
    .rejects.toThrow(`uvx is not on PATH and the gateway installs uv only on Linux x64/arm64; install uv ${UV_VERSION} on this host`);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('reads stored and deflated zip entries and reports missing ones', () => {
  const stored = zip({ a: Buffer.from('one') }, 0);
  expect(readZipEntries(stored, ['a']).get('a')!.toString()).toBe('one');
  expect(() => readZipEntries(stored, ['a', 'b'])).toThrow('uv archive is missing b');
  expect(() => readZipEntries(Buffer.from('not a zip at all, padded to more than twenty-two bytes'), ['a'])).toThrow('not a zip file');
});
