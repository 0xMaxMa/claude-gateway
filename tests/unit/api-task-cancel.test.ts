import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { createApiRouter } from '../../src/api/router';
import { apiPrincipal } from '../../src/orchestration/identity';
import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig } from '../../src/types';

test('task cancel HTTP control requires agent access and forwards authenticated session ownership', async () => {
  const cancelApiTask=jest.fn(async () => ({taskId:'task-a',state:'cancel_requested'}));
  const runner=Object.assign(new EventEmitter(),{cancelApiTask}) as unknown as AgentRunner;
  const owner={key:'owner-fixture',agents:['a']};
  const app=express(); app.use(express.json());
  app.use('/api',createApiRouter(new Map([['a',runner]]),new Map([['a',{id:'a'} as AgentConfig]]),[owner,{key:'other-fixture',agents:['other']} ]));
  const path='/api/v1/agents/a/sessions/session-a/tasks/task-a/cancel';
  expect((await request(app).post(path)).status).toBe(401);
  expect((await request(app).post(path).set('Authorization','Bearer other-fixture')).status).toBe(403);
  expect(cancelApiTask).not.toHaveBeenCalled();
  expect((await request(app).post(path).set('Authorization','Bearer owner-fixture')).body.task.state).toBe('cancel_requested');
  expect(cancelApiTask).toHaveBeenCalledWith('session-a',apiPrincipal(owner),'task-a');
  cancelApiTask.mockRejectedValueOnce(new Error('ACCESS_DENIED'));
  expect((await request(app).post(path).set('Authorization','Bearer owner-fixture')).status).toBe(403);
});

test('legacy mode rejects task cancellation without opening orchestration', async () => {
  const runner=Object.create(AgentRunner.prototype) as any;
  runner.agentConfig={orchestration:{enabled:false}};
  runner.getOrchestration=jest.fn();
  await expect(runner.cancelApiTask('s','owner','t')).rejects.toThrow('require orchestration');
  expect(runner.getOrchestration).not.toHaveBeenCalled();
});
