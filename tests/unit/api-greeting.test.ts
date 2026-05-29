import express from 'express';
import * as supertest from 'supertest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { createApiRouter } from '../../src/api/router';
import { AgentConfig, ApiKey, StreamEvent } from '../../src/types';

// ── Mock AgentRunner for greeting tests ─────────────────────────────────────

type SseCallbacks = {
  onChunk: (event: StreamEvent) => void;
  onDone: (text: string) => void;
  onError: (err: Error) => void;
};

class MockGreetingRunner extends EventEmitter {
  private _workspacePath: string;
  sendStreamResult: string | Error = 'Hello from agent!';
  // When set, sendApiMessageStream throws synchronously before returning
  sendStreamThrow: Error | null = null;
  activeSession = false;
  cleanupCalled = false;
  capturedCallbacks: SseCallbacks | null = null;

  constructor(workspacePath: string) {
    super();
    this._workspacePath = workspacePath;
  }

  get workspacePath(): string {
    return this._workspacePath;
  }

  hasActiveApiSession(_sessionId: string): boolean {
    return this.activeSession;
  }

  async sendApiMessageStream(
    _sessionId: string,
    _chatId: string,
    _message: string,
    callbacks: SseCallbacks,
    _opts: { timeoutMs: number; skipUserMessage?: boolean },
  ): Promise<() => void> {
    if (this.sendStreamThrow) throw this.sendStreamThrow;
    this.capturedCallbacks = callbacks;
    // Fire callbacks asynchronously to simulate streaming
    setImmediate(() => {
      if (this.sendStreamResult instanceof Error) {
        callbacks.onError(this.sendStreamResult);
      } else {
        callbacks.onChunk({ type: 'text_delta', text: this.sendStreamResult });
        callbacks.onDone(this.sendStreamResult);
      }
    });
    return () => { this.cleanupCalled = true; };
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'getpod';

const agentConfig: AgentConfig = {
  id: AGENT_ID,
  description: 'Test agent',
  workspace: '/tmp/test-agent',
  env: '',
  claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
};

const apiKeys: ApiKey[] = [
  { key: 'sk-read-only', agents: [AGENT_ID] },
  { key: 'sk-write', agents: [AGENT_ID], write: true },
  { key: 'sk-admin', agents: '*', admin: true },
];

function buildApp(runner: MockGreetingRunner) {
  const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
  const configs = new Map([[AGENT_ID, agentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
  return app;
}

async function waitForFileDeleted(filePath: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(filePath);
      await new Promise(r => setTimeout(r, 20));
    } catch {
      return;
    }
  }
  throw new Error(`File ${filePath} still exists after ${timeoutMs}ms`);
}

// Parse SSE response body into event objects
function parseSseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter(chunk => chunk.startsWith('data: ') && chunk.slice(6) !== '[DONE]')
    .map(chunk => {
      try { return JSON.parse(chunk.slice(6)) as Record<string, unknown>; } catch { return {}; }
    })
    .filter(e => Object.keys(e).length > 0);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/agents/:agentId/greeting', () => {
  let tmpDir: string;
  let runner: MockGreetingRunner;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'greeting-test-'));
    runner = new MockGreetingRunner(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── 204 no-op paths ────────────────────────────────────────────────────────

  it('T-GREETING-204-NO-FILE: returns 204 when GREETING.md is absent', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ session_id: 'sess-abc' });
    expect(res.status).toBe(204);
    expect(runner.capturedCallbacks).toBeNull();
  });

  it('T-GREETING-204-EMPTY: returns 204 when GREETING.md is empty', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), '   \n  ');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ session_id: 'sess-abc' });
    expect(res.status).toBe(204);
    expect(runner.capturedCallbacks).toBeNull();
  });

  // ── Input validation ───────────────────────────────────────────────────────

  it('T-GREETING-400-NO-SESSION: missing session_id returns 400', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome!');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/session_id/i);
  });

  it('T-GREETING-400-EMPTY-SESSION: empty session_id returns 400', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome!');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ session_id: '   ' });
    expect(res.status).toBe(400);
  });

  // ── Conflict ───────────────────────────────────────────────────────────────

  it('T-GREETING-409-ACTIVE: returns 409 when session is already active', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome!');
    runner.activeSession = true;
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ session_id: 'sess-abc' });
    expect(res.status).toBe(409);
    expect(runner.capturedCallbacks).toBeNull();
  });

  // ── Auth ───────────────────────────────────────────────────────────────────

  it('T-GREETING-403-READ-KEY: read-only key is rejected with 403', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-read-only')
      .send({ session_id: 'sess-abc' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/write or admin/i);
  });

  it('T-GREETING-403-ADMIN-OK: admin key is accepted', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome!');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-admin')
      .send({ session_id: 'sess-abc' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });

  // ── 404 ────────────────────────────────────────────────────────────────────

  it('T-GREETING-404-UNKNOWN-AGENT: unknown agent returns 404', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post('/api/v1/agents/nonexistent/greeting')
      .set('X-Api-Key', 'sk-admin')
      .send({ session_id: 'sess-abc' });
    expect(res.status).toBe(404);
  });

  // ── 500 on read error ──────────────────────────────────────────────────────

  it('T-GREETING-500-EACCES: permission error on GREETING.md returns 500', async () => {
    const greetingPath = path.join(tmpDir, 'GREETING.md');
    await fs.writeFile(greetingPath, 'Welcome!');
    await fs.chmod(greetingPath, 0o000);
    if ((process.getuid?.() ?? -1) === 0) {
      await fs.chmod(greetingPath, 0o644);
      return;
    }
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ session_id: 'sess-abc' });
    await fs.chmod(greetingPath, 0o644);
    expect(res.status).toBe(500);
    expect(runner.capturedCallbacks).toBeNull();
  });

  // ── SSE streaming ──────────────────────────────────────────────────────────

  it('T-GREETING-200-SSE: happy path returns 200 SSE with text_delta + result + [DONE]', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome to the platform!');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ session_id: 'sess-abc' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const events = parseSseEvents(res.text);
    const chunk = events.find(e => e['type'] === 'text_delta');
    const result = events.find(e => e['type'] === 'result');
    expect(chunk).toBeDefined();
    expect(result?.['session_id']).toBe('sess-abc');
    expect(res.text).toContain('[DONE]');
  });

  it('T-GREETING-200-AGENT-ERROR: agent error during stream sends error SSE event', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome!');
    runner.sendStreamResult = new Error('agent crashed');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ session_id: 'sess-abc' });
    expect(res.status).toBe(200);
    const events = parseSseEvents(res.text);
    const errEvent = events.find(e => e['type'] === 'error');
    expect(errEvent?.['message']).toMatch(/agent crashed/);
  });

  // ── File lifecycle ─────────────────────────────────────────────────────────

  it('T-GREETING-DELETES-FILE: GREETING.md is deleted before streaming begins', async () => {
    const greetingPath = path.join(tmpDir, 'GREETING.md');
    await fs.writeFile(greetingPath, 'Welcome!');
    const app = buildApp(runner);
    await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ session_id: 'sess-abc' });
    await waitForFileDeleted(greetingPath);
  });

  it('T-GREETING-IDEMPOTENT: second call returns 204 after first success', async () => {
    const greetingPath = path.join(tmpDir, 'GREETING.md');
    await fs.writeFile(greetingPath, 'Welcome!');
    const app = buildApp(runner);
    const first = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ session_id: 'sess-abc' });
    expect(first.status).toBe(200);
    await waitForFileDeleted(greetingPath);
    const second = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ session_id: 'sess-abc' });
    expect(second.status).toBe(204);
  });

  // ── Sync throw after headers ───────────────────────────────────────────────

  // SSE headers are written before sendApiMessageStream is called. If sendApiMessageStream
  // throws synchronously (e.g. subprocess spawn failure), the error must be delivered as
  // an SSE error event — JSON 500 is impossible once headers are flushed.
  it('T-GREETING-SSE-ERROR-ON-THROW: sync throw from sendApiMessageStream delivers SSE error event', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome!');
    runner.sendStreamThrow = new Error('spawn failed');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ session_id: 'sess-abc' });
    // Headers already flushed — status is 200, error comes via SSE
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const events = parseSseEvents(res.text);
    const errEvent = events.find(e => e['type'] === 'error');
    expect(errEvent?.['message']).toMatch(/spawn failed/);
  });
});
