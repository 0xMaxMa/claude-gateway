import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';

/** Max bytes of recent PTY output retained per agent for scrollback replay. */
const SCROLLBACK_MAX_BYTES = 256 * 1024;

export class PtyStreamRegistry {
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly servers = new Map<string, net.Server>();
  private readonly agentSockets = new Map<string, Set<string>>();
  /** Rolling buffer of recent PTY bytes per agent (latin1), for replay on subscribe. */
  private readonly scrollback = new Map<string, { chunks: string[]; bytes: number }>();

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
    // First socket for this agent → a fresh session is starting, so reset the
    // scrollback so replay shows output from this session's start, not a prior one.
    if (this.agentSockets.get(agentId)!.size === 0) this.scrollback.delete(agentId);
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
    // Replay buffered scrollback so the viewer sees output from session start,
    // not just bytes that arrive after connecting.
    const buf = this.scrollback.get(agentId);
    if (buf && buf.chunks.length && ws.readyState === WebSocket.OPEN) {
      try { ws.send(Buffer.from(buf.chunks.join(''), 'latin1')); } catch { /* client gone */ }
    }
  }

  unsubscribe(agentId: string, ws: WebSocket): void {
    const set = this.clients.get(agentId);
    if (!set) return;
    set.delete(ws);
    if (!set.size) this.clients.delete(agentId);
  }

  broadcast(agentId: string, data: string): void {
    this.appendScrollback(agentId, data);
    const set = this.clients.get(agentId);
    if (!set?.size) return;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        // Send as binary to preserve latin1 bytes faithfully; xterm.js accepts both
        try { ws.send(Buffer.from(data, 'latin1')); } catch { /* client gone */ }
      }
    }
  }

  /** Append data to the agent's rolling scrollback, trimming oldest bytes past the cap. */
  private appendScrollback(agentId: string, data: string): void {
    if (!data) return;
    let buf = this.scrollback.get(agentId);
    if (!buf) { buf = { chunks: [], bytes: 0 }; this.scrollback.set(agentId, buf); }
    buf.chunks.push(data);
    buf.bytes += data.length;
    while (buf.bytes > SCROLLBACK_MAX_BYTES && buf.chunks.length > 1) {
      buf.bytes -= buf.chunks.shift()!.length;
    }
  }
}

export const ptyStreamRegistry = new PtyStreamRegistry();
