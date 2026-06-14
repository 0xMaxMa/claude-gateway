import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { Terminal } from '@xterm/headless';
import { serializeScreen } from './pty-serialize';

/** Server PTY geometry — the headless mirror must match so the screen reconstructs faithfully. */
const PTY_COLS = 200;
const PTY_ROWS = 50;

export class PtyStreamRegistry {
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly servers = new Map<string, net.Server>();
  private readonly agentSockets = new Map<string, Set<string>>();
  /**
   * Headless terminal mirror per agent. Fed every PTY byte so it always holds
   * the agent's current screen grid; on subscribe we serialize this into one
   * complete frame instead of replaying a (lossy, truncatable) raw-byte tail.
   */
  private readonly screens = new Map<string, Terminal>();

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
    // screen mirror to show output from this session's start, not a prior one.
    if (this.agentSockets.get(agentId)!.size === 0) this.resetScreen(agentId);
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
      if (!paths.size) {
        this.agentSockets.delete(agentId);
        this.disposeScreen(agentId);
      }
    }
  }

  /** Returns true if at least one active PTY socket server is registered for this agent. */
  hasSockets(agentId: string): boolean {
    return (this.agentSockets.get(agentId)?.size ?? 0) > 0;
  }

  subscribe(agentId: string, ws: WebSocket): void {
    if (!this.clients.has(agentId)) this.clients.set(agentId, new Set());
    // Register the client BEFORE sending the frame so no live byte produced in
    // the meantime is dropped (a gap there is exactly the old replay bug). The
    // frame is a full repaint, so any byte that races ahead of it is harmlessly
    // re-applied by Claude's next redraw.
    this.clients.get(agentId)!.add(ws);

    const term = this.screens.get(agentId);
    if (!term || ws.readyState !== WebSocket.OPEN) return;
    // Flush the terminal's write queue first so the serialized frame reflects
    // every byte received so far, then send one complete screen snapshot.
    term.write('', () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        // UTF-8 (not latin1): serialized cell chars are decoded Unicode.
        ws.send(Buffer.from(serializeScreen(term), 'utf8'));
      } catch { /* client gone */ }
    });
  }

  unsubscribe(agentId: string, ws: WebSocket): void {
    const set = this.clients.get(agentId);
    if (!set) return;
    set.delete(ws);
    if (!set.size) this.clients.delete(agentId);
  }

  broadcast(agentId: string, data: string): void {
    this.feedScreen(agentId, data);
    const set = this.clients.get(agentId);
    if (!set?.size) return;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        // Send as binary to preserve latin1 bytes faithfully; xterm.js accepts both
        try { ws.send(Buffer.from(data, 'latin1')); } catch { /* client gone */ }
      }
    }
  }

  /** Feed raw PTY bytes into the agent's headless mirror, creating it on first use. */
  private feedScreen(agentId: string, data: string): void {
    if (!data) return;
    let term = this.screens.get(agentId);
    if (!term) { term = this.createTerm(); this.screens.set(agentId, term); }
    // `data` is a latin1-decoded byte string (the socket reads with
    // setEncoding('latin1')). Reconstruct the raw bytes and hand xterm a
    // Uint8Array, NOT a string: xterm.write(string) treats each code unit as a
    // final codepoint and does NOT UTF-8-decode, so multi-byte glyphs (Thai,
    // emoji) would be stored as individual latin1 chars and serialize back as
    // mojibake. xterm.write(Uint8Array) runs them through its UTF-8 decoder.
    term.write(Buffer.from(data, 'latin1'));
  }

  /** Start a clean mirror for a fresh session, disposing any prior one. */
  private resetScreen(agentId: string): void {
    this.disposeScreen(agentId);
    this.screens.set(agentId, this.createTerm());
  }

  private disposeScreen(agentId: string): void {
    const term = this.screens.get(agentId);
    if (term) { try { term.dispose(); } catch { /* already disposed */ } }
    this.screens.delete(agentId);
  }

  private createTerm(): Terminal {
    // scrollback: 0 — we only ever serialize the visible screen (the alt-screen
    // TUI has no scrollback by design), so retaining none bounds memory.
    return new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, scrollback: 0, allowProposedApi: true });
  }
}

export const ptyStreamRegistry = new PtyStreamRegistry();
