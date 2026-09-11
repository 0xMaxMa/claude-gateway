/**
 * Unit: POST /api/v1/agents/wizard/start pending-draft replacement (#2493).
 *
 * The wizard 409'd on ANY existing draft for an id — including a stale `pending`
 * draft the same user abandoned via Back/Cancel — locking the id for the 30-min
 * TTL. The fix replaces a `pending` draft (it owns no on-disk agent) and keeps
 * rejecting a `confirmed`/`complete` one.
 *
 * The route shells out to `claude` via child_process.spawn (runClaude); stub it
 * so a start that clears the pre-checks completes without a real subprocess.
 */
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: jest.Mock; end: jest.Mock };
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: jest.fn(), end: jest.fn() };
    setImmediate(() => {
      child.stdout.emit(
        'data',
        Buffer.from('# Agent: Test\n\nA generated personality body long enough to pass the length gate.\n'),
      );
      child.emit('close', 0);
    });
    return child;
  }),
}));

import express from 'express';
import * as supertest from 'supertest';
import { createApiRouter } from '../../src/api/router';
import { wizardStore } from '../../src/api/wizard-state';
import type { ApiKey } from '../../src/types';

const ADMIN_KEY = 'test-admin-key';

function makeApp(): express.Express {
  const agentRunners = new Map();
  const agentConfigs = new Map();
  const apiKeys: ApiKey[] = [{ key: ADMIN_KEY, agents: '*', admin: true }];
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(agentRunners, agentConfigs, apiKeys, '/tmp'));
  return app;
}

function startWizard(app: express.Express, id: string) {
  return supertest
    .default(app)
    .post('/api/v1/agents/wizard/start')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .set('Content-Type', 'application/json')
    .send({ id, prompt: 'a helpful test agent' });
}

// wizardStore is a module singleton — clear any drafts these tests seed.
afterEach(() => {
  for (const id of ['resume-me', 'confirmed-id']) {
    let s = wizardStore.findByAgentId(id);
    while (s) {
      wizardStore.delete(s.wizardId);
      s = wizardStore.findByAgentId(id);
    }
  }
});

describe('wizard/start — pending-draft replacement (#2493)', () => {
  it('replaces a stale pending draft with a fresh one instead of 409 (AC#3 same-id / AC#4)', async () => {
    const app = makeApp();
    const prior = wizardStore.create('resume-me', 'old prompt', { 'AGENTS.md': 'x' });
    expect(prior.step).toBe('pending');

    const res = await startWizard(app, 'resume-me');

    expect(res.status).toBe(201);
    expect(res.body.wizardId).toBeTruthy();
    expect(res.body.wizardId).not.toBe(prior.wizardId);
    // The old draft is gone; the new one owns the id.
    expect(wizardStore.get(prior.wizardId)).toBeUndefined();
    expect(wizardStore.findByAgentId('resume-me')?.wizardId).toBe(res.body.wizardId);
  });

  it('still 409s when the existing draft is already confirmed (guard)', async () => {
    const app = makeApp();
    const prior = wizardStore.create('confirmed-id', 'p', { 'AGENTS.md': 'x' });
    wizardStore.update(prior.wizardId, { step: 'confirmed' });

    const res = await startWizard(app, 'confirmed-id');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/);
    // The confirmed draft is untouched.
    expect(wizardStore.get(prior.wizardId)?.step).toBe('confirmed');
  });
});
