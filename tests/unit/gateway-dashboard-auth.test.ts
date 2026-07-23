/**
 * Regression tests for the bind=0.0.0.0 hardening: with API keys configured, the
 * dashboard-adjacent endpoints that used to be reachable with no credential
 * (/status, /processes, /dashboard) now require an API key OR a dashboard session
 * cookie, and /health leaks nothing beyond liveness. When no API keys are
 * configured, behavior stays open (keyless installs must not lock themselves out).
 *
 * These exercise the real Express app built by GatewayRouter (getApp()) with
 * supertest — no port binding, no WS.
 */
import supertest from 'supertest';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentConfig, GatewayConfig, ApiKey } from '../../src/types';

const KEY = 'sk-gateway-test-000000';

function buildApp(apiKeys: ApiKey[] = [], bind?: string) {
  const gatewayConfig: GatewayConfig = {
    gateway: {
      logDir: '/tmp',
      timezone: 'UTC',
      ...(bind ? { bind } : {}),
      ...(apiKeys.length ? { api: { keys: apiKeys } } : {}),
    },
    agents: [],
  };
  const agents = new Map();
  const configs = new Map<string, AgentConfig>();
  const router = new GatewayRouter(agents, configs, undefined, gatewayConfig);
  return router.getApp();
}

const WITH_KEYS = [{ key: KEY, description: 'test', agents: '*' as const }];

/** Extract the `name=value` pair from a Set-Cookie header for reuse as a Cookie. */
function cookieFrom(res: { headers: Record<string, string[] | string> }): string {
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  return setCookie[0].split(';')[0];
}

describe('gateway dashboard auth hardening (bind 0.0.0.0)', () => {
  describe('① /health is minimal and leaks nothing', () => {
    it('returns exactly {status:ok} with no agents/version fields', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(res.body.agents).toBeUndefined();
    });
  });

  describe('② /status + /processes require auth when keys are configured', () => {
    it('/status → 401 without any credential', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).get('/status');
      expect(res.status).toBe(401);
    });

    it('/processes → 401 without any credential', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).get('/processes');
      expect(res.status).toBe(401);
    });

    it('/status → 200 with a valid API key (X-Api-Key)', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).get('/status').set('X-Api-Key', KEY);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.agents)).toBe(true);
    });

    it('/status → 200 with a valid API key (Bearer)', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).get('/status').set('Authorization', `Bearer ${KEY}`);
      expect(res.status).toBe(200);
    });

    it('/status → 401 with a wrong API key', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).get('/status').set('X-Api-Key', 'nope');
      expect(res.status).toBe(401);
    });
  });

  describe('③ dashboard session cookie flow', () => {
    it('GET /dashboard unauthenticated serves the login page (no dashboard, no token in HTML)', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).get('/dashboard');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Enter an API key');
      expect(res.text).not.toContain('name="dash-token"');
    });

    it('POST /dashboard/login with a valid key sets an HttpOnly SameSite=Strict cookie', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).post('/dashboard/login').send({ key: KEY });
      expect(res.status).toBe(200);
      const setCookie = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(setCookie).toMatch(/dash_session=[0-9a-f]{64}/);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Strict/);
      expect(setCookie).toMatch(/Path=\//);
    });

    it('POST /dashboard/login with a wrong key → 401, no cookie', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).post('/dashboard/login').send({ key: 'wrong' });
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('the session cookie authorizes /status and GET /dashboard (serves the real dashboard)', async () => {
      const app = buildApp(WITH_KEYS);
      const login = await supertest(app).post('/dashboard/login').send({ key: KEY });
      const cookie = cookieFrom(login);

      const status = await supertest(app).get('/status').set('Cookie', cookie);
      expect(status.status).toBe(200);

      const dash = await supertest(app).get('/dashboard').set('Cookie', cookie);
      expect(dash.status).toBe(200);
      expect(dash.text).toContain('Claude Gateway');
      expect(dash.text).not.toContain('Enter an API key');
    });

    it('logout revokes the session — the same cookie no longer authorizes /status', async () => {
      const app = buildApp(WITH_KEYS);
      const login = await supertest(app).post('/dashboard/login').send({ key: KEY });
      const cookie = cookieFrom(login);

      await supertest(app).post('/dashboard/logout').set('Cookie', cookie).expect(200);

      const status = await supertest(app).get('/status').set('Cookie', cookie);
      expect(status.status).toBe(401);
    });

    it('a forged/unknown session cookie is rejected', async () => {
      const res = await supertest(buildApp(WITH_KEYS))
        .get('/status')
        .set('Cookie', 'dash_session=deadbeefdeadbeef');
      expect(res.status).toBe(401);
    });
  });

  describe('keyless install on loopback stays open (no lock-out)', () => {
    // No bind → resolves to the 127.0.0.1 default (loopback).
    it('/status is reachable with no credential when no API keys are configured', async () => {
      const res = await supertest(buildApp([])).get('/status');
      expect(res.status).toBe(200);
    });

    it('GET /dashboard serves the dashboard directly (not the login page) with no keys', async () => {
      const res = await supertest(buildApp([])).get('/dashboard');
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('Enter an API key');
    });

    it('explicit loopback bind (127.0.0.1) keyless is still open', async () => {
      const res = await supertest(buildApp([], '127.0.0.1')).get('/status');
      expect(res.status).toBe(200);
    });

    it('POST /dashboard/login → 404 when auth is not configured', async () => {
      const res = await supertest(buildApp([])).post('/dashboard/login').send({ key: 'anything' });
      expect(res.status).toBe(404);
    });
  });

  describe('keyless install on a NON-loopback bind fails closed', () => {
    it('/status → 503 (not open) when keyless and bound to 0.0.0.0', async () => {
      const res = await supertest(buildApp([], '0.0.0.0')).get('/status');
      expect(res.status).toBe(503);
    });

    it('/processes → 503 when keyless and bound to 0.0.0.0', async () => {
      const res = await supertest(buildApp([], '0.0.0.0')).get('/processes');
      expect(res.status).toBe(503);
    });

    it('GET /dashboard → 503 with a "configure gateway.api.keys" notice (no open dashboard)', async () => {
      const res = await supertest(buildApp([], '0.0.0.0')).get('/dashboard');
      expect(res.status).toBe(503);
      expect(res.text).toContain('gateway.api.keys');
      expect(res.text).not.toContain('id="pty-mode-toggle-btn"'); // not the real dashboard
    });

    it('/health stays public even keyless on 0.0.0.0 (liveness only)', async () => {
      const res = await supertest(buildApp([], '0.0.0.0')).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('configuring an API key re-enables access on 0.0.0.0 (login works)', async () => {
      const app = buildApp(WITH_KEYS, '0.0.0.0');
      const status = await supertest(app).get('/status');
      expect(status.status).toBe(401); // keyed → needs a credential, not 503
      const login = await supertest(app).post('/dashboard/login').send({ key: KEY });
      expect(login.status).toBe(200);
    });
  });
});
