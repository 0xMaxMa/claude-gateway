import express from 'express';
import { EventEmitter } from 'events';
import * as supertest from 'supertest';
import * as http from 'http';
import { createApiRouter, isValidSessionId } from '../../src/api/router';
import { AgentConfig, ApiKey, StreamEvent } from '../../src/types';

// ── Minimal mock AgentRunner ─────────────────────────────────────────────────

interface StreamCallbacks {
  onChunk: (event: StreamEvent) => void;
  onDone: (fullText: string, attachments: import('../../src/types').ApiAttachment[]) => void;
  onError: (err: Error) => void;
}

class MockAgentRunner extends EventEmitter {
  sendApiMessageImpl: (sessionId: string, chatId: string, message: string, opts?: { allowTools?: boolean }) => Promise<{ text: string; attachments: import('../../src/types').ApiAttachment[] }>;
  sendApiMessageStreamImpl?: (
    sessionId: string,
    chatId: string,
    message: string,
    callbacks: StreamCallbacks,
    opts?: { timeoutMs: number; allowTools?: boolean },
  ) => Promise<() => void>;
  private _activeApiSessions = new Set<string>();

  // Builtin-command handler (#157). Defaults to a simple echo; override per-test.
  executeApiCommandImpl: (
    sessionId: string,
    chatId: string,
    command: string,
    opts?: { skipPersist?: boolean },
  ) => Promise<{ result: Record<string, unknown>; responseText: string }> =
    async (_sid, _cid, command) => ({ result: { command }, responseText: `ran ${command}` });

  // Records the args of the last executeApiCommand call so tests can assert wiring.
  lastCommandCall?: { sessionId: string; chatId: string; command: string; opts?: { skipPersist?: boolean } };

  constructor(impl: (sessionId: string, chatId: string, message: string, opts?: { allowTools?: boolean }) => Promise<{ text: string; attachments: import('../../src/types').ApiAttachment[] }>) {
    super();
    this.sendApiMessageImpl = impl;
  }

  async executeApiCommand(
    sessionId: string,
    chatId: string,
    command: string,
    opts?: { skipPersist?: boolean },
  ): Promise<{ result: Record<string, unknown>; responseText: string }> {
    this.lastCommandCall = { sessionId, chatId, command, opts };
    return this.executeApiCommandImpl(sessionId, chatId, command, opts);
  }

  async sendApiMessage(
    sessionId: string,
    chatId: string,
    message: string,
    opts: { timeoutMs: number; allowTools?: boolean },
  ): Promise<{ text: string; attachments: import('../../src/types').ApiAttachment[] }> {
    return this.sendApiMessageImpl(sessionId, chatId, message, { allowTools: opts.allowTools });
  }

  async sendApiMessageStream(
    sessionId: string,
    chatId: string,
    message: string,
    callbacks: StreamCallbacks,
    _opts: { timeoutMs: number; allowTools?: boolean },
  ): Promise<() => void> {
    if (this.sendApiMessageStreamImpl) {
      return this.sendApiMessageStreamImpl(sessionId, chatId, message, callbacks, _opts);
    }
    throw new Error('sendApiMessageStream not implemented in mock');
  }

  hasActiveApiSession(sessionId: string): boolean {
    return this._activeApiSessions.has(sessionId);
  }

  markSessionActive(sessionId: string): void {
    this._activeApiSessions.add(sessionId);
  }

  // Required by media_files path validation in the router
  getAgentsBaseDir(): string {
    return '/tmp';
  }

  // Backing data for GET /v1/agents/sessions — override per-test via the impl fields.
  getHistoryDbImpl: () => { listSessions: (chatId?: string) => Array<Record<string, unknown>> } =
    () => ({ listSessions: () => [] });
  getAllSessionMetaImpl: () => Promise<Map<string, { name: string; imageConfig?: unknown; model?: string }>> =
    () => Promise.resolve(new Map());

  getHistoryDb(): { listSessions: (chatId?: string) => Array<Record<string, unknown>> } {
    return this.getHistoryDbImpl();
  }

  getAllSessionMeta(): Promise<Map<string, { name: string; imageConfig?: unknown; model?: string }>> {
    return this.getAllSessionMetaImpl();
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

const AGENT_ID = 'alfred';

const agentConfig: AgentConfig = {
  id: AGENT_ID,
  description: 'Personal assistant',
  workspace: '/tmp/alfred',
  env: '',
  telegram: { botToken: 'tok' },
  claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
};

const apiKeys: ApiKey[] = [
  { key: 'sk-test-app', agents: [AGENT_ID] },
  { key: 'sk-test-admin', agents: '*', admin: true },
  { key: 'sk-test-tools', agents: [AGENT_ID], allow_tools: true },
  { key: 'sk-test-write', agents: [AGENT_ID], write: true },
];

function buildApp(runnerImpl: (sessionId: string, chatId: string, msg: string) => Promise<{ text: string; attachments: import('../../src/types').ApiAttachment[] }>) {
  const runner = new MockAgentRunner(runnerImpl);
  const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
  const configs = new Map([[AGENT_ID, agentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
  return app;
}

function buildStreamApp(
  streamImpl: (
    sessionId: string,
    chatId: string,
    message: string,
    callbacks: StreamCallbacks,
    opts?: { timeoutMs: number; allowTools?: boolean },
  ) => Promise<() => void>,
): { app: express.Express; runner: MockAgentRunner } {
  const runner = new MockAgentRunner(async () => ({ text: 'ok', attachments: [] }));
  runner.sendApiMessageStreamImpl = streamImpl;
  const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
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
    const app = buildApp(async () => ({ text: 'Hello!', attachments: [] }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'Hi', chat_id: 'test-chat' });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe('Hello!');
    expect(res.body.agent_id).toBe(AGENT_ID);
    expect(typeof res.body.request_id).toBe('string');
    expect(typeof res.body.session_id).toBe('string');
    expect(typeof res.body.duration_ms).toBe('number');
  });

  it('echoes back provided session_id', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'ping', chat_id: 'test-chat', session_id: 'my-session-001' });
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe('my-session-001');
  });

  it('generates a uuid session_id when not provided', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'ping', chat_id: 'test-chat' });
    expect(res.status).toBe(200);
    // UUID v4 pattern
    expect(res.body.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('returns 400 when message is missing and no media_files provided', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ chat_id: 'test-chat' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/i);
  });

  it('returns 400 when message is empty string and no media_files provided', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: '   ', chat_id: 'test-chat' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/i);
  });

  it('returns 200 when message is missing but media_files is provided (image-only)', async () => {
    let receivedMessage: string | undefined;
    const app = buildApp(async (_sid, _chatId, msg) => {
      receivedMessage = msg;
      return { text: 'Saw the image.', attachments: [] };
    });
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ chat_id: 'test-chat', media_files: ['ui-upload/abc/test.jpg'] });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe('Saw the image.');
    // Runner receives empty string when no text was provided
    expect(receivedMessage).toBe('');
  });

  it('returns 200 when message is empty string but media_files is provided', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: '   ', chat_id: 'test-chat', media_files: ['ui-upload/abc/test.jpg'] });
    expect(res.status).toBe(200);
  });

  it('returns 400 when message exceeds 10,000 chars', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'x'.repeat(10_001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  it('returns 400 when session_id is not a string', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi', chat_id: 'test-chat', session_id: 123 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when session_id contains path-traversal characters', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi', chat_id: 'test-chat', session_id: '../evil' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/session_id must be/);
  });

  it('returns 401 when no auth header', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when key has no access to agent', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    // Use a key that only accesses a different agent
    const restrictedKeys: ApiKey[] = [{ key: 'sk-test-app', agents: ['other-agent'] }];
    const runner = new MockAgentRunner(async () => ({ text: 'ok', attachments: [] }));
    const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
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
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
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
      .send({ message: 'hi', chat_id: 'test-chat' });
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
      .send({ message: 'hi', chat_id: 'test-chat' });
    expect(res.status).toBe(409);
  });

  it('returns 500 on unexpected error', async () => {
    const app = buildApp(async () => {
      throw new Error('unexpected');
    });
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi', chat_id: 'test-chat' });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/v1/agents', () => {
  it('returns only agents accessible by the key', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .get('/api/v1/agents')
      .set(AUTH); // sk-test-app → only alfred
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].id).toBe(AGENT_ID);
  });

  it('admin key returns all agents', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .get('/api/v1/agents')
      .set({ Authorization: 'Bearer sk-test-admin' });
    expect(res.status).toBe(200);
    expect(res.body.agents.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 401 without auth', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app).get('/api/v1/agents');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/agents — access control', () => {
  it('returns 403 for non-admin key', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post('/api/v1/agents')
      .set(AUTH) // sk-test-app — no admin flag
      .send({ id: 'new-agent', description: 'test' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin key required/i);
  });

  it('returns 403 for write key without admin flag', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post('/api/v1/agents')
      .set({ Authorization: 'Bearer sk-test-write' })
      .send({ id: 'new-agent', description: 'test' });
    expect(res.status).toBe(403);
  });

  it('admin key passes auth check (returns 501 without configPath)', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .post('/api/v1/agents')
      .set({ Authorization: 'Bearer sk-test-admin' })
      .send({ id: 'new-agent', description: 'test' });
    expect(res.status).toBe(501); // no configPath — auth check passed
  });
});

describe('PATCH /api/v1/agents/:agentId — access control', () => {
  it('returns 403 for key without write flag', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .patch(`/api/v1/agents/${AGENT_ID}`)
      .set(AUTH) // sk-test-app — no write flag
      .send({ description: 'new desc' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/write permission required/i);
  });

  it('write key with correct scope passes auth check (returns 501 without configPath)', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .patch(`/api/v1/agents/${AGENT_ID}`)
      .set({ Authorization: 'Bearer sk-test-write' })
      .send({ description: 'new desc' });
    expect(res.status).toBe(501); // auth passed, no configPath
  });

  it('admin key passes auth check', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .patch(`/api/v1/agents/${AGENT_ID}`)
      .set({ Authorization: 'Bearer sk-test-admin' })
      .send({ description: 'new desc' });
    expect(res.status).toBe(501); // auth passed, no configPath
  });
});

describe('DELETE /api/v1/agents/:agentId — access control', () => {
  it('returns 403 for non-admin key', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .delete(`/api/v1/agents/${AGENT_ID}`)
      .set(AUTH);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin key required/i);
  });

  it('returns 403 for write key without admin flag', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .delete(`/api/v1/agents/${AGENT_ID}`)
      .set({ Authorization: 'Bearer sk-test-write' });
    expect(res.status).toBe(403);
  });

  it('admin key passes auth check (returns 501 without configPath)', async () => {
    const app = buildApp(async () => ({ text: 'ok', attachments: [] }));
    const res = await supertest.default(app)
      .delete(`/api/v1/agents/${AGENT_ID}`)
      .set({ Authorization: 'Bearer sk-test-admin' });
    expect(res.status).toBe(501); // auth passed, no configPath
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
  auth = 'Bearer sk-test-app',
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
            'Authorization': auth,
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
    const { app } = buildStreamApp(async (_sid, _chatId, _msg, cb) => {
      cb.onDone('Hello', []);
      return () => {};
    });
    const { status, headers } = await collectSSE(app, { message: 'hi', chat_id: 'test-chat', stream: true });
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
  });

  // T2: text_delta events
  it('T2: stream receives text_delta events', async () => {
    const { app } = buildStreamApp(async (_sid, _chatId, _msg, cb) => {
      cb.onChunk({ type: 'text_delta', text: 'Hello' });
      cb.onChunk({ type: 'text_delta', text: ' world' });
      cb.onDone('Hello world', []);
      return () => {};
    });
    const { data } = await collectSSE(app, { message: 'hi', chat_id: 'test-chat', stream: true });
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
    const { app } = buildStreamApp(async (_sid, _chatId, _msg, cb) => {
      cb.onDone('done', []);
      return () => {};
    });
    const { data } = await collectSSE(app, { message: 'hi', chat_id: 'test-chat', stream: true });
    expect(data.trimEnd()).toMatch(/data: \[DONE\]$/);
  });

  // T4: no message returns 400 JSON
  it('T4: stream with no message and no media_files returns 400 JSON', async () => {
    const { app } = buildStreamApp(async (_sid, _chatId, _msg, cb) => {
      cb.onDone('ok', []);
      return () => {};
    });
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ chat_id: 'test-chat', stream: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/i);
  });

  // T4b: stream + image-only (no message) returns 200 SSE
  it('T4b: stream with image-only (no message) returns 200', async () => {
    const { app } = buildStreamApp(async (_sid, _chatId, _msg, cb) => {
      cb.onDone('Saw the image.', []);
      return () => {};
    });
    const { status } = await collectSSE(app, {
      chat_id: 'test-chat',
      stream: true,
      media_files: ['ui-upload/abc/test.jpg'],
    });
    expect(status).toBe(200);
  });

  // T5: conflict returns 409 JSON
  it('T5: stream conflict returns 409 JSON', async () => {
    const { app, runner } = buildStreamApp(async (_sid, _chatId, _msg, cb) => {
      cb.onDone('ok', []);
      return () => {};
    });
    runner.markSessionActive('conflict-session');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi', chat_id: 'test-chat', session_id: 'conflict-session', stream: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pending request/i);
  });

  // T6: timeout sends error event in SSE
  it('T6: stream timeout sends error event in SSE', async () => {
    const { app } = buildStreamApp(async (_sid, _chatId, _msg, cb) => {
      cb.onError(new Error('Agent response timeout'));
      return () => {};
    });
    const { data } = await collectSSE(app, { message: 'hi', chat_id: 'test-chat', stream: true });
    const lines = data.split('\n').filter(l => l.startsWith('data: '));
    const events = lines.map(l => l.slice(6)).filter(s => s !== '[DONE]');
    const errorEvent = JSON.parse(events[events.length - 1]);
    expect(errorEvent.type).toBe('error');
    expect(errorEvent.message).toMatch(/timeout/i);
  });

  // T7: stream=false still works (regression)
  it('T7: stream=false returns existing JSON behavior', async () => {
    const app = buildApp(async () => ({ text: 'Hello!', attachments: [] }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'Hi', chat_id: 'test-chat', stream: false });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe('Hello!');
  });

  // T8: client disconnect triggers cleanup
  it('T8: client disconnect triggers cleanup function', async () => {
    let cleanupCalled = false;
    let sendChunk: ((event: StreamEvent) => void) | undefined;

    const { app } = buildStreamApp(async (_sid, _chatId, _msg, cb) => {
      sendChunk = cb.onChunk;
      // Send initial chunk so client gets data
      cb.onChunk({ type: 'text_delta', text: 'hi' });
      return () => { cleanupCalled = true; };
    });

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const reqBody = JSON.stringify({ message: 'hi', chat_id: 'test-chat', stream: true });
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

  // T8b: onDone fires after SSE client disconnects — no crash, router stays stable
  it('T8b: onDone fires after SSE client disconnects — no crash', async () => {
    let onDoneCalled = false;
    let savedCallbacks: StreamCallbacks | undefined;

    const { app } = buildStreamApp(async (_sid, _chatId, _msg, cb) => {
      savedCallbacks = cb;
      cb.onChunk({ type: 'text_delta', text: 'partial' });
      // Disconnect handler: simulate Claude finishing after client leaves
      return () => {
        setTimeout(() => {
          savedCallbacks!.onDone('full response after disconnect', []);
          onDoneCalled = true;
        }, 50);
      };
    });

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const reqBody = JSON.stringify({ message: 'hi', chat_id: 'test-chat', stream: true });
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
            res.once('data', () => { res.destroy(); });
          },
        );
        req.on('error', () => {});
        req.write(reqBody);
        req.end();
        setTimeout(() => { server.close(); resolve(); }, 500);
      });
      server.on('error', reject);
    });

    await new Promise(r => setTimeout(r, 200));
    expect(onDoneCalled).toBe(true);
  }, 10000);

  // T-ALLOW-TOOLS-1: key with allow_tools=true passes allowTools=true to runner
  it('T-ALLOW-TOOLS-1: key with allow_tools=true passes allowTools=true to runner', async () => {
    let capturedOpts: { timeoutMs: number; allowTools?: boolean } | undefined;
    const runner = new MockAgentRunner(async () => ({ text: 'ok', attachments: [] }));
    runner.sendApiMessageStream = async (sid, chatId, msg, cbs, opts) => {
      capturedOpts = opts as { timeoutMs: number; allowTools?: boolean };
      cbs.onDone('done', []);
      return () => {};
    };

    const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
    const configs = new Map([[AGENT_ID, agentConfig]]);
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys));

    await collectSSE(app, { message: 'run job', chat_id: 'test-chat', stream: true }, 'Bearer sk-test-tools');

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.allowTools).toBe(true);
  });

  // T-ALLOW-TOOLS-2: key without allow_tools passes allowTools=false to runner
  it('T-ALLOW-TOOLS-2: key without allow_tools passes allowTools=false to runner', async () => {
    let capturedOpts: { timeoutMs: number; allowTools?: boolean } | undefined;
    const runner = new MockAgentRunner(async () => ({ text: 'ok', attachments: [] }));
    runner.sendApiMessageStream = async (sid, chatId, msg, cbs, opts) => {
      capturedOpts = opts as { timeoutMs: number; allowTools?: boolean };
      cbs.onDone('done', []);
      return () => {};
    };

    const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
    const configs = new Map([[AGENT_ID, agentConfig]]);
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys));

    await collectSSE(app, { message: 'hi', chat_id: 'test-chat', stream: true });

    expect(capturedOpts!.allowTools).toBe(false);
  });

  // T-ALLOW-TOOLS-3: timeout_ms forwarded to runner
  it('T-ALLOW-TOOLS-3: custom timeout_ms is forwarded to runner', async () => {
    let capturedOpts: { timeoutMs: number; allowTools?: boolean } | undefined;
    const runner = new MockAgentRunner(async () => ({ text: 'ok', attachments: [] }));
    runner.sendApiMessageStream = async (sid, chatId, msg, cbs, opts) => {
      capturedOpts = opts as { timeoutMs: number; allowTools?: boolean };
      cbs.onDone('done', []);
      return () => {};
    };

    const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
    const configs = new Map([[AGENT_ID, agentConfig]]);
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys));

    await collectSSE(app, { message: 'hi', chat_id: 'test-chat', stream: true, timeout_ms: 120000 });

    expect(capturedOpts!.timeoutMs).toBe(120000);
  });

  // T-ALLOW-TOOLS-4: timeout_ms over max is clamped to default (60000)
  it('T-ALLOW-TOOLS-4: timeout_ms over max is clamped to default', async () => {
    let capturedOpts: { timeoutMs: number } | undefined;
    const runner = new MockAgentRunner(async () => ({ text: 'ok', attachments: [] }));
    runner.sendApiMessageStream = async (sid, chatId, msg, cbs, opts) => {
      capturedOpts = opts as { timeoutMs: number };
      cbs.onDone('done', []);
      return () => {};
    };

    const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
    const configs = new Map([[AGENT_ID, agentConfig]]);
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys));

    await collectSSE(app, { message: 'hi', chat_id: 'test-chat', stream: true, timeout_ms: 999999 });

    expect(capturedOpts!.timeoutMs).toBe(60000); // DEFAULT_TIMEOUT_MS
  });

  // I-API-14: key with allow_tools=true passes allowTools=true to sync runner
  it('I-API-14: key with allow_tools=true passes allowTools=true to sync sendApiMessage', async () => {
    let capturedAllowTools: boolean | undefined;
    const runner = new MockAgentRunner(async (_sid, _chatId, _msg, opts) => {
      capturedAllowTools = opts?.allowTools;
      return { text: 'ok', attachments: [] };
    });
    const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
    const configs = new Map([[AGENT_ID, agentConfig]]);
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys));

    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/messages`)
      .set('Authorization', 'Bearer sk-test-tools')
      .send({ message: 'run job', chat_id: 'test-chat' });

    expect(res.status).toBe(200);
    expect(capturedAllowTools).toBe(true);
  });

  // I-API-15: key without allow_tools passes allowTools=false to sync runner
  it('I-API-15: key without allow_tools passes allowTools=false to sync sendApiMessage', async () => {
    let capturedAllowTools: boolean | undefined;
    const runner = new MockAgentRunner(async (_sid, _chatId, _msg, opts) => {
      capturedAllowTools = opts?.allowTools;
      return { text: 'ok', attachments: [] };
    });
    const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
    const configs = new Map([[AGENT_ID, agentConfig]]);
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys));

    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/messages`)
      .set('Authorization', 'Bearer sk-test-app')
      .send({ message: 'hello', chat_id: 'test-chat' });

    expect(res.status).toBe(200);
    expect(capturedAllowTools).toBe(false);
  });

  // T-API-STREAM-TCP: TCP_NODELAY is set on SSE connections (regression test)
  it('T-API-STREAM-TCP: SSE streaming works correctly with TCP_NODELAY set', async () => {
    const { app } = buildStreamApp(async (_sid, _chatId, _msg, cb) => {
      cb.onChunk({ type: 'text_delta', text: 'fast' });
      cb.onChunk({ type: 'text_delta', text: ' response' });
      cb.onDone('fast response', []);
      return () => {};
    });
    const { status, headers, data } = await collectSSE(app, { message: 'hi', chat_id: 'test-chat', stream: true });
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/event-stream');

    // Verify the stream data is correct (regression: setNoDelay should not break streaming)
    const lines = data.split('\n').filter(l => l.startsWith('data: '));
    const events = lines
      .map(l => l.slice(6))
      .filter(s => s !== '[DONE]')
      .map(s => JSON.parse(s));
    const deltas = events.filter((e: { type: string }) => e.type === 'text_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].text).toBe('fast');
    expect(deltas[1].text).toBe(' response');

    // Verify stream ends with [DONE]
    expect(data.trimEnd()).toMatch(/data: \[DONE\]$/);
  });
});

// ── Builtin command response path (#157) ─────────────────────────────────────
//
// Builtin commands (/model, /session, /clear, …) are answered locally via
// executeApiCommand but flow through the SAME response path as a normal message:
// SSE events when streaming, the normal JSON shape when sync. They also bypass
// the 409 preflight (so /stop works mid-session) and never reach Claude.

function buildCommandApp(
  execImpl?: MockAgentRunner['executeApiCommandImpl'],
): { app: express.Express; runner: MockAgentRunner } {
  // If the command path ever falls through to Claude, these impls throw → test fails.
  const runner = new MockAgentRunner(async () => { throw new Error('command leaked to sendApiMessage'); });
  runner.sendApiMessageStreamImpl = async () => { throw new Error('command leaked to sendApiMessageStream'); };
  if (execImpl) runner.executeApiCommandImpl = execImpl;
  const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
  const configs = new Map([[AGENT_ID, agentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
  return { app, runner };
}

function parseSSE(data: string): Array<Record<string, unknown>> {
  return data.split('\n')
    .filter(l => l.startsWith('data: '))
    .map(l => l.slice(6))
    .filter(s => s !== '[DONE]')
    .map(s => JSON.parse(s) as Record<string, unknown>);
}

describe('POST /api/v1/agents/:agentId/messages — builtin commands (#157)', () => {
  // ── stream: true ──────────────────────────────────────────────────────────
  it('C1: stream command emits text_delta + result + [DONE]', async () => {
    const { app } = buildCommandApp(async () => ({ result: { model: 'opus' }, responseText: 'Current model: opus' }));
    const { status, headers, data } = await collectSSE(app, { message: '/model', chat_id: 'c1', session_id: 's1', stream: true });

    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/event-stream');

    const events = parseSSE(data);
    const delta = events.find(e => e.type === 'text_delta');
    const result = events.find(e => e.type === 'result');
    expect(delta?.text).toBe('Current model: opus');
    expect(result?.text).toBe('Current model: opus');
    expect(result?.session_id).toBe('s1');
    expect(data.trimEnd()).toMatch(/data: \[DONE\]$/);
  });

  it('C2: stream command with arguments resolves and reaches executeApiCommand verbatim', async () => {
    const { app, runner } = buildCommandApp(async () => ({ result: {}, responseText: 'ok' }));
    await collectSSE(app, { message: '/model sonnet', chat_id: 'c2', stream: true });

    // The full command text (not just the base token) is handed to the runner.
    expect(runner.lastCommandCall?.command).toBe('/model sonnet');
  });

  it('C3: stream command failure emits an SSE error event', async () => {
    const { app } = buildCommandApp(async () => { throw new Error('Not enough messages'); });
    const { data } = await collectSSE(app, { message: '/compact', chat_id: 'c3', stream: true });

    const events = parseSSE(data);
    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent?.message).toBe('Not enough messages');
  });

  it('C4: stream command bypasses the 409 preflight (works mid-session)', async () => {
    const { app, runner } = buildCommandApp(async () => ({ result: { stopped: true }, responseText: 'Session interrupted.' }));
    runner.markSessionActive('busy-session'); // a normal message here would 409

    const { status, data } = await collectSSE(app, { message: '/stop', chat_id: 'c4', session_id: 'busy-session', stream: true });

    expect(status).toBe(200);
    expect(parseSSE(data).find(e => e.type === 'result')?.text).toBe('Session interrupted.');
  });

  it('C5: stream command forwards skipPersist=true when store_user_message=false', async () => {
    const { app, runner } = buildCommandApp(async () => ({ result: {}, responseText: 'ok' }));
    // store_user_message:false requires a write/admin key.
    await collectSSE(app, { message: '/model', chat_id: 'c5', stream: true, store_user_message: false }, 'Bearer sk-test-write');

    expect(runner.lastCommandCall?.opts?.skipPersist).toBe(true);
  });

  // ── stream: false (sync) ────────────────────────────────────────────────────
  it('C6: sync command returns the normal reply JSON shape', async () => {
    const { app } = buildCommandApp(async () => ({ result: { model: 'opus' }, responseText: 'Current model: opus' }));
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: '/model', chat_id: 'c6', session_id: 's6', stream: false });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe('Current model: opus');
    expect(res.body.agent_id).toBe(AGENT_ID);
    expect(res.body.session_id).toBe('s6');
    expect(typeof res.body.request_id).toBe('string');
    expect(typeof res.body.duration_ms).toBe('number');
  });

  it('C7: sync command failure returns 500', async () => {
    const { app } = buildCommandApp(async () => { throw new Error('boom'); });
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: '/compact', chat_id: 'c7', stream: false });

    expect(res.status).toBe(500);
  });

  // ── regression: non-builtin text is NOT intercepted ──────────────────────────
  it('C8: a non-builtin slash message falls through to Claude (not intercepted)', async () => {
    // executeApiCommand throws if called; sendApiMessage answers normally.
    const runner = new MockAgentRunner(async () => ({ text: 'claude answer', attachments: [] }));
    runner.executeApiCommandImpl = async () => { throw new Error('should not intercept /foobar'); };
    const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
    const configs = new Map([[AGENT_ID, agentConfig]]);
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys));

    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: '/foobar', chat_id: 'c8', stream: false });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe('claude answer');
    expect(runner.lastCommandCall).toBeUndefined();
  });
});

// ── GET /v1/agents/sessions — model field exposure (#273) ────────────────────

describe('GET /api/v1/agents/sessions', () => {
  const SESSIONS_URL = '/api/v1/agents/sessions';
  const ADMIN_AUTH = { Authorization: 'Bearer sk-test-admin' };

  function makeHistorySession(sessionId: string, overrides: Record<string, unknown> = {}) {
    return {
      chatId: 'chat:1',
      sessionId,
      source: 'telegram',
      messageCount: 2,
      createdAt: 1000,
      lastActivity: 2000,
      lastMessage: 'hi',
      lastMessageRole: 'assistant',
      sessionName: null,
      ...overrides,
    };
  }

  function buildSessionsApp(agents: Record<string, { sessions: Array<Record<string, unknown>>; metaMap: Map<string, { name: string; imageConfig?: unknown; model?: string }> }>) {
    const runners = new Map<string, import('../../src/agent/runner').AgentRunner>();
    const configs = new Map<string, AgentConfig>();
    for (const [id, data] of Object.entries(agents)) {
      const runner = new MockAgentRunner(async () => ({ text: 'ok', attachments: [] }));
      runner.getHistoryDbImpl = () => ({ listSessions: () => data.sessions });
      runner.getAllSessionMetaImpl = () => Promise.resolve(data.metaMap);
      runners.set(id, runner as unknown as import('../../src/agent/runner').AgentRunner);
      configs.set(id, { ...agentConfig, id, description: `desc-${id}` });
    }
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys));
    return app;
  }

  it('S1: exposes model from getAllSessionMeta on each session', async () => {
    const app = buildSessionsApp({
      [AGENT_ID]: {
        sessions: [makeHistorySession('sess-1')],
        metaMap: new Map([['sess-1', { name: 'My Session', model: 'claude-opus-4-8' }]]),
      },
    });

    const res = await supertest.default(app).get(SESSIONS_URL).set(ADMIN_AUTH);

    expect(res.status).toBe(200);
    const session = res.body.agents[0].sessions[0];
    expect(session.model).toBe('claude-opus-4-8');
    expect(session.sessionName).toBe('My Session');
  });

  it('S2 (bad case): a session with no meta entry at all reports model: null, not undefined/missing', async () => {
    const app = buildSessionsApp({
      [AGENT_ID]: {
        sessions: [makeHistorySession('sess-orphan')],
        metaMap: new Map(), // no meta registered for this session
      },
    });

    const res = await supertest.default(app).get(SESSIONS_URL).set(ADMIN_AUTH);

    expect(res.status).toBe(200);
    const session = res.body.agents[0].sessions[0];
    expect(session).toHaveProperty('model');
    expect(session.model).toBeNull();
  });

  it('S3 (bad case): a meta entry that predates the model field reports model: null', async () => {
    const app = buildSessionsApp({
      [AGENT_ID]: {
        sessions: [makeHistorySession('sess-old')],
        metaMap: new Map([['sess-old', { name: 'Old Session' }]]), // no `model` key
      },
    });

    const res = await supertest.default(app).get(SESSIONS_URL).set(ADMIN_AUTH);

    expect(res.status).toBe(200);
    expect(res.body.agents[0].sessions[0].model).toBeNull();
  });

  it('S4: models stay correctly scoped per-agent across multiple agents', async () => {
    const app = buildSessionsApp({
      alfred: {
        sessions: [makeHistorySession('sess-a')],
        metaMap: new Map([['sess-a', { name: 'A', model: 'claude-sonnet-4-6' }]]),
      },
      baerbel: {
        sessions: [makeHistorySession('sess-b')],
        metaMap: new Map([['sess-b', { name: 'B', model: 'claude-opus-4-8' }]]),
      },
    });

    const res = await supertest.default(app).get(SESSIONS_URL).set(ADMIN_AUTH);

    expect(res.status).toBe(200);
    const byAgent = Object.fromEntries(
      (res.body.agents as Array<{ agentId: string; sessions: Array<Record<string, unknown>> }>)
        .map(a => [a.agentId, a.sessions[0].model]),
    );
    expect(byAgent.alfred).toBe('claude-sonnet-4-6');
    expect(byAgent.baerbel).toBe('claude-opus-4-8');
  });

  it('S5 (bad case): non-admin key is rejected with 403 and no session data leaks', async () => {
    const app = buildSessionsApp({
      [AGENT_ID]: {
        sessions: [makeHistorySession('sess-1')],
        metaMap: new Map([['sess-1', { name: 'Secret', model: 'claude-opus-4-8' }]]),
      },
    });

    const res = await supertest.default(app).get(SESSIONS_URL).set(AUTH); // sk-test-app, not admin

    expect(res.status).toBe(403);
    expect(res.body.agents).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('claude-opus-4-8');
  });

  it('S6 (bad case): unauthenticated request is rejected with 401', async () => {
    const app = buildSessionsApp({
      [AGENT_ID]: { sessions: [makeHistorySession('sess-1')], metaMap: new Map() },
    });

    const res = await supertest.default(app).get(SESSIONS_URL);

    expect(res.status).toBe(401);
  });

  it('S7: an agent with zero sessions returns an empty sessions array (not an error)', async () => {
    const app = buildSessionsApp({
      [AGENT_ID]: { sessions: [], metaMap: new Map() },
    });

    const res = await supertest.default(app).get(SESSIONS_URL).set(ADMIN_AUTH);

    expect(res.status).toBe(200);
    expect(res.body.agents[0].sessions).toEqual([]);
  });
});

describe('isValidSessionId', () => {
  it('accepts a normal id and a UUID', () => {
    expect(isValidSessionId('my-session-001')).toBe(true);
    expect(isValidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidSessionId('a'.repeat(64))).toBe(true);
  });

  it('rejects path-traversal, separators, dots, empty, and over-length strings', () => {
    expect(isValidSessionId('../x')).toBe(false);
    expect(isValidSessionId('a/b')).toBe(false);
    expect(isValidSessionId('.')).toBe(false);
    expect(isValidSessionId('a.jsonl')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('a'.repeat(65))).toBe(false);
    expect(isValidSessionId(123)).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
  });
});
