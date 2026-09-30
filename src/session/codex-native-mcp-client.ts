import { sanitizeJevChildEnv } from '../jev/child-env';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { codexPolicyArgs } from './codex-policy';

/** Native Codex owns MCP OAuth/keyring refresh and plugin enablement. This
 * discovery-only sidecar creates no model turn. Only configured server names
 * are exposed; no generic native RPC method is reachable from model arguments. */
export class CodexNativeClient {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private threadId?: string;
  private buffer = '';
  private started?: Promise<void>;
  private changed?: () => unknown;
  private unavailable: string[] = [];
  private tools = new Map<string, { server: string; name: string }>();
  constructor(private config: { bin: string; cwd: string; home: string; servers: string[]; pluginIds?: string[]; env?: Record<string, string> }) {}
  setNotificationHandler(_schema: unknown, handler: () => unknown): void { this.changed = handler; }
  getInstructions(): string { return 'Native Codex MCP tools use the CLI user\'s existing connections and permissions. No model conversation runs in the connector.' + (this.unavailable.length ? ' Unavailable servers: ' + this.unavailable.join(', ') + '. Check codex mcp list and complete native connection setup.' : ''); }
  async connect(): Promise<void> {
    if (this.started) return this.started;
    this.started = this.start().catch(async error => { await this.close(); throw error; });
    return this.started;
  }
  private async start(): Promise<void> {
    const policy = codexPolicyArgs();
    for (const setting of ['features.plugins=false', 'features.apps=false']) { const index = policy.indexOf(setting); if (index >= 1) policy.splice(index - 1, 2); }
    const child = this.child = spawn(this.config.bin, [...policy, 'app-server', '--listen', 'stdio://'], { cwd: this.config.cwd, env: sanitizeJevChildEnv({ ...process.env, ...this.config.env, CODEX_HOME: this.config.home }), stdio: 'pipe' });
    child.stderr.resume();
    const failed = () => { if (this.child !== child) return; this.started = undefined; this.threadId = undefined; this.tools.clear(); this.buffer = ''; void this.changed?.(); for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Native MCP connection closed.')); } this.pending.clear(); };
    child.on('error', failed); child.on('close', failed); child.stdin.on('error', failed);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) { void this.close(); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        let message: any; try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== undefined && message.method) {
          // Do not silently approve an OAuth consent, policy exception or tool
          // confirmation. Native login/connection setup remains a user action.
          child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Native MCP requires user interaction. Complete it in Codex before retrying.' } }) + '\n');
          continue;
        }
        if (message.method && message.id === undefined) {
          if (/mcp.*(updated|changed|startup)/i.test(message.method)) { this.tools.clear(); void this.changed?.(); }
          continue;
        }
        const entry = this.pending.get(message.id); if (!entry) continue;
        this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`Native MCP ${entry.method} failed (${Number(message.error.code) || 'unknown'}). Check the native CLI connection and permissions.`));
        else entry.resolve(message.result);
      }
    });
    await this.rpc('initialize', { clientInfo: { name: 'gateway_mcp', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const thread = await this.rpc('thread/start', { cwd: this.config.cwd, ephemeral: true, approvalPolicy: 'on-request' });
    this.threadId = thread.thread?.id;
    if (typeof this.threadId !== 'string') throw new Error('Native MCP thread unavailable.');
  }
  private rpc(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null || this.child.stdin.destroyed) { reject(new Error('Native MCP connection is not running. Rediscover tools before retrying.')); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Native MCP request timed out. Inspect any prior effects before retrying.')); }, method === 'mcpServer/tool/call' ? 600000 : 20000);
      this.pending.set(id, { method, resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async listTools(): Promise<{ tools: any[] }> {
    await this.connect();
    this.tools.clear(); this.unavailable = [];
    const inventory = new Map<string, { server: string; name: string }>();
    const tools: any[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await this.rpc('mcpServerStatus/list', { threadId: this.threadId, cursor, limit: 100 });
      for (const server of page.data ?? []) {
        if (!this.config.servers.includes(server.name) && !(server.pluginId && this.config.pluginIds?.includes(server.pluginId))) continue;
        if (server.toolsError || server.authStatus === 'notLoggedIn') { this.unavailable.push(server.name); continue; }
        for (const [key, tool] of Object.entries(server.tools ?? {}) as [string, any][]) {
          const name = `${server.name}__${tool.name ?? key}`;
          inventory.set(name, { server: server.name, name: tool.name ?? key }); tools.push({ ...tool, name });
        }
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor) || cursors.size > 500 || tools.length > 10000) throw new Error('Native MCP inventory exceeded its limit.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.tools = inventory;
    return { tools };
  }
  async callTool(input: { name: string; arguments?: any }): Promise<any> {
    const tool = this.tools.get(input.name);
    if (!tool) throw new Error('Discover the native tool before calling it.');
    return this.rpc('mcpServer/tool/call', { threadId: this.threadId, server: tool.server, tool: tool.name, arguments: input.arguments ?? {} });
  }
  async close(): Promise<void> {
    this.child?.stdin.end(); this.child?.kill('SIGTERM');
    const child = this.child;
    if (child) { const kill = setTimeout(() => child.kill('SIGKILL'), 1000); kill.unref(); child.once('close', () => clearTimeout(kill)); }
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Native MCP connection closed.')); }
    this.tools.clear(); this.buffer = '';
    this.pending.clear(); this.started = undefined; this.threadId = undefined; this.child = undefined;
  }
}
