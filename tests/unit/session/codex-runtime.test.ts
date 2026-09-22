import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { resolveCodexRuntime, CODEX_CONTAINER_EXECUTABLE } from '../../../src/session/codex-runtime';

let mockHomeDir: string | undefined;
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => mockHomeDir ?? actual.homedir() };
});

describe('optional host Codex runtime', () => {
  let root: string;
  let previousPath: string | undefined;
  function file(relative: string, contents: string | Buffer = '#!/bin/sh\n'): string {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents, { mode: 0o755 });
    return filename;
  }
  function native(relative: string, machine = process.arch === 'arm64' ? 183 : 62): string {
    const bytes = Buffer.alloc(64);
    bytes.set([127, 69, 76, 70, 2, 1]); bytes.writeUInt16LE(machine, 18);
    return file(relative, bytes);
  }
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex runtime ')); previousPath = process.env.PATH; process.env.PATH = path.join(root, 'empty'); mockHomeDir = path.join(root, 'home'); });
  afterEach(() => { mockHomeDir = undefined; if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; fs.rmSync(root, { recursive: true, force: true }); });
  test('restricted service PATH discovers the standalone user install without executing it', () => {
    const chosen = native('release/bin/codex');
    const link = path.join(root, 'home/.local/bin/codex');
    fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(chosen, link);
    const runtime = resolveCodexRuntime();
    expect(runtime.executable).toBe(chosen);
    expect(runtime.nativeExecutable).toBe(chosen);
    expect(runtime.containerError).toBeUndefined();
    expect(runtime.mounts).toEqual([{ source: chosen, target: CODEX_CONTAINER_EXECUTABLE, readOnly: true }]);
  });
  test('PATH and explicit selections take precedence over the user install', () => {
    native('home/.local/bin/codex');
    const chosen = native('path/bin/codex'); process.env.PATH = path.dirname(chosen);
    expect(resolveCodexRuntime().executable).toBe(chosen);
    const explicit = native('explicit/bin/codex');
    expect(resolveCodexRuntime(explicit).executable).toBe(explicit);
    process.env.PATH = path.join(root, 'empty');
    expect(() => resolveCodexRuntime('codex')).toThrow(/missing/);
    expect(() => resolveCodexRuntime('custom-codex')).toThrow(/missing/);
    expect(() => resolveCodexRuntime(path.join(root, 'missing'))).toThrow(/missing/);
  });
  test('nonexecutable and dangling user installs do not resolve', () => {
    const candidate = native('home/.local/bin/codex'); fs.chmodSync(candidate, 0o644);
    expect(() => resolveCodexRuntime()).toThrow(/not executable/);
    fs.unlinkSync(candidate); fs.symlinkSync(path.join(root, 'missing'), candidate);
    expect(() => resolveCodexRuntime()).toThrow(/missing/);
  });
  test('missing Codex fails with operator instructions without installing anything', () => {
    expect(() => resolveCodexRuntime()).toThrow(/Install Codex.*workers.codex.bin/);
  });
  test('explicit executable wins over PATH and resolves symlinks and spaces', () => {
    const chosen = native('chosen version/bin/codex');
    native('path/bin/codex'); process.env.PATH = path.join(root, 'path/bin');
    const link = path.join(root, 'linked codex'); fs.symlinkSync(chosen, link);
    expect(resolveCodexRuntime(link).executable).toBe(chosen);
    expect(resolveCodexRuntime().executable).toBe(path.join(root, 'path/bin/codex'));
    expect(() => resolveCodexRuntime(path.join(root, 'absent'))).toThrow(/missing/);
  });
  test('relative explicit executables resolve against the worker workspace without PATH fallback', () => {
    const chosen = native('agent workspace/bin/codex');
    native('path/bin/codex'); process.env.PATH = path.join(root, 'path/bin');
    expect(resolveCodexRuntime('./bin/codex', path.join(root, 'agent workspace')).executable).toBe(chosen);
    process.env.PATH = './bin';
    expect(resolveCodexRuntime(undefined, path.join(root, 'agent workspace')).executable).toBe(chosen);
    process.env.PATH = path.join(root, 'path/bin');
    expect(() => resolveCodexRuntime('./bin/codex', path.join(root, 'other workspace'))).toThrow(/missing/);
  });
  test('nonexecutable files and directories cannot resolve', () => {
    const chosen = native('codex'); fs.chmodSync(chosen, 0o644);
    expect(() => resolveCodexRuntime(chosen)).toThrow(/not executable/);
    expect(() => resolveCodexRuntime(root)).toThrow(/not executable/);
  });
  test('standalone mounts only known runtime resources read-only, never parent or personal state', () => {
    const chosen = native('release/bin/codex'); native('release/bin/codex-code-mode-host');
    file('release/codex-path/rg'); file('release/codex-resources/runtime.json', '{}');
    file('release/auth.json', 'private'); file('release/sessions/private', 'private'); file('release/bin/unrelated');
    const runtime = resolveCodexRuntime(chosen);
    expect(runtime.containerError).toBeUndefined();
    expect(runtime.nativeSha256).toBe(createHash('sha256').update(fs.readFileSync(chosen)).digest('hex'));
    expect(runtime.mounts.map(m => m.target)).toEqual([CODEX_CONTAINER_EXECUTABLE, '/opt/gateway-codex/bin/codex-code-mode-host', '/opt/gateway-codex/codex-path', '/opt/gateway-codex/codex-resources']);
    expect(runtime.mounts.every(m => m.readOnly)).toBe(true);
    expect(runtime.mounts.some(m => m.source === path.join(root, 'release'))).toBe(false);
  });
  test.each([true, false])('npm optional package and bundled vendor resolve native plus resources (optional=%s)', optional => {
    const launcher = file('node_modules/@openai/codex/bin/codex.js', '#!/usr/bin/env node\n');
    file('node_modules/@openai/codex/package.json', JSON.stringify({ name: '@openai/codex' }));
    const packageRoot = optional ? `node_modules/@openai/codex-linux-${process.arch}` : 'node_modules/@openai/codex';
    if (optional) file(`${packageRoot}/package.json`, JSON.stringify({ name: `@openai/codex-linux-${process.arch}` }));
    const triple = process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
    const chosen = native(`${packageRoot}/vendor/${triple}/bin/codex`);
    file(`${packageRoot}/vendor/${triple}/codex-path/rg`);
    const runtime = resolveCodexRuntime(launcher);
    expect(runtime.executable).toBe(launcher);
    expect(runtime.nativeExecutable).toBe(chosen);
    expect(runtime.containerError).toBeUndefined();
    expect(runtime.fingerprint).toBe(resolveCodexRuntime(chosen).fingerprint);
    expect(runtime.mounts).toEqual(resolveCodexRuntime(chosen).mounts);
  });
  test('host launchers remain usable while incompatible app runtimes fail explicitly', () => {
    const wrapper = file('custom-wrapper');
    expect(resolveCodexRuntime(wrapper)).toMatchObject({ executable: wrapper, mounts: [], containerError: expect.stringContaining('cannot be mounted') });
    const wrongArch = native('wrong/bin/codex', process.arch === 'arm64' ? 62 : 183);
    expect(resolveCodexRuntime(wrongArch).containerError).toBeDefined();
  });
  test('symlinked resources never expose an unrelated directory', () => {
    const chosen = native('release/bin/codex'); file('private/auth.json', 'secret');
    fs.symlinkSync(path.join(root, 'private'), path.join(root, 'release/codex-resources'));
    expect(resolveCodexRuntime(chosen)).toMatchObject({ mounts: [], containerError: expect.stringContaining('link outside') });
  });
  test('nested resource symlinks are rejected too', () => {
    const chosen = native('release/bin/codex'); file('release/codex-resources/manifest.json', '{}'); file('private/auth.json');
    fs.symlinkSync(path.join(root, 'private'), path.join(root, 'release/codex-resources/escape'));
    expect(resolveCodexRuntime(chosen).mounts).toEqual([]);
  });
  test('fingerprint changes when a runtime is replaced at the same path', () => {
    const chosen = native('release/bin/codex'); const before = resolveCodexRuntime(chosen).fingerprint;
    fs.appendFileSync(chosen, Buffer.from('upgrade'));
    expect(resolveCodexRuntime(chosen).fingerprint).not.toBe(before);
  });
});
