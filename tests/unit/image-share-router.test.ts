/**
 * Unit tests for the image share bridge HTTP surface (#70) —
 * src/api/image-share-router.ts. Covers plan §20.1 API-level items:
 * mint/batch order, agent-scope auth, uniform public 404s, GET/HEAD vs 405,
 * the no-list guarantee, the in-handler per-IP rate limit (§11), and the
 * SHARE_PUBLIC_BASE_URL fail-closed validation (§14).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import * as supertest from 'supertest';
import {
  createImageSharePublicRouter,
  createImageSharePrivateRouter,
  resolvePublicBaseUrl,
} from '../../src/api/image-share-router';
import { ImageShareStore } from '../../src/share/image-share-store';
import { ApiKey } from '../../src/types';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 2)]);

const AGENT = 'a1';
const SESSION = 'session-1';
const BASE_URL = 'https://pod-123.vm.example.com';

const KEYS: ApiKey[] = [
  { key: 'admin-key', agents: '*', admin: true },
  { key: 'a1-key', agents: [AGENT] },
  { key: 'b1-key', agents: ['b1'] },
];

const AUTH_A1 = { Authorization: 'Bearer a1-key' };
const AUTH_B1 = { Authorization: 'Bearer b1-key' };

describe('image share router', () => {
  let baseDir: string;
  let mediaDir: string;
  let store: ImageShareStore;
  let app: express.Application;
  let logSpy: jest.SpyInstance;

  const request = () => supertest.default(app);

  const buildApp = (publicOpts: { ratePerMinute?: number } = {}) => {
    const a = express();
    a.use(express.json());
    a.use(createImageSharePublicRouter(store, baseDir, publicOpts));
    a.use('/api', createImageSharePrivateRouter(store, KEYS, baseDir, BASE_URL));
    return a;
  };

  const mintOne = async (refPath = `${SESSION}/ok.png`, extra: Record<string, unknown> = {}) => {
    const res = await request()
      .post('/api/v1/image-shares')
      .set(AUTH_A1)
      .send({ agent_id: AGENT, session_id: SESSION, refs: [{ path: refPath }], ...extra });
    expect(res.status).toBe(201);
    return res.body.items[0] as { share_id: string; url: string; expires_at: string };
  };

  const sharedPath = (url: string) => new URL(url).pathname;

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'imgshare-http-')));
    mediaDir = path.join(baseDir, AGENT, 'media', SESSION);
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'ok.png'), PNG);
    fs.writeFileSync(path.join(mediaDir, 'ok.jpg'), JPEG);
    store = new ImageShareStore(path.join(baseDir, 'shares.db'));
    app = buildApp();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    store.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
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
        .post('/api/v1/image-shares')
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
        .post('/api/v1/image-shares')
        .set(AUTH_B1)
        .send({ agent_id: AGENT, session_id: SESSION, refs: [{ path: `${SESSION}/ok.png` }] });
      expect(res.status).toBe(403);
      const noAuth = await request()
        .post('/api/v1/image-shares')
        .send({ agent_id: AGENT, session_id: SESSION, refs: [{ path: `${SESSION}/ok.png` }] });
      expect(noAuth.status).toBe(401);
    });

    test('rejects traversal, duplicates and over-count before minting', async () => {
      const post = (refs: unknown[]) =>
        request().post('/api/v1/image-shares').set(AUTH_A1).send({ agent_id: AGENT, session_id: SESSION, refs });

      expect((await post([{ path: '../../etc/passwd' }])).status).toBe(400);
      const dup = await post([{ path: `${SESSION}/ok.png` }, { path: `${SESSION}/ok.png` }]);
      expect(dup.status).toBe(400);
      expect(dup.body.code).toBe('duplicate_ref');
      const many = await post(Array.from({ length: 6 }, (_, i) => ({ path: `${SESSION}/x${i}.png` })));
      expect(many.status).toBe(400);
      expect(many.body.code).toBe('too_many_refs');
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
        .post('/api/v1/image-shares')
        .set(AUTH_A1)
        .send({ agent_id: AGENT, session_id: SESSION, refs: [{ artifact_id: artifact.artifact_id }] });
      expect(ok.status).toBe(201);

      const wrongSession = await request()
        .post('/api/v1/image-shares')
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
      await request().delete(`/api/v1/image-shares/${revokedItem.share_id}`).set(AUTH_A1).expect(200);
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

    test('no list endpoint exists (GET /shared, GET /api/v1/image-shares → 404)', async () => {
      expect((await request().get('/shared')).status).toBe(404);
      expect((await request().get('/shared/')).status).toBe(404);
      expect((await request().get('/api/v1/image-shares').set(AUTH_A1)).status).toBe(404);
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
      const foreign = await request().delete(`/api/v1/image-shares/${item.share_id}`).set(AUTH_B1);
      expect(foreign.status).toBe(404);
      // still alive
      expect((await request().get(sharedPath(item.url))).status).toBe(200);
      const own = await request().delete(`/api/v1/image-shares/${item.share_id}`).set(AUTH_A1);
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

  describe('resolvePublicBaseUrl (§14 fail-closed)', () => {
    test('accepts https origins; rejects http-to-public, paths, queries, garbage', () => {
      expect(resolvePublicBaseUrl('https://pod-1.vm.getpod.ai')).toBe('https://pod-1.vm.getpod.ai');
      expect(resolvePublicBaseUrl('https://pod-1.vm.getpod.ai/')).toBe('https://pod-1.vm.getpod.ai');
      expect(resolvePublicBaseUrl('http://localhost:10850')).toBe('http://localhost:10850');
      expect(resolvePublicBaseUrl('http://pod-1.vm.getpod.ai')).toBeNull();
      expect(resolvePublicBaseUrl('https://pod-1.vm.getpod.ai/base')).toBeNull();
      expect(resolvePublicBaseUrl('https://pod-1.vm.getpod.ai?x=1')).toBeNull();
      expect(resolvePublicBaseUrl('')).toBeNull();
      expect(resolvePublicBaseUrl(undefined)).toBeNull();
      expect(resolvePublicBaseUrl('not a url')).toBeNull();
    });
  });
});
