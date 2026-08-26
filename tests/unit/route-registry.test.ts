import express from 'express';
import request from 'supertest';
import {
  defineRoute,
  getRegisteredRoutes,
  resetRegisteredRoutes,
} from '../../src/api/route-registry';

describe('route-registry defineRoute', () => {
  beforeEach(() => resetRegisteredRoutes());

  it('mounts the handler on the router (behaves like router.get)', async () => {
    const router = express.Router();
    defineRoute(
      router,
      { method: 'GET', path: '/v1/ping', auth: 'none', summary: 'ping', cli: { noun: 'ping', verb: 'get' } },
      (_req, res) => res.json({ pong: true }),
    );
    const app = express();
    app.use('/api', router);
    const res = await request(app).get('/api/v1/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
  });

  it('records the route metadata into the manifest', () => {
    const router = express.Router();
    defineRoute(
      router,
      { method: 'POST', path: '/v1/things/:id', auth: 'key', summary: 'do', cli: { noun: 'things', verb: 'do', args: ['id'] } },
      (_req, res) => res.end(),
    );
    const routes = getRegisteredRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'POST',
      path: '/v1/things/:id',
      auth: 'key',
      summary: 'do',
      cli: { noun: 'things', verb: 'do', args: ['id'] },
    });
  });

  it('dedupes repeated registration by method+path (idempotent across factory calls)', () => {
    for (let i = 0; i < 3; i++) {
      const router = express.Router();
      defineRoute(router, { method: 'GET', path: '/v1/x', auth: 'none', summary: 'x', cli: { noun: 'x', verb: 'get' } }, (_r, res) => res.end());
    }
    expect(getRegisteredRoutes().filter((r) => r.path === '/v1/x')).toHaveLength(1);
  });

  it('returns a deep copy — callers cannot mutate the manifest', () => {
    const router = express.Router();
    defineRoute(router, { method: 'GET', path: '/v1/y', auth: 'none', summary: 'y', cli: { noun: 'y', verb: 'get' } }, (_r, res) => res.end());
    const snap = getRegisteredRoutes();
    snap[0].summary = 'mutated';
    (snap[0].cli as { noun: string }).noun = 'hacked';
    const fresh = getRegisteredRoutes();
    expect(fresh[0].summary).toBe('y');
    expect(fresh[0].cli!.noun).toBe('y');
  });

  it('resetRegisteredRoutes clears the manifest', () => {
    const router = express.Router();
    defineRoute(router, { method: 'GET', path: '/v1/z', auth: 'none', summary: 'z', cli: null }, (_r, res) => res.end());
    expect(getRegisteredRoutes().length).toBeGreaterThan(0);
    resetRegisteredRoutes();
    expect(getRegisteredRoutes()).toHaveLength(0);
  });
});
