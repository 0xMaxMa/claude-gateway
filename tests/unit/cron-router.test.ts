/**
 * Unit tests for cron-router (Planning-27 Task 5 + Auth)
 *
 * T21-T23: Router validation for new schedule/payload fields
 * T24-T28: API key auth + agent-scoped access control
 * T29: agentId existence validation (knownAgentIds)
 */

import express from 'express';
import request from 'supertest';
import { CronManager } from '../../src/cron-manager';
import { createCronRouter } from '../../src/cron-router';
import { ApiKey } from '../../src/types';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const VALID_KEY = 'test-key-abc';
const apiKeys: ApiKey[] = [
  { key: VALID_KEY, description: 'test', agents: ['agent-1'] },
  { key: 'admin-key', description: 'admin', agents: '*' },
];

function makeApp(withAuth = false, knownAgentIds?: Set<string>) {
  const manager = new CronManager(
    { storePath: '/tmp/crons-router-test.json', runsDir: '/tmp/crons-router-runs' },
    new Map(),
    new Map(),
    makeLogger(),
  );
  // Mock create to avoid actual filesystem/scheduling
  manager.create = jest.fn().mockImplementation(async (input) => ({
    id: 'mock-id',
    ...input,
    scheduleKind: input.scheduleKind ?? 'cron',
    type: input.type ?? 'command',
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: { lastRunAt: null, lastStatus: null, lastError: null, consecutiveErrors: 0, runCount: 0 },
  }));

  const app = express();
  app.use(express.json());
  app.use('/api', createCronRouter(manager, withAuth ? apiKeys : undefined, knownAgentIds));
  return { app, manager };
}

describe('T21-T23: Router validation for new fields', () => {
  it('T21: POST with scheduleKind=at + valid scheduleAt → 201', async () => {
    const { app } = makeApp();

    const futureTs = new Date(Date.now() + 60_000).toISOString();
    const res = await request(app)
      .post('/api/v1/crons')
      .send({
        agentId: 'agent-1',
        name: 'one-shot',
        scheduleKind: 'at',
        scheduleAt: futureTs,
        command: 'echo hi',
      });

    expect(res.status).toBe(201);
    expect(res.body.job).toBeDefined();
  });

  it('T22: POST with scheduleKind=at + missing scheduleAt → 400', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/api/v1/crons')
      .send({
        agentId: 'agent-1',
        name: 'bad-at',
        scheduleKind: 'at',
        // no scheduleAt
        command: 'echo hi',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('scheduleAt');
  });

  it('T23: POST with type=agent + missing prompt → 400', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/api/v1/crons')
      .send({
        agentId: 'agent-1',
        name: 'agent-job',
        scheduleKind: 'cron',
        schedule: '* * * * *',
        type: 'agent',
        telegram: '12345',
        // no prompt
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('prompt');
  });

  it('T23b: POST with type=agent + missing telegram → 400', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/api/v1/crons')
      .send({
        agentId: 'agent-1',
        name: 'agent-job',
        scheduleKind: 'cron',
        schedule: '* * * * *',
        type: 'agent',
        prompt: 'hello',
        // no telegram
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('telegram');
  });
});

describe('T24-T28: Auth + agent-scoped access control', () => {
  it('T24: missing API key → 401', async () => {
    const { app } = makeApp(true);

    const res = await request(app).get('/api/v1/crons');
    expect(res.status).toBe(401);
  });

  it('T25: invalid API key → 403', async () => {
    const { app } = makeApp(true);

    const res = await request(app)
      .get('/api/v1/crons')
      .set('X-Api-Key', 'wrong-key');
    expect(res.status).toBe(403);
  });

  it('T26: valid key → GET /v1/crons returns 200', async () => {
    const { app } = makeApp(true);

    const res = await request(app)
      .get('/api/v1/crons')
      .set('X-Api-Key', VALID_KEY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.jobs)).toBe(true);
  });

  it('T27: key scoped to agent-1 cannot create cron for agent-2 → 403', async () => {
    const { app } = makeApp(true);

    const res = await request(app)
      .post('/api/v1/crons')
      .set('X-Api-Key', VALID_KEY)
      .send({
        agentId: 'agent-2',
        name: 'forbidden-job',
        scheduleKind: 'cron',
        schedule: '* * * * *',
        
        command: 'echo hi',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('agent-2');
  });

  it('T28: admin key (*) can create cron for any agent → 201', async () => {
    const { app } = makeApp(true);

    const res = await request(app)
      .post('/api/v1/crons')
      .set('X-Api-Key', 'admin-key')
      .send({
        agentId: 'agent-99',
        name: 'admin-job',
        scheduleKind: 'cron',
        schedule: '* * * * *',
        
        command: 'echo hi',
      });

    expect(res.status).toBe(201);
  });
});

describe('T29: agentId existence validation', () => {
  const knownAgents = new Set(['claude-research', 'claude-founder']);

  it('T29a: POST with unknown agentId → 404', async () => {
    const { app } = makeApp(false, knownAgents);

    const res = await request(app)
      .post('/api/v1/crons')
      .send({
        agentId: 'alfred',
        name: 'bad-job',
        scheduleKind: 'cron',
        schedule: '* * * * *',
        
        command: 'echo hi',
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('alfred');
  });

  it('T29b: POST with known agentId → 201', async () => {
    const { app } = makeApp(false, knownAgents);

    const res = await request(app)
      .post('/api/v1/crons')
      .send({
        agentId: 'claude-research',
        name: 'valid-job',
        scheduleKind: 'cron',
        schedule: '* * * * *',
        
        command: 'echo hi',
      });

    expect(res.status).toBe(201);
  });

  it('T29c: POST without knownAgentIds (no validation) → 201 for any agentId', async () => {
    const { app } = makeApp(false, undefined);

    const res = await request(app)
      .post('/api/v1/crons')
      .send({
        agentId: 'nonexistent-agent',
        name: 'any-job',
        scheduleKind: 'cron',
        schedule: '* * * * *',
        
        command: 'echo hi',
      });

    expect(res.status).toBe(201);
  });
});
