import express from 'express';
import * as supertest from 'supertest';
import { EventEmitter } from 'events';
import { createApiRouter } from '../../src/api/router';
import { AgentConfig, ApiKey } from '../../src/types';

// ── Mock runner ───────────────────────────────────────────────────────────────

class MockRenameRunner extends EventEmitter {
  updateApiSessionCalls: Array<{ chatId: string; sessionId: string; updates: { sessionName?: string } }> = [];
  updateApiSessionResult: { sessionId: string; sessionName?: string } = {
    sessionId: 'sess-rename-01',
    sessionName: 'Updated Name',
  };

  async updateApiSession(
    chatId: string,
    sessionId: string,
    updates: { sessionName?: string },
  ): Promise<{ sessionId: string; sessionName?: string }> {
    this.updateApiSessionCalls.push({ chatId, sessionId, updates });
    return this.updateApiSessionResult;
  }

  hasActiveApiSession(_sessionId: string): boolean { return false; }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AGENT_ID = 'alfred';
const SESSION_ID = 'sess-rename-01';

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

function buildApp(runner: MockRenameRunner) {
  const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
  const configs = new Map([[AGENT_ID, agentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/agents/:agentId/sessions/:sessionId', () => {
  let runner: MockRenameRunner;

  beforeEach(() => {
    runner = new MockRenameRunner();
  });

  // T-RENAME-200-SNAKE: snake_case session_name is accepted (preferred field)
  it('T-RENAME-200-SNAKE: session_name (snake_case) is accepted and passed to updateApiSession', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .patch(`/api/v1/agents/${AGENT_ID}/sessions/${SESSION_ID}`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ session_name: 'New Session Name' });
    expect(res.status).toBe(200);
    expect(runner.updateApiSessionCalls).toHaveLength(1);
    expect(runner.updateApiSessionCalls[0].updates.sessionName).toBe('New Session Name');
  });

  // T-RENAME-200-CAMEL: camelCase sessionName is accepted (backward compat)
  it('T-RENAME-200-CAMEL: sessionName (camelCase) is accepted for backward compatibility', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .patch(`/api/v1/agents/${AGENT_ID}/sessions/${SESSION_ID}`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ sessionName: 'Old Style Name' });
    expect(res.status).toBe(200);
    expect(runner.updateApiSessionCalls[0].updates.sessionName).toBe('Old Style Name');
  });

  // T-RENAME-SNAKE-PREFERRED: when both fields are present, session_name takes priority
  it('T-RENAME-SNAKE-PREFERRED: session_name takes priority over sessionName when both are sent', async () => {
    const app = buildApp(runner);
    await supertest.default(app)
      .patch(`/api/v1/agents/${AGENT_ID}/sessions/${SESSION_ID}`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ session_name: 'snake wins', sessionName: 'camel loses' });
    expect(runner.updateApiSessionCalls[0].updates.sessionName).toBe('snake wins');
  });

  // T-RENAME-400-NO-NAME: missing both fields returns 400
  it('T-RENAME-400-NO-NAME: missing session_name and sessionName returns 400', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .patch(`/api/v1/agents/${AGENT_ID}/sessions/${SESSION_ID}`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/session_name/i);
    expect(runner.updateApiSessionCalls).toHaveLength(0);
  });

  // T-RENAME-400-EMPTY-STRING: empty string is rejected
  it('T-RENAME-400-EMPTY-STRING: empty session_name (whitespace) is rejected', async () => {
    const app = buildApp(runner);
    const res = await supertest.default(app)
      .patch(`/api/v1/agents/${AGENT_ID}/sessions/${SESSION_ID}`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ session_name: '   ' });
    expect(res.status).toBe(400);
    expect(runner.updateApiSessionCalls).toHaveLength(0);
  });

  // T-RENAME-200-TRIMS: leading/trailing whitespace is trimmed
  it('T-RENAME-200-TRIMS: session_name is trimmed before passing to runner', async () => {
    const app = buildApp(runner);
    await supertest.default(app)
      .patch(`/api/v1/agents/${AGENT_ID}/sessions/${SESSION_ID}`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ session_name: '  Padded Name  ' });
    expect(runner.updateApiSessionCalls[0].updates.sessionName).toBe('Padded Name');
  });
});
