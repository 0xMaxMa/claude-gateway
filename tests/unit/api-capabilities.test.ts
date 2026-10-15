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
import * as path from 'path';
import request from 'supertest';
import {
  createCapabilitiesRouter,
  buildCapabilitiesResponse,
  CROSS_CHANNEL_MESSAGE_CHANNELS,
  PROJECTS_CAPABILITIES,
} from '../../src/api/capabilities';
import { GATEWAY_VERSION } from '../../src/api/gateway-version';
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
        projects: expect.any(Array),
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

  it('advertises project list/create/read', async () => {
    const res = await request(buildApp(apiKeys)).get('/api/v1/capabilities').set(AUTH);
    expect(res.body.capabilities.projects).toEqual(['list', 'create', 'read', 'git', 'chat', 'run', 'start', 'delete']);
  });

  it('drops chat without orchestration and everything when the Projects API is disabled', () => {
    const gw = (g: Record<string, unknown>) => ({ gateway: g, agents: [] }) as never;
    expect(buildCapabilitiesResponse('1', gw({ orchestration: false })).capabilities.projects).not.toContain('chat');
    expect(buildCapabilitiesResponse('1', gw({ orchestration: true })).capabilities.projects).toContain('chat');
    expect(buildCapabilitiesResponse('1', gw({ orchestration: true, projects: { enabled: false } })).capabilities.projects).toEqual([]);
  });

  it.each(['sk-pod-write', 'sk-pod-read', 'sk-agent'])('%s gets no project tokens and projectsUnavailable admin_required, and still reaches the endpoint', async (key) => {
    const res = await request(buildApp(apiKeys)).get('/api/v1/capabilities').set(as(key));
    expect(res.status).toBe(200);
    expect(res.body.capabilities.projects).toEqual([]);
    expect(res.body.projectsUnavailable).toBe('admin_required');
    expect(res.body.capabilities.cross_channel_message).toContain('telegram');
  });

  it('omits projectsUnavailable for an admin key when Projects is usable', async () => {
    const res = await request(buildApp(apiKeys)).get('/api/v1/capabilities').set(AUTH);
    expect(res.body).not.toHaveProperty('projectsUnavailable');
  });

  it('says disabled to every key, admin included, when Projects is off', async () => {
    const config = { gateway: { projects: { enabled: false } }, agents: [] } as never;
    const app = express();
    app.use('/api', createCapabilitiesRouter(apiKeys, config));
    for (const key of ['sk-test-app', 'sk-pod-write', 'sk-agent']) {
      const res = await request(app).get('/api/v1/capabilities').set(as(key));
      expect([res.body.capabilities.projects, res.body.projectsUnavailable]).toEqual([[], 'disabled']);
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

  it('system.md shows the projects array the gateway serves, in the example and the reference table', () => {
    const doc = fs.readFileSync(path.join(__dirname, '../../website/api/system.md'), 'utf8');
    const example = doc.match(/"projects": (\[[^\]]*\])/);
    const table = doc.match(/Currently `(\[[^\]]*\])`/);
    expect(JSON.parse(example![1])).toEqual([...PROJECTS_CAPABILITIES]);
    expect(JSON.parse(table![1])).toEqual([...PROJECTS_CAPABILITIES]);
  });

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
