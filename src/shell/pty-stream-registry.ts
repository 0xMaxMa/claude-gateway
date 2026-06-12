import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';

class PtyStreamRegistry {
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly servers = new Map<string, net.Server>();

  socketPath(agentId: string, sessionKey: string): string {
    const safe = sessionKey.replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
    return path.join(os.tmpdir(), `gw-pty-${agentId}-${safe}.sock`);
  }

  listen(agentId: string, socketPath: string): void {
    try { fs.unlinkSync(socketPath); } catch { /* stale or absent */ }

    const server = net.createServer((conn) => {
      conn.on('data', (chunk) => this.broadcast(agentId, chunk.toString()));
      conn.on('error', () => { /* child exited */ });
    });

    server.on('error', () => { /* ignore — another process may have grabbed the path */ });
    server.listen(socketPath);
    this.servers.set(socketPath, server);
  }

  close(socketPath: string): void {
    const server = this.servers.get(socketPath);
    if (!server) return;
    server.close();
    this.servers.delete(socketPath);
    try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
  }

  subscribe(agentId: string, ws: WebSocket): void {
    if (!this.clients.has(agentId)) this.clients.set(agentId, new Set());
    this.clients.get(agentId)!.add(ws);
  }

  unsubscribe(agentId: string, ws: WebSocket): void {
    this.clients.get(agentId)?.delete(ws);
  }

  broadcast(agentId: string, data: string): void {
    const set = this.clients.get(agentId);
    if (!set?.size) return;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(data); } catch { /* client gone */ }
      }
    }
  }
}

export const ptyStreamRegistry = new PtyStreamRegistry();
