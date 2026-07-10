import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveClaudeBin, pathWithNativeBin, isExecutableFile } from '../../src/session/claude-bin';

// Exercised against real temp dirs so the executable-file checks run for real.
describe('resolveClaudeBin', () => {
  let dir: string;

  const mkExec = (p: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcb-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves bare `claude` from PATH when present', () => {
    const binDir = path.join(dir, 'pathbin');
    mkExec(path.join(binDir, 'claude'));
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);

    const r = resolveClaudeBin({ PATH: binDir }, home);
    expect(r.bin).toBe('claude');
    expect(r.source).toBe('PATH');
  });

  it('falls back to the native ~/.local/bin/claude symlink when not on PATH', () => {
    const home = path.join(dir, 'home');
    const nativeBin = path.join(home, '.local', 'bin', 'claude');
    mkExec(nativeBin);

    const r = resolveClaudeBin({ PATH: path.join(dir, 'empty') }, home);
    expect(r.bin).toBe(nativeBin);
    expect(r.source).toBe('native-bin');
  });

  it('falls back to the newest native version dir (numeric-aware)', () => {
    const home = path.join(dir, 'home');
    const versions = path.join(home, '.local', 'share', 'claude', 'versions');
    mkExec(path.join(versions, '2.1.99', 'claude'));
    mkExec(path.join(versions, '2.1.206', 'claude'));

    const r = resolveClaudeBin({ PATH: '' }, home);
    expect(r.source).toBe('native-versions');
    expect(r.bin).toBe(path.join(versions, '2.1.206', 'claude'));
  });

  it('resolves a native version stored as a bare file (versions/<ver>)', () => {
    const home = path.join(dir, 'home');
    const versions = path.join(home, '.local', 'share', 'claude', 'versions');
    mkExec(path.join(versions, '2.1.206'));

    const r = resolveClaudeBin({ PATH: '' }, home);
    expect(r.source).toBe('native-versions');
    expect(r.bin).toBe(path.join(versions, '2.1.206'));
  });

  it('falls back to the legacy npm-under-nvm path', () => {
    const home = path.join(dir, 'home');
    const legacy = path.join(home, '.nvm', 'versions', 'node', 'v22.22.3', 'bin', 'claude');
    mkExec(legacy);

    const r = resolveClaudeBin({ PATH: '' }, home);
    expect(r.source).toBe('legacy-npm');
    expect(r.bin).toBe(legacy);
  });

  it('returns fallback `claude` with the searched paths when nothing resolves', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);

    const r = resolveClaudeBin({ PATH: path.join(dir, 'nope') }, home);
    expect(r.bin).toBe('claude');
    expect(r.source).toBe('fallback');
    expect(r.searched).toContain('claude (PATH)');
    expect(r.searched.length).toBeGreaterThanOrEqual(4);
  });

  it('ignores a non-executable `claude` on PATH', () => {
    const binDir = path.join(dir, 'pathbin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'claude'), 'plain'); // no +x bit
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);

    const r = resolveClaudeBin({ PATH: binDir }, home);
    expect(r.source).toBe('fallback');
  });
});

describe('pathWithNativeBin', () => {
  let dir: string;

  const mkExec = (p: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwnb-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prepends ~/.local/bin when it holds an executable claude', () => {
    const home = path.join(dir, 'home');
    mkExec(path.join(home, '.local', 'bin', 'claude'));

    const result = pathWithNativeBin(home, '/usr/bin');
    expect(result).toBe(`${path.join(home, '.local', 'bin')}${path.delimiter}/usr/bin`);
  });

  it('returns the original PATH unchanged when there is no native install', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);

    expect(pathWithNativeBin(home, '/usr/bin')).toBe('/usr/bin');
  });
});

describe('isExecutableFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exe-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is false for a directory, a missing path, and a non-executable file', () => {
    const subdir = path.join(dir, 'sub');
    fs.mkdirSync(subdir);
    const plain = path.join(dir, 'plain');
    fs.writeFileSync(plain, 'x');

    expect(isExecutableFile(subdir)).toBe(false);
    expect(isExecutableFile(path.join(dir, 'missing'))).toBe(false);
    expect(isExecutableFile(plain)).toBe(false);
  });
});
