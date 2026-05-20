import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScriptDefinition {
  /** Relative path to .sh script (within app dir) */
  path: string;
  /** Script timeout in seconds parsed from e.g. "60s" */
  timeoutMs: number;
  /** Argument definitions for pattern validation */
  args?: Array<{
    name: string;
    type: string;
    pattern?: string;
    /** Compiled RegExp from pattern — cached at startup to avoid per-request ReDoS risk */
    _compiledPattern?: RegExp;
  }>;
}

interface SocketConfig {
  appName: string;
  serviceName: string;
  appDir: string;
  scripts: Record<string, ScriptDefinition>;
}

// ─── Server ───────────────────────────────────────────────────────────────────

/**
 * Manages per-app Unix socket servers.
 * Each socket is a separate HTTP server listening on a Unix domain socket file.
 * Containers with the socket volume-mounted send HTTP requests here to execute
 * declared scripts on the VM host.
 */
export class SocketServer {
  private readonly servers = new Map<string, net.Server>();

  /**
   * Create a Unix socket server at socketPath.
   * The socket is created with the caller's umask; chmod 600 is applied after bind.
   */
  start(socketPath: string, config: SocketConfig): Promise<void> {
    if (this.servers.has(socketPath)) {
      return Promise.resolve();
    }

    // Pre-compile arg patterns at startup to avoid per-request ReDoS risk
    for (const scriptDef of Object.values(config.scripts)) {
      for (const argDef of scriptDef.args ?? []) {
        if (argDef.pattern && !argDef._compiledPattern) {
          try { argDef._compiledPattern = new RegExp(argDef.pattern); } catch { /* invalid pattern */ }
        }
      }
    }

    return new Promise((resolve, reject) => {
      // Ensure parent directory exists (socket lives inside a per-app subdirectory)
      try { fs.mkdirSync(path.dirname(socketPath), { recursive: true }); } catch { /* exists */ }
      // Clean up any stale socket or leftover directory before binding
      if (fs.existsSync(socketPath)) {
        try { fs.rmSync(socketPath, { recursive: true, force: true }); } catch { /* already gone */ }
      }

      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res, socketPath, config);
      });

      const netServer = server.listen(socketPath, () => {
        try {
          // 0o666: containers with cap_drop:ALL lack CAP_DAC_OVERRIDE so they cannot
          // bypass file permissions even as root — world-writable is required here.
          // Exposure is bounded: only containers with this socket explicitly bind-mounted
          // in their compose file can reach it.
          fs.chmodSync(socketPath, 0o666);
        } catch {
          // chmod may fail in test environments — not fatal
        }
        resolve();
      }) as unknown as net.Server;

      netServer.on('error', (err: NodeJS.ErrnoException) => {
        this.servers.delete(socketPath);
        reject(new Error(`Socket server failed: ${err.message}`));
      });

      this.servers.set(socketPath, netServer);
    });
  }

  stop(socketPath: string): void {
    const server = this.servers.get(socketPath);
    if (!server) return;
    server.close();
    this.servers.delete(socketPath);
    try {
      fs.rmSync(socketPath, { recursive: true, force: true });
    } catch {
      // Already removed
    }
  }

  stopAll(): void {
    for (const socketPath of this.servers.keys()) {
      this.stop(socketPath);
    }
  }

  /** Stop all sockets whose path is under the app's socket directory (e.g. "my-app-svc/"). */
  stopApp(appName: string): void {
    const prefix = `${appName}-`;
    for (const socketPath of [...this.servers.keys()]) {
      const parts = socketPath.split('/');
      // New layout: .../sockets/appName-svcName/gateway.sock — check parent dir
      const parentDir = parts[parts.length - 2] ?? '';
      // Legacy layout: .../sockets/appName-svcName.sock — check basename
      const basename = parts[parts.length - 1] ?? '';
      if (parentDir.startsWith(prefix) || basename.startsWith(prefix)) {
        this.stop(socketPath);
      }
    }
  }

  // ─── Request handler ────────────────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    _socketPath: string,
    config: SocketConfig,
  ): Promise<void> {
    // Only POST /tool/script/:name is supported
    const match = req.url?.match(/^\/tool\/script\/([a-z0-9_-]+)$/i);
    if (req.method !== 'POST' || !match) {
      this.send(res, 404, { error: 'Not found' });
      return;
    }

    const scriptName = match[1];
    const scriptDef = config.scripts[scriptName];
    if (!scriptDef) {
      this.send(res, 403, {
        error: `Script "${scriptName}" is not declared for this app`,
      });
      return;
    }

    // Parse request body
    let body: Record<string, unknown>;
    try {
      body = await this.readBody(req);
    } catch {
      this.send(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const providedArgs = (body['args'] ?? {}) as Record<string, unknown>;

    // Validate args against declared patterns
    const validationError = this.validateArgs(providedArgs, scriptDef);
    if (validationError) {
      this.send(res, 400, { error: validationError });
      return;
    }

    // Build positional args array (in declaration order)
    const positional: string[] = [];
    for (const argDef of scriptDef.args ?? []) {
      const val = providedArgs[argDef.name];
      if (val !== undefined) {
        positional.push(String(val));
      }
    }

    // Execute script via bash — re-resolve realpath at execute time to guard against symlink swaps
    const scriptAbsPath = path.resolve(config.appDir, scriptDef.path);
    let realScriptPath: string;
    let realAppDir: string;
    try {
      realScriptPath = fs.realpathSync(scriptAbsPath);
      realAppDir = fs.realpathSync(config.appDir);
    } catch {
      this.send(res, 403, { error: 'Script not accessible' });
      return;
    }
    if (!realScriptPath.startsWith(realAppDir + path.sep) && realScriptPath !== realAppDir) {
      this.send(res, 403, { error: 'Script path escapes app directory' });
      return;
    }
    // Minimal env — never expose host secrets to scripts
    const scriptEnv = {
      PATH: process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: process.env['HOME'] ?? '/root',
    };
    try {
      const result = spawnSync('bash', [realScriptPath, ...positional], {
        encoding: 'utf-8',
        timeout: scriptDef.timeoutMs,
        env: scriptEnv,
      });

      this.send(res, 200, {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.status ?? 1,
      });
    } catch (err) {
      this.send(res, 500, {
        error: `Script execution failed: ${(err as Error).message}`,
      });
    }
  }

  private validateArgs(
    provided: Record<string, unknown>,
    scriptDef: ScriptDefinition,
  ): string | null {
    const MAX_ARG_LEN = 256;
    for (const argDef of scriptDef.args ?? []) {
      const val = provided[argDef.name];
      if (val === undefined) continue; // Optional args are OK
      if (typeof val !== 'string') {
        return `Argument "${argDef.name}" must be a string`;
      }
      // Cap value length before regex test to prevent ReDoS from catastrophic backtracking
      if (val.length > MAX_ARG_LEN) {
        return `Argument "${argDef.name}" exceeds maximum length of ${MAX_ARG_LEN}`;
      }
      if (argDef.pattern) {
        const re = argDef._compiledPattern;
        if (!re) {
          return `Internal error: invalid pattern for argument "${argDef.name}"`;
        }
        if (!re.test(val)) {
          return `Argument "${argDef.name}" does not match required pattern`;
        }
      }
    }
    return null;
  }

  private readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const MAX_BODY = 1 * 1024 * 1024; // 1 MB
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse "60s", "10s", "5s" → milliseconds. Defaults to 30000. */
export function parseTimeoutMs(timeout?: string): number {
  if (!timeout) return 30_000;
  const m = timeout.match(/^(\d+)s$/);
  if (!m) return 30_000;
  return parseInt(m[1], 10) * 1000;
}
