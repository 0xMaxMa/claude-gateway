import supertest from 'supertest';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentRunner } from '../../src/agent/runner';

const report = { sessionId: 'session', coverage: 'recorded-turns-only', totals: { agentTokens: 0, workerTokens: 0, totalTokens: 0 }, turns: [] };
function setup(keyless = false, bind = '127.0.0.1') {
  const getTokenReport = jest.fn().mockResolvedValue(report);
  const dashboardContextWindow=jest.fn().mockResolvedValue(32768);
  const router = new GatewayRouter(new Map([['agent', { getTokenReport, dashboardContextWindow } as unknown as AgentRunner]]), new Map(), undefined, {
    gateway: { bind, logDir: '/tmp', timezone: 'UTC', api: { keys: keyless ? [] : [{ key: 'admin-secret', admin: true, agents: '*' }, { key: 'scoped-secret', agents: ['agent'] }] } }, agents: [],
  });
  return { app: router.getApp(), getTokenReport, dashboardContextWindow };
}
for (const path of ['/token-report', '/dashboard/token-report']) {
  describe(path, () => {
    test('requires admin before reading report data', async () => {
      const { app, getTokenReport } = setup();
      for (const key of ['', 'scoped-secret']) {
        const response = await supertest(app).get(path).query({ agentId: 'agent', sessionId: 'session' }).set('X-Api-Key', key);
        expect(response.status).toBe(path === '/token-report' ? 401 : 303);
      }
      expect(getTokenReport).not.toHaveBeenCalled();
    });
    test('HTML needs dashboard login; JSON also accepts admin API keys; no caching', async () => {
      const { app, getTokenReport } = setup();
      const response = await supertest(app).get(path).query({ agentId: 'agent', sessionId: 'session' }).set('X-Api-Key', 'admin-secret');
      expect(response.status).toBe(path === '/token-report' ? 200 : 303); expect(response.headers['cache-control']).toBe('no-store');
      if (path === '/token-report') expect(getTokenReport).toHaveBeenCalledWith('session');
      else expect(getTokenReport).not.toHaveBeenCalled();
      const login = await supertest(app).post('/dashboard/login').send({ key: 'admin-secret' });
      const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      expect((await supertest(app).get(path).query({ agentId: 'agent', sessionId: 'session' }).set('Cookie', cookie)).status).toBe(200);
    });
    test('unknown agent and malformed query never invoke a runner', async () => {
      const { app, getTokenReport } = setup();
      const login = await supertest(app).post('/dashboard/login').send({key:'admin-secret'});
      const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      expect((await supertest(app).get(path).set('Cookie',cookie).query({ agentId: '../agent', sessionId: 'session' }).set('X-Api-Key', 'admin-secret')).status).toBe(404);
      expect((await supertest(app).get(path).set('Cookie',cookie).query({ agentId: 'agent', sessionId: ['one', 'two'] }).set('X-Api-Key', 'admin-secret')).status).toBe(400);
      expect(getTokenReport).not.toHaveBeenCalled();
    });
    test('keyless public bind fails closed', async () => {
      const { app, getTokenReport } = setup(true, '0.0.0.0');
      expect((await supertest(app).get(path).query({ agentId: 'agent', sessionId: 'session' })).status).toBe(503);
      expect(getTokenReport).not.toHaveBeenCalled();
    });
  });
}


test.each(['/dashboard/session','/dashboard/task','/dashboard/events'])('%s rejects non-admin access before resolving agent data', async path=>{
 const {app,getTokenReport}=setup();
 for(const key of ['', 'scoped-secret']) expect((await supertest(app).get(path).query({agentId:'agent',sessionId:'session',taskId:'task'}).set('X-Api-Key',key)).status).toBe(401);
 expect(getTokenReport).not.toHaveBeenCalled();
});
test.each(['/dashboard/session','/dashboard/task','/dashboard/events','/status'])('%s validates pagination',async path=>{
 const {app}=setup();
 for(const offset of ['NaN','-1','1.5','1000001']) expect((await supertest(app).get(path).query({agentId:'agent',sessionId:'session',taskId:'task',offset}).set('X-Api-Key','admin-secret')).status).toBe(400);
});


test.each(['/dashboard/token-report','/dashboard/token-report/'])('proxy-injected keys cannot bypass dashboard login at %s', async path => {
  const {app,getTokenReport} = setup();
  for (const cookie of ['', 'dash_session=forged']) {
    const res = await supertest(app).get(path).query({agentId:'agent',sessionId:'session'}).set('X-Api-Key','admin-secret').set('Authorization','Bearer admin-secret').set('Cookie',cookie);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.location, 'https://example.test/gateway'+path).pathname).toBe('/gateway/dashboard/');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toContain('Token distribution');
  }
  expect(getTokenReport).not.toHaveBeenCalled();
  const login = await supertest(app).post('/dashboard/login').send({key:'admin-secret'});
  const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  await supertest(app).get(path).query({agentId:'agent',sessionId:'session'}).set('Cookie',cookie).expect(200);
  await supertest(app).post('/dashboard/logout').set('Cookie',cookie).expect(200);
  getTokenReport.mockClear();
  await supertest(app).get(path).query({agentId:'agent',sessionId:'session'}).set('Cookie',cookie).set('X-Api-Key','admin-secret').expect(303);
  expect(getTokenReport).not.toHaveBeenCalled();
});

test('dashboard context capacity resolves catalog first, configured models second, unknown as missing', async()=>{
 const context:any={availableModels:async()=>[{id:'catalog-model',contextWindow:32768}],gatewayConfig:{gateway:{models:[{id:'configured-model',contextWindow:64000}]}}};
 expect(await AgentRunner.prototype.dashboardContextWindow.call(context,'catalog-model')).toBe(32768);
 expect(await AgentRunner.prototype.dashboardContextWindow.call(context,'configured-model')).toBe(64000);
 expect(await AgentRunner.prototype.dashboardContextWindow.call(context,'unknown-model')).toBeNull();
});

test('JSON report uses resolved capacity instead of guessing from the model ID',async()=>{
 const {app,getTokenReport,dashboardContextWindow}=setup();
 getTokenReport.mockResolvedValue({...report,contextWindow:{used:11000,total:null,model:'custom-model'}});
 const response=await supertest(app).get('/token-report').query({agentId:'agent',sessionId:'session'}).set('X-Api-Key','admin-secret');
 expect(response.body.contextWindow).toEqual({used:11000,total:32768,model:'custom-model'});
 expect(dashboardContextWindow).toHaveBeenCalledWith('custom-model');
});
