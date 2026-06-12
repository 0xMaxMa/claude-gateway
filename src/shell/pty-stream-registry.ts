import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';

export class PtyStreamRegistry {
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly servers = new Map<string, net.Server>();
  private readonly agentSockets = new Map<string, Set<string>>();

  socketPath(agentId: string, sessionKey: string): string {
    const safe = sessionKey.replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
    return path.join(os.tmpdir(), `gw-pty-${safe}.sock`);
  }

  listen(agentId: string, socketPath: string): void {
    try { fs.unlinkSync(socketPath); } catch { /* stale or absent */ }

    const server = net.createServer((conn) => {
      // Use latin1 to preserve raw byte sequences from the PTY without UTF-8 re-encoding
      conn.setEncoding('latin1');
      conn.on('data', (chunk: string) => this.broadcast(agentId, chunk));
      conn.on('error', () => { /* child exited */ });
    });

    server.on('error', () => { /* ignore — another process may have grabbed the path */ });
    server.listen(socketPath);
    this.servers.set(socketPath, server);
    if (!this.agentSockets.has(agentId)) this.agentSockets.set(agentId, new Set());
    this.agentSockets.get(agentId)!.add(socketPath);
  }

  close(socketPath: string): void {
    const server = this.servers.get(socketPath);
    if (!server) return;
    server.close();
    this.servers.delete(socketPath);
    try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
    for (const [agentId, paths] of this.agentSockets) {
      paths.delete(socketPath);
      if (!paths.size) this.agentSockets.delete(agentId);
    }
  }

  /** Returns true if at least one active PTY socket server is registered for this agent. */
  hasSockets(agentId: string): boolean {
    return (this.agentSockets.get(agentId)?.size ?? 0) > 0;
  }

  subscribe(agentId: string, ws: WebSocket): void {
    if (!this.clients.has(agentId)) this.clients.set(agentId, new Set());
    this.clients.get(agentId)!.add(ws);
  }

  unsubscribe(agentId: string, ws: WebSocket): void {
    const set = this.clients.get(agentId);
    if (!set) return;
    set.delete(ws);
    if (!set.size) this.clients.delete(agentId);
  }

  broadcast(agentId: string, data: string): void {
    const set = this.clients.get(agentId);
    if (!set?.size) return;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        // Send as binary to preserve latin1 bytes faithfully; xterm.js accepts both
        try { ws.send(Buffer.from(data, 'latin1')); } catch { /* client gone */ }
      }
    }
  }
}

export const ptyStreamRegistry = new PtyStreamRegistry();
