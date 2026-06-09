import express from 'express';
import * as supertest from 'supertest';
import { EventEmitter } from 'events';
import { createApiRouter } from '../../src/api/router';
import { AgentConfig, ApiKey, SessionMeta } from '../../src/types';

// ── Mock runner ───────────────────────────────────────────────────────────────

class MockCreateRunner extends EventEmitter {
  createApiSessionCalls: Array<{ chatId: string; prompt?: string; name?: string }> = [];
  generateSessionNameInBackgroundCalls: Array<{ chatId: string; sessionId: string; prompt: string }> = [];

  private nextSessionId = 'sess-create-01';

  async createApiSession(chatId: string, prompt?: string, name?: string): Promise<SessionMeta> {
    this.createApiSessionCalls.push({ chatId, prompt, name });
    let sessionName = name;
    if (!sessionName && prompt) {
      sessionName = prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt;
    }
    return {
      id: this.nextSessionId,
      name: sessionName,
      createdAt: 1749430000000,
      lastActive: 1749430000000,
      messageCount: 0,
      totalTokensUsed: 0,
    } as SessionMeta;
  }

  hasActiveApiSession(_sessionId: string): boolean { return false; }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AGENT_ID = 'alfred';

const agentConfig: AgentConfig = {
  id: AGENT_ID,
  description: 'Test agent',
  workspace: '/tmp/test-agent',
  env: '',
  claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
};

const apiKeys: ApiKey[] = [
  { key: 'sk-read', agents: [AGENT_ID] },
  { key: 'sk-admin', agents: '*', admin: true },
];

function buildApp(runner: MockCreateRunner) {
  const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
  const configs = new Map([[AGENT_ID, agentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/agents/:agentId/sessions', () => {
  let runner: MockCreateRunner;

  beforeEach(() => {
    runner = new MockCreateRunner();
  });

  // T-CREATE-201-NO-INPUT: no prompt, no name → sessionName is undefined
  it('T-CREATE-201-NO-INPUT: responds 201 with undefined sessionName when no prompt or name', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/sessions`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe('sess-create-01');
    expect(res.body.sessionName).toBeUndefined();
  });

  // T-CREATE-201-SHORT-PROMPT: short prompt → sessionName equals prompt
  it('T-CREATE-201-SHORT-PROMPT: short prompt used as sessionName without truncation', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/sessions`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ prompt: 'Hello world' });
    expect(res.status).toBe(201);
    expect(res.body.sessionName).toBe('Hello world');
  });

  // T-CREATE-201-LONG-PROMPT: prompt >60 chars → truncated with ellipsis
  it('T-CREATE-201-LONG-PROMPT: prompt longer than 60 chars is truncated with trailing ellipsis', async () => {
    const longPrompt = 'A'.repeat(61);
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/sessions`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ prompt: longPrompt });
    expect(res.status).toBe(201);
    expect(res.body.sessionName).toBe(`${'A'.repeat(60)}...`);
  });

  // T-CREATE-201-EXACT-60: prompt exactly 60 chars → not truncated
  it('T-CREATE-201-EXACT-60: prompt exactly 60 chars is used as-is without ellipsis', async () => {
    const exactPrompt = 'B'.repeat(60);
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/sessions`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ prompt: exactPrompt });
    expect(res.status).toBe(201);
    expect(res.body.sessionName).toBe(exactPrompt);
  });

  // T-CREATE-201-EXPLICIT-NAME: explicit name bypasses prompt-based naming
  it('T-CREATE-201-EXPLICIT-NAME: explicit name is used as-is regardless of prompt', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/sessions`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ name: 'My Custom Session', prompt: 'Some long prompt that should be ignored' });
    expect(res.status).toBe(201);
    expect(res.body.sessionName).toBe('My Custom Session');
    expect(runner.createApiSessionCalls[0].name).toBe('My Custom Session');
  });

  // T-CREATE-201-RESPONSE-SHAPE: response always includes sessionId and createdAt
  it('T-CREATE-201-RESPONSE-SHAPE: response body includes sessionId and createdAt fields', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/sessions`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ prompt: 'Test session' });
    expect(res.status).toBe(201);
    expect(typeof res.body.sessionId).toBe('string');
    expect(typeof res.body.createdAt).toBe('number');
  });

  // T-CREATE-401-NO-KEY: missing API key returns 401
  it('T-CREATE-401-NO-KEY: request without API key is rejected', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .post(`/api/v1/agents/${AGENT_ID}/sessions`)
      .query({ chat_id: 'testchat' })
      .send({ prompt: 'Test' });
    expect(res.status).toBe(401);
  });
});
