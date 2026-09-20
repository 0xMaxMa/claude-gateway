import { execFile, execFileSync } from 'child_process';
import { resolveCodexRuntime } from '../../../src/session/codex-runtime';
import { assertLocalCodexDocker, inspectSelectedCodexRuntime, assertCodexRuntimeInspection, inspectedCodexRuntime, CODEX_RUNTIME_LABEL, CODEX_CONTAINER_BIN } from '../../../src/session/codex-container-runtime';
jest.mock('child_process', () => ({ execFile: jest.fn(), execFileSync: jest.fn() }));
jest.mock('../../../src/session/codex-runtime', () => ({ resolveCodexRuntime: jest.fn() }));
const runtime: any = { fingerprint: 'hash', mounts: [{ source: '/native/codex', target: CODEX_CONTAINER_BIN, readOnly: true }] };
let savedHost: string | undefined, savedContext: string | undefined;
beforeEach(() => {
  savedHost = process.env.DOCKER_HOST; savedContext = process.env.DOCKER_CONTEXT;
  delete process.env.DOCKER_HOST; delete process.env.DOCKER_CONTEXT;
  (execFile as unknown as jest.Mock).mockReset().mockImplementation((_bin, args, _options, callback) => callback(null, JSON.stringify(args[0] === 'context' ? [{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }] : args[0] === 'inspect' ? [inspection()] : { OSType: 'linux', Architecture: process.arch })));
  (resolveCodexRuntime as jest.Mock).mockReset().mockReturnValue(runtime);
});
afterEach(() => { if (savedHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = savedHost; if (savedContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = savedContext; });
test('requires local matching Linux Docker; no mutation commands', async () => {
  await expect(assertLocalCodexDocker()).resolves.toBeUndefined();
  expect((execFile as unknown as jest.Mock).mock.calls.map(c => c[1][0])).toEqual(['context', 'info']);
});
test.each(['ssh://host', 'tcp://127.0.0.1:2375'])('refuses nonlocal endpoint %s', async host => {
  process.env.DOCKER_HOST = host;
  await expect(assertLocalCodexDocker()).rejects.toThrow('local Linux Docker');
  expect(execFile).not.toHaveBeenCalled();
});
test.each([{ OSType: 'linux', Architecture: 'unsupported' }, { OSType: 'linux', Architecture: process.arch, OperatingSystem: 'Docker Desktop' }])('rejects incompatible daemon %j', async info => {
  process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
  (execFile as unknown as jest.Mock).mockImplementation((_bin, _args, _options, callback) => callback(null, JSON.stringify(info)));
  await expect(assertLocalCodexDocker()).rejects.toThrow('unsupported');
});
test('DOCKER_CONTEXT takes precedence over DOCKER_HOST', async () => {
  process.env.DOCKER_CONTEXT = 'remote'; process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
  (execFile as unknown as jest.Mock).mockImplementation((_bin, _args, _options, callback) => callback(null, JSON.stringify([{ Endpoints: { docker: { Host: 'ssh://remote' } } }])));
  await expect(assertLocalCodexDocker()).rejects.toThrow();
});
function inspection() { return { Id: 'container-id', Config: { Labels: { [CODEX_RUNTIME_LABEL]: 'hash' } }, Mounts: [{ Type: 'bind', Source: '/native/codex', Destination: CODEX_CONTAINER_BIN, RW: false }] }; }
test('matches selected runtime and strict read-only mount identity', () => {
  expect(() => assertCodexRuntimeInspection(inspection(), runtime)).not.toThrow();
  for (const patch of [{ RW: true }, { Source: '/other/codex' }, { Type: 'volume' }]) {
    const c = inspection(); Object.assign(c.Mounts[0], patch);
    expect(() => assertCodexRuntimeInspection(c, runtime)).toThrow('refresh-runtime');
  }
  const c = inspection(); c.Config.Labels[CODEX_RUNTIME_LABEL] = 'old';
  expect(() => assertCodexRuntimeInspection(c, runtime)).toThrow('STALE');
});
test('admission derives only validated resource allowlist from the native file, not a label', () => {
  expect(inspectedCodexRuntime(inspection())).toBe(runtime);
  expect(resolveCodexRuntime).toHaveBeenCalledWith('/native/codex');
  expect(inspectedCodexRuntime({ Mounts: [] })).toBeUndefined();
  (resolveCodexRuntime as jest.Mock).mockReturnValue({ containerError: 'unrecognized binary' });
  expect(() => inspectedCodexRuntime(inspection())).toThrow('MOUNT_DENIED');
});

test('returns the inspected immutable container ID after runtime validation', async () => {
  await expect(inspectSelectedCodexRuntime({ container: 'app-agent' } as any, runtime)).resolves.toBe('container-id');
  expect(execFile).toHaveBeenLastCalledWith('docker', ['inspect', 'app-agent'], expect.objectContaining({ timeout: 10000, maxBuffer: 1024 * 1024 }), expect.any(Function));
});

test('rejects inspection without an immutable container ID', async () => {
  (execFile as unknown as jest.Mock).mockImplementation((_bin, args, _options, callback) => callback(null, JSON.stringify(args[0] === 'context' ? [{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }] : args[0] === 'inspect' ? [{ ...inspection(), Id: '' }] : { OSType: 'linux', Architecture: process.arch })));
  await expect(inspectSelectedCodexRuntime({ container: 'app-agent' } as any, runtime)).rejects.toThrow('cannot inspect');
});

test('gateway timers progress while Docker is pending', async () => {
  process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
  let finishDocker!: (error: Error | null, stdout: string) => void;
  (execFile as unknown as jest.Mock).mockImplementation((_bin, _args, _options, callback) => { finishDocker = callback; });
  let complete = false;
  (execFileSync as unknown as jest.Mock).mockImplementation(() => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    return JSON.stringify({ OSType: 'linux', Architecture: process.arch });
  });
  const preflight = Promise.resolve(assertLocalCodexDocker()).then(() => { complete = true; });
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  expect(complete).toBe(false);
  finishDocker(null, JSON.stringify({ OSType: 'linux', Architecture: process.arch }));
  await preflight;
  expect(complete).toBe(true);
});

test('timeout errors reject preflight with bounded subprocess options', async () => {
  process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
  (execFile as unknown as jest.Mock).mockImplementation((_bin, _args, _options, callback) => {
    setTimeout(() => callback(Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' }), ''), 0);
  });
  await expect(assertLocalCodexDocker()).rejects.toThrow('CODEX_CONTAINER_RUNTIME_UNAVAILABLE');
  expect(execFile).toHaveBeenCalledWith('docker', ['info', '--format', '{{json .}}'], expect.objectContaining({ timeout: 5000, maxBuffer: 256 * 1024 }), expect.any(Function));
});
