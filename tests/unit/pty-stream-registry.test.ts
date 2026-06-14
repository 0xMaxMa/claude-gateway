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
    it('strips non-alphanumeric chars from sessionKey', () => {
      const p = reg.socketPath('agent1', 'abc/def:xyz');
      expect(path.basename(p)).not.toMatch(/[^a-z0-9_\-.]/i);
    });

    it('truncates sessionKey to 32 chars', () => {
      const longKey = 'a'.repeat(100);
      const p = reg.socketPath('agent1', longKey);
      const safePart = path.basename(p).replace('gw-pty-', '').replace('.sock', '');
      expect(safePart.length).toBeLessThanOrEqual(32);
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
  });
});
