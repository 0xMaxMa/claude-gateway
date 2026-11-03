import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { createApiRouter } from '../../src/api/router';
import { apiPrincipal } from '../../src/orchestration/identity';
import { AgentRunner } from '../../src/agent/runner';
import { AgentOrchestrationRuntime } from '../../src/orchestration/runtime';
import { ComputerLiveRuns } from '../../src/orchestration/computer-live';
import { AgentConfig } from '../../src/types';

const GRANT = '7d3f1a52-0b6e-4c7a-9f1e-2a4b6c8d0e12';
const owner = { key: 'owner-fixture', agents: ['a', 'b'] }, other = { key: 'other-fixture', agents: ['a'] }, elsewhere = { key: 'elsewhere-fixture', agents: ['c'] };

test('computer activity: authenticated, a UUID grant, only runs the caller owns, newest first, nothing else', async () => {
  // The runner answers only for the principal that is a member of the run's conversation.
  const answer = (run: Record<string, unknown>) => jest.fn((g: string, principal: string) => g === GRANT && principal === apiPrincipal(owner) ? run : undefined);
  const runnerA = Object.assign(new EventEmitter(), { computerActivity: answer({ taskId: 't-a', phase: 'acting', label: 'Opening Spotify', step: 2, updatedAt: 10 }) }) as unknown as AgentRunner;
  const runnerB = Object.assign(new EventEmitter(), { computerActivity: answer({ taskId: 't-b', phase: 'waiting_for_user', label: 'play a song', updatedAt: 20 }) }) as unknown as AgentRunner;
  const app = express(); app.use(express.json());
  app.use('/api', createApiRouter(new Map([['a', runnerA], ['b', runnerB]]), new Map([['a', { id: 'a' } as AgentConfig], ['b', { id: 'b' } as AgentConfig]]), [owner, other, elsewhere]));
  const path = `/api/v1/computer/activity?grant_id=${GRANT}`;
  // No key: 401; an unknown key: 403 (the shared auth middleware). Neither reaches a runner.
  for (const [res, status] of [[await request(app).get(path), 401], [await request(app).get(path).set('Authorization', 'Bearer wrong-key'), 403]] as const) {
    expect(res.status).toBe(status);expect(res.body.run).toBeUndefined();
  }
  expect(runnerA.computerActivity).not.toHaveBeenCalled();
  expect((await request(app).get('/api/v1/computer/activity?grant_id=not-a-uuid').set('Authorization', 'Bearer owner-fixture')).status).toBe(400);
  expect((await request(app).get('/api/v1/computer/activity').set('Authorization', 'Bearer owner-fixture')).status).toBe(400);
  // A key that knows the grant but owns no run on it reads nothing, the same answer as no run at all.
  for (const key of ['other-fixture', 'elsewhere-fixture']) expect((await request(app).get(path).set('Authorization', `Bearer ${key}`)).body).toEqual({ run: null });
  expect(runnerB.computerActivity).not.toHaveBeenCalledWith(GRANT, apiPrincipal(other));
  const res = await request(app).get(path).set('Authorization', 'Bearer owner-fixture');
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({ run: { taskId: 't-b', phase: 'waiting_for_user', label: 'play a song', updatedAt: 20 } });
});

test('the runtime answers only a member of the run\'s conversation', () => {
  const live = new ComputerLiveRuns(() => 7);live.start(GRANT, 'task-1', 'r1');
  const store = { task: jest.fn(() => ({ taskId: 'task-1', conversationId: 'conv-1', state: 'running' })),
    assertMember: jest.fn((conversation: string, principal: string) => { if (conversation !== 'conv-1' || principal !== 'member') throw Error('ACCESS_DENIED'); }) };
  const runtime = Object.assign(Object.create(AgentOrchestrationRuntime.prototype), { store, computerAdapter: { live } }) as AgentOrchestrationRuntime;
  expect(runtime.computerActivity(GRANT, 'member')).toEqual({ taskId: 'task-1', phase: 'acting', label: 'Starting', updatedAt: 7 });
  expect(runtime.computerActivity(GRANT, 'stranger')).toBeUndefined();
  expect(runtime.computerActivity('2b1c0d9e-8f7a-4b6c-9d5e-1f2a3b4c5d6e', 'member')).toBeUndefined();
});

test('the runner answers from a started orchestration only, never starting one to answer', () => {
  const runner = Object.create(AgentRunner.prototype) as any;
  runner.getOrchestration = jest.fn();
  expect(runner.computerActivity(GRANT, 'p')).toBeUndefined();
  expect(runner.getOrchestration).not.toHaveBeenCalled();
  runner.orchestration = { computerActivity: jest.fn(() => ({ taskId: 't' })) };
  expect(runner.computerActivity(GRANT, 'p')).toEqual({ taskId: 't' });
  expect(runner.orchestration.computerActivity).toHaveBeenCalledWith(GRANT, 'p');
});
