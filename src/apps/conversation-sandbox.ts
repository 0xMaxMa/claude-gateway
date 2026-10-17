import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { homedir } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { AgentConfig } from '../types';
import { chatMemoryDirName } from '../agent/workspace-loader';
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
 *   per-user and shared-state ones, and only the persona files among the root
 *   files (see `workspaceEntryVisible`);
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
const CONVERGED_MS = 5_000;

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

const PRIVATE_DIRS = new Set(['chats', 'memory', 'media']);
/** Project-scoped Claude Code configuration an app may ship; the rest of `.claude/`
 * (for example subagent memory) can hold what earlier conversations wrote. */
export const CLAUDE_PROJECT_ENTRIES: ReadonlySet<string> = new Set(['skills', 'commands', 'agents', 'settings.json']);

/** The root files a sandbox sees: the persona the gateway composes from. Any other
 * root file may be a note an agent wrote about a user before isolate mode. */
const PERSONA_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'HEARTBEAT.md']);

/** Whether a workspace root entry is mounted (read-only) into a sandbox. Default
 * deny: of the root files only the persona; of the directories none that is
 * per-user or gateway state (dot entries, conversation memory, notes, media). */
export function workspaceEntryVisible(name: string, kind: 'file' | 'dir'): boolean {
  if (kind === 'file') return PERSONA_FILES.has(name);
  return !name.startsWith('.') && !PRIVATE_DIRS.has(name);
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
    const source = path.join(paths.workspace, name);
    const kind = plainEntry(source);
    // A name the --mount syntax cannot carry is left out, not a reason to refuse the sandbox.
    if (kind && workspaceEntryVisible(name, kind) && !/[,"\n]/.test(name)) mounts.push({ source, target: `/workspace/${name}`, readonly: true });
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
 * Environment values travel in `envFile` (0600, removed after the create), never on
 * the argv, where any local user could read them from /proc. */
export function sandboxCreateArgs(name: string, base: any, mounts: SandboxMount[], spec: string, extraLabels: Record<string, string> = {}, envFile?: string): string[] {
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
    ...(envFile ? ['--env-file', envFile] : []),
    ...mounts.flatMap(m => ['--mount', `type=bind,source=${m.source},target=${m.target}${m.readonly ? ',readonly' : ''}`]),
    ...(entrypoint.length ? ['--entrypoint', entrypoint[0]] : []),
    base.Image,
    ...entrypoint.slice(1), ...cmd,
  ];
}

/** The app container's environment as `--env-file` lines. Docker's env file has no
 * multi-line values; such a variable is left out rather than split. */
export function sandboxEnvFile(env: unknown): string {
  return (Array.isArray(env) ? env.map(String) : []).filter(e => /^[A-Za-z_][A-Za-z0-9_]*=/.test(e) && !/[\r\n]/.test(e)).join('\n') + '\n';
}

async function inspect(name: string): Promise<any | undefined> {
  try { return JSON.parse((await exec('docker', ['inspect', '--type', 'container', name], { timeout: 10_000 })).stdout)[0]; }
  catch (error: any) { if (/No such (object|container)/i.test(String(error?.stderr ?? error?.message))) return undefined; throw error; }
}

/** A running session's hold on its conversation's sandbox: while any lease is held
 * the sandbox is neither reaped nor replaced. */
export interface SandboxLease { container: string; release(): void }

export class SandboxPool {
  /** Per-sandbox queue: create, replace and reap of one name never interleave. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly leases = new Map<string, number>();
  private readonly used = new Map<string, number>();
  /** When each sandbox was last converged: one turn opens it several times. */
  private readonly converged = new Map<string, number>();
  private readonly started = Date.now();
  private timer?: ReturnType<typeof setInterval>;

  /** The running sandbox of this conversation, for a short operation that holds no lease. */
  async ensure(agent: AgentConfig, conversation: SandboxConversation): Promise<string> {
    return (await this.open(agent, conversation, false)).container;
  }

  /** The running sandbox of this conversation, held until `release()`. */
  acquire(agent: AgentConfig, conversation: SandboxConversation): Promise<SandboxLease> {
    return this.open(agent, conversation, true);
  }

  private open(agent: AgentConfig, conversation: SandboxConversation, hold: boolean): Promise<SandboxLease> {
    if (!usesConversationSandbox(agent)) throw new Error('SANDBOX_NOT_APPLICABLE');
    const name = sandboxContainerName(agent, conversation);
    this.used.set(name, Date.now());
    this.timer ??= setInterval(() => { void this.reap().catch(() => {}); }, REAP_INTERVAL_MS);
    this.timer.unref?.();
    return this.serialize(name, async () => {
      if (Date.now() - (this.converged.get(name) ?? 0) >= CONVERGED_MS) {
        await this.converge(agent, conversation, name);
        this.converged.set(name, Date.now());
      }
      if (!hold) return { container: name, release: () => {} };
      this.leases.set(name, (this.leases.get(name) ?? 0) + 1);
      let released = false;
      return { container: name, release: () => {
        if (released) return;
        released = true;
        const left = (this.leases.get(name) ?? 1) - 1;
        if (left > 0) this.leases.set(name, left); else this.leases.delete(name);
        this.used.set(name, Date.now());
      } };
    });
  }

  private serialize<T>(name: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(name) ?? Promise.resolve()).catch(() => {}).then(task);
    this.queues.set(name, next);
    void next.finally(() => { if (this.queues.get(name) === next) this.queues.delete(name); }).catch(() => {});
    return next;
  }

  private async converge(agent: AgentConfig, conversation: SandboxConversation, name: string): Promise<void> {
    const base = await inspect(agent.container!);
    if (!base?.State?.Running) throw new Error('CONTAINER_REQUIRED');
    const toolMounts: SandboxMount[] = (base.Mounts ?? []).filter((m: any) => m.Type === 'bind' && !m.RW).map((m: any) => ({ source: m.Source, target: m.Destination, readonly: true }));
    const mounts = sandboxMounts(agent, conversation, toolMounts);
    const labels: Record<string, string> = base.Config?.Labels?.[CODEX_RUNTIME_LABEL] ? { [CODEX_RUNTIME_LABEL]: String(base.Config.Labels[CODEX_RUNTIME_LABEL]) } : {};
    const env = sandboxEnvFile(base.Config?.Env);
    // Inode numbers: a directory deleted and recreated (for example by /clear) is a
    // different mount source, which a running sandbox would still hold the old one of.
    const inodes = mounts.map(m => fs.statSync(m.source, { throwIfNoEntry: false })?.ino ?? 0);
    const spec = createHash('sha256').update(JSON.stringify([sandboxCreateArgs(name, base, mounts, '', labels), env, inodes])).digest('hex').slice(0, 32);
    const existing = await inspect(name);
    if (existing && existing.Config?.Labels?.[SANDBOX_LABEL] !== '1') throw new Error('SANDBOX_NAME_CONFLICT');
    // A sandbox from an older spec keeps serving the sessions that hold it; it is
    // replaced once none does.
    if (existing && (existing.Config?.Labels?.[SPEC_LABEL] === spec || (this.leases.get(name) ?? 0) > 0)) {
      if (!existing.State?.Running) await exec('docker', ['start', name], { timeout: 30_000 });
      return;
    }
    if (existing) await exec('docker', ['rm', '-f', name], { timeout: 30_000 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-sandbox-'));
    try {
      const envFile = path.join(dir, 'env');
      fs.writeFileSync(envFile, env, { mode: 0o600 });
      await exec('docker', sandboxCreateArgs(name, base, mounts, spec, labels, envFile), { timeout: 60_000 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    try {
      for (const network of Object.keys(base.NetworkSettings?.Networks ?? {}).slice(1)) await exec('docker', ['network', 'connect', network, name], { timeout: 30_000 });
      await exec('docker', ['start', name], { timeout: 30_000 });
    } catch (error) {
      await exec('docker', ['rm', '-f', name], { timeout: 30_000 }).catch(() => {});
      throw error;
    }
  }

  /** Remove sandboxes no session holds and none used for IDLE_MS. One this gateway
   * process has not used counts from its start, so a restart also clears the
   * previous run's, along with anything still running in them. */
  async reap(now = Date.now()): Promise<void> {
    const { stdout } = await exec('docker', ['ps', '-a', '--filter', `label=${SANDBOX_LABEL}=1`, '--format', '{{.Names}}'], { timeout: 10_000 });
    for (const name of stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
      await this.serialize(name, async () => {
        if ((this.leases.get(name) ?? 0) > 0 || now - (this.used.get(name) ?? this.started) < IDLE_MS) return;
        await exec('docker', ['rm', '-f', name], { timeout: 30_000 }).catch(() => {});
        this.used.delete(name);
        this.converged.delete(name);
      });
    }
  }

  /** Remove every sandbox of an app container (uninstall). */
  async removeFor(baseContainer: string): Promise<void> {
    const { stdout } = await exec('docker', ['ps', '-aq', '--filter', `label=${BASE_LABEL}=${baseContainer}`], { timeout: 10_000 });
    const ids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
    if (ids.length) await exec('docker', ['rm', '-f', ...ids], { timeout: 60_000 });
    this.converged.clear();
  }
}

export const sandboxPool = new SandboxPool();
