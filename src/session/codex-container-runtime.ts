import { execFileSync } from 'child_process';
import type { AgentConfig } from '../types';
import { resolveCodexRuntime, CodexRuntime } from './codex-runtime';

export const CODEX_RUNTIME_LABEL = 'ai.claude-gateway.codex-runtime';
export const CODEX_CONTAINER_BIN = '/opt/gateway-codex/bin/codex';
export const CODEX_RUNTIME_MAINTENANCE = 'Drain work and stop only the app agent service, then run claude-gateway app refresh-runtime APP_NAME. All agents sharing this container must select the same host Codex runtime.';

/** Bind sources belong to this host, never a remote Docker machine. */
export function assertLocalCodexDocker(): void {
  let endpoint = process.env.DOCKER_CONTEXT ? undefined : process.env.DOCKER_HOST;
  try {
    if (!endpoint) {
      const contexts = JSON.parse(execFileSync('docker', ['context', 'inspect'], { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 }));
      endpoint = contexts[0]?.Endpoints?.docker?.Host;
    }
    if (!endpoint?.startsWith('unix://')) throw new Error('remote');
    const info = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 }));
    const arch = info.Architecture === 'x86_64' ? 'x64' : info.Architecture === 'aarch64' ? 'arm64' : info.Architecture;
    if (/docker desktop/i.test(info.OperatingSystem ?? '') || /desktop-linux/i.test(process.env.DOCKER_CONTEXT ?? '') || process.platform !== 'linux' || info.OSType !== 'linux' || arch !== process.arch) throw new Error('incompatible');
  } catch {
    throw new Error('CODEX_CONTAINER_RUNTIME_UNAVAILABLE: host runtime mounts require a local Linux Docker daemon with the same CPU architecture. Remote Docker and Docker Desktop are unsupported.');
  }
}

/** Derive the narrow runtime allowlist from the native executable, never from labels.
 * Only validated executable/resource mounts qualify, not an arbitrary parent directory.
 * Task startup separately matches these against the operator-selected runtime. */
export function inspectedCodexRuntime(c: any): CodexRuntime | undefined {
  const native = (c.Mounts ?? []).filter((m: any) => m.Destination === CODEX_CONTAINER_BIN);
  if (!native.length) return undefined;
  if (native.length !== 1 || native[0].Type !== 'bind' || native[0].RW) throw new Error('CODEX_CONTAINER_RUNTIME_MOUNT_DENIED');
  const runtime = resolveCodexRuntime(native[0].Source);
  if (runtime.containerError) throw new Error('CODEX_CONTAINER_RUNTIME_MOUNT_DENIED');
  return runtime;
}

export function assertCodexRuntimeInspection(c: any, runtime: CodexRuntime): void {
  if (c.Config?.Labels?.[CODEX_RUNTIME_LABEL] !== runtime.fingerprint) {
    throw new Error(`CODEX_CONTAINER_RUNTIME_STALE: missing or changed host runtime. ${CODEX_RUNTIME_MAINTENANCE}`);
  }
  for (const mount of runtime.mounts) {
    const actual = (c.Mounts ?? []).filter((m: any) => m.Destination === mount.target);
    if (actual.length !== 1 || actual[0].Type !== 'bind' || actual[0].RW || actual[0].Source !== mount.source) {
      throw new Error(`CODEX_CONTAINER_RUNTIME_STALE: runtime mounts do not match the selected executable. ${CODEX_RUNTIME_MAINTENANCE}`);
    }
  }
}

/** Read-only preflight. Never refresh a container underneath active work. */
export function inspectSelectedCodexRuntime(agent: AgentConfig, runtime: CodexRuntime): void {
  if (runtime.containerError) throw new Error(`CODEX_CONTAINER_RUNTIME_UNAVAILABLE: ${runtime.containerError}`);
  assertLocalCodexDocker();
  let inspection: any;
  try {
    inspection = JSON.parse(execFileSync('docker', ['inspect', agent.container!], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }))[0];
  } catch { throw new Error('CODEX_CONTAINER_RUNTIME_UNAVAILABLE: cannot inspect the app agent container.'); }
  assertCodexRuntimeInspection(inspection, runtime);
}
