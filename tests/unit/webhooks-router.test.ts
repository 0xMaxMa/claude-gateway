/**
 * Unit: the unified /webhooks/:app dispatcher. Verifies app routing (known vs
 * unknown app) and that a known app reaches its handler. The LINE app's full
 * inbound pipeline is covered by tests/integration/line-config-to-chat.test.ts.
 */
import express from 'express';
import * as supertest from 'supertest';
import type { AgentRunner } from '../../src/agent/runner';
import { createWebhooksRouter } from '../../src/api/webhooks-router';

function makeApp(): express.Express {
  const app = express();
  const agents = new Map<string, AgentRunner>();
  app.use('/webhooks', createWebhooksRouter(agents, '/tmp'));
  return app;
}

describe('webhooks dispatcher', () => {
  it('routes GET /webhooks/line to the LINE verify handler (200 ok)', async () => {
    const res = await supertest.default(makeApp()).get('/webhooks/line');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('404s an unknown app on GET', async () => {
    const res = await supertest.default(makeApp()).get('/webhooks/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('unknown webhook app');
  });

  it('404s an unknown app on POST', async () => {
    const res = await supertest.default(makeApp())
      .post('/webhooks/nope')
      .set('Content-Type', 'application/json')
      .send({ hello: 'world' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('nope');
  });

  it('dispatches POST /webhooks/line to the LINE handler (404 when no LINE agent)', async () => {
    const res = await supertest.default(makeApp())
      .post('/webhooks/line')
      .set('Content-Type', 'application/json')
      .send({ events: [] });
    // Reaches the LINE handler, which resolves no LINE-enabled agent.
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('no LINE-enabled agent');
  });

  // `app` is attacker-controlled (`:app` path segment, no auth on this zone). A
  // plain-object lookup with no own-property guard would resolve these to a
  // truthy prototype-chain value instead of undefined, bypassing the 404 below
  // and crashing on the missing verify()/handlePost() call.
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    '404s the reserved prototype-chain key "%s" instead of crashing',
    async (app) => {
      const res = await supertest.default(makeApp()).get(`/webhooks/${app}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('unknown webhook app');
    },
  );

  it('404s "__proto__" on POST too', async () => {
    const res = await supertest.default(makeApp())
      .post('/webhooks/__proto__')
      .set('Content-Type', 'application/json')
      .send({ hello: 'world' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('unknown webhook app');
  });
});
