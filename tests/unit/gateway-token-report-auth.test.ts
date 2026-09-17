import supertest from 'supertest';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentRunner } from '../../src/agent/runner';

const report = { sessionId: 'session', coverage: 'recorded-turns-only', totals: { agentTokens: 0, workerTokens: 0, totalTokens: 0 }, turns: [] };
function setup(keyless = false, bind = '127.0.0.1') {
  const getTokenReport = jest.fn().mockResolvedValue(report);
  const router = new GatewayRouter(new Map([['agent', { getTokenReport } as unknown as AgentRunner]]), new Map(), undefined, {
    gateway: { bind, logDir: '/tmp', timezone: 'UTC', api: { keys: keyless ? [] : [{ key: 'admin-secret', admin: true, agents: '*' }, { key: 'scoped-secret', agents: ['agent'] }] } }, agents: [],
  });
  return { app: router.getApp(), getTokenReport };
}
for (const path of ['/token-report', '/dashboard/token-report']) {
  describe(path, () => {
    test('requires admin before reading report data', async () => {
      const { app, getTokenReport } = setup();
      for (const key of ['', 'scoped-secret']) {
        const response = await supertest(app).get(path).query({ agentId: 'agent', sessionId: 'session' }).set('X-Api-Key', key);
        expect(response.status).toBe(401);
      }
      expect(getTokenReport).not.toHaveBeenCalled();
    });
    test('admin and dashboard cookie may read report; no caching', async () => {
      const { app, getTokenReport } = setup();
      const response = await supertest(app).get(path).query({ agentId: 'agent', sessionId: 'session' }).set('X-Api-Key', 'admin-secret');
      expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(getTokenReport).toHaveBeenCalledWith('session');
      const login = await supertest(app).post('/dashboard/login').send({ key: 'admin-secret' });
      const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      expect((await supertest(app).get(path).query({ agentId: 'agent', sessionId: 'session' }).set('Cookie', cookie)).status).toBe(200);
    });
    test('unknown agent and malformed query never invoke a runner', async () => {
      const { app, getTokenReport } = setup();
      expect((await supertest(app).get(path).query({ agentId: '../agent', sessionId: 'session' }).set('X-Api-Key', 'admin-secret')).status).toBe(404);
      expect((await supertest(app).get(path).query({ agentId: 'agent', sessionId: ['one', 'two'] }).set('X-Api-Key', 'admin-secret')).status).toBe(400);
      expect(getTokenReport).not.toHaveBeenCalled();
    });
    test('keyless public bind fails closed', async () => {
      const { app, getTokenReport } = setup(true, '0.0.0.0');
      expect((await supertest(app).get(path).query({ agentId: 'agent', sessionId: 'session' })).status).toBe(503);
      expect(getTokenReport).not.toHaveBeenCalled();
    });
  });
}
