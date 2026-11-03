/**
 * GET /api/v1/capabilities — feature-detection manifest.
 *
 * Clients use this to decide whether to offer a feature (e.g. injecting a
 * message into another channel's session) against the gateway they are talking
 * to, instead of comparing version strings. The shape is a contract: keys are
 * additive-only, a missing key means "unsupported", and `cross_channel_message`
 * lists the channel identifiers for which cross-channel injection works.
 */

import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import {
  createCapabilitiesRouter,
  buildCapabilitiesResponse,
  CROSS_CHANNEL_MESSAGE_CHANNELS,
  FILES_ADMIN_CAPABILITIES,
  FILES_CAPABILITIES,
  GIT_CAPABILITIES,
  SESSIONS_CAPABILITIES,
} from '../../src/api/capabilities';
import { GATEWAY_VERSION } from '../../src/api/gateway-version';
import { collectManifest } from '../../src/api/manifest-sources';
import { CHAT_CHANNELS } from '../../src/history/types';
import type { ApiKey } from '../../src/types';

const apiKeys: ApiKey[] = [
  { key: 'sk-test-app', agents: '*', admin: true },
  { key: 'sk-pod-write', agents: '*', write: true },
  { key: 'sk-pod-read', agents: '*' },
  { key: 'sk-agent', agents: ['alfred'], write: true },
];
const AUTH = { Authorization: 'Bearer sk-test-app' };
const as = (key: string) => ({ Authorization: `Bearer ${key}` });

function buildApp(keys: ApiKey[]) {
  const app = express();
  app.use(express.json());
  app.use('/api', createCapabilitiesRouter(keys));
  return app;
}

describe('GET /api/v1/capabilities', () => {
  it('returns 200 with the version and the capability manifest', async () => {
    const res = await request(buildApp(apiKeys)).get('/api/v1/capabilities').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({
      version: expect.any(String),
      capabilities: {
        cross_channel_message: expect.any(Array),
        files: expect.any(Array),
        git: expect.any(Array),
        sessions: expect.any(Array),
        processes: expect.any(Array),
      },
    });
    expect(res.body.version.length).toBeGreaterThan(0);
    expect(res.body.version).not.toBe('unknown');
    expect(res.body.version).toBe(GATEWAY_VERSION);
  });

  it('reports package.json version — the same value /status serves', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { version: string };
    expect(GATEWAY_VERSION).toBe(pkg.version);
  });

  it('lists telegram under cross_channel_message', async () => {
    const res = await request(buildApp(apiKeys)).get('/api/v1/capabilities').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.capabilities.cross_channel_message).toContain('telegram');
  });

  it('advertises every files, git and sessions token to an admin key', async () => {
    const res = await request(buildApp(apiKeys)).get('/api/v1/capabilities').set(AUTH);
    const { files, git, sessions } = res.body.capabilities;
    expect({ files, git, sessions }).toEqual({ files: ['list', 'create', 'delete', 'marks', 'cleanup'], git: ['status', 'summary'], sessions: ['cwd'] });
    expect(res.body.capabilities).not.toHaveProperty('projects');
  });

  it('drops sessions cwd without orchestration and every token when the files API is disabled', () => {
    const gw = (g: Record<string, unknown>) => ({ gateway: g, agents: [] }) as never;
    expect(buildCapabilitiesResponse('1', gw({ orchestration: false })).capabilities).toMatchObject({ files: ['list', 'create', 'delete', 'marks', 'cleanup'], git: ['status', 'summary'], sessions: [] });
    expect(buildCapabilitiesResponse('1', gw({ orchestration: true })).capabilities.sessions).toEqual(['cwd']);
    expect(buildCapabilitiesResponse('1', gw({ orchestration: true, files: { enabled: false } })).capabilities).toMatchObject({ files: [], git: [], sessions: [] });
  });

  it.each(['sk-pod-write', 'sk-pod-read', 'sk-agent'])('%s gets every token but create, delete and marks', async (key) => {
    const res = await request(buildApp(apiKeys)).get('/api/v1/capabilities').set(as(key));
    expect(res.status).toBe(200);
    const { files, git, sessions } = res.body.capabilities;
    expect({ files, git, sessions }).toEqual({ files: ['list'], git: ['status', 'summary'], sessions: ['cwd'] });
    expect(res.body).not.toHaveProperty('filesUnavailable');
    expect(res.body.capabilities.cross_channel_message).toContain('telegram');
  });

  it('advertises processes, start and stop only to an admin key, and nothing when files are off', () => {
    const on = { gateway: { orchestration: true }, agents: [] } as never;
    expect(buildCapabilitiesResponse('1', on, apiKeys[0]).capabilities.processes).toEqual(['list', 'start', 'stop']);
    expect(buildCapabilitiesResponse('1', on, apiKeys[2]).capabilities.processes).toEqual([]);
    const off = { gateway: { files: { enabled: false } }, agents: [] } as never;
    expect(buildCapabilitiesResponse('1', off, apiKeys[0]).capabilities.processes).toEqual([]);
    const served = new Map(collectManifest().filter((r) => r.path.startsWith('/v1/processes')).map((r) => [`${r.method} ${r.path}`, r.auth]));
    expect(Object.fromEntries(served)).toEqual({ 'GET /v1/processes': 'admin', 'POST /v1/processes/start': 'admin', 'POST /v1/processes/stop': 'admin' });
  });

  it('drops sessions cwd for a non-admin key too when orchestration is off', () => {
    const config = { gateway: { orchestration: false }, agents: [] } as never;
    expect(buildCapabilitiesResponse('1', config, apiKeys[2]).capabilities).toMatchObject({ files: ['list'], sessions: [] });
  });

  it('omits filesUnavailable for an admin key when the files API is usable', async () => {
    const res = await request(buildApp(apiKeys)).get('/api/v1/capabilities').set(AUTH);
    expect(res.body).not.toHaveProperty('filesUnavailable');
  });

  it('says disabled to every key, admin included, when the files API is off', async () => {
    const config = { gateway: { files: { enabled: false } }, agents: [] } as never;
    const app = express();
    app.use('/api', createCapabilitiesRouter(apiKeys, config));
    for (const key of ['sk-test-app', 'sk-pod-write', 'sk-agent']) {
      const res = await request(app).get('/api/v1/capabilities').set(as(key));
      const { files, git, sessions } = res.body.capabilities;
      expect([files, git, sessions, res.body.filesUnavailable]).toEqual([[], [], [], 'disabled']);
    }
  });

  describe('filesRoot', () => {
    let base: string;
    beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caps-root-'))); });
    afterEach(() => fs.rmSync(base, { recursive: true, force: true }));
    const appWith = (files: Record<string, unknown>) => {
      const app = express();
      app.use('/api', createCapabilitiesRouter(apiKeys, { gateway: { orchestration: true, files }, agents: [] } as never));
      return app;
    };

    it('reports the real root to every key, through a symlink, the value the files list reports', async () => {
      fs.mkdirSync(path.join(base, 'real'));
      fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
      for (const key of ['sk-test-app', 'sk-pod-read']) {
        const res = await request(appWith({ root: path.join(base, 'link') })).get('/api/v1/capabilities').set(as(key));
        expect(res.body.filesRoot).toBe(path.join(base, 'real'));
      }
    });

    it('reports the configured spelling while the root does not exist yet', async () => {
      const res = await request(appWith({ root: path.join(base, 'later') })).get('/api/v1/capabilities').set(AUTH);
      expect(res.body.filesRoot).toBe(path.join(base, 'later'));
    });

    it('omits filesRoot when the files API is off', async () => {
      const res = await request(appWith({ root: base, enabled: false })).get('/api/v1/capabilities').set(AUTH);
      expect(res.body).not.toHaveProperty('filesRoot');
      expect(res.body.filesUnavailable).toBe('disabled');
    });
  });

  it('maps every files and git token to one served route, admin-only exactly where the token is', () => {
    const routes: Record<string, string[]> = {
      'files.list': ['GET /v1/files'], 'files.create': ['POST /v1/files/mkdir'], 'files.delete': ['DELETE /v1/files'],
      'files.marks': ['POST /v1/files/busy', 'POST /v1/files/marks', 'DELETE /v1/files/marks/:markId'],
      'files.cleanup': ['GET /v1/files/cleanup/candidates', 'POST /v1/files/cleanup'],
      'git.status': ['GET /v1/git/status'], 'git.summary': ['GET /v1/git/summary'],
    };
    const served = new Map(collectManifest().filter((r) => /^\/v1\/(files|git)\b/.test(r.path)).map((r) => [`${r.method} ${r.path}`, r.auth]));
    const tokens = [...FILES_CAPABILITIES.map((t) => `files.${t}`), ...GIT_CAPABILITIES.map((t) => `git.${t}`)];
    expect(tokens.flatMap((t) => routes[t]!).sort()).toEqual([...served.keys()].sort());
    for (const t of tokens) {
      for (const route of routes[t]!) expect([route, served.get(route)]).toEqual([route, FILES_ADMIN_CAPABILITIES.has(t.slice(6) as never) && t.startsWith('files.') ? 'admin' : 'key']);
    }
  });

  it('only advertises channel identifiers the gateway itself uses', () => {
    // Every advertised channel must be a real ChatChannel string — the same value
    // a session reports as its channel — so a client's `includes(channel)` check
    // cannot silently miss because of a spelling drift.
    for (const ch of CROSS_CHANNEL_MESSAGE_CHANNELS) {
      expect(CHAT_CHANNELS).toContain(ch);
    }
    expect(new Set(CROSS_CHANNEL_MESSAGE_CHANNELS).size).toBe(CROSS_CHANNEL_MESSAGE_CHANNELS.length);
  });

  it.each([['files', FILES_CAPABILITIES], ['git', GIT_CAPABILITIES], ['sessions', SESSIONS_CAPABILITIES]] as const)(
    'system.md shows the %s array the gateway serves, in the example and the reference table',
    (key, tokens) => {
      const full = fs.readFileSync(path.join(__dirname, '../../website/api/system.md'), 'utf8');
      // From the capabilities example on: the /status example earlier on the page has a "sessions" array of its own.
      const doc = full.slice(full.indexOf('"cross_channel_message"'));
      const example = doc.match(new RegExp(`"${key}": (\\[[^\\]]*\\])`));
      const table = doc.match(new RegExp(`\\| \`${key}\` \\|[^\\n]*Currently \`(\\[[^\\]]*\\])\``));
      expect(JSON.parse(example![1])).toEqual([...tokens]);
      expect(JSON.parse(table![1])).toEqual([...tokens]);
    },
  );

  it('the handler serves exactly what the builder produces (single source of truth)', async () => {
    const res = await request(buildApp(apiKeys)).get('/api/v1/capabilities').set(AUTH);
    expect(res.body).toEqual(buildCapabilitiesResponse());
  });

  it('requires an API key when keys are configured — there is no keyless-open path', async () => {
    // The router applies API-key auth unconditionally, so a request without a
    // credential is rejected. The gateway mounts this router only when
    // `gateway.api.keys` is non-empty (GatewayRouter's `api.keys?.length`
    // guard), so a keyless install never reaches it at all — the endpoint 404s
    // rather than serving open access. There is thus no open mode to assert.
    const res = await request(buildApp(apiKeys)).get('/api/v1/capabilities');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong API key', async () => {
    const res = await request(buildApp(apiKeys))
      .get('/api/v1/capabilities')
      .set({ Authorization: 'Bearer sk-wrong' });
    // createApiAuthMiddleware: 401 = no credential, 403 = credential did not match.
    expect(res.status).toBe(403);
  });
});
