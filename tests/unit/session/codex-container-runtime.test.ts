import { execFileSync } from 'child_process';
import { resolveCodexRuntime } from '../../../src/session/codex-runtime';
import { assertLocalCodexDocker, assertCodexRuntimeInspection, inspectedCodexRuntime, CODEX_RUNTIME_LABEL, CODEX_CONTAINER_BIN } from '../../../src/session/codex-container-runtime';
jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('../../../src/session/codex-runtime', () => ({ resolveCodexRuntime: jest.fn() }));
const runtime: any = { fingerprint: 'hash', mounts: [{ source: '/native/codex', target: CODEX_CONTAINER_BIN, readOnly: true }] };
let savedHost: string | undefined, savedContext: string | undefined;
beforeEach(() => {
  savedHost = process.env.DOCKER_HOST; savedContext = process.env.DOCKER_CONTEXT;
  delete process.env.DOCKER_HOST; delete process.env.DOCKER_CONTEXT;
  (execFileSync as jest.Mock).mockReset().mockImplementation((_bin, args) => JSON.stringify(args[0] === 'context' ? [{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }] : { OSType: 'linux', Architecture: process.arch }));
  (resolveCodexRuntime as jest.Mock).mockReset().mockReturnValue(runtime);
});
afterEach(() => { if (savedHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = savedHost; if (savedContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = savedContext; });
test('requires local matching Linux Docker; no mutation commands', () => {
  expect(() => assertLocalCodexDocker()).not.toThrow();
  expect((execFileSync as jest.Mock).mock.calls.map(c => c[1][0])).toEqual(['context', 'info']);
});
test.each(['ssh://host', 'tcp://127.0.0.1:2375'])('refuses nonlocal endpoint %s', host => {
  process.env.DOCKER_HOST = host;
  expect(() => assertLocalCodexDocker()).toThrow('local Linux Docker');
  expect(execFileSync).not.toHaveBeenCalled();
});
test.each([{ OSType: 'linux', Architecture: 'unsupported' }, { OSType: 'linux', Architecture: process.arch, OperatingSystem: 'Docker Desktop' }])('rejects incompatible daemon %j', info => {
  process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
  (execFileSync as jest.Mock).mockReturnValue(JSON.stringify(info));
  expect(() => assertLocalCodexDocker()).toThrow('unsupported');
});
test('DOCKER_CONTEXT takes precedence over DOCKER_HOST', () => {
  process.env.DOCKER_CONTEXT = 'remote'; process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
  (execFileSync as jest.Mock).mockReturnValue(JSON.stringify([{ Endpoints: { docker: { Host: 'ssh://remote' } } }]));
  expect(() => assertLocalCodexDocker()).toThrow();
});
function inspection() { return { Config: { Labels: { [CODEX_RUNTIME_LABEL]: 'hash' } }, Mounts: [{ Type: 'bind', Source: '/native/codex', Destination: CODEX_CONTAINER_BIN, RW: false }] }; }
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
