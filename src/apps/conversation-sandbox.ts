import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { AgentConfig } from '../types';
import { chatMemoryDirName } from '../agent/workspace-loader';
import { DIARY_FILENAME } from '../agent/skill-learning/notifier';
import { CODEX_RUNTIME_LABEL } from '../session/codex-container-runtime';

/**
 * Per-conversation sandbox containers for isolated app agents (#609).
 *
 * An app agent runs every conversation through `docker exec` into its one app
 * container, as one uid, with the whole workspace mounted read-write. Isolate
 * mode only kept conversations apart in the prompt: Bash in one conversation
 * could read another's chats/ files, its /tmp bridge ticket, its Claude Code
 * transcript in the shared HOME, or its processes. With isolate mode on, each
 * conversation instead executes in its own container, created from the app
 * container's image, user, environment and networks, but with its own PID
 * namespace, /tmp and HOME, and only these mounts:
 *
 * - the workspace entries that exist when it is created, read-only, except
 *   per-user and shared-state ones (see `workspaceEntryVisible`);
 * - `chats/<this conversation>/`, the only writable workspace path;
 * - this conversation's media directory;
 * - a HOME of its own on the host, outside the workspace;
 * - the task bridge's socket directory, read-only.
 *
 * Everything else is absent, so a path that appears later stays hidden until
 * the sandbox is recreated.
 */

// Resolve subprocess support only when a sandbox is used (tests replace child_process).
const exec = (file: string, args: string[], options: import('child_process').ExecFileOptions = {}) =>
  promisify(execFile)(file, args, { ...options, encoding: 'utf8' as const });
export const SANDBOX_LABEL = 'ai.claude-gateway.sandbox';
const BASE_LABEL = 'ai.claude-gateway.sandbox.base';
const SPEC_LABEL = 'ai.claude-gateway.sandbox.spec';
const NAME_PATTERN = /-c-[0-9a-f]{20}$/;
/** The bridge socket directory under the workspace, shared read-only with sandboxes. */
export const BRIDGE_SOCKET_DIR = '.orch';
const IDLE_MS = 30 * 60_000;
const REAP_INTERVAL_MS = 5 * 60_000;

/** The conversation one sandbox serves. An API chat holds many sessions, each with
 * its own media directory, so an API sandbox also names the session. */
export interface SandboxConversation { source: string; chatId: string; sessionId?: string }

export interface SandboxMount { source: string; target: string; readonly: boolean }

export function usesConversationSandbox(agent: Pick<AgentConfig, 'type' | 'container' | 'isolateMemory'>): boolean {
  return agent.type === 'app-agent' && Boolean(agent.container) && agent.isolateMemory === true;
}

export function isSandboxContainerName(name: string | undefined): boolean {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

export function sandboxContainerName(agent: Pick<AgentConfig, 'id' | 'container'>, conversation: SandboxConversation): string {
  if (!agent.container) throw new Error('CONTAINER_REQUIRED');
  if (!conversation.chatId) throw new Error('SANDBOX_CONVERSATION_REQUIRED');
  if (conversation.source === 'api' && !conversation.sessionId) throw new Error('SANDBOX_CONVERSATION_REQUIRED');
  const key = [agent.id, conversation.source, conversation.chatId, ...(conversation.source === 'api' ? [conversation.sessionId!] : [])].join('\0');
  return `${agent.container}-c-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

/** The agent config whose `container` is this conversation's sandbox. */
export async function sandboxedAgent<T extends AgentConfig>(agent: T, conversation: SandboxConversation): Promise<T> {
  return { ...agent, container: await sandboxPool.ensure(agent, conversation) };
}

const PRIVATE_ENTRIES = new Set(['chats', 'memory', 'media', 'MEMORY.md', 'USER.md', DIARY_FILENAME]);
/** Project-scoped Claude Code configuration an app may ship; the rest of `.claude/`
 * (for example subagent memory) can hold what earlier conversations wrote. */
export const CLAUDE_PROJECT_ENTRIES: ReadonlySet<string> = new Set(['skills', 'commands', 'agents', 'settings.json']);

/** Whether a workspace root entry is mounted (read-only) into a sandbox. Default
 * deny for anything per-user or gateway state: dot entries, conversation memory,
 * root memory files written before isolate mode, archives and media. */
export function workspaceEntryVisible(name: string): boolean {
  if (name.startsWith('.') || PRIVATE_ENTRIES.has(name)) return false;
  return !/\.(sqlite|db)(-wal|-shm|-journal)?$/i.test(name);
}

function plainEntry(file: string): 'file' | 'dir' | undefined {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return undefined;
  return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : undefined;
}

/** A directory the sandbox mounts read-write: created when absent, and refused when
 * it or its parent is a symlink, which Docker would follow on the host. */
function ownDirectory(dir: string): string {
  const parent = path.dirname(dir);
  for (const candidate of [parent, dir]) {
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('SANDBOX_PATH_DENIED');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (plainEntry(dir) !== 'dir') throw new Error('SANDBOX_PATH_DENIED');
  return dir;
}

/** The host directories one conversation's sandbox owns. */
export function sandboxPaths(agent: Pick<AgentConfig, 'workspace'>, conversation: SandboxConversation) {
  const agentDir = path.dirname(agent.workspace);
  const chatDir = chatMemoryDirName(conversation.source, conversation.chatId);
  const mediaName = conversation.source === 'api' ? `api-${conversation.sessionId}` : `${conversation.source}-${conversation.chatId}`;
  return {
    workspace: fs.realpathSync(agent.workspace),
    chat: chatDir,
    // Named like MediaStore.copyToMedia's directories; a chat id that is not one path
    // segment gets no media directory rather than one outside its own.
    media: /^[^/\\\0]+$/.test(mediaName) && mediaName !== '.' && mediaName !== '..' ? path.join(agentDir, 'media', mediaName) : undefined,
    home: path.join(agentDir, 'sandbox-homes', chatDir),
  };
}

/** The mounts of one conversation's sandbox. `toolMounts` are the app container's
 * read-only runtime mounts (CLI, node, seed, Codex). */
export function sandboxMounts(agent: Pick<AgentConfig, 'workspace'>, conversation: SandboxConversation, toolMounts: SandboxMount[]): SandboxMount[] {
  const paths = sandboxPaths(agent, conversation);
  const mounts: SandboxMount[] = toolMounts.filter(m => m.readonly && m.target !== '/workspace' && !m.target.startsWith('/workspace/') && m.target !== homedir());
  for (const name of fs.readdirSync(paths.workspace).sort()) {
    if (!workspaceEntryVisible(name)) continue;
    const source = path.join(paths.workspace, name);
    if (plainEntry(source)) mounts.push({ source, target: `/workspace/${name}`, readonly: true });
  }
  const claudeDir = path.join(paths.workspace, '.claude');
  if (plainEntry(claudeDir) === 'dir') {
    for (const name of [...CLAUDE_PROJECT_ENTRIES].sort()) {
      const source = path.join(claudeDir, name);
      if (plainEntry(source)) mounts.push({ source, target: `/workspace/.claude/${name}`, readonly: true });
    }
  }
  mounts.push({ source: ownDirectory(path.join(paths.workspace, BRIDGE_SOCKET_DIR)), target: `/workspace/${BRIDGE_SOCKET_DIR}`, readonly: true });
  mounts.push({ source: ownDirectory(path.join(paths.workspace, 'chats', paths.chat)), target: `/workspace/chats/${paths.chat}`, readonly: false });
  if (paths.media) mounts.push({ source: ownDirectory(paths.media), target: paths.media, readonly: false });
  mounts.push({ source: ownDirectory(paths.home), target: homedir(), readonly: false });
  for (const m of mounts) if (/[,"\n]/.test(m.source + m.target)) throw new Error('SANDBOX_PATH_DENIED');
  return mounts;
}

/** `docker create` arguments for a sandbox of `base` (a `docker inspect` record).
 * Environment values travel by name only (see process.ts), never on the argv. */
export function sandboxCreateArgs(name: string, base: any, mounts: SandboxMount[], spec: string, extraLabels: Record<string, string> = {}): string[] {
  const config = base.Config ?? {}, host = base.HostConfig ?? {};
  const networks = Object.keys(base.NetworkSettings?.Networks ?? {});
  const entrypoint: string[] = Array.isArray(config.Entrypoint) ? config.Entrypoint : [];
  const cmd: string[] = Array.isArray(config.Cmd) ? config.Cmd : [];
  return [
    'create', '--name', name,
    '--label', `${SANDBOX_LABEL}=1`, '--label', `${BASE_LABEL}=${base.Name?.replace(/^\//, '') ?? ''}`, '--label', `${SPEC_LABEL}=${spec}`,
    ...Object.entries(extraLabels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    ...(config.User ? ['--user', String(config.User)] : []),
    '--workdir', '/workspace', '--restart', 'no',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...(networks[0] ? ['--network', networks[0]] : ['--network', 'none']),
    ...(host.Memory ? ['--memory', String(host.Memory)] : []),
    ...(host.NanoCpus ? ['--cpus', String(host.NanoCpus / 1e9)] : []),
    ...(host.PidsLimit ? ['--pids-limit', String(host.PidsLimit)] : []),
    ...envNames(config.Env).flatMap(k => ['--env', k]),
    ...mounts.flatMap(m => ['--mount', `type=bind,source=${m.source},target=${m.target}${m.readonly ? ',readonly' : ''}`]),
    ...(entrypoint.length ? ['--entrypoint', entrypoint[0]] : []),
    base.Image,
    ...entrypoint.slice(1), ...cmd,
  ];
}

function envNames(env: unknown): string[] {
  return Array.isArray(env) ? env.map(e => String(e).split('=')[0]).filter(k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) : [];
}

function envValues(env: unknown): Record<string, string> {
  const values: Record<string, string> = {};
  if (Array.isArray(env)) for (const e of env) { const i = String(e).indexOf('='); if (i > 0) values[String(e).slice(0, i)] = String(e).slice(i + 1); }
  return values;
}

async function inspect(name: string): Promise<any | undefined> {
  try { return JSON.parse((await exec('docker', ['inspect', '--type', 'container', name], { timeout: 10_000 })).stdout)[0]; }
  catch (error: any) { if (/No such (object|container)/i.test(String(error?.stderr ?? error?.message))) return undefined; throw error; }
}

/** Processes other than the sandbox's init: a running session or tool. */
async function busy(name: string): Promise<boolean> {
  try { return (await exec('docker', ['top', name, '-eo', 'pid'], { timeout: 10_000 })).stdout.trim().split('\n').length > 2; }
  catch { return false; }
}

class SandboxPool {
  private readonly pending = new Map<string, Promise<string>>();
  private readonly used = new Map<string, number>();
  private readonly started = Date.now();
  private timer?: ReturnType<typeof setInterval>;

  /** The running sandbox of this conversation, created or recreated as needed. */
  ensure(agent: AgentConfig, conversation: SandboxConversation): Promise<string> {
    if (!usesConversationSandbox(agent)) throw new Error('SANDBOX_NOT_APPLICABLE');
    const name = sandboxContainerName(agent, conversation);
    this.used.set(name, Date.now());
    this.timer ??= setInterval(() => { void this.reap().catch(() => {}); }, REAP_INTERVAL_MS);
    this.timer.unref?.();
    const previous = this.pending.get(name) ?? Promise.resolve('');
    const next = previous.catch(() => '').then(() => this.converge(agent, conversation, name));
    this.pending.set(name, next);
    void next.finally(() => { if (this.pending.get(name) === next) this.pending.delete(name); }).catch(() => {});
    return next;
  }

  private async converge(agent: AgentConfig, conversation: SandboxConversation, name: string): Promise<string> {
    const base = await inspect(agent.container!);
    if (!base?.State?.Running) throw new Error('CONTAINER_REQUIRED');
    const toolMounts: SandboxMount[] = (base.Mounts ?? []).filter((m: any) => m.Type === 'bind' && !m.RW).map((m: any) => ({ source: m.Source, target: m.Destination, readonly: true }));
    const mounts = sandboxMounts(agent, conversation, toolMounts);
    const labels: Record<string, string> = base.Config?.Labels?.[CODEX_RUNTIME_LABEL] ? { [CODEX_RUNTIME_LABEL]: String(base.Config.Labels[CODEX_RUNTIME_LABEL]) } : {};
    // Inode numbers: a directory deleted and recreated (for example by /clear) is a
    // different mount source, which a running sandbox would still hold the old one of.
    const inodes = mounts.map(m => fs.statSync(m.source, { throwIfNoEntry: false })?.ino ?? 0);
    const spec = createHash('sha256').update(JSON.stringify([sandboxCreateArgs(name, base, mounts, '', labels), envValues(base.Config?.Env), inodes])).digest('hex').slice(0, 32);
    const existing = await inspect(name);
    if (existing && existing.Config?.Labels?.[SANDBOX_LABEL] !== '1') throw new Error('SANDBOX_NAME_CONFLICT');
    if (existing && existing.Config?.Labels?.[SPEC_LABEL] === spec) {
      if (!existing.State?.Running) await exec('docker', ['start', name], { timeout: 30_000 });
      return name;
    }
    // A sandbox from an older spec keeps serving the processes already running in it;
    // it is replaced once it is idle.
    if (existing && existing.State?.Running && await busy(name)) return name;
    if (existing) await exec('docker', ['rm', '-f', name], { timeout: 30_000 });
    await exec('docker', sandboxCreateArgs(name, base, mounts, spec, labels), { timeout: 60_000, env: { ...process.env, ...envValues(base.Config?.Env) } });
    try {
      for (const network of Object.keys(base.NetworkSettings?.Networks ?? {}).slice(1)) await exec('docker', ['network', 'connect', network, name], { timeout: 30_000 });
      await exec('docker', ['start', name], { timeout: 30_000 });
    } catch (error) {
      await exec('docker', ['rm', '-f', name], { timeout: 30_000 }).catch(() => {});
      throw error;
    }
    return name;
  }

  /** Remove sandboxes that ran nothing for IDLE_MS. One this gateway process has not
   * used counts from its start, so a restart also clears the previous run's. */
  async reap(now = Date.now()): Promise<void> {
    const { stdout } = await exec('docker', ['ps', '-a', '--filter', `label=${SANDBOX_LABEL}=1`, '--format', '{{.Names}}'], { timeout: 10_000 });
    for (const name of stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
      if (this.pending.has(name) || now - (this.used.get(name) ?? this.started) < IDLE_MS || await busy(name)) continue;
      await exec('docker', ['rm', '-f', name], { timeout: 30_000 }).catch(() => {});
      this.used.delete(name);
    }
  }

  /** Remove every sandbox of an app container (uninstall). */
  async removeFor(baseContainer: string): Promise<void> {
    const { stdout } = await exec('docker', ['ps', '-aq', '--filter', `label=${BASE_LABEL}=${baseContainer}`], { timeout: 10_000 });
    const ids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
    if (ids.length) await exec('docker', ['rm', '-f', ...ids], { timeout: 60_000 });
  }
}

export const sandboxPool = new SandboxPool();
