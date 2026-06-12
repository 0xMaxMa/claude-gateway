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
});
