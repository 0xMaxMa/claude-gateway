import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { createApiRouter } from '../../src/api/router';
import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig } from '../../src/types';
import { OrchestrationError } from '../../src/orchestration/types';

function app(controlApiTask: jest.Mock) {
  const runner = Object.assign(new EventEmitter(), { controlApiTask, getAgentConfig: () => ({ id: 'a', allow_tools: true }) }) as unknown as AgentRunner;
  const server = express(); server.use(express.json());
  server.use('/api', createApiRouter(new Map([['a', runner]]), new Map([['a', { id: 'a' } as AgentConfig]]), [{ key: 'owner-fixture', agents: ['a'] }]));
  return server;
}
const session = randomUUID(), task = randomUUID();
const path = (taskId: string = task, sessionId: string = session) => `/api/v1/agents/a/sessions/${sessionId}/tasks/${taskId}/control`;
const body = () => ({ id: randomUUID(), action: 'pause', expectedRevision: 1 });

test.each([
  ['INVALID_INPUT', new OrchestrationError('INVALID_INPUT'), 400],
  ['COMMAND_QUEUE_FULL', new OrchestrationError('COMMAND_QUEUE_FULL', 'Too many commands are waiting.'), 429],
  ['AUTOMATION_SESSION_CLOSED', new OrchestrationError('AUTOMATION_SESSION_CLOSED', 'This automation session was ended.'), 410],
  ['REVISION_CONFLICT', new OrchestrationError('REVISION_CONFLICT'), 409],
  ['EXECUTION_DENIED', new OrchestrationError('EXECUTION_DENIED'), 403],
  ['ORCHESTRATION_DISABLED', new Error('ORCHESTRATION_DISABLED'), 409],
  ['ACCESS_DENIED', new OrchestrationError('TASK_NOT_FOUND'), 403],
])('task control maps %s by error code', async (code, error, status) => {
  const control = jest.fn(async () => { throw error; });
  const res = await request(app(control)).post(path()).set('Authorization', 'Bearer owner-fixture').send(body());
  expect(res.status).toBe(status);
  expect(res.body.error).toBe(code);
});

test('task control rejects malformed ids with 400 before reaching the runner', async () => {
  const control = jest.fn(async () => ({ taskId: task }));
  const server = app(control);
  for (const req of [
    request(server).post(path('not-a-uuid')).send(body()),
    request(server).post(path(task, 'bad.session')).send(body()),
    request(server).post(path()).send({ ...body(), id: 'command-1' }),
  ]) expect((await req.set('Authorization', 'Bearer owner-fixture')).status).toBe(400);
  expect(control).not.toHaveBeenCalled();
  expect((await request(server).post(path()).set('Authorization', 'Bearer owner-fixture').send(body())).status).toBe(202);
});
