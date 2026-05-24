import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { SocketServer, parseTimeoutMs } from '../../../src/apps/socket-server';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'socket-server-test-'));
}

function makeSocketPath(dir: string): string {
  return path.join(dir, 'test.sock');
}

async function postToSocket(
  socketPath: string,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options: http.RequestOptions = {
      socketPath,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: raw });
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function getToSocket(
  socketPath: string,
  urlPath: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      socketPath,
      path: urlPath,
      method: 'GET',
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: raw });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SocketServer', () => {
  let server: SocketServer;
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    server = new SocketServer();
    tmpDir = makeTmpDir();
    socketPath = makeSocketPath(tmpDir);
  });

  afterEach(async () => {
    server.stopAll();
    // Give sockets time to close
    await new Promise((r) => setTimeout(r, 50));
  });

  describe('start()', () => {
    it('creates a socket file after starting', async () => {
      server.start(socketPath, {
        appName: 'test-app',
        serviceName: 'app',
        appDir: tmpDir,
        scripts: {},
      });
      // Wait for socket to be created
      await new Promise((r) => setTimeout(r, 100));
      expect(fs.existsSync(socketPath)).toBe(true);
    });

    it('is idempotent — calling start twice does not throw', () => {
      const config = {
        appName: 'test-app',
        serviceName: 'app',
        appDir: tmpDir,
        scripts: {},
      };
      server.start(socketPath, config);
      expect(() => server.start(socketPath, config)).not.toThrow();
    });
  });

  describe('stop()', () => {
    it('removes the socket file', async () => {
      server.start(socketPath, {
        appName: 'test-app',
        serviceName: 'app',
        appDir: tmpDir,
        scripts: {},
      });
      await new Promise((r) => setTimeout(r, 100));
      server.stop(socketPath);
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.existsSync(socketPath)).toBe(false);
    });

    it('is a no-op for unknown socket path', () => {
      expect(() => server.stop('/tmp/nonexistent.sock')).not.toThrow();
    });
  });

  describe('request handling', () => {
    let scriptPath: string;

    beforeEach(async () => {
      // Create a simple echo script
      scriptPath = path.join(tmpDir, 'echo.sh');
      fs.writeFileSync(scriptPath, '#!/bin/bash\necho "hello $1"', 'utf-8');
      fs.chmodSync(scriptPath, 0o755);

      server.start(socketPath, {
        appName: 'test-app',
        serviceName: 'app',
        appDir: tmpDir,
        scripts: {
          'echo-script': {
            path: 'echo.sh',
            timeoutMs: 5000,
            args: [{ name: 'name', type: 'string' }],
          },
          'no-args-script': {
            path: 'echo.sh',
            timeoutMs: 5000,
          },
        },
      });
      await new Promise((r) => setTimeout(r, 100));
    });

    it('returns 404 for GET requests (only POST supported)', async () => {
      const result = await getToSocket(socketPath, '/tool/script/echo-script');
      expect(result.status).toBe(404);
    });

    it('returns 404 for unknown URL path', async () => {
      const result = await postToSocket(socketPath, '/unknown', {});
      expect(result.status).toBe(404);
    });

    it('returns 403 for undeclared script name', async () => {
      const result = await postToSocket(socketPath, '/tool/script/evil-script', {});
      expect(result.status).toBe(403);
      expect((result.data as Record<string, string>).error).toMatch(/not declared/);
    });

    it('executes declared script and returns stdout', async () => {
      const result = await postToSocket(socketPath, '/tool/script/echo-script', {
        args: { name: 'world' },
      });
      expect(result.status).toBe(200);
      const data = result.data as Record<string, unknown>;
      expect(data.exitCode).toBe(0);
      expect(String(data.stdout).trim()).toContain('hello world');
    });

    it('executes script with no args', async () => {
      const result = await postToSocket(socketPath, '/tool/script/no-args-script', {});
      expect(result.status).toBe(200);
      const data = result.data as Record<string, unknown>;
      expect(data.exitCode).toBe(0);
    });

    it('returns 400 when arg pattern does not match', async () => {
      const scriptPath2 = path.join(tmpDir, 'strict.sh');
      fs.writeFileSync(scriptPath2, '#!/bin/bash\necho "ok"', 'utf-8');
      fs.chmodSync(scriptPath2, 0o755);

      const socketPath2 = path.join(tmpDir, 'strict.sock');
      server.start(socketPath2, {
        appName: 'test-app',
        serviceName: 'strict',
        appDir: tmpDir,
        scripts: {
          'strict-script': {
            path: 'strict.sh',
            timeoutMs: 5000,
            args: [
              {
                name: 'device',
                type: 'string',
                pattern: '^/dev/(sd|vd)[a-z]$',
              },
            ],
          },
        },
      });
      await new Promise((r) => setTimeout(r, 100));

      const bad = await postToSocket(socketPath2, '/tool/script/strict-script', {
        args: { device: '/dev/../evil' },
      });
      expect(bad.status).toBe(400);
      expect((bad.data as Record<string, string>).error).toMatch(/pattern/);

      const good = await postToSocket(socketPath2, '/tool/script/strict-script', {
        args: { device: '/dev/sda' },
      });
      expect(good.status).toBe(200);

      server.stop(socketPath2);
    });

    it('returns 400 for invalid JSON body', async () => {
      const result = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
        const options: http.RequestOptions = {
          socketPath,
          path: '/tool/script/echo-script',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        };
        const req = http.request(options, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString() });
          });
        });
        req.on('error', reject);
        req.write('not json {{{');
        req.end();
      });
      expect(result.status).toBe(400);
    });
  });

  describe('stopAll()', () => {
    it('stops all active socket servers', async () => {
      const sock1 = path.join(tmpDir, 'a.sock');
      const sock2 = path.join(tmpDir, 'b.sock');
      const config = { appName: 'x', serviceName: 's', appDir: tmpDir, scripts: {} };
      server.start(sock1, config);
      server.start(sock2, config);
      await new Promise((r) => setTimeout(r, 100));

      server.stopAll();
      await new Promise((r) => setTimeout(r, 50));

      expect(fs.existsSync(sock1)).toBe(false);
      expect(fs.existsSync(sock2)).toBe(false);
    });
  });
});

// ─── parseTimeoutMs ───────────────────────────────────────────────────────────

describe('parseTimeoutMs()', () => {
  it('parses "60s" → 60000', () => expect(parseTimeoutMs('60s')).toBe(60_000));
  it('parses "10s" → 10000', () => expect(parseTimeoutMs('10s')).toBe(10_000));
  it('parses "5s" → 5000', () => expect(parseTimeoutMs('5s')).toBe(5_000));
  it('returns 30000 for undefined', () => expect(parseTimeoutMs()).toBe(30_000));
  it('returns 30000 for invalid format', () => expect(parseTimeoutMs('2min')).toBe(30_000));
});
