/**
 * GET /api/v1/connectors/github/account — which GitHub account the pod's
 * `github` connector token belongs to, from a live call to api.github.com.
 * The fetch is injected; nothing here touches the network.
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ApiKey } from '../../src/types';

const TOKEN_ENV = path.join(os.tmpdir(), `github-account-test-${process.pid}.env`);
const TOKEN = 'ghp_secretTokenValue123';
const apiKeys: ApiKey[] = [{ key: 'k', agents: '*', admin: true }];

const githubEntry = {
  label: 'GitHub',
  config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer {access_token}' } },
  secretNames: ['access_token'],
  credentialOwner: 'external',
};

const octocat = {
  login: 'octocat',
  name: 'The Octocat',
  avatar_url: 'https://avatars.githubusercontent.com/u/583231',
  html_url: 'https://github.com/octocat',
  email: 'octocat@github.com',
};

beforeEach(() => {
  process.env.GATEWAY_MCP_TOKEN_ENV_PATH = TOKEN_ENV;
  try { fs.rmSync(TOKEN_ENV); } catch { /* absent */ }
  jest.resetModules();
});

afterAll(() => {
  delete process.env.GATEWAY_MCP_TOKEN_ENV_PATH;
  try { fs.rmSync(TOKEN_ENV); } catch { /* absent */ }
});

function tmpConfig(customConnectors: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-gh-account-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC', customConnectors }, agents: [] }));
  return cfgPath;
}

function storeToken(name: string, value: string): void {
  const { setSecret } = require('../../src/connectors/token-env');
  setSecret(`CUSTOM__github__${name}`, value);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeApp(opts: { connectors?: Record<string, unknown>; fetchGithub: jest.Mock; store?: unknown }) {
  const { createConnectorsRouter } = require('../../src/api/connectors-router');
  const app = express();
  app.use(express.json());
  const cfgPath = opts.store ? undefined : tmpConfig(opts.connectors ?? {});
  app.use('/api', createConnectorsRouter(apiKeys, cfgPath, undefined, opts.store, { fetchGithub: opts.fetchGithub }));
  return app;
}

const get = (app: express.Express) => request(app).get('/api/v1/connectors/github/account').set('X-Api-Key', 'k');

describe('GET /api/v1/connectors/github/account', () => {
  it('reports the account GitHub returns for the stored token', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn().mockResolvedValue(jsonResponse(200, octocat));
    const res = await get(makeApp({ connectors: { github: githubEntry }, fetchGithub }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      connected: true,
      valid: true,
      account: {
        login: 'octocat',
        name: 'The Octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/583231',
        htmlUrl: 'https://github.com/octocat',
      },
    });
    expect(fetchGithub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchGithub.mock.calls[0];
    expect(url).toBe('https://api.github.com/user');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'claude-gateway',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes a null name through', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn().mockResolvedValue(jsonResponse(200, { ...octocat, name: null }));
    const res = await get(makeApp({ connectors: { github: githubEntry }, fetchGithub }));
    expect(res.body.account.name).toBeNull();
  });

  it('reports token_rejected when GitHub answers 401', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn().mockResolvedValue(jsonResponse(401, { message: 'Bad credentials' }));
    const res = await get(makeApp({ connectors: { github: githubEntry }, fetchGithub }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true, valid: false, reason: 'token_rejected' });
  });

  it('answers 502 github_unreachable on a network error', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const res = await get(makeApp({ connectors: { github: githubEntry }, fetchGithub }));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'github_unreachable' });
  });

  it('answers 502 github_unreachable on a timeout', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const res = await get(makeApp({ connectors: { github: githubEntry }, fetchGithub }));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'github_unreachable' });
  });

  it.each([500, 403, 304])('answers 502 github_unreachable when GitHub answers %i, whatever the body', async (status) => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn().mockImplementation(async () =>
      status === 304 ? new Response(null, { status }) : jsonResponse(status, octocat));
    const res = await get(makeApp({ connectors: { github: githubEntry }, fetchGithub }));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'github_unreachable' });
  });

  it('answers 502 rather than valid when a 200 carries no usable account', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn().mockResolvedValue(jsonResponse(200, { message: 'not a user' }));
    const res = await get(makeApp({ connectors: { github: githubEntry }, fetchGithub }));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'github_unreachable' });
  });

  it('reports not connected when there is no github entry, without calling GitHub', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn();
    const res = await get(makeApp({ connectors: {}, fetchGithub }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false });
    expect(fetchGithub).not.toHaveBeenCalled();
  });

  it('reports not connected when the entry has a secret missing', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn();
    const twoSecrets = {
      ...githubEntry,
      config: { ...githubEntry.config, headers: { Authorization: 'Bearer {access_token}', 'X-Org': '{org}' } },
      secretNames: ['access_token', 'org'],
    };
    const res = await get(makeApp({ connectors: { github: twoSecrets }, fetchGithub }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false });
    expect(fetchGithub).not.toHaveBeenCalled();
  });

  it('reports not connected when the token was cleared', async () => {
    const fetchGithub = jest.fn();
    const res = await get(makeApp({ connectors: { github: githubEntry }, fetchGithub }));
    expect(res.body).toEqual({ connected: false });
    expect(fetchGithub).not.toHaveBeenCalled();
  });

  it('never puts the token in a response body', async () => {
    storeToken('access_token', TOKEN);
    const bodies = [
      jsonResponse(200, { ...octocat, login: 'octocat' }),
      jsonResponse(401, { message: `Bad credentials ${TOKEN}` }),
      jsonResponse(500, { message: TOKEN }),
    ];
    for (const body of bodies) {
      const res = await get(makeApp({ connectors: { github: githubEntry }, fetchGithub: jest.fn().mockResolvedValue(body) }));
      expect(res.text).not.toContain(TOKEN);
    }
    const rejected = await get(makeApp({
      connectors: { github: githubEntry },
      fetchGithub: jest.fn().mockRejectedValue(new Error(`connect failed for ${TOKEN}`)),
    }));
    expect(rejected.text).not.toContain(TOKEN);
  });

  it('serves a repeat lookup from the cache without calling GitHub again', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn().mockImplementation(async () => jsonResponse(200, octocat));
    const app = makeApp({ connectors: { github: githubEntry }, fetchGithub });
    const first = await get(app);
    const second = await get(app);
    expect(second.body).toEqual(first.body);
    expect(fetchGithub).toHaveBeenCalledTimes(1);
  });

  it('caches a rejected token too', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn().mockImplementation(async () => jsonResponse(401, {}));
    const app = makeApp({ connectors: { github: githubEntry }, fetchGithub });
    await get(app);
    const second = await get(app);
    expect(second.body).toEqual({ connected: true, valid: false, reason: 'token_rejected' });
    expect(fetchGithub).toHaveBeenCalledTimes(1);
  });

  it('calls GitHub again once the cached answer is 60 seconds old', async () => {
    storeToken('access_token', TOKEN);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const fetchGithub = jest.fn().mockImplementation(async () => jsonResponse(200, octocat));
      const app = makeApp({ connectors: { github: githubEntry }, fetchGithub });
      await get(app);
      now.mockReturnValue(1_000_000 + 59_999);
      await get(app);
      expect(fetchGithub).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_000_000 + 60_000);
      await get(app);
      expect(fetchGithub).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('looks up a new token instead of serving the old token\'s account', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn()
      .mockResolvedValueOnce(jsonResponse(200, octocat))
      .mockResolvedValueOnce(jsonResponse(200, { ...octocat, login: 'hubot' }));
    const app = makeApp({ connectors: { github: githubEntry }, fetchGithub });
    await get(app);
    storeToken('access_token', 'ghp_aDifferentToken');
    const res = await get(app);
    expect(res.body.account.login).toBe('hubot');
    expect(fetchGithub).toHaveBeenCalledTimes(2);
  });

  it('does not cache a 502', async () => {
    storeToken('access_token', TOKEN);
    const fetchGithub = jest.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, octocat));
    const app = makeApp({ connectors: { github: githubEntry }, fetchGithub });
    expect((await get(app)).status).toBe(502);
    const second = await get(app);
    expect(second.status).toBe(200);
    expect(second.body.valid).toBe(true);
    expect(fetchGithub).toHaveBeenCalledTimes(2);
  });

  it('answers 500 when the connector store cannot be read', async () => {
    const fetchGithub = jest.fn();
    const store = { read: jest.fn().mockRejectedValue(new Error('EACCES')) };
    const res = await get(makeApp({ fetchGithub, store }));
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual(expect.any(String));
    expect(fetchGithub).not.toHaveBeenCalled();
  });

  it('answers 500 for a malformed github entry', async () => {
    const fetchGithub = jest.fn();
    const { secretNames: _omitted, ...malformed } = githubEntry;
    const res = await get(makeApp({ connectors: { github: malformed }, fetchGithub }));
    expect(res.status).toBe(500);
  });

  it('requires an API key', async () => {
    const res = await request(makeApp({ connectors: { github: githubEntry }, fetchGithub: jest.fn() }))
      .get('/api/v1/connectors/github/account');
    expect(res.status).toBe(401);
  });

  it('is advertised as capabilities.githubAccount on GET /v1/connectors', async () => {
    const res = await request(makeApp({ connectors: {}, fetchGithub: jest.fn() }))
      .get('/api/v1/connectors').set('X-Api-Key', 'k');
    expect(res.body.capabilities.githubAccount).toBe(true);
  });
});
