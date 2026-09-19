import { EventEmitter } from 'events';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, writeFile, rename, cp, rm, readdir, lstat } from 'fs/promises';
import { join } from 'path';
import { userInfo, homedir } from 'os';
import type { AgentConfig, GatewayConfig } from '../types';
import type { RuntimeProfile } from './runtime-profile';
import type { InputImage } from './input-image';
import { assertContainerBinding, prepareContainerProfile, containerNode, CONTAINER_SUPERVISOR, stopContainerProfile } from '../orchestration/container';
import { stopProcessGroup } from '../orchestration/process-supervisor';

export interface CodexProcessOptions {
  agent: AgentConfig;
  gateway: GatewayConfig;
  profile: RuntimeProfile;
  sessionId: string;
  stateDirectory: string;
  checkpoint?: () => Promise<{ text: string; kind?: 'assignment' | 'advice'; acknowledge: () => void | Promise<void> } | undefined>;
  config: { model: string; baseUrl?: string; apiKeyEnv?: string; reasoningEffort?: string; bin?: string };
}
const quote = (value: string): string => JSON.stringify(value);
const MAX_LINE = 4 * 1024 * 1024;
const threadPattern = /^[a-f0-9-]{36}$/i;
interface SavedThread { threadId: string; home: string; container?: string; identity?: string; usage?: NativeUsage; }
interface NativeUsage { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number; outputTokens: number; }

interface SessionHomes { sessionId: string; workspace: string; container?: string; homes: string[]; }
function sessionRoot(stateDirectory: string, workspace: string, sessionId: string): string {
  return join(stateDirectory, 'codex', createHash('sha256').update(workspace + '\0' + sessionId).digest('hex'));
}
function ownedHome(root: string, home: unknown, container?: string): home is string {
  if (typeof home !== 'string') return false;
  const prefix = container ? homedir() + '/.gateway-codex-' : root + '/attempt-';
  return home.startsWith(prefix) && threadPattern.test(home.slice(prefix.length));
}
const cleanupRuns = new Map<string, Promise<number>>();
const cleanupCursors = new Map<string, string>();
/** Lazy bounded reclamation after the worker pool has expired or replaced logical slots.
 * A durable lease also fences uncertain processes after a gateway crash. Such leases
 * are intentionally retained until process reconciliation can prove they stopped. */
export function cleanupCodexSessions(options: { agent: AgentConfig; stateDirectory: string; retainedSessionIds: readonly string[]; limit?: number }): Promise<number> {
  const directory = join(options.stateDirectory, 'codex');
  const running = cleanupRuns.get(directory);
  if (running) return running;
  const run = (async () => {
    let names: string[];
    try { names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).map(entry => entry.name).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
    const previous = cleanupCursors.get(directory) ?? '';
    const start = Math.max(0, names.findIndex(name => name > previous));
    const batch = [...names.slice(start), ...names.slice(0, start)].slice(0, Math.max(1, Math.min(options.limit ?? 32, 128)));
    const retained = new Set(options.retainedSessionIds);
    let removed = 0;
    for (const name of batch) {
      cleanupCursors.set(directory, name);
      const root = join(directory, name), lease = join(root, '.active');
      let locked = false;
      try {
        const file = join(root, 'homes.json');
        if (!(await lstat(file)).isFile()) continue;
        const homes = JSON.parse(await readFile(file, 'utf8')) as SessionHomes;
        if (typeof homes.sessionId !== 'string' || typeof homes.workspace !== 'string' || homes.container !== options.agent.container || root !== sessionRoot(options.stateDirectory, homes.workspace, homes.sessionId) || retained.has(homes.sessionId) || !Array.isArray(homes.homes) || !homes.homes.every(home => ownedHome(root, home, homes.container))) continue;
        await mkdir(lease, { mode: 0o700 }); locked = true;
        // Host deletion cannot establish containment inside an app-agent namespace.
        if (homes.container) {
          for (const home of homes.homes) await containerNode(homes.container, "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", [home]);
        }
        await rm(root, { recursive: true, force: true }); locked = false; removed++;
      } catch (error) {
        // Missing metadata, existing leases, malformed bindings and offline containers
        // are preserved. Cleanup must not turn a new task into a failure.
      } finally { if (locked) await rm(lease, { recursive: true, force: true }).catch(() => {}); }
    }
    return removed;
  })().finally(() => { cleanupRuns.delete(directory); });
  cleanupRuns.set(directory, run);
  return run;
}

/** A bounded native Codex app-server session. No Claude auth or user Codex configuration is inherited. */
export class CodexProcess extends EventEmitter {
  readonly spawnedAt = Date.now();
  readonly runtimeProfile: RuntimeProfile;
  managedGroupStopped = false;
  private child?: ChildProcessWithoutNullStreams;
  private group?: number;
  get managedProcessId(): number | undefined { return this.group; }
  private preparing?: Promise<void>;
  private launching?: Promise<void>;
  private stopping?: Promise<void>;
  private cancelled = false;
  private terminal = false;
  private completion?: Promise<void>;
  private exited = false;
  private home = '';
  private containerAttempt?: { directory: string; config: string };
  private saved?: SavedThread;
  private threadId?: string;
  private buffer = '';
  private stderr = '';
  private lastError = '';
  private finalText = '';
  private readonly tools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly mapping: string;
  private sequence = 0;
  private readonly requests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private turnId?: string;
  private turnEnded = false;
  private steering?: Promise<void>;
  private amendment?: { text: string; kind?: 'assignment' | 'advice'; acknowledge: () => void | Promise<void> };
  private nativeUsage?: NativeUsage;
  private identity = '';
  private homePersisted = false;
  private leaseOwned = false;
  private approvedMcp: Record<string, any> = {};
  private readonly root: string;
  constructor(private readonly options: CodexProcessOptions) {
    super();
    this.runtimeProfile = options.profile;
    this.root = sessionRoot(options.stateDirectory, options.agent.workspace, options.sessionId);
    this.mapping = join(this.root, 'thread.json');
  }
  start(): Promise<void> {
    return this.preparing ??= this.prepare().catch(async error => {
      // Preparation cannot spawn a worker; reclaim its partial home even when a
      // caller never reaches the normal stop lifecycle. Preserve the original error.
      await this.cleanupHomes().catch(() => {});
      throw error;
    });
  }
  private async prepare(): Promise<void> {
    const { agent, profile, config } = this.options;
    if (this.cancelled) throw new Error('Codex process cancelled before startup');
    if (profile.role !== 'worker') throw new Error('Codex harness supports workers only');
    assertContainerBinding(agent, profile);
    if (agent.type === 'app-agent' && profile.hostExecution) throw new Error('Container roles cannot use host execution');
    if (profile.workerTools && (!profile.workerTools.includes('Bash') || !profile.workerTools.includes('Edit'))) throw new Error('Codex cannot enforce this restricted native tool profile');
    const key = config.apiKeyEnv ?? 'OPENAI_API_KEY';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^ANTHROPIC_|^CLAUDE_/.test(key)) throw new Error('Codex requires an independent API key environment variable');
    if (!process.env[key]) throw new Error(`Codex API credential environment variable ${key} is not set`);
    if (config.baseUrl) { const url = new URL(config.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid Codex Responses base URL'); }
    this.identity = createHash('sha256').update(JSON.stringify([config.baseUrl ?? 'https://api.openai.com/v1', key, process.env[key]])).digest('hex');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, '.active'), { mode: 0o700 });
    this.leaseOwned = true;
    try { this.saved = JSON.parse(await readFile(this.mapping, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.saved && (!threadPattern.test(this.saved.threadId) || this.saved.identity !== this.identity || this.saved.container !== agent.container ||
      !ownedHome(this.root, this.saved.home, agent.container))) throw new Error('Invalid persisted Codex thread binding');
    await this.recordHomes();
    let mcp: any;
    if (agent.type === 'app-agent') {
      this.containerAttempt = await prepareContainerProfile(agent, profile);
      // Existing app-agent images create the installer's home but may have no passwd entry for its numeric UID.
      const containerHome = homedir();
      if (!/^\/(?:home\/[^/]+|root)$/.test(containerHome)) throw new Error('Container requires a writable non-temporary home for Codex');
      this.home = containerHome + '/.gateway-codex-' + randomUUID();
      await this.recordHomes();
      mcp = JSON.parse(await containerNode(agent.container!, "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))", [this.containerAttempt.config]));
    } else {
      this.home = join(this.root, 'attempt-' + randomUUID());
      await this.recordHomes();
      await mkdir(this.home, { mode: 0o700 });
      mcp = JSON.parse(await readFile(profile.mcpConfigPath, 'utf8'));
    }
    this.approvedMcp = mcp.mcpServers ?? {};
    const lines = [
      `model = ${quote(config.model)}`, 'model_provider = "gateway"', 'approval_policy = "never"',
      `sandbox_mode = ${quote(profile.hostExecution || agent.type === 'app-agent' ? 'danger-full-access' : 'workspace-write')}`,
      'web_search = "disabled"', 'project_doc_fallback_filenames = ["CLAUDE.md"]',
      `developer_instructions = ${quote([profile.context, profile.overlay, profile.skillPluginDir ? `Task skill resources: ${this.containerAttempt ? this.containerAttempt.directory + '/skill-plugin' : profile.skillPluginDir}` : undefined].filter(Boolean).join('\n\n'))}`,
      ...(config.reasoningEffort ? [`model_reasoning_effort = ${quote(config.reasoningEffort)}`] : []),
      '[model_providers.gateway]', 'name = "Gateway Responses"', 'wire_api = "responses"',
      `base_url = ${quote(config.baseUrl ?? 'https://api.openai.com/v1')}`, `env_key = ${quote(key)}`,
      '[features]', 'multi_agent = false',
      `[projects.${quote(agent.type === 'app-agent' ? '/workspace' : agent.workspace)}]`, 'trust_level = "untrusted"',
    ];
    for (const [name, server] of Object.entries(mcp.mcpServers ?? {}) as [string, any][]) {
      if (typeof server.command !== 'string' || !Array.isArray(server.args) || server.args.some((v: unknown) => typeof v !== 'string')) throw new Error('Codex MCP requires a stdio command and string arguments');
      lines.push(`[mcp_servers.${quote(name)}]`, `command = ${quote(server.command)}`, `args = ${JSON.stringify(server.args)}`, 'required = true');
      if (server.env) {
        lines.push(`[mcp_servers.${quote(name)}.env]`);
        for (const [k, v] of Object.entries(server.env)) { if (typeof v !== 'string') throw new Error('Invalid MCP environment'); lines.push(`${quote(k)} = ${quote(v)}`); }
      }
    }
    const configText = lines.join('\n') + '\n';
    if (agent.type === 'app-agent') {
      await containerNode(agent.container!, `const fs=require('fs'),path=require('path');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const p=JSON.parse(s);fs.mkdirSync(p.home,{mode:448});if(p.previous)fs.cpSync(p.previous+'/sessions',p.home+'/sessions',{recursive:true});fs.writeFileSync(p.home+'/config.toml',p.config,{mode:384});});`, [], JSON.stringify({ home: this.home, previous: this.saved?.home, config: configText }));
    } else {
      if (this.saved) await cp(join(this.saved.home, 'sessions'), join(this.home, 'sessions'), { recursive: true });
      await writeFile(join(this.home, 'config.toml'), configText, { mode: 0o600 });
    }
    if (this.cancelled) throw new Error('Codex process cancelled during startup');
  }
  private async recordHomes(): Promise<void> {
    const agent = this.options.agent;
    await writeFile(join(this.root, 'homes.json'), JSON.stringify({ sessionId: this.options.sessionId, workspace: agent.workspace, container: agent.container, homes: [this.saved?.home, this.home].filter(Boolean) }), { mode: 0o600 });
  }
  sendMessage(prompt: string, images: readonly InputImage[] = []): void {
    if (this.launching) throw new Error('Codex process accepts one turn');
    this.launching = this.launch(prompt, images).catch(error => { this.emit('startup-error', error); });
  }
  private async launch(prompt: string, images: readonly InputImage[]): Promise<void> {
    await this.start();
    const { agent, config, profile } = this.options;
    const input: any[] = [{ type: 'text', text: prompt, text_elements: [] }];
    for (const [index, image] of images.entries()) {
      const filename = this.home + `/input-${index}.${image.source.media_type.split('/')[1]}`;
      if (agent.type === 'app-agent') await containerNode(agent.container!, "require('fs').writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'),{mode:384})", [filename, image.source.data]);
      else await writeFile(filename, Buffer.from(image.source.data, 'base64'), { mode: 0o600 });
      input.push({ type: 'localImage', path: filename });
    }
    if (this.cancelled) return;
    const args = ['app-server', '--listen', 'stdio://'];
    const key = config.apiKeyEnv ?? 'OPENAI_API_KEY';
    const env: NodeJS.ProcessEnv = profile.hostExecution ? { ...process.env } : Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].flatMap(k => process.env[k] === undefined ? [] : [[k, process.env[k]]]));
    for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_)/.test(k)) delete env[k];
    env.CODEX_HOME = this.home; env[key] = process.env[key];
    const bin = config.bin ?? 'codex';
    const child = this.child = agent.type === 'app-agent'
      ? spawn('docker', ['exec', '-i', '--workdir', '/workspace', '--user', String(userInfo().uid), '-e', 'CODEX_HOME', '-e', `HOME=${homedir()}`, '-e', key, agent.container!, 'node', '-e', CONTAINER_SUPERVISOR, this.containerAttempt!.directory, bin, ...args], { env, stdio: 'pipe', detached: true })
      : spawn(bin, args, { cwd: agent.workspace, env, stdio: 'pipe', detached: true });
    this.group = child.pid;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-16384); });
    child.stdin.on('error', error => { if (!this.cancelled && !this.terminal) this.fail(error.message); });
    child.on('error', error => { this.rejectRequests(error); this.emit('startup-error', error); });
    child.on('close', async (code, signal) => {
      this.exited = true;
      this.rejectRequests(new Error(this.stderr.trim() || 'Codex app-server exited'));
      if (this.buffer.trim()) this.consume('\n');
      await this.completion;
      if (!this.terminal && !this.cancelled) this.fail(this.lastError || this.stderr.trim() || `Codex exited without a completed turn (${code ?? signal})`);
      this.emit('exit', code, signal);
    });
    await this.request('initialize', { clientInfo: { name: 'claude_gateway', version: '1.0.0' } });
    this.write({ method: 'initialized', params: {} });
    await this.validateConfiguration();
    const parameters = { model: config.model, modelProvider: 'gateway', cwd: agent.type === 'app-agent' ? '/workspace' : agent.workspace, approvalPolicy: 'never', sandbox: profile.hostExecution || agent.type === 'app-agent' ? 'danger-full-access' : 'workspace-write' };
    const response = await this.request(this.saved ? 'thread/resume' : 'thread/start', { ...parameters, ...(this.saved ? { threadId: this.saved.threadId } : {}) });
    if (!threadPattern.test(response.thread?.id) || (this.saved && response.thread.id !== this.saved.threadId)) throw new Error('Codex thread identity mismatch');
    this.threadId = response.thread.id;
    await this.persist();
    this.output({ type: 'system', subtype: 'native_init', model: config.model });
    await this.beginTurn(input);

  }
  private output(event: unknown): void { this.emit('output', JSON.stringify(event)); }
  private fail(message: string): void { if (this.terminal) return; this.terminal = true; this.output({ type: 'result', is_error: true, result: message }); }
  private consume(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_LINE) { this.fail('Codex output exceeded the bounded JSON buffer'); void this.stop(); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { this.event(JSON.parse(line)); } catch (error) { this.fail(`Invalid Codex event: ${(error as Error).message}`); void this.stop(); return; }
    }
  }
  private async validateConfiguration(): Promise<void> {
    const reply = await this.request('config/read', { cwd: this.options.agent.type === 'app-agent' ? '/workspace' : this.options.agent.workspace, includeLayers: true });
    const effective = reply.config;
    if (!effective || !Array.isArray(reply.layers)) throw new Error('Codex did not provide effective configuration');
    if (reply.layers.some((layer: any) => layer.name?.type === 'project' && !layer.disabledReason)) throw new Error('Codex project executable configuration is not permitted');
    const actual = effective.mcp_servers ?? {};
    if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(this.approvedMcp).sort())) throw new Error('Codex MCP server inventory mismatch');
    for (const [name, expected] of Object.entries(this.approvedMcp)) {
      const server = actual[name];
      if (server.command !== expected.command || JSON.stringify(server.args) !== JSON.stringify(expected.args) || Object.keys(server.env ?? {}).length !== Object.keys(expected.env ?? {}).length || Object.entries(expected.env ?? {}).some(([key, value]) => server.env?.[key] !== value)) throw new Error('Codex MCP server configuration mismatch');
    }
    if (effective.notify?.length || (effective.hooks && Object.keys(effective.hooks).length)) throw new Error('Codex executable hooks are not permitted');
    const provider = effective.model_providers?.gateway;
    if (effective.model_provider !== 'gateway' || provider?.base_url !== (this.options.config.baseUrl ?? 'https://api.openai.com/v1') || provider?.env_key !== (this.options.config.apiKeyEnv ?? 'OPENAI_API_KEY') || provider?.wire_api !== 'responses') throw new Error('Codex provider configuration mismatch');
  }
  private write(message: unknown): void {
    if (!this.child || this.exited) throw new Error('Codex app-server is unavailable');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private request(method: string, params: unknown): Promise<any> {
    if (this.cancelled) return Promise.reject(new Error('Codex process cancelled'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 30000);
      this.requests.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.requests.delete(id); reject(error); }
    });
  }
  private rejectRequests(error: Error): void {
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
    this.requests.clear();
  }
  private async beginTurn(input: unknown[]): Promise<void> {
    this.turnEnded = false;
    this.finalText = '';
    const response = await this.request('turn/start', { threadId: this.threadId, input, ...(this.options.config.reasoningEffort ? { effort: this.options.config.reasoningEffort } : {}), ...(this.options.agent.type === 'app-agent' ? { sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' } } : {}) });
    if (typeof response.turn?.id !== 'string') throw new Error('Codex omitted turn identity');
    this.turnId = response.turn.id;
  }
  private event(event: any): void {
    if (typeof event.id === 'number' && !event.method) {
      const pending = this.requests.get(event.id);
      if (pending) { clearTimeout(pending.timer); this.requests.delete(event.id); event.error ? pending.reject(new Error(event.error.message || JSON.stringify(event.error))) : pending.resolve(event.result); }
      return;
    }
    if (event.id !== undefined && event.method) {
      // This worker is noninteractive. Unexpected approval/tool requests fail closed.
      this.write({ id: event.id, error: { code: -32601, message: 'Interactive requests are not supported by gateway workers' } });
      this.fail(`Codex requested unsupported interaction: ${event.method}`); void this.stop(); return;
    }
    if (this.terminal || this.cancelled) return;
    const p = event.params ?? {};
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    if (event.method === 'turn/started') {
      this.turnId = p.turn.id;
      this.output({ type: 'stream_event', event: { type: 'message_start', message: { id: p.turn.id, model: this.options.config.model, content: [] } } });
    } else if (['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(event.method) && typeof p.delta === 'string' && p.delta) {
      // Activity is observable, but only the canonical completed answer is published.
      this.output({ type: 'assistant', message: { model: this.options.config.model, content: [{ type: event.method === 'item/agentMessage/delta' ? 'text' : 'thinking', text: p.delta, thinking: p.delta }] } });
    } else if (event.method === 'error') {
      this.lastError = p.error?.message || JSON.stringify(p.error);
    } else if (event.method === 'thread/tokenUsage/updated') {
      this.nativeUsage = p.tokenUsage?.total;
      if (this.nativeUsage) this.output({ type: 'system', subtype: 'native_usage', usage: this.normalizedUsage() });
    } else if (event.method === 'turn/completed') {
      if (this.turnId && p.turn.id !== this.turnId) return;
      this.turnEnded = true;
      if (p.turn.status !== 'completed') { this.fail(p.turn.error?.message || this.lastError || `Codex turn ${p.turn.status}`); return; }
      this.completion = this.completeTurn().catch(error => this.fail(error.message));
    } else if (event.method === 'item/started' || event.method === 'item/completed') {
      const item = p.item;
      if (!item || typeof item.id !== 'string') return;
      const completed = event.method === 'item/completed';
      if (item.type === 'agentMessage' && completed) { if (item.phase !== 'commentary') this.finalText = item.text ?? ''; return; }
      const name = item.type === 'commandExecution' ? 'Bash' : item.type === 'fileChange' ? 'Edit' : item.type === 'mcpToolCall' ? `mcp__${item.server}__${item.tool}` : undefined;
      if (!name) return;
      if (!this.tools.has(item.id)) {
        this.tools.add(item.id);
        this.output({ type: 'assistant', message: { model: this.options.config.model, content: [{ type: 'tool_use', id: item.id, name, input: item.type === 'commandExecution' ? { command: item.command } : item.type === 'fileChange' ? { changes: item.changes } : item.arguments ?? {} }] } });
      }
      if (completed && !this.completedTools.has(item.id)) {
        this.completedTools.add(item.id);
        this.output({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: item.id, is_error: item.status === 'failed' || item.status === 'declined' || !!item.error || item.result?.isError === true || (typeof item.exitCode === 'number' && item.exitCode !== 0), content: item.aggregatedOutput ?? JSON.stringify(item.error ?? item.result ?? item.changes ?? '') }] } });
        if (!this.steering) {
          this.steering = this.steer().catch(error => { this.fail(`Codex task update failed: ${error.message}`); void this.stop(); }).finally(() => { this.steering = undefined; });
        }
      }
    }
  }
  private async steer(): Promise<void> {
    if (!this.options.checkpoint || this.cancelled || this.turnEnded) return;
    this.amendment ??= await this.options.checkpoint();
    if (!this.amendment || this.cancelled || this.turnEnded) return;
    try {
      await this.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text: this.amendment.text, text_elements: [] }] });
    } catch (error) {
      // A just-completed turn cannot accept steering; preserve the amendment for the next turn.
      if (this.turnEnded) return;
      throw error;
    }
    await this.amendment.acknowledge();
    this.amendment = undefined;
  }
  private async completeTurn(): Promise<void> {
    await this.steering;
    if (this.cancelled || this.terminal) return;
    this.amendment ??= await this.options.checkpoint?.();
    if (this.cancelled) return;
    if (this.amendment?.kind === 'advice') { await this.amendment.acknowledge(); this.amendment = undefined; }
    if (this.amendment) {
      const amendment = this.amendment;
      await this.beginTurn([{ type: 'text', text: amendment.text, text_elements: [] }]);
      await amendment.acknowledge(); this.amendment = undefined;
      return;
    }
    await this.persist();
    if (this.cancelled) return;
    this.terminal = true;
    this.output({ type: 'result', result: this.finalText, ...(this.nativeUsage ? { usage: this.normalizedUsage() } : {}) });
  }
  private normalizedUsage(): { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens?: number; output_tokens: number } {
    const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const difference = (field: keyof NativeUsage) => Math.max(0, count(this.nativeUsage?.[field]) - count(this.saved?.usage?.[field]));
    const input = difference('inputTokens'), cached = Math.min(input, difference('cachedInputTokens'));
    // Codex's input total includes cache reads AND writes. Preserve a reported
    // zero, but do not manufacture a measurement when either cumulative endpoint
    // is unknown (notably a resumed transcript from an older Codex version).
    const reportedWrites = this.nativeUsage?.cacheWriteInputTokens;
    const previousWrites = this.saved?.usage?.cacheWriteInputTokens;
    const writesKnown = typeof reportedWrites === 'number' && Number.isSafeInteger(reportedWrites) && reportedWrites >= 0 &&
      (!this.saved?.usage || (typeof previousWrites === 'number' && Number.isSafeInteger(previousWrites) && previousWrites >= 0));
    const written = writesKnown ? Math.min(input - cached, difference('cacheWriteInputTokens')) : 0;
    return { input_tokens: input - cached - written, cache_read_input_tokens: cached,
      ...(writesKnown ? { cache_creation_input_tokens: written } : {}), output_tokens: difference('outputTokens') };
  }
  private async persist(): Promise<void> {
    if (!this.threadId) throw new Error('Codex omitted its thread identity');
    const temporary = this.mapping + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify({ threadId: this.threadId, home: this.home, container: this.options.agent.container, identity: this.identity, usage: this.nativeUsage ?? this.saved?.usage }), { mode: 0o600 });
    await rename(temporary, this.mapping);
    this.homePersisted = true;
  }
  interrupt(): boolean {
    if (this.turnId && !this.cancelled && !this.exited) { try { this.write({ id: ++this.sequence, method: 'turn/interrupt', params: { threadId: this.threadId, turnId: this.turnId } }); } catch {} }
    this.cancelled = true; this.rejectRequests(new Error('Codex process cancelled'));
    return !!this.child && !this.exited;
  }
  stop(): Promise<void> {
    this.interrupt();
    return this.stopping ??= this.shutdown();
  }
  private async shutdown(): Promise<void> {
    await this.preparing?.catch(() => {});
    await this.launching?.catch(() => {});
    await this.completion;
    let stopped = true;
    if (this.containerAttempt && this.child) stopped = await stopContainerProfile(this.options.agent.container!, this.containerAttempt.directory);
    if (this.group) stopped = await stopProcessGroup(this.group) && stopped;
    this.managedGroupStopped = stopped;
    if (stopped) this.group = undefined;
    // Failed/interrupted turns also advance the durable token baseline.
    if (stopped && this.threadId && this.nativeUsage) await this.persist();
    if (!this.child) this.emit('exit', null, 'SIGINT');
    if (stopped) await this.cleanupHomes();
  }
  private async cleanupHomes(): Promise<void> {
    if (!this.leaseOwned) return;
    // Only the most recent transcript home is needed after its replacement is durable.
    if (this.saved && this.homePersisted && this.home !== this.saved.home) {
      if (this.options.agent.type === 'app-agent') await containerNode(this.options.agent.container!, "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", [this.saved.home]);
      else await rm(this.saved.home, { recursive: true, force: true });
    }
    // Transcripts remain for explicit resume; short-lived MCP ticket configuration does not.
    if (this.containerAttempt) await containerNode(this.options.agent.container!, "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", [this.containerAttempt.directory]);
    if (this.home) {
      if (this.options.agent.type === 'app-agent') await containerNode(this.options.agent.container!, "require('fs').rmSync(process.argv[1],{force:true})", [this.home + '/config.toml']).catch(() => {});
      else await rm(join(this.home, 'config.toml'), { force: true });
      if (!this.homePersisted) {
        if (this.options.agent.type === 'app-agent') await containerNode(this.options.agent.container!, "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", [this.home]);
        else await rm(this.home, { recursive: true, force: true });
      }
    }
    await rm(join(this.root, '.active'), { recursive: true, force: true });
    this.leaseOwned = false;
  }
}
