import express from 'express';
import { EventEmitter } from 'events';
import * as supertest from 'supertest';
import * as http from 'http';
import { createApiRouter } from '../../src/api-router';
import { AgentConfig, ApiKey, StreamEvent } from '../../src/types';

// ── Minimal mock AgentRunner ─────────────────────────────────────────────────

interface StreamCallbacks {
  onChunk: (event: StreamEvent) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

class MockAgentRunner extends EventEmitter {
  sendApiMessageImpl: (sessionId: string, message: string) => Promise<string>;
  sendApiMessageStreamImpl?: (
    sessionId: string,
    message: string,
    callbacks: StreamCallbacks,
  ) => Promise<() => void>;
  private _activeApiSessions = new Set<string>();

  constructor(impl: (sessionId: string, message: string) => Promise<string>) {
    super();
    this.sendApiMessageImpl = impl;
  }

  async sendApiMessage(
    sessionId: string,
    message: string,
    _opts: { timeoutMs: number },
  ): Promise<string> {
    return this.sendApiMessageImpl(sessionId, message);
  }

  async sendApiMessageStream(
    sessionId: string,
    message: string,
    callbacks: StreamCallbacks,
    _opts: { timeoutMs: number },
  ): Promise<() => void> {
    if (this.sendApiMessageStreamImpl) {
      return this.sendApiMessageStreamImpl(sessionId, message, callbacks);
    }
    throw new Error('sendApiMessageStream not implemented in mock');
  }

  hasActiveApiSession(sessionId: string): boolean {
    return this._activeApiSessions.has(sessionId);
  }

  markSessionActive(sessionId: string): void {
    this._activeApiSessions.add(sessionId);
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

const AGENT_ID = 'alfred';

const agentConfig: AgentConfig = {
  id: AGENT_ID,
  description: 'Personal assistant',
  workspace: '/tmp/alfred',
  env: '',
  telegram: { botToken: 'tok', allowedUsers: [], dmPolicy: 'allowlist' },
  claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
};

const apiKeys: ApiKey[] = [
  { key: 'sk-test-app', agents: [AGENT_ID] },
  { key: 'sk-test-admin', agents: '*' },
];

function buildApp(runnerImpl: (sessionId: string, msg: string) => Promise<string>) {
  const runner = new MockAgentRunner(runnerImpl);
  const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent-runner').AgentRunner]]);
  const configs = new Map([[AGENT_ID, agentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
  return app;
}

function buildStreamApp(
  streamImpl: (
    sessionId: string,
    message: string,
    callbacks: StreamCallbacks,
  ) => Promise<() => void>,
): { app: express.Express; runner: MockAgentRunner } {
  const runner = new MockAgentRunner(async () => 'ok');
  runner.sendApiMessageStreamImpl = streamImpl;
  const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent-runner').AgentRunner]]);
  const configs = new Map([[AGENT_ID, agentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
  return { app, runner };
}

const AUTH = { Authorization: 'Bearer sk-test-app' };
const POST_URL = `/api/v1/agents/${AGENT_ID}/messages`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/agents/:agentId/messages', () => {
  it('returns 200 with response on success', async () => {
    const app = buildApp(async () => 'Hello!');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'Hi' });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe('Hello!');
    expect(res.body.agent_id).toBe(AGENT_ID);
    expect(typeof res.body.request_id).toBe('string');
    expect(typeof res.body.session_id).toBe('string');
    expect(typeof res.body.duration_ms).toBe('number');
  });

  it('echoes back provided session_id', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'ping', session_id: 'my-session-001' });
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe('my-session-001');
  });

  it('generates a uuid session_id when not provided', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'ping' });
    expect(res.status).toBe(200);
    // UUID v4 pattern
    expect(res.body.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('returns 400 when message is missing', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/i);
  });

  it('returns 400 when message is empty string', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when message exceeds 10,000 chars', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'x'.repeat(10_001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  it('returns 400 when session_id is not a string', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi', session_id: 123 });
    expect(res.status).toBe(400);
  });

  it('returns 401 when no auth header', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when key has no access to agent', async () => {
    const app = buildApp(async () => 'ok');
    // Use a key that only accesses a different agent
    const restrictedKeys: ApiKey[] = [{ key: 'sk-test-app', agents: ['other-agent'] }];
    const runner = new MockAgentRunner(async () => 'ok');
    const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent-runner').AgentRunner]]);
    const configs = new Map([[AGENT_ID, agentConfig]]);
    const restrictedApp = express();
    restrictedApp.use(express.json());
    restrictedApp.use('/api', createApiRouter(runners, configs, restrictedKeys));
    const res = await supertest.default(restrictedApp)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown agent', async () => {
    const app = buildApp(async () => 'ok');
    const adminAuth = { Authorization: 'Bearer sk-test-admin' };
    const res = await supertest.default(app)
      .post('/api/v1/agents/unknown-agent/messages')
      .set(adminAuth)
      .send({ message: 'hi' });
    expect(res.status).toBe(404);
  });

  it('returns 504 on TIMEOUT error', async () => {
    const app = buildApp(async () => {
      const err = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      throw err;
    });
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi' });
    expect(res.status).toBe(504);
  });

  it('returns 409 on CONFLICT error', async () => {
    const app = buildApp(async () => {
      const err = Object.assign(new Error('conflict'), { code: 'CONFLICT' });
      throw err;
    });
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi' });
    expect(res.status).toBe(409);
  });

  it('returns 500 on unexpected error', async () => {
    const app = buildApp(async () => {
      throw new Error('unexpected');
    });
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi' });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/v1/agents', () => {
  it('returns only agents accessible by the key', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .get('/api/v1/agents')
      .set(AUTH); // sk-test-app → only alfred
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].id).toBe(AGENT_ID);
  });

  it('admin key returns all agents', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .get('/api/v1/agents')
      .set({ Authorization: 'Bearer sk-test-admin' });
    expect(res.status).toBe(200);
    expect(res.body.agents.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 401 without auth', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app).get('/api/v1/agents');
    expect(res.status).toBe(401);
  });
});

// ── SSE Streaming Tests ──────────────────────────────────────────────────────

/**
 * Helper to collect raw SSE response from a streaming POST request.
 * Uses raw http to get access to chunked response.
 */
function collectSSE(
  app: express.Express,
  body: Record<string, unknown>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const reqBody = JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: POST_URL,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer sk-test-app',
            'Content-Length': Buffer.byteLength(reqBody),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode!, headers: res.headers, data });
          });
        },
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.write(reqBody);
      req.end();
    });
  });
}

describe('POST /api/v1/agents/:agentId/messages (stream: true)', () => {
  // T1: SSE headers
  it('T1: returns SSE headers when stream=true', async () => {
    const { app } = buildStreamApp(async (_sid, _msg, cb) => {
      cb.onDone('Hello');
      return () => {};
    });
    const { status, headers } = await collectSSE(app, { message: 'hi', stream: true });
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
  });

  // T2: text_delta events
  it('T2: stream receives text_delta events', async () => {
    const { app } = buildStreamApp(async (_sid, _msg, cb) => {
      cb.onChunk({ type: 'text_delta', text: 'Hello' });
      cb.onChunk({ type: 'text_delta', text: ' world' });
      cb.onDone('Hello world');
      return () => {};
    });
    const { data } = await collectSSE(app, { message: 'hi', stream: true });
    const lines = data.split('\n').filter(l => l.startsWith('data: '));
    const events = lines
      .map(l => l.slice(6))
      .filter(s => s !== '[DONE]')
      .map(s => JSON.parse(s));
    const deltas = events.filter((e: { type: string }) => e.type === 'text_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].text).toBe('Hello');
    expect(deltas[1].text).toBe(' world');
  });

  // T3: ends with [DONE]
  it('T3: stream ends with [DONE]', async () => {
    const { app } = buildStreamApp(async (_sid, _msg, cb) => {
      cb.onDone('done');
      return () => {};
    });
    const { data } = await collectSSE(app, { message: 'hi', stream: true });
    expect(data.trimEnd()).toMatch(/data: \[DONE\]$/);
  });

  // T4: no message returns 400 JSON
  it('T4: stream with no message returns 400 JSON', async () => {
    const { app } = buildStreamApp(async (_sid, _msg, cb) => {
      cb.onDone('ok');
      return () => {};
    });
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ stream: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/i);
  });

  // T5: conflict returns 409 JSON
  it('T5: stream conflict returns 409 JSON', async () => {
    const { app, runner } = buildStreamApp(async (_sid, _msg, cb) => {
      cb.onDone('ok');
      return () => {};
    });
    runner.markSessionActive('conflict-session');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi', session_id: 'conflict-session', stream: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pending request/i);
  });

  // T6: timeout sends error event in SSE
  it('T6: stream timeout sends error event in SSE', async () => {
    const { app } = buildStreamApp(async (_sid, _msg, cb) => {
      cb.onError(new Error('Agent response timeout'));
      return () => {};
    });
    const { data } = await collectSSE(app, { message: 'hi', stream: true });
    const lines = data.split('\n').filter(l => l.startsWith('data: '));
    const events = lines.map(l => l.slice(6)).filter(s => s !== '[DONE]');
    const errorEvent = JSON.parse(events[events.length - 1]);
    expect(errorEvent.type).toBe('error');
    expect(errorEvent.message).toMatch(/timeout/i);
  });

  // T7: stream=false still works (regression)
  it('T7: stream=false returns existing JSON behavior', async () => {
    const app = buildApp(async () => 'Hello!');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'Hi', stream: false });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe('Hello!');
  });

  // T8: client disconnect triggers cleanup
  it('T8: client disconnect triggers cleanup function', async () => {
    let cleanupCalled = false;
    let sendChunk: ((event: StreamEvent) => void) | undefined;

    const { app } = buildStreamApp(async (_sid, _msg, cb) => {
      sendChunk = cb.onChunk;
      // Send initial chunk so client gets data
      cb.onChunk({ type: 'text_delta', text: 'hi' });
      return () => { cleanupCalled = true; };
    });

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const reqBody = JSON.stringify({ message: 'hi', stream: true });
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: addr.port,
            path: POST_URL,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer sk-test-app',
              'Content-Length': Buffer.byteLength(reqBody),
            },
          },
          (res) => {
            res.once('data', () => {
              // Destroy the socket to simulate client disconnect
              res.destroy();
            });
          },
        );
        req.on('error', () => { /* expected when we destroy */ });
        req.write(reqBody);
        req.end();

        // Wait for the close event to propagate
        setTimeout(() => {
          server.close();
          resolve();
        }, 500);
      });
    });

    expect(cleanupCalled).toBe(true);
  }, 10000);
});
