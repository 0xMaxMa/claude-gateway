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
import request from 'supertest';
import {
  createCapabilitiesRouter,
  buildCapabilitiesResponse,
  CROSS_CHANNEL_MESSAGE_CHANNELS,
} from '../../src/api/capabilities';
import { GATEWAY_VERSION } from '../../src/api/gateway-version';
import { CHAT_CHANNELS } from '../../src/history/types';
import type { ApiKey } from '../../src/types';

const apiKeys: ApiKey[] = [{ key: 'sk-test-app', agents: ['alfred'] }];
const AUTH = { Authorization: 'Bearer sk-test-app' };

function buildApp(keys?: ApiKey[]) {
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

  it('only advertises channel identifiers the gateway itself uses', () => {
    // Every advertised channel must be a real ChatChannel string — the same value
    // a session reports as its channel — so a client's `includes(channel)` check
    // cannot silently miss because of a spelling drift.
    for (const ch of CROSS_CHANNEL_MESSAGE_CHANNELS) {
      expect(CHAT_CHANNELS).toContain(ch);
    }
    expect(new Set(CROSS_CHANNEL_MESSAGE_CHANNELS).size).toBe(CROSS_CHANNEL_MESSAGE_CHANNELS.length);
  });

  it('the handler serves exactly what the builder produces (single source of truth)', async () => {
    const res = await request(buildApp(apiKeys)).get('/api/v1/capabilities').set(AUTH);
    expect(res.body).toEqual(buildCapabilitiesResponse());
  });

  it('requires an API key when keys are configured', async () => {
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

  it('is open when no API keys are configured (matches the other /api routers)', async () => {
    const res = await request(buildApp([])).get('/api/v1/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.capabilities.cross_channel_message).toContain('telegram');
  });
});
