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
  start(socketPath: string, config: SocketConfig): void {
    if (this.servers.has(socketPath)) {
      return; // Already listening
    }

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res, socketPath, config);
    });

    const netServer = server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        // chmod may fail in test environments — not fatal
      }
    }) as unknown as net.Server;

    netServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Stale socket — remove and retry
        fs.unlinkSync(socketPath);
        netServer.listen(socketPath);
      }
    });

    this.servers.set(socketPath, netServer);
  }

  stop(socketPath: string): void {
    const server = this.servers.get(socketPath);
    if (!server) return;
    server.close();
    this.servers.delete(socketPath);
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Already removed
    }
  }

  stopAll(): void {
    for (const socketPath of this.servers.keys()) {
      this.stop(socketPath);
    }
  }

  /** Stop all sockets whose path contains the app name prefix (e.g. "my-app-"). */
  stopApp(appName: string): void {
    const prefix = `${appName}-`;
    for (const socketPath of [...this.servers.keys()]) {
      const basename = socketPath.split('/').pop() ?? '';
      if (basename.startsWith(prefix)) {
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

    // Execute script via bash (script path is pre-validated at install time)
    const scriptAbsPath = path.resolve(config.appDir, scriptDef.path);
    try {
      const result = spawnSync('bash', [scriptAbsPath, ...positional], {
        encoding: 'utf-8',
        timeout: scriptDef.timeoutMs,
        env: { ...process.env },
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
    for (const argDef of scriptDef.args ?? []) {
      const val = provided[argDef.name];
      if (val === undefined) continue; // Optional args are OK
      if (typeof val !== 'string') {
        return `Argument "${argDef.name}" must be a string`;
      }
      if (argDef.pattern) {
        let re: RegExp;
        try {
          re = new RegExp(argDef.pattern);
        } catch {
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
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
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
