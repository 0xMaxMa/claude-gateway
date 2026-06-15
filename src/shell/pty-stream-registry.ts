import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { Terminal } from '@xterm/headless';
import type { IBufferCell } from '@xterm/headless';
import { serializeScreen } from './pty-serialize';

/** Server PTY geometry — the headless mirror must match so the screen reconstructs faithfully. */
const PTY_COLS = 200;
const PTY_ROWS = 50;

/**
 * Tracks live PTY output streams so the dashboard can mirror a running shell.
 *
 * Everything is keyed by `streamKey` — the per-session id, NOT the agent id. A
 * single agent can run several concurrent sessions (e.g. a Telegram session and
 * an API/cron session), each its own PTY with its own screen. Keying by agent
 * id would merge them: both sessions would feed one shared mirror (interleaved,
 * unreadable output) and the viewer could not target a specific session. Keying
 * by session id keeps each stream isolated.
 */
export class PtyStreamRegistry {
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly servers = new Map<string, net.Server>();
  private readonly streamSockets = new Map<string, Set<string>>();
  /**
   * Headless terminal mirror per stream. Fed every PTY byte so it always holds
   * the session's current screen grid; on subscribe we serialize this into one
   * complete frame instead of replaying a (lossy, truncatable) raw-byte tail.
   */
  private readonly screens = new Map<string, Terminal>();

  /** Per-session unix socket path. Derived from the session id so each session gets its own stream. */
  socketPath(streamKey: string): string {
    // 48 chars comfortably fits a full UUID without truncation — two sessions
    // must never collide onto the same socket (that would cross-wire output).
    const safe = streamKey.replace(/[^a-z0-9_-]/gi, '').slice(0, 48);
    return path.join(os.tmpdir(), `gw-pty-${safe}.sock`);
  }

  listen(streamKey: string, socketPath: string): void {
    try { fs.unlinkSync(socketPath); } catch { /* stale or absent */ }

    const server = net.createServer((conn) => {
      // Use latin1 to preserve raw byte sequences from the PTY without UTF-8 re-encoding
      conn.setEncoding('latin1');
      conn.on('data', (chunk: string) => this.broadcast(streamKey, chunk));
      conn.on('error', () => { /* child exited */ });
    });

    server.on('error', () => { /* ignore — another process may have grabbed the path */ });
    server.listen(socketPath);
    this.servers.set(socketPath, server);
    if (!this.streamSockets.has(streamKey)) this.streamSockets.set(streamKey, new Set());
    // First socket for this stream → a fresh session is starting, so reset the
    // screen mirror to show output from this session's start, not a prior one.
    if (this.streamSockets.get(streamKey)!.size === 0) this.resetScreen(streamKey);
    this.streamSockets.get(streamKey)!.add(socketPath);
  }

  close(socketPath: string): void {
    const server = this.servers.get(socketPath);
    if (!server) return;
    server.close();
    this.servers.delete(socketPath);
    try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
    for (const [streamKey, paths] of this.streamSockets) {
      paths.delete(socketPath);
      if (!paths.size) {
        this.streamSockets.delete(streamKey);
        this.disposeScreen(streamKey);
      }
    }
  }

  /** Returns true if at least one active PTY socket server is registered for this stream/session. */
  hasSockets(streamKey: string): boolean {
    return (this.streamSockets.get(streamKey)?.size ?? 0) > 0;
  }

  /**
   * Return the current visible screen as plain text — ANSI escape codes stripped,
   * trailing blank lines removed. Each screen row becomes one line in the output.
   * Returns null if no headless mirror exists for the given stream key (session
   * not running in PTY mode, or not yet started).
   *
   * Intended for agents that need to observe what is currently displayed in the
   * PTY shell (e.g. to detect hang states, unexpected prompts, or tool output)
   * without having to parse ANSI/VT100 sequences.
   *
   * Async: flushes the terminal's write queue (same as subscribe does for the
   * serialized frame) so the snapshot reflects every byte received so far.
   */
  async screenText(streamKey: string): Promise<{ text: string; cursorRow: number; cursorCol: number; cols: number; rows: number } | null> {
    const term = this.screens.get(streamKey);
    if (!term) return null;

    // Flush write queue so the buffer reflects all bytes received so far.
    await new Promise<void>((resolve) => term.write('', resolve));

    const buf = term.buffer.active;
    const cols = term.cols;
    const rows = term.rows;
    const lines: string[] = [];
    let cell: IBufferCell | undefined;

    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line) { lines.push(''); continue; }

      // Collect characters up to the last non-blank cell on this row.
      let rowStr = '';
      let lastNonBlank = -1;
      // First pass: find last non-blank column.
      for (let x = cols - 1; x >= 0; x--) {
        cell = line.getCell(x, cell);
        if (cell) {
          const ch = cell.getChars();
          if (ch !== '' && ch !== ' ') { lastNonBlank = x; break; }
        }
      }
      if (lastNonBlank < 0) { lines.push(''); continue; }
      // Second pass: build the string up to lastNonBlank.
      for (let x = 0; x <= lastNonBlank; x++) {
        cell = line.getCell(x, cell);
        if (!cell) { rowStr += ' '; continue; }
        if (cell.getWidth() === 0) continue; // spacer for wide glyph
        const ch = cell.getChars();
        rowStr += ch === '' ? ' ' : ch;
      }
      lines.push(rowStr);
    }

    // Strip trailing blank lines so the agent sees a compact snapshot.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    return {
      text: lines.join('\n'),
      cursorRow: buf.cursorY,
      cursorCol: buf.cursorX,
      cols,
      rows,
    };
  }

  subscribe(streamKey: string, ws: WebSocket): void {
    if (!this.clients.has(streamKey)) this.clients.set(streamKey, new Set());
    // Register the client BEFORE sending the frame so no live byte produced in
    // the meantime is dropped (a gap there is exactly the old replay bug). The
    // frame is a full repaint, so any byte that races ahead of it is harmlessly
    // re-applied by Claude's next redraw.
    this.clients.get(streamKey)!.add(ws);

    const term = this.screens.get(streamKey);
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

  unsubscribe(streamKey: string, ws: WebSocket): void {
    const set = this.clients.get(streamKey);
    if (!set) return;
    set.delete(ws);
    if (!set.size) this.clients.delete(streamKey);
  }

  broadcast(streamKey: string, data: string): void {
    this.feedScreen(streamKey, data);
    const set = this.clients.get(streamKey);
    if (!set?.size) return;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        // Send as binary to preserve latin1 bytes faithfully; xterm.js accepts both
        try { ws.send(Buffer.from(data, 'latin1')); } catch { /* client gone */ }
      }
    }
  }

  /** Feed raw PTY bytes into the stream's headless mirror, creating it on first use. */
  private feedScreen(streamKey: string, data: string): void {
    if (!data) return;
    let term = this.screens.get(streamKey);
    if (!term) { term = this.createTerm(); this.screens.set(streamKey, term); }
    // `data` is a latin1-decoded byte string (the socket reads with
    // setEncoding('latin1')). Reconstruct the raw bytes and hand xterm a
    // Uint8Array, NOT a string: xterm.write(string) treats each code unit as a
    // final codepoint and does NOT UTF-8-decode, so multi-byte glyphs (Thai,
    // emoji) would be stored as individual latin1 chars and serialize back as
    // mojibake. xterm.write(Uint8Array) runs them through its UTF-8 decoder.
    term.write(Buffer.from(data, 'latin1'));
  }

  /** Start a clean mirror for a fresh session, disposing any prior one. */
  private resetScreen(streamKey: string): void {
    this.disposeScreen(streamKey);
    this.screens.set(streamKey, this.createTerm());
  }

  private disposeScreen(streamKey: string): void {
    const term = this.screens.get(streamKey);
    if (term) { try { term.dispose(); } catch { /* already disposed */ } }
    this.screens.delete(streamKey);
  }

  private createTerm(): Terminal {
    // scrollback: 0 — we only ever serialize the visible screen (the alt-screen
    // TUI has no scrollback by design), so retaining none bounds memory.
    return new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, scrollback: 0, allowProposedApi: true });
  }
}

export const ptyStreamRegistry = new PtyStreamRegistry();
