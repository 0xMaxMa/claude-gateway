import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as supertest from 'supertest';
import { EventEmitter } from 'events';
import { createApiRouter } from '../../src/api/router';
import { AgentConfig, ApiKey, GatewayConfig, SessionMeta } from '../../src/types';
import { AgentRunner } from '../../src/agent/runner';

// ── Mock child_process so AgentRunner works without Claude ────────────────────
jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdin: { write: jest.Mock; end: jest.Mock };
      stdout: EventEmitter;
      stderr: EventEmitter;
      killed: boolean;
      kill: jest.Mock;
      pid: number;
    };
    proc.stdin = { write: jest.fn(), end: jest.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = jest.fn(() => { proc.killed = true; return true; });
    proc.pid = 99999;
    return proc;
  }),
  execFile: jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeWorkspace(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'api-sess-create-'));
  // SessionStore resolves agentsBaseDir as workspace/../.. so workspace must be <base>/alfred/workspace
  const ws = path.join(base, 'alfred', 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

function makeAgentConfig(workspace: string): AgentConfig {
  return {
    id: 'alfred',
    description: 'test agent',
    workspace,
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };
}

function makeGatewayConfig(): GatewayConfig {
  return { gateway: { logDir: os.tmpdir(), timezone: 'UTC' }, agents: [] };
}

// ── Section 1: HTTP layer — thin mock runner ──────────────────────────────────
//
// Verify HTTP contract (status codes, auth, response shape, argument routing).
// The mock does NOT reimplement truncation — that is tested against the real
// AgentRunner in Section 2.

class ThinMockRunner extends EventEmitter {
  createApiSessionCalls: Array<{ chatId: string; prompt?: string; name?: string }> = [];

  async createApiSession(chatId: string, prompt?: string, name?: string): Promise<SessionMeta> {
    this.createApiSessionCalls.push({ chatId, prompt, name });
    return {
      id: 'sess-create-01',
      name: name ?? prompt ?? undefined,
      createdAt: 1749430000000,
      lastActive: 1749430000000,
      messageCount: 0,
      totalTokensUsed: 0,
    } as SessionMeta;
  }

  hasActiveApiSession(_sessionId: string): boolean { return false; }
}

const AGENT_ID = 'alfred';
const httpAgentConfig: AgentConfig = {
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

function buildApp(runner: ThinMockRunner) {
  const runners = new Map([[AGENT_ID, runner as unknown as AgentRunner]]);
  const configs = new Map([[AGENT_ID, httpAgentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
  return app;
}

describe('POST /api/v1/agents/:agentId/sessions — HTTP contract', () => {
  let runner: ThinMockRunner;
  beforeEach(() => { runner = new ThinMockRunner(); });

  it('T-CREATE-201-NO-INPUT: responds 201 with undefined sessionName when no prompt or name', async () => {
    const res = await supertest.default(buildApp(runner))
      .post(`/api/v1/agents/${AGENT_ID}/sessions`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe('sess-create-01');
    expect(res.body.sessionName).toBeUndefined();
  });

  it('T-CREATE-201-RESPONSE-SHAPE: response includes sessionId and createdAt', async () => {
    const res = await supertest.default(buildApp(runner))
      .post(`/api/v1/agents/${AGENT_ID}/sessions`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ prompt: 'Test session' });
    expect(res.status).toBe(201);
    expect(typeof res.body.sessionId).toBe('string');
    expect(typeof res.body.createdAt).toBe('number');
  });

  it('T-CREATE-ROUTING: router passes prompt and name to createApiSession unchanged', async () => {
    await supertest.default(buildApp(runner))
      .post(`/api/v1/agents/${AGENT_ID}/sessions`)
      .set('X-Api-Key', 'sk-admin')
      .query({ chat_id: 'testchat' })
      .send({ prompt: 'Hello world', name: 'My Session' });
    expect(runner.createApiSessionCalls).toHaveLength(1);
    expect(runner.createApiSessionCalls[0]!.prompt).toBe('Hello world');
    expect(runner.createApiSessionCalls[0]!.name).toBe('My Session');
  });

  it('T-CREATE-401-NO-KEY: request without API key is rejected', async () => {
    const res = await supertest.default(buildApp(runner))
      .post(`/api/v1/agents/${AGENT_ID}/sessions`)
      .query({ chat_id: 'testchat' })
      .send({ prompt: 'Test' });
    expect(res.status).toBe(401);
  });
});

// ── Section 2: AgentRunner.createApiSession — real implementation ─────────────
//
// Test truncation logic and background generation against the real AgentRunner
// (with a temp session store). generateSessionNameInBackground is spied on
// to prevent actual Claude subprocess invocation.

describe('AgentRunner.createApiSession — truncation and background generation', () => {
  let runner: AgentRunner;
  let workspace: string;

  beforeEach(() => {
    workspace = makeWorkspace();
    runner = new AgentRunner(makeAgentConfig(workspace), makeGatewayConfig());
  });

  afterEach(() => {
    // Remove the base dir (two levels above workspace: workspace/../..)
    fs.rmSync(path.resolve(workspace, '..', '..'), { recursive: true, force: true });
  });

  it('T-RUNNER-SHORT-PROMPT: prompt ≤ 60 chars is used as sessionName as-is', async () => {
    const bgSpy = jest.spyOn(runner as unknown as { generateSessionNameInBackground: () => void }, 'generateSessionNameInBackground').mockImplementation(() => {});
    const meta = await runner.createApiSession('chat-1', 'Hello world');
    expect(meta.name).toBe('Hello world');
    bgSpy.mockRestore();
  });

  it('T-RUNNER-LONG-PROMPT: prompt > 60 chars is truncated with trailing ellipsis', async () => {
    const bgSpy = jest.spyOn(runner as unknown as { generateSessionNameInBackground: () => void }, 'generateSessionNameInBackground').mockImplementation(() => {});
    const meta = await runner.createApiSession('chat-1', 'A'.repeat(61));
    expect(meta.name).toBe(`${'A'.repeat(60)}...`);
    bgSpy.mockRestore();
  });

  it('T-RUNNER-EXACT-60: prompt of exactly 60 chars is used as-is without ellipsis', async () => {
    const bgSpy = jest.spyOn(runner as unknown as { generateSessionNameInBackground: () => void }, 'generateSessionNameInBackground').mockImplementation(() => {});
    const meta = await runner.createApiSession('chat-1', 'B'.repeat(60));
    expect(meta.name).toBe('B'.repeat(60));
    bgSpy.mockRestore();
  });

  it('T-RUNNER-EXPLICIT-NAME: explicit name bypasses truncation and skips background generation', async () => {
    const bgSpy = jest.spyOn(runner as unknown as { generateSessionNameInBackground: () => void }, 'generateSessionNameInBackground').mockImplementation(() => {});
    const meta = await runner.createApiSession('chat-1', 'A'.repeat(80), 'My Custom Session');
    expect(meta.name).toBe('My Custom Session');
    expect(bgSpy).not.toHaveBeenCalled();
    bgSpy.mockRestore();
  });

  it('T-RUNNER-NO-INPUT: no prompt and no name → session store auto-generates a name', async () => {
    // createTelegramSession generates "Session N" when no name is provided
    const meta = await runner.createApiSession('chat-1');
    expect(typeof meta.name).toBe('string');
    expect(meta.name).toMatch(/^Session \d+$/);
  });

  it('T-RUNNER-BG-TRIGGERED: generateSessionNameInBackground is called with correct args when prompt provided without name', async () => {
    const bgSpy = jest.spyOn(runner as unknown as { generateSessionNameInBackground: (c: string, s: string, p: string) => void }, 'generateSessionNameInBackground').mockImplementation(() => {});
    const meta = await runner.createApiSession('chat-1', 'Deploy the new service');
    expect(bgSpy).toHaveBeenCalledTimes(1);
    expect(bgSpy).toHaveBeenCalledWith('chat-1', meta.id, 'Deploy the new service');
    bgSpy.mockRestore();
  });
});
