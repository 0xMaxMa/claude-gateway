/**
 * Regression tests for the bind=0.0.0.0 hardening: with API keys configured, the
 * dashboard-adjacent endpoints that used to be reachable with no credential
 * (/status, /processes, /dashboard) now require an ADMIN API key OR a dashboard
 * session cookie (itself only issued to an admin key), and /health leaks nothing
 * beyond liveness. A valid-but-non-admin (scoped/write) key is rejected. When no
 * API keys are configured, behavior stays open (keyless installs must not lock
 * themselves out).
 *
 * These exercise the real Express app built by GatewayRouter (getApp()) with
 * supertest — no port binding, no WS.
 */
import supertest from 'supertest';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentConfig, GatewayConfig, ApiKey } from '../../src/types';

const KEY = 'sk-gateway-test-000000';
const NON_ADMIN_KEY = 'sk-gateway-scoped-00000';

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

// The dashboard/monitoring surface requires an ADMIN key. KEY is admin; the
// scoped key below is a valid, configured key that must NOT reach the dashboard.
const WITH_KEYS = [
  { key: KEY, description: 'test admin', agents: '*' as const, admin: true },
  { key: NON_ADMIN_KEY, description: 'test scoped', agents: ['some-agent'] },
];

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

    it('POST /dashboard/login with a valid key sets an HttpOnly SameSite=Lax cookie', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).post('/dashboard/login').send({ key: KEY });
      expect(res.status).toBe(200);
      const setCookie = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(setCookie).toMatch(/dash_session=[0-9a-f]{64}/);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Lax/);
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

    // Robust loopback detection — these unusual-but-legitimate loopback spellings
    // must NOT be treated as exposed (keyless → still open), while bind-all forms must.
    it.each(['localhost', '::1', '0:0:0:0:0:0:0:1', '127.0.0.5'])(
      'keyless on loopback spelling %s stays open',
      async (bind) => {
        const res = await supertest(buildApp([], bind)).get('/status');
        expect(res.status).toBe(200);
      },
    );

    it.each(['::', '192.168.1.10'])('keyless on non-loopback %s fails closed (503)', async (bind) => {
      const res = await supertest(buildApp([], bind)).get('/status');
      expect(res.status).toBe(503);
    });
  });

  describe('④ dashboard/monitoring requires an ADMIN key (non-admin key rejected)', () => {
    it('POST /dashboard/login with a valid NON-admin key → 401, no cookie', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).post('/dashboard/login').send({ key: NON_ADMIN_KEY });
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('/status with a valid NON-admin key (X-Api-Key) → 401', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).get('/status').set('X-Api-Key', NON_ADMIN_KEY);
      expect(res.status).toBe(401);
    });

    it('/status with a valid NON-admin key (Bearer) → 401', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).get('/status').set('Authorization', `Bearer ${NON_ADMIN_KEY}`);
      expect(res.status).toBe(401);
    });

    it('/processes with a valid NON-admin key → 401', async () => {
      const res = await supertest(buildApp(WITH_KEYS)).get('/processes').set('X-Api-Key', NON_ADMIN_KEY);
      expect(res.status).toBe(401);
    });

    it('an ADMIN key is accepted at /status and /dashboard/login', async () => {
      const app = buildApp(WITH_KEYS);
      const status = await supertest(app).get('/status').set('X-Api-Key', KEY);
      expect(status.status).toBe(200);
      const login = await supertest(app).post('/dashboard/login').send({ key: KEY });
      expect(login.status).toBe(200);
    });

    it('a config with keys but no admin key rejects every key at login (fail-closed)', async () => {
      const scopedOnly = [{ key: NON_ADMIN_KEY, description: 'scoped', agents: ['some-agent'] }];
      const app = buildApp(scopedOnly);
      const login = await supertest(app).post('/dashboard/login').send({ key: NON_ADMIN_KEY });
      expect(login.status).toBe(401);
      const status = await supertest(app).get('/status').set('X-Api-Key', NON_ADMIN_KEY);
      expect(status.status).toBe(401);
    });
  });

  describe('/dashboard/login brute-force throttle', () => {
    it('blocks with 429 after 10 failed attempts — even with the correct key', async () => {
      const app = buildApp(WITH_KEYS);
      // 10 wrong attempts are allowed (each 401)…
      for (let i = 0; i < 10; i++) {
        const r = await supertest(app).post('/dashboard/login').send({ key: 'wrong' });
        expect(r.status).toBe(401);
      }
      // …the 11th is throttled, and the throttle applies even to the correct key.
      const blocked = await supertest(app).post('/dashboard/login').send({ key: KEY });
      expect(blocked.status).toBe(429);
    });

    it('a successful login before the limit clears the failure window', async () => {
      const app = buildApp(WITH_KEYS);
      for (let i = 0; i < 5; i++) {
        await supertest(app).post('/dashboard/login').send({ key: 'wrong' });
      }
      const ok = await supertest(app).post('/dashboard/login').send({ key: KEY });
      expect(ok.status).toBe(200);
      // Window was reset, so a fresh batch of wrong attempts is allowed again.
      const afterReset = await supertest(app).post('/dashboard/login').send({ key: 'wrong' });
      expect(afterReset.status).toBe(401);
    });
  });
});
