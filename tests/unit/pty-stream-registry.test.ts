import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PtyStreamRegistry } from '../../src/shell/pty-stream-registry';

function makeWs(state: number = 1 /* OPEN */) {
  return {
    readyState: state,
    sentBuffers: [] as Buffer[],
    send(buf: Buffer) { this.sentBuffers.push(buf); },
    OPEN: 1,
  } as any;
}

describe('PtyStreamRegistry', () => {
  let tmpDir: string;
  let reg: PtyStreamRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-reg-test-'));
    reg = new PtyStreamRegistry();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('socketPath', () => {
    it('strips non-alphanumeric chars from the stream key', () => {
      const p = reg.socketPath('abc/def:xyz');
      expect(path.basename(p)).not.toMatch(/[^a-z0-9_\-.]/i);
    });

    it('truncates the stream key to 48 chars (fits a full UUID)', () => {
      const longKey = 'a'.repeat(100);
      const p = reg.socketPath(longKey);
      const safePart = path.basename(p).replace('gw-pty-', '').replace('.sock', '');
      expect(safePart.length).toBeLessThanOrEqual(48);
    });

    it('gives two distinct session ids distinct socket paths (no collision)', () => {
      const a = reg.socketPath('53c1e240-0dd4-4a5f-8a65-5f3448368aab');
      const b = reg.socketPath('3c01897c-204e-470a-a856-f3a260c49392');
      expect(a).not.toEqual(b);
    });
  });

  describe('hasSockets', () => {
    it('returns false when no sockets registered', () => {
      expect(reg.hasSockets('agent1')).toBe(false);
    });

    it('returns true after listen()', () => {
      const sockPath = path.join(tmpDir, 'test.sock');
      reg.listen('agent1', sockPath);
      expect(reg.hasSockets('agent1')).toBe(true);
      reg.close(sockPath);
    });

    it('returns false after close()', () => {
      const sockPath = path.join(tmpDir, 'test2.sock');
      reg.listen('agent1', sockPath);
      reg.close(sockPath);
      expect(reg.hasSockets('agent1')).toBe(false);
    });

    it('does not cross-contaminate agents', () => {
      const sockPath = path.join(tmpDir, 'agent2.sock');
      reg.listen('agent2', sockPath);
      expect(reg.hasSockets('agent1')).toBe(false);
      expect(reg.hasSockets('agent2')).toBe(true);
      reg.close(sockPath);
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('unsubscribe after subscribe is a no-op', () => {
      const ws = makeWs();
      reg.subscribe('agent1', ws);
      reg.unsubscribe('agent1', ws);
      expect(() => reg.broadcast('agent1', 'hello')).not.toThrow();
    });

    it('unsubscribe on unknown agent is a no-op', () => {
      const ws = makeWs();
      expect(() => reg.unsubscribe('nobody', ws)).not.toThrow();
    });

    it('cleans up empty Set after last unsubscribe', () => {
      const ws = makeWs();
      reg.subscribe('agent1', ws);
      reg.unsubscribe('agent1', ws);
      expect((reg as any).clients.has('agent1')).toBe(false);
    });
  });

  describe('broadcast', () => {
    it('sends binary buffer to OPEN ws clients', () => {
      const ws = makeWs(1);
      reg.subscribe('agent1', ws);
      reg.broadcast('agent1', 'hello');
      expect(ws.sentBuffers).toHaveLength(1);
      expect(ws.sentBuffers[0]).toEqual(Buffer.from('hello', 'latin1'));
    });

    it('skips non-OPEN clients', () => {
      const ws = makeWs(3); // CLOSING
      reg.subscribe('agent1', ws);
      reg.broadcast('agent1', 'hello');
      expect(ws.sentBuffers).toHaveLength(0);
    });

    it('preserves latin1 bytes faithfully (ANSI escapes)', () => {
      const ws = makeWs(1);
      reg.subscribe('agent1', ws);
      const raw = '\x1b[32mGreen\x1b[0m';
      reg.broadcast('agent1', raw);
      expect(ws.sentBuffers[0]).toEqual(Buffer.from(raw, 'latin1'));
    });

    it('is a no-op when no subscribers', () => {
      expect(() => reg.broadcast('ghost', 'data')).not.toThrow();
    });

    it('broadcasts to multiple subscribers', () => {
      const ws1 = makeWs(1);
      const ws2 = makeWs(1);
      reg.subscribe('agent1', ws1);
      reg.subscribe('agent1', ws2);
      reg.broadcast('agent1', 'hi');
      expect(ws1.sentBuffers).toHaveLength(1);
      expect(ws2.sentBuffers).toHaveLength(1);
    });
  });

  describe('screen replay', () => {
    // The serialized frame is delivered inside xterm's write-flush callback
    // (async), so a late subscriber's frame lands on a later tick than subscribe().
    async function waitForFrame(ws: any, timeoutMs = 1000): Promise<void> {
      const start = Date.now();
      while (ws.sentBuffers.length === 0 && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    const frameText = (ws: any): string => Buffer.concat(ws.sentBuffers).toString('utf8');

    it('replays the current screen to a client that subscribes after data arrived', async () => {
      // Data broadcast before anyone is subscribed still builds the screen mirror.
      reg.broadcast('agent1', 'old-line-1\r\n');
      reg.broadcast('agent1', 'old-line-2\r\n');

      const ws = makeWs(1);
      reg.subscribe('agent1', ws);
      await waitForFrame(ws);

      // The late subscriber receives one serialized frame reconstructing the screen.
      expect(ws.sentBuffers).toHaveLength(1);
      const text = frameText(ws);
      expect(text).toContain('old-line-1');
      expect(text).toContain('old-line-2');
    });

    it('does not replay across agents', async () => {
      reg.broadcast('agent1', 'a1-data');
      const ws = makeWs(1);
      reg.subscribe('agent2', ws);
      await new Promise((r) => setTimeout(r, 30));
      expect(ws.sentBuffers).toHaveLength(0);
    });

    it('resets the screen when a fresh session (first socket) starts', async () => {
      const sockPath = path.join(tmpDir, 'sb.sock');
      reg.broadcast('agent1', 'stale-from-previous-session');
      // New session begins → first listen() for the agent clears the stale screen.
      reg.listen('agent1', sockPath);
      const ws = makeWs(1);
      reg.subscribe('agent1', ws);
      await waitForFrame(ws, 100);
      // A frame may be sent, but it must NOT carry content from the prior session.
      expect(frameText(ws)).not.toContain('stale-from-previous-session');
      reg.close(sockPath);
    });

    it('replays the latest screen, not a truncated byte history, after heavy output', async () => {
      // Push far past any byte ring-buffer cap, then a final repaint. The frame
      // must reflect the live grid (final content), and stay bounded by screen size.
      reg.broadcast('agent1', '\x1b[?1049h\x1b[2J');
      const noise = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 8; i++) reg.broadcast('agent1', '\x1b[1;1H' + noise);
      reg.broadcast('agent1', '\x1b[2J\x1b[1;1HFINAL-TOP\x1b[50;1HFINAL-BOTTOM');

      const ws = makeWs(1);
      reg.subscribe('agent1', ws);
      await waitForFrame(ws);

      const text = frameText(ws);
      expect(text).toContain('FINAL-TOP');
      expect(text).toContain('FINAL-BOTTOM');
      expect(text).not.toContain('xxxxxxxxxx'); // stale noise must be gone
      // A 200x50 screen frame is far smaller than the old 256 KiB raw cap.
      expect(Buffer.concat(ws.sentBuffers).length).toBeLessThanOrEqual(256 * 1024);
    });

    it('isolates concurrent sessions of the same agent (regression: keyed by sessionId)', async () => {
      // Two sessions for one agent — keyed by their own session ids. The bug was
      // keying by agentId, which merged both into one interleaved mirror and made
      // the viewer unable to target a specific session.
      const sessA = 'sess-aaaa';
      const sessB = 'sess-bbbb';
      reg.broadcast(sessA, '\x1b[2J\x1b[1;1HSESSION-A-CONTENT');
      reg.broadcast(sessB, '\x1b[2J\x1b[1;1HSESSION-B-CONTENT');

      const wsA = makeWs(1);
      const wsB = makeWs(1);
      reg.subscribe(sessA, wsA);
      reg.subscribe(sessB, wsB);
      await waitForFrame(wsA);
      await waitForFrame(wsB);

      const textA = frameText(wsA);
      const textB = frameText(wsB);
      // Each subscriber sees only its own session's screen — no interleaving.
      expect(textA).toContain('SESSION-A-CONTENT');
      expect(textA).not.toContain('SESSION-B-CONTENT');
      expect(textB).toContain('SESSION-B-CONTENT');
      expect(textB).not.toContain('SESSION-A-CONTENT');
    });

    it('broadcast to one session does not reach another session\'s subscriber', () => {
      const wsA = makeWs(1);
      reg.subscribe('sess-A', wsA);
      reg.broadcast('sess-B', 'only-for-B');
      // Live byte for session B must not be delivered to session A's client.
      expect(wsA.sentBuffers.every((b: Buffer) => !b.toString('latin1').includes('only-for-B'))).toBe(true);
    });
  });

  describe('screenText', () => {
    it('returns null when no mirror exists for the session', async () => {
      expect(await reg.screenText('nonexistent')).toBeNull();
    });

    it('returns plain text with ANSI codes stripped', async () => {
      // Feed ANSI-decorated content: bold + color + text
      reg.broadcast('sess-st', '\x1b[2J\x1b[1;1H\x1b[1;32mHello\x1b[0m World');
      const snap = await reg.screenText('sess-st');
      expect(snap).not.toBeNull();
      // Text content only — no escape sequences
      expect(snap!.text).toContain('Hello World');
      expect(snap!.text).not.toContain('\x1b[');
    });

    it('returns cursor position and dimensions', async () => {
      reg.broadcast('sess-cur', '\x1b[2J\x1b[3;5HX');
      const snap = await reg.screenText('sess-cur');
      expect(snap).not.toBeNull();
      expect(snap!.cursorRow).toBeGreaterThanOrEqual(0);
      expect(snap!.cursorCol).toBeGreaterThanOrEqual(0);
      expect(snap!.cols).toBe(200);
      expect(snap!.rows).toBe(50);
    });

    it('trims trailing blank lines', async () => {
      // Write only on row 1; rows 2-50 are blank
      reg.broadcast('sess-trim', '\x1b[2J\x1b[1;1HOnlyOneLine');
      const snap = await reg.screenText('sess-trim');
      expect(snap).not.toBeNull();
      const lines = snap!.text.split('\n');
      // Last line should not be blank
      expect(lines[lines.length - 1]).not.toBe('');
      expect(snap!.text).toContain('OnlyOneLine');
    });

    it('handles multi-byte UTF-8 (Thai) without mojibake', async () => {
      // Simulate production path: UTF-8 bytes → latin1 string (socket encoding)
      const thaiMsg = 'สวัสดี';
      const latin1 = Buffer.from(thaiMsg, 'utf8').toString('latin1');
      reg.broadcast('sess-thai', `\x1b[2J\x1b[1;1H${latin1}`);
      const snap = await reg.screenText('sess-thai');
      expect(snap).not.toBeNull();
      expect(snap!.text).toContain(thaiMsg);
      expect(snap!.text).not.toMatch(/à¸/); // no mojibake
    });

    it('two sessions have independent screen snapshots', async () => {
      reg.broadcast('sess-x', '\x1b[2J\x1b[1;1HSCREEN-X');
      reg.broadcast('sess-y', '\x1b[2J\x1b[1;1HSCREEN-Y');
      const [snapX, snapY] = await Promise.all([
        reg.screenText('sess-x'),
        reg.screenText('sess-y'),
      ]);
      expect(snapX!.text).toContain('SCREEN-X');
      expect(snapX!.text).not.toContain('SCREEN-Y');
      expect(snapY!.text).toContain('SCREEN-Y');
      expect(snapY!.text).not.toContain('SCREEN-X');
    });
  });
});
