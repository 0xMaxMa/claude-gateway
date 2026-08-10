/**
 * Unit tests for the image share bridge HTTP surface (#70) —
 * src/api/share-router.ts. Covers plan §20.1 API-level items:
 * mint/batch order, agent-scope auth, uniform public 404s, GET/HEAD vs 405,
 * the no-list guarantee and the in-handler per-IP rate limit (§11).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import * as supertest from 'supertest';
import {
  createSharesPublicRouter,
  createSharesPrivateRouter,
} from '../../src/api/share-router';
import { resolveGatewayPublicUrl } from '../../src/config/public-url';
import { ShareStore } from '../../src/share/share-store';
import { HistoryDB } from '../../src/history/db';
import { ApiKey } from '../../src/types';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 2)]);

const AGENT = 'a1';
const SESSION = 'session-1';
const BASE_URL = 'https://pod-123.vm.example.com/gateway';

const KEYS: ApiKey[] = [
  { key: 'admin-key', agents: '*', admin: true },
  { key: 'a1-key', agents: [AGENT] },
  { key: 'b1-key', agents: ['b1'] },
  // Non-admin wildcard key: passes canAccessAgent for ANY agent id, so it is the
  // key that would weaponize a "../"-laden agent_id if format validation were
  // missing (HIGH #1 regression below).
  { key: 'star-key', agents: '*' },
];

const AUTH_A1 = { Authorization: 'Bearer a1-key' };
const AUTH_B1 = { Authorization: 'Bearer b1-key' };
const AUTH_STAR = { Authorization: 'Bearer star-key' };

describe('image share router', () => {
  let baseDir: string;
  let mediaDir: string;
  let store: ShareStore;
  let app: express.Application;
  let logSpy: jest.SpyInstance;

  const request = () => supertest.default(app);

  const buildApp = (publicOpts: { ratePerMinute?: number } = {}) => {
    const a = express();
    a.use(express.json());
    a.use(createSharesPublicRouter(store, baseDir, publicOpts));
    a.use('/api', createSharesPrivateRouter(store, KEYS, baseDir, BASE_URL));
    return a;
  };

  const mintOne = async (refPath = `${SESSION}/ok.png`, extra: Record<string, unknown> = {}) => {
    const res = await request()
      .post('/api/v1/shares')
      .set(AUTH_A1)
      .send({ agent_id: AGENT, session_id: SESSION, refs: [{ path: refPath }], ...extra });
    expect(res.status).toBe(201);
    return res.body.items[0] as { share_id: string; url: string; token: string; expires_at: string };
  };

  const sharedPath = (url: string) => new URL(url).pathname;

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'imgshare-http-')));
    mediaDir = path.join(baseDir, AGENT, 'media', SESSION);
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'ok.png'), PNG);
    fs.writeFileSync(path.join(mediaDir, 'ok.jpg'), JPEG);
    store = new ShareStore(path.join(baseDir, 'shares.db'));
    app = buildApp();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    store.close();
    HistoryDB.evict(baseDir, AGENT);
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe('B1 — mint returns a host-agnostic token; url is an optional convenience', () => {
    test('mint response includes a raw token alongside the url', async () => {
      const item = await mintOne();
      expect(typeof item.token).toBe('string');
      expect(item.token.length).toBeGreaterThan(0);
      // url is still built from the configured public base, and its /shared/ path
      // segment is exactly the returned token.
      expect(item.url.startsWith(`${BASE_URL}/shared/`)).toBe(true);
      expect(item.url.endsWith(`/shared/${item.token}`)).toBe(true);
    });

    test('mint works WITHOUT a public base: token present, url omitted, token still resolves', async () => {
      // A LINE-style pod with no gateway.publicUrl → private router mounted with no
      // base. Mint must still succeed (the publicUrl gate is gone) and return a
      // token the caller builds its own URL from; the `url` field is simply omitted.
      const noBaseApp = express();
      noBaseApp.use(express.json());
      noBaseApp.use(createSharesPublicRouter(store, baseDir));
      noBaseApp.use('/api', createSharesPrivateRouter(store, KEYS, baseDir)); // no base URL
      const res = await supertest
        .default(noBaseApp)
        .post('/api/v1/shares')
        .set(AUTH_A1)
        .send({ agent_id: AGENT, session_id: SESSION, refs: [{ path: `${SESSION}/ok.png` }] });
      expect(res.status).toBe(201);
      const item = res.body.items[0] as { share_id: string; url?: string; token: string };
      expect(typeof item.token).toBe('string');
      expect(item.token.length).toBeGreaterThan(0);
      expect(item.url).toBeUndefined();
      // Host-agnostic: the bare token resolves through the public route regardless
      // of which base the caller prepends.
      const fetched = await supertest.default(noBaseApp).get(`/shared/${item.token}`);
      expect(fetched.status).toBe(200);
    });
  });

  describe('id format validation (HIGH #1 — sandbox-escape guard)', () => {
    // A non-admin agents:'*' key passes canAccessAgent for any id, so without a
    // format check a "../"-laden agent_id would relocate the media containment
    // root itself (path.join(base, agentId, 'media')) outside the agents tree.
    const BAD_AGENTS = ['../../../../etc', '..', 'a/../../b', 'A1', 'has space', ''];
    const BAD_SESSIONS = ['../../secrets', 'a/b', 'has space', ''];

    test('mint rejects malformed agent_id with 400 before any path resolution', async () => {
      for (const bad of BAD_AGENTS) {
        const res = await request()
          .post('/api/v1/shares')
          .set(AUTH_STAR)
          .send({ agent_id: bad, session_id: SESSION, refs: [{ path: `${SESSION}/ok.png` }] });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('agent_id and session_id must be valid identifiers');
      }
    });

    test('mint rejects malformed session_id with 400', async () => {
      for (const bad of BAD_SESSIONS) {
        const res = await request()
          .post('/api/v1/shares')
          .set(AUTH_STAR)
          .send({ agent_id: AGENT, session_id: bad, refs: [{ path: `${SESSION}/ok.png` }] });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('agent_id and session_id must be valid identifiers');
      }
    });

    test('artifacts rejects malformed agent_id with 400', async () => {
      const res = await request()
        .post('/api/v1/image-artifacts')
        .set(AUTH_STAR)
        .send({ agent_id: '../../../../etc', session_id: SESSION, files: [`${SESSION}/ok.png`] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('agent_id and session_id must be valid identifiers');
    });

    test('catalog rejects malformed agent_id with 400', async () => {
      const res = await request()
        .get(`/api/v1/image-catalog?agent_id=${encodeURIComponent('../../../../etc')}&session_id=${SESSION}`)
        .set(AUTH_STAR);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('agent_id and session_id must be valid identifiers');
    });
  });

  describe('mint (§10)', () => {
    test('creates a share from a valid media file and serves it publicly', async () => {
      const item = await mintOne();
      expect(item.share_id).toMatch(/^shr_/);
      expect(item.url.startsWith(`${BASE_URL}/shared/`)).toBe(true);
      expect(new Date(item.expires_at).getTime()).toBeGreaterThan(Date.now());

      const res = await request().get(sharedPath(item.url));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-length']).toBe(String(PNG.length));
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
    });

    test('batch create preserves input order', async () => {
      const res = await request()
        .post('/api/v1/shares')
        .set(AUTH_A1)
        .send({
          agent_id: AGENT,
          session_id: SESSION,
          refs: [{ path: `${SESSION}/ok.jpg` }, { path: `${SESSION}/ok.png` }],
        });
      expect(res.status).toBe(201);
      const [first, second] = res.body.items as Array<{ url: string }>;
      const r1 = await request().get(sharedPath(first.url));
      const r2 = await request().get(sharedPath(second.url));
      expect(r1.headers['content-type']).toBe('image/jpeg');
      expect(r2.headers['content-type']).toBe('image/png');
    });

    test('same ref re-minted within the window returns the SAME URL (§17.4)', async () => {
      const a = await mintOne();
      const b = await mintOne();
      expect(b.url).toBe(a.url);
      expect(b.share_id).toBe(a.share_id);
    });

    test('key without access to the agent → 403; no auth → 401', async () => {
      const res = await request()
        .post('/api/v1/shares')
        .set(AUTH_B1)
        .send({ agent_id: AGENT, session_id: SESSION, refs: [{ path: `${SESSION}/ok.png` }] });
      expect(res.status).toBe(403);
      const noAuth = await request()
        .post('/api/v1/shares')
        .send({ agent_id: AGENT, session_id: SESSION, refs: [{ path: `${SESSION}/ok.png` }] });
      expect(noAuth.status).toBe(401);
    });

    test('rejects traversal, duplicates and over-count before minting', async () => {
      const post = (refs: unknown[]) =>
        request().post('/api/v1/shares').set(AUTH_A1).send({ agent_id: AGENT, session_id: SESSION, refs });

      expect((await post([{ path: '../../etc/passwd' }])).status).toBe(400);
      const dup = await post([{ path: `${SESSION}/ok.png` }, { path: `${SESSION}/ok.png` }]);
      expect(dup.status).toBe(400);
      expect(dup.body.code).toBe('duplicate_ref');
      const many = await post(Array.from({ length: 6 }, (_, i) => ({ path: `${SESSION}/x${i}.png` })));
      expect(many.status).toBe(400);
      expect(many.body.code).toBe('too_many_refs');
    });

    test('registration persists the prompt, capped at 500 chars', async () => {
      const reg = await request()
        .post('/api/v1/image-artifacts')
        .set(AUTH_A1)
        .send({
          agent_id: AGENT,
          session_id: SESSION,
          provider: 'codex-image',
          model: 'gpt-image',
          prompt: `pad ${'x'.repeat(600)}`,
          files: [`${SESSION}/ok.png`],
        });
      expect(reg.status).toBe(201);
      const found = store.findArtifactByPath(AGENT, SESSION, `${SESSION}/ok.png`);
      expect(found?.prompt).toHaveLength(500);
      expect(found?.prompt!.startsWith('pad x')).toBe(true);
    });

    test('artifact refs resolve only in the owning agent/session', async () => {
      const reg = await request()
        .post('/api/v1/image-artifacts')
        .set(AUTH_A1)
        .send({
          agent_id: AGENT,
          session_id: SESSION,
          provider: 'codex-image',
          model: 'gpt-image',
          task_id: 't-1',
          files: [`${SESSION}/ok.png`],
        });
      expect(reg.status).toBe(201);
      const artifact = reg.body.items[0] as { artifact_id: string; artifact_ref: string; index: number };
      expect(artifact.artifact_ref).toBe(`artifact:${artifact.artifact_id}`);

      const ok = await request()
        .post('/api/v1/shares')
        .set(AUTH_A1)
        .send({ agent_id: AGENT, session_id: SESSION, refs: [{ artifact_id: artifact.artifact_id }] });
      expect(ok.status).toBe(201);

      const wrongSession = await request()
        .post('/api/v1/shares')
        .set(AUTH_A1)
        .send({ agent_id: AGENT, session_id: 'other-session', refs: [{ artifact_id: artifact.artifact_id }] });
      expect(wrongSession.status).toBe(404);
      expect(wrongSession.body.code).toBe('image_ref_not_found');
    });
  });

  describe('public endpoint (§11)', () => {
    test('HEAD returns headers without a body', async () => {
      const item = await mintOne();
      const res = await request().head(sharedPath(item.url));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-length']).toBe(String(PNG.length));
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    test('unknown / expired / revoked / deleted all yield an IDENTICAL 404', async () => {
      // unknown
      const unknown = await request().get('/shared/' + 'A'.repeat(32));
      // expired (min TTL is clamped to 10s — insert an already-expired row directly)
      const expired = store.mintShare({
        agentId: AGENT,
        sessionId: SESSION,
        relativePath: `${SESSION}/ok.png`,
        dedupeRef: 'path:expired',
        purpose: 'codex_ref',
        ttlSeconds: 0,
      });
      const expiredRes = await request().get(`/shared/${expired.token}`);
      // revoked
      const revokedItem = await mintOne();
      await request().delete(`/api/v1/shares/${revokedItem.share_id}`).set(AUTH_A1).expect(200);
      const revokedRes = await request().get(sharedPath(revokedItem.url));
      // deleted file (fresh ref so the idempotency cache is not hit)
      fs.writeFileSync(path.join(mediaDir, 'temp.png'), PNG);
      const deletedItem = await mintOne(`${SESSION}/temp.png`);
      fs.unlinkSync(path.join(mediaDir, 'temp.png'));
      const deletedRes = await request().get(sharedPath(deletedItem.url));

      for (const res of [unknown, expiredRes, revokedRes, deletedRes]) {
        expect(res.status).toBe(404);
        expect(res.text).toBe('Not Found');
        expect(res.headers['content-type']).toContain('text/plain');
      }
    });

    test('methods other than GET/HEAD → 405 with Allow header', async () => {
      const item = await mintOne();
      for (const method of ['post', 'put', 'delete', 'patch'] as const) {
        const res = await request()[method](sharedPath(item.url));
        expect(res.status).toBe(405);
        expect(res.headers['allow']).toBe('GET, HEAD');
      }
    });

    test('no list endpoint exists (GET /shared, GET /api/v1/shares → 404)', async () => {
      expect((await request().get('/shared')).status).toBe(404);
      expect((await request().get('/shared/')).status).toBe(404);
      expect((await request().get('/api/v1/shares').set(AUTH_A1)).status).toBe(404);
    });

    test('per-IP rate limit sheds a 404-flood with 429 (§11)', async () => {
      const limited = buildApp({ ratePerMinute: 3 });
      const req = supertest.default(limited);
      const token = 'B'.repeat(32);
      for (let i = 0; i < 3; i++) {
        expect((await req.get(`/shared/${token}`)).status).toBe(404);
      }
      expect((await req.get(`/shared/${token}`)).status).toBe(429);
    });
  });

  describe('revoke (§10)', () => {
    test('owner revokes → public URL dies; foreign key sees uniform 404', async () => {
      const item = await mintOne();
      const foreign = await request().delete(`/api/v1/shares/${item.share_id}`).set(AUTH_B1);
      expect(foreign.status).toBe(404);
      // still alive
      expect((await request().get(sharedPath(item.url))).status).toBe(200);
      const own = await request().delete(`/api/v1/shares/${item.share_id}`).set(AUTH_A1);
      expect(own.status).toBe(200);
      expect(own.body.revoked).toBe(true);
      expect((await request().get(sharedPath(item.url))).status).toBe(404);
    });
  });

  describe('artifact registration (§8)', () => {
    test('foreign key cannot register artifacts for the agent', async () => {
      const res = await request()
        .post('/api/v1/image-artifacts')
        .set(AUTH_B1)
        .send({ agent_id: AGENT, session_id: SESSION, provider: 'p', model: 'm', files: [`${SESSION}/ok.png`] });
      expect(res.status).toBe(403);
    });

    test('registration validates containment (traversal rejected)', async () => {
      const res = await request()
        .post('/api/v1/image-artifacts')
        .set(AUTH_A1)
        .send({ agent_id: AGENT, session_id: SESSION, provider: 'p', model: 'm', files: ['../../x.png'] });
      expect(res.status).toBe(400);
    });
  });

  describe('image catalog (#72)', () => {
    const seedHistory = () => {
      const db = HistoryDB.forAgent(baseDir, AGENT);
      db.insertMessage({
        chatId: `api-${SESSION}`,
        sessionId: SESSION,
        source: 'api',
        role: 'user',
        content: 'here you go',
        mediaFiles: [`media/${SESSION}/ok.png`],
        ts: 1_700_000_001_000,
      });
      db.insertMessage({
        chatId: `api-${SESSION}`,
        sessionId: SESSION,
        source: 'api',
        role: 'assistant',
        content: 'made one',
        mediaFiles: [`media/${SESSION}/ok.jpg`],
        ts: 1_700_000_002_000,
      });
    };

    const get = (query: string, auth?: Record<string, string>) => {
      const r = request().get(`/api/v1/image-catalog${query}`);
      return auth ? r.set(auth) : r;
    };

    test('no auth → 401; key without access to the agent → 403', async () => {
      expect((await get(`?agent_id=${AGENT}&session_id=${SESSION}`)).status).toBe(401);
      expect((await get(`?agent_id=${AGENT}&session_id=${SESSION}`, AUTH_B1)).status).toBe(403);
    });

    test('missing or blank agent_id / session_id → 400', async () => {
      for (const q of ['', `?agent_id=${AGENT}`, `?session_id=${SESSION}`, `?agent_id=%20&session_id=${SESSION}`]) {
        const res = await get(q, AUTH_A1);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('agent_id and session_id must be valid identifiers');
      }
    });

    test('returns the session catalog with ordinals, origin and availability', async () => {
      seedHistory();
      const res = await get(`?agent_id=${AGENT}&session_id=${SESSION}`, AUTH_A1);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([
        {
          index: 1,
          ref: `${SESSION}/ok.png`,
          relative_path: `${SESSION}/ok.png`,
          origin: 'upload',
          ts: 1_700_000_001_000,
          available: true,
          desc: 'here you go',
        },
        {
          index: 2,
          ref: `${SESSION}/ok.jpg`,
          relative_path: `${SESSION}/ok.jpg`,
          origin: 'generated',
          ts: 1_700_000_002_000,
          available: true,
        },
      ]);
    });

    test('a session with no media returns an empty list', async () => {
      const res = await get(`?agent_id=${AGENT}&session_id=nothing-here`, AUTH_A1);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    test('response carries no share token and mints nothing (read-only)', async () => {
      seedHistory();
      const minted = await mintOne();
      const token = minted.url.split('/shared/')[1]!;

      const res = await get(`?agent_id=${AGENT}&session_id=${SESSION}`, AUTH_A1);
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(token);
      expect(body).not.toContain('token');
      expect(body).not.toContain('/shared/');
      expect(body).not.toContain(minted.share_id);
      for (const item of res.body.items as Array<Record<string, unknown>>) {
        // desc is optional (only when the source message carried text / a prompt)
        const keys = Object.keys(item).filter((k) => k !== 'desc').sort();
        expect(keys).toEqual(['available', 'index', 'origin', 'ref', 'relative_path', 'ts']);
      }
    });
  });

  describe('resolveGatewayPublicUrl (§14 fail-closed)', () => {
    test('requires /gateway and permits HTTP only for local development hosts', () => {
      expect(resolveGatewayPublicUrl('https://pod-1.example.com/gateway')).toBe(
        'https://pod-1.example.com/gateway',
      );
      expect(resolveGatewayPublicUrl('https://pod-1.example.com/gateway/')).toBe(
        'https://pod-1.example.com/gateway',
      );
      expect(resolveGatewayPublicUrl('http://host.docker.internal:10850/gateway')).toBe(
        'http://host.docker.internal:10850/gateway',
      );
      expect(resolveGatewayPublicUrl('http://localhost:10850/gateway')).toBe(
        'http://localhost:10850/gateway',
      );
      expect(resolveGatewayPublicUrl('http://pod-1.example.com/gateway')).toBeNull();
      expect(resolveGatewayPublicUrl('https://pod-1.example.com')).toBeNull();
      expect(resolveGatewayPublicUrl('https://pod-1.example.com/shared')).toBeNull();
      expect(resolveGatewayPublicUrl('https://pod-1.example.com/gateway?x=1')).toBeNull();
      expect(resolveGatewayPublicUrl('')).toBeNull();
      expect(resolveGatewayPublicUrl(undefined)).toBeNull();
      expect(resolveGatewayPublicUrl('not a url')).toBeNull();
    });
  });
});
