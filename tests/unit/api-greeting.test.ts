import express from 'express';
import * as supertest from 'supertest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { createApiRouter } from '../../src/api/router';
import { AgentConfig, ApiKey, SessionMeta } from '../../src/types';

// ── Mock AgentRunner for greeting tests ─────────────────────────────────────

class MockGreetingRunner extends EventEmitter {
  private _workspacePath: string;
  sendApiMessageResult: string | Error = 'Hello!';
  createApiSessionResult: SessionMeta = {
    id: 'sess-abc123',
    name: 'Welcome to GetPod',
    createdAt: Date.now(),
    lastActive: Date.now(),
    messageCount: 0,
    totalTokensUsed: 0,
  };
  createApiSessionCalls: Array<{ chatId: string; prompt?: string; name?: string }> = [];
  deleteApiSessionCalls: Array<{ chatId: string; sessionId: string }> = [];

  constructor(workspacePath: string) {
    super();
    this._workspacePath = workspacePath;
  }

  get workspacePath(): string {
    return this._workspacePath;
  }

  async createApiSession(chatId: string, prompt?: string, name?: string): Promise<SessionMeta> {
    this.createApiSessionCalls.push({ chatId, prompt, name });
    return this.createApiSessionResult;
  }

  async sendApiMessage(
    _sessionId: string,
    _chatId: string,
    _message: string,
    _opts: { timeoutMs: number; skipUserMessage?: boolean },
  ): Promise<string> {
    if (this.sendApiMessageResult instanceof Error) throw this.sendApiMessageResult;
    return this.sendApiMessageResult;
  }

  async deleteApiSession(_chatId: string, _sessionId: string): Promise<void> {
    this.deleteApiSessionCalls.push({ chatId: _chatId, sessionId: _sessionId });
  }

  hasActiveApiSession(_sessionId: string): boolean { return false; }
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

// Poll until the file is gone (avoids arbitrary setTimeout for fire-and-forget unlink)
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

  // T-GREETING-204-NO-FILE: returns 204 when GREETING.md does not exist
  it('T-GREETING-204-NO-FILE: returns 204 when GREETING.md is absent', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ chat_id: 'testchat' });
    expect(res.status).toBe(204);
    expect(runner.createApiSessionCalls).toHaveLength(0);
  });

  // T-GREETING-204-EMPTY: returns 204 when GREETING.md is empty/whitespace
  it('T-GREETING-204-EMPTY: returns 204 when GREETING.md is empty', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), '   \n  ');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ chat_id: 'testchat' });
    expect(res.status).toBe(204);
    expect(runner.createApiSessionCalls).toHaveLength(0);
  });

  // T-GREETING-500-EACCES: non-ENOENT readFile error (e.g. EACCES) returns 500, not 204
  it('T-GREETING-500-EACCES: permission error on GREETING.md returns 500', async () => {
    const greetingPath = path.join(tmpDir, 'GREETING.md');
    await fs.writeFile(greetingPath, 'Welcome!');
    await fs.chmod(greetingPath, 0o000);
    // root can read any file — skip assertion in that environment
    if ((process.getuid?.() ?? -1) === 0) {
      await fs.chmod(greetingPath, 0o644);
      return;
    }
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ chat_id: 'testchat' });
    await fs.chmod(greetingPath, 0o644);
    expect(res.status).toBe(500);
    expect(runner.createApiSessionCalls).toHaveLength(0);
  });

  // T-GREETING-201-NO-NAME: returns 201 and passes name=undefined (triggers LLM naming)
  it('T-GREETING-201-NO-NAME: returns 201 without session_name, passes undefined to createApiSession', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome, the VM is ready!');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ chat_id: 'testchat' });
    expect(res.status).toBe(201);
    expect(res.body.greeted).toBe(true);
    expect(res.body.sessionId).toBe('sess-abc123');
    expect(res.body.sessionName).toBe('Welcome to GetPod');
    expect(runner.createApiSessionCalls[0].name).toBeUndefined();
  });

  // T-GREETING-201-WITH-NAME: passes session_name to createApiSession, skipping LLM naming
  it('T-GREETING-201-WITH-NAME: passes session_name to createApiSession when provided', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome, the VM is ready!');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ chat_id: 'testchat', session_name: 'My Custom Title' });
    expect(res.status).toBe(201);
    expect(runner.createApiSessionCalls[0].name).toBe('My Custom Title');
  });

  // T-GREETING-DELETES-FILE: GREETING.md is deleted after successful greeting
  it('T-GREETING-DELETES-FILE: GREETING.md is deleted after 201 response', async () => {
    const greetingPath = path.join(tmpDir, 'GREETING.md');
    await fs.writeFile(greetingPath, 'Welcome, the VM is ready!');
    const app = buildApp(runner);
    await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ chat_id: 'testchat', session_name: 'Welcome' });
    await waitForFileDeleted(greetingPath);
  });

  // T-GREETING-IDEMPOTENT: second call returns 204 because GREETING.md was deleted
  it('T-GREETING-IDEMPOTENT: second call returns 204 after first success', async () => {
    const greetingPath = path.join(tmpDir, 'GREETING.md');
    await fs.writeFile(greetingPath, 'Welcome!');
    const app = buildApp(runner);
    const first = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ chat_id: 'testchat', session_name: 'Welcome' });
    expect(first.status).toBe(201);
    await waitForFileDeleted(greetingPath);
    const second = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ chat_id: 'testchat', session_name: 'Welcome' });
    expect(second.status).toBe(204);
    expect(runner.createApiSessionCalls).toHaveLength(1);
  });

  // T-GREETING-403-READ-KEY: read-only key returns 403
  it('T-GREETING-403-READ-KEY: read-only key is rejected with 403', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-read-only')
      .send({ chat_id: 'testchat' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/write or admin/i);
  });

  // T-GREETING-403-ADMIN-OK: admin key succeeds
  it('T-GREETING-403-ADMIN-OK: admin key is accepted', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome!');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-admin')
      .send({ chat_id: 'testchat', session_name: 'Welcome' });
    expect(res.status).toBe(201);
  });

  // T-GREETING-400-NO-CHAT: missing chat_id returns 400
  it('T-GREETING-400-NO-CHAT: missing chat_id returns 400', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome!');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chat_id/i);
  });

  // T-GREETING-404-UNKNOWN-AGENT: unknown agent returns 404
  it('T-GREETING-404-UNKNOWN-AGENT: unknown agent returns 404', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post('/api/v1/agents/nonexistent/greeting')
      .set('X-Api-Key', 'sk-admin')
      .send({ chat_id: 'testchat' });
    expect(res.status).toBe(404);
  });

  // T-GREETING-409-CONFLICT: sendApiMessage CONFLICT maps to 409
  it('T-GREETING-409-CONFLICT: concurrent greeting returns 409', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome!');
    const err = Object.assign(new Error('conflict'), { code: 'CONFLICT' });
    runner.sendApiMessageResult = err;
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ chat_id: 'testchat', session_name: 'Welcome' });
    expect(res.status).toBe(409);
    expect(res.body.sessionId).toBe('sess-abc123');
  });

  // T-GREETING-500-ERROR: non-CONFLICT error deletes orphaned session and returns 500
  it('T-GREETING-500-ERROR: unexpected error cleans up session and returns 500', async () => {
    await fs.writeFile(path.join(tmpDir, 'GREETING.md'), 'Welcome!');
    runner.sendApiMessageResult = new Error('internal failure');
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/greeting`)
      .set('X-Api-Key', 'sk-write')
      .send({ chat_id: 'testchat', session_name: 'Welcome' });
    expect(res.status).toBe(500);
    expect(runner.deleteApiSessionCalls).toHaveLength(1);
    expect(runner.deleteApiSessionCalls[0].sessionId).toBe('sess-abc123');
  });
});
