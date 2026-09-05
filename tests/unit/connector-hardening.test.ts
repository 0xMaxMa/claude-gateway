/**
 * Regression tests for the review findings on the MCP-connectors PR.
 *
 * Each test here is written to fail against the pre-fix code, so the mechanism it
 * describes is the thing being asserted — not just the fixed behaviour's shape:
 *
 *   token-env injection     — a token VALUE containing a newline forged a second
 *                             `KEY=value` line, overwriting another connector's secret
 *   connector id validation — `:id` came straight off the URL into both a config.json
 *                             object key and an mcp-token.env key name
 *   internal key namespace  — `{__refresh_token}` in a pasted config resolved to the
 *                             refresh sweep's own storage slot
 *   config write lock       — two subsystems rewriting config.json each lost the
 *                             other's change
 *   sweep overlap           — a slow refresh let the next 60s tick start a second one,
 *                             replaying an already-redeemed refresh token
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ApiKey } from '../../src/types';

const TOKEN_ENV = '/tmp/connector-hardening-test-mcp-token.env';
const ADMIN_KEY: ApiKey = { key: 'test-admin-key', agents: '*', admin: true };

beforeEach(() => {
  process.env.GATEWAY_MCP_TOKEN_ENV_PATH = TOKEN_ENV;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
  jest.resetModules();
});

afterAll(() => {
  delete process.env.GATEWAY_MCP_TOKEN_ENV_PATH;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
});

describe('token-env — a hostile value cannot forge another entry', () => {
  it('round-trips a value containing a newline instead of splitting it into a second line', () => {
    const { setSecret, getSecret } = require('../../src/connectors/token-env');

    setSecret('CUSTOM__victim__access_token', 'GOOD-TOKEN');
    // An OAuth provider's token endpoint decides what access_token looks like, and
    // oauth-connectors-router.ts stores it verbatim. Before the fix this wrote
    //   CUSTOM__evil__access_token=x
    //   CUSTOM__victim__access_token=ATTACKER-TOKEN
    // and the second line won on the next read.
    setSecret(
      'CUSTOM__evil__access_token',
      'x\nCUSTOM__victim__access_token=ATTACKER-TOKEN',
    );

    expect(getSecret('CUSTOM__victim__access_token')).toBe('GOOD-TOKEN');
    expect(getSecret('CUSTOM__evil__access_token')).toBe(
      'x\nCUSTOM__victim__access_token=ATTACKER-TOKEN',
    );
  });

  it('round-trips values with quotes, backslashes, carriage returns and surrounding spaces', () => {
    const { setSecret, getSecret } = require('../../src/connectors/token-env');
    const nasty = ' lead "quoted" back\\slash\r\nnewline trail ';
    setSecret('CUSTOM__x__access_token', nasty);
    expect(getSecret('CUSTOM__x__access_token')).toBe(nasty);
  });

  it('rejects a malformed key rather than silently writing a broken file', () => {
    const { setSecret, getSecret } = require('../../src/connectors/token-env');
    expect(() => setSecret('BAD KEY', 'v')).toThrow(/Invalid secret key/);
    expect(() => setSecret('CUSTOM__a\nB__t', 'v')).toThrow(/Invalid secret key/);
    expect(getSecret('CUSTOM__a')).toBeNull();
  });

  it('still accepts the dashed ids slugify() produces', () => {
    const { setSecret, getSecret } = require('../../src/connectors/token-env');
    setSecret('CUSTOM__google-calendar__access_token', 'tok');
    expect(getSecret('CUSTOM__google-calendar__access_token')).toBe('tok');
  });

  it('ignores an unparseable key already present in the file', () => {
    fs.writeFileSync(TOKEN_ENV, 'GOOD=1\nBAD KEY=2\n= 3\n', { mode: 0o600 });
    const { readTokenEnv } = require('../../src/connectors/token-env');
    const env = readTokenEnv();
    expect(env['GOOD']).toBe('1');
    expect(Object.keys(env)).toEqual(['GOOD']);
  });
});

describe('connector id validation', () => {
  function makeApp() {
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], undefined, undefined));
    return app;
  }

  it('400s an id carrying a newline instead of using it as a secret-file key', async () => {
    const app = makeApp();
    const evil = 'evil%0ACUSTOM__victim__access_token=PWN%0Ax';
    const res = await request(app)
      .post(`/api/v1/connectors/${evil}/oauth/receive`)
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send({
        access_token: 'tok',
        label: 'Evil',
        config: { type: 'streamable-http', url: 'https://e.example', headers: { Authorization: 'Bearer {access_token}' } },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid connector id/);
    const { readTokenEnv } = require('../../src/connectors/token-env');
    expect(readTokenEnv()['CUSTOM__victim__access_token']).toBeUndefined();
  });

  it.each(['UPPER', 'has space', '-leading', 'dot.dot', '__proto__', '../etc'])(
    'rejects %p',
    async (id) => {
      const res = await request(makeApp())
        .get(`/api/v1/connectors/${encodeURIComponent(id)}/status`)
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
      expect(res.status).toBe(400);
    },
  );

  it('still accepts a normal slug (404s on unknown, does not 400)', async () => {
    const res = await request(makeApp())
      .get('/api/v1/connectors/google-calendar/status')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
    expect(res.status).toBe(404);
  });
});

describe('gateway-internal secret namespace', () => {
  it('customSecretKey can never collide with the refresh sweep\'s own slots', () => {
    const { customSecretKey } = require('../../src/connectors/custom');
    const { refreshTokenSecretKey, clientIdSecretKey, tokenGenerationSecretKey } =
      require('../../src/connectors/oauth-refresh-sweep');

    // PLACEHOLDER_RE accepts a leading underscore, so this IS a reachable
    // secretName for a pasted config — it just must not name the sweep's slot.
    expect(customSecretKey('acme', '__refresh_token')).not.toBe(refreshTokenSecretKey('acme'));
    expect(customSecretKey('acme', '__client_id')).not.toBe(clientIdSecretKey('acme'));
    expect(customSecretKey('acme', '__token_generation')).not.toBe(tokenGenerationSecretKey('acme'));
  });

  it('a pasted {__refresh_token} placeholder does not resolve to the stored refresh token', () => {
    const { setSecret } = require('../../src/connectors/token-env');
    const { refreshTokenSecretKey } = require('../../src/connectors/oauth-refresh-sweep');
    const { resolveEnabledConnectors } = require('../../src/connectors/resolve');

    setSecret(refreshTokenSecretKey('acme'), 'SECRET-REFRESH-TOKEN');

    const resolved = resolveEnabledConnectors(
      { connectors: { acme: { enabled: true } } },
      {
        acme: {
          label: 'Acme',
          config: { type: 'streamable-http', url: 'https://acme.example', headers: { 'X-Leak': '{__refresh_token}' } },
          secretNames: ['__refresh_token'],
        },
      },
    );

    const leaked = JSON.stringify(resolved ?? {});
    expect(leaked).not.toContain('SECRET-REFRESH-TOKEN');
  });

  it('rejects a reserved placeholder name at add-time with a clear error', async () => {
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], undefined, undefined));

    const res = await request(app)
      .post('/api/v1/connectors/custom')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send({
        label: 'Sneaky',
        config: { type: 'streamable-http', url: 'https://s.example', headers: { 'X-Leak': '{__refresh_token}' } },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reserved/i);
  });
});

describe('config.json write lock is shared across subsystems', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-lock-'));
    configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: {}, agents: [{ id: 'a1', claude: { model: 'old' } }] }, null, 2),
    );
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('a connectors write interleaved with an agents write loses neither', async () => {
    const { createCustomConnectorsStore } = require('../../src/connectors/custom-connectors-store');
    const { withConfigWriteLock } = require('../../src/config/config-write-lock');
    const store = createCustomConnectorsStore(configPath);

    // Stand-in for api/router.ts's writeAgentsToConfig: same read → await →
    // mutate → rename shape, so it interleaves exactly the way that one does.
    const agentsWrite = withConfigWriteLock(configPath, async () => {
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf-8'));
      await new Promise((r) => setTimeout(r, 20)); // the window the old code raced in
      config.agents[0].claude.model = 'new';
      const tmp = `${configPath}.tmp.agents`;
      await fs.promises.writeFile(tmp, JSON.stringify(config, null, 2));
      await fs.promises.rename(tmp, configPath);
    });

    const connectorWrite = store.mutate((connectors: Record<string, unknown>) => {
      connectors['acme'] = { label: 'Acme', config: {}, secretNames: [] };
    });

    await Promise.all([agentsWrite, connectorWrite]);

    const final = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(final.agents[0].claude.model).toBe('new');
    expect(final.gateway.customConnectors.acme.label).toBe('Acme');
  });

  it('serialises writers of the same path but not of different paths', async () => {
    const { withConfigWriteLock } = require('../../src/config/config-write-lock');
    const order: string[] = [];

    const slow = withConfigWriteLock(configPath, async () => {
      order.push('slow:start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('slow:end');
    });
    const same = withConfigWriteLock(configPath, () => { order.push('same'); });
    const other = withConfigWriteLock(path.join(dir, 'other.json'), () => { order.push('other'); });

    await Promise.all([slow, same, other]);

    expect(order).toEqual(['slow:start', 'other', 'slow:end', 'same']);
  });

  it('a throwing writer releases the lock for the next one', async () => {
    const { withConfigWriteLock } = require('../../src/config/config-write-lock');
    await expect(
      withConfigWriteLock(configPath, () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    await expect(withConfigWriteLock(configPath, () => 'ok')).resolves.toBe('ok');
  });
});

describe('PATCH /api/v1/agents/:id connectors — session restart semantics', () => {
  let tmpDir: string;
  let configPath: string;

  const agentConfig = {
    id: 'alfred',
    description: 'a',
    workspace: '/tmp/alfred',
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-connector-patch-'));
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { logDir: '~/logs', timezone: 'UTC' }, agents: [agentConfig] }, null, 2),
    );
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('defers idle channel sessions instead of SIGKILLing them', async () => {
    const { createApiRouter } = require('../../src/api/router');

    const restartOrDefer = jest.fn().mockResolvedValue({ immediate: 0, deferred: 0, skipped: 0 });
    const runner = { updateAgentConfig: jest.fn(), restartOrDefer } as never;

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createApiRouter(
        new Map([['alfred', runner]]),
        new Map([['alfred', { ...agentConfig }]]),
        [ADMIN_KEY],
        configPath,
      ),
    );

    const res = await request(app)
      .patch('/api/v1/agents/alfred')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send({ connectors: { firecrawl: { enabled: true } } });

    expect(res.status).toBe(200);
    // A bare restartOrDefer() defaults deferIdle to false, which stops an idle
    // channel session immediately — the same enablement change made through
    // AgentRunner.restartSessionsUsingConnector defers it.
    expect(restartOrDefer).toHaveBeenCalledWith(
      expect.objectContaining({ deferIdle: true, skipBusy: false }),
    );
  });

  // Regression: this route wrote whatever keys the body carried straight into
  // the agent's `connectors` map, unvalidated — the one connector-id entry
  // point that did not. Anything could land there: a key with a newline, a
  // 300-character string, `__proto__`. It is then persisted to config.json and
  // read back by resolveEnabledConnectors on every spawn, so a junk key is
  // permanent state the user cannot clear from the panel (which only lists real
  // connectors). Validate the shape here, at the door.
  it('400s a malformed connector id instead of persisting it into config.json', async () => {
    const { createApiRouter } = require('../../src/api/router');

    const runner = {
      updateAgentConfig: jest.fn(),
      restartOrDefer: jest.fn().mockResolvedValue({ immediate: 0, deferred: 0, skipped: 0 }),
    } as never;

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createApiRouter(new Map([['alfred', runner]]), new Map([['alfred', { ...agentConfig }]]), [ADMIN_KEY], configPath),
    );

    for (const bad of ['Firecrawl', 'has space', '-leading', 'dot.dot', '__proto__', '../etc', 'a\nb', 'x'.repeat(65)]) {
      const res = await request(app)
        .patch('/api/v1/agents/alfred')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ connectors: { [bad]: { enabled: true } } });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid connector id');
    }

    // Rejected before any write — config.json still has no connectors at all.
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).agents[0].connectors).toBeUndefined();

    // A well-formed id for a connector that does not exist yet is still
    // accepted: pre-setting `{enabled: false}` before adding a connector is
    // legitimate under the opt-out default, so this validates shape, not
    // existence.
    const ok = await request(app)
      .patch('/api/v1/agents/alfred')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send({ connectors: { 'not-added-yet': { enabled: false } } });
    expect(ok.status).toBe(200);
  });

  // The panel re-sends the agent's whole `connectors` map on every save, so a
  // user toggling something unrelated (the model, the description) posts the
  // connector block back unchanged. Restarting on the mere *presence* of the key
  // meant that save tore down every live session for this agent — for a config
  // that is byte-identical to the one already loaded.
  it('does not restart sessions when the connectors block is present but unchanged', async () => {
    const { createApiRouter } = require('../../src/api/router');

    const restartOrDefer = jest.fn().mockResolvedValue({ immediate: 0, deferred: 0, skipped: 0 });
    const updateAgentConfig = jest.fn();
    const runner = { updateAgentConfig, restartOrDefer } as never;
    const withConnectors = { ...agentConfig, connectors: { firecrawl: { enabled: true } } };

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createApiRouter(new Map([['alfred', runner]]), new Map([['alfred', withConnectors]]), [ADMIN_KEY], configPath),
    );

    const same = await request(app)
      .patch('/api/v1/agents/alfred')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send({ connectors: { firecrawl: { enabled: true } } });
    expect(same.status).toBe(200);
    // The runner still gets the new config — it just isn't torn down for it.
    expect(updateAgentConfig).toHaveBeenCalled();
    expect(restartOrDefer).not.toHaveBeenCalled();

    // And the moment something actually changes, it does restart — otherwise
    // this test would pass just as well against a route that never restarts.
    const flipped = await request(app)
      .patch('/api/v1/agents/alfred')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send({ connectors: { firecrawl: { enabled: false } } });
    expect(flipped.status).toBe(200);
    expect(restartOrDefer).toHaveBeenCalledTimes(1);
  });
});

describe('refresh sweep overlap', () => {
  it('skips a tick while the previous sweep is still in flight', async () => {
    const mcpOauth = require('../../src/connectors/mcp-oauth');
    const { setSecret } = require('../../src/connectors/token-env');
    const {
      refreshExpiringOAuthConnectors,
      refreshTokenSecretKey,
      clientIdSecretKey,
      expiresAtSecretKey,
    } = require('../../src/connectors/oauth-refresh-sweep');

    setSecret(refreshTokenSecretKey('acme'), 'rt-1');
    setSecret(clientIdSecretKey('acme'), 'cid-1');
    setSecret(expiresAtSecretKey('acme'), String(Date.now() + 1000)); // due now

    const store = {
      read: async () => ({
        acme: {
          label: 'Acme',
          config: { type: 'streamable-http', url: 'https://acme.example' },
          secretNames: ['access_token'],
          credentialOwner: 'gateway',
        },
      }),
      mutate: async () => {},
    };

    // The sweep goes through the *cached* discovery wrapper (a refresh that
    // must not spend three extra round-trips, on a path where enough failures
    // delete the user's tokens) — spying on the uncached one would leave the
    // real network call in place.
    jest.spyOn(mcpOauth, 'discoverOAuthMetadataCached').mockResolvedValue({
      resource: 'https://acme.example',
      authorizationEndpoint: 'https://as.example/authorize',
      tokenEndpoint: 'https://as.example/token',
      scopesSupported: [],
    });

    // A slow token endpoint — the exact condition that let a 60s tick overlap.
    let refreshCalls = 0;
    const refresh = jest.spyOn(mcpOauth, 'refreshAccessToken').mockImplementation(async () => {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 50));
      return { access_token: 'at-2', token_type: 'bearer', expires_in: 3600, refresh_token: 'rt-2' };
    });

    const first = refreshExpiringOAuthConnectors(store);
    await new Promise((r) => setTimeout(r, 10)); // next interval tick lands mid-flight
    const second = refreshExpiringOAuthConnectors(store);
    await Promise.all([first, second]);

    // Before the fix this was 2 — the same rt-1 POSTed twice, which a provider
    // doing refresh-token rotation treats as replay and revokes the grant.
    expect(refreshCalls).toBe(1);

    // And the guard releases: a later tick refreshes normally.
    refresh.mockClear();
    setSecret(expiresAtSecretKey('acme'), String(Date.now() + 1000));
    await refreshExpiringOAuthConnectors(store);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight guard when a sweep throws', async () => {
    const {
      refreshExpiringOAuthConnectors,
    } = require('../../src/connectors/oauth-refresh-sweep');

    const throwingStore = { read: async () => { throw new Error('config unreadable'); }, mutate: async () => {} };
    await expect(refreshExpiringOAuthConnectors(throwingStore)).rejects.toThrow('config unreadable');

    // Guard released — a store that works is swept, not skipped forever.
    let read = false;
    const okStore = { read: async () => { read = true; return {}; }, mutate: async () => {} };
    await refreshExpiringOAuthConnectors(okStore);
    expect(read).toBe(true);
  });
});

// Regression (#460, second wave): config.json holds the admin API key and every
// agent's channel bot tokens, so an install that has locked it to 0600 must stay
// there. Both writers here go through write-tmp-then-rename, and rename() carries
// the TMP file's mode onto the target — an unmoded tmp inherits the process umask
// (0644 by default), silently world-readabling the config on the next connector
// add, delete, or disconnect. The four other config.json writers were fixed in
// #461; this store was explicitly left for this PR.
describe('custom connectors store: config.json permissions', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-perm-'));
    configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: {}, agents: [{ id: 'a1', connectors: { acme: { enabled: true } } }] }, null, 2),
      { mode: 0o600 },
    );
    fs.chmodSync(configPath, 0o600); // writeFileSync's mode is advisory under a umask
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const modeOf = (): number => fs.statSync(configPath).mode & 0o777;

  it('mutate() keeps 0600 instead of downgrading to 0644', async () => {
    const { createCustomConnectorsStore } = require('../../src/connectors/custom-connectors-store');
    const store = createCustomConnectorsStore(configPath);

    await store.mutate((connectors: Record<string, unknown>) => {
      connectors['acme'] = { label: 'Acme', config: {}, secretNames: [] };
    });

    expect(modeOf()).toBe(0o600);
    // ...and the write actually happened (a no-op would pass the mode check).
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).gateway.customConnectors.acme.label).toBe('Acme');
  });

  it('removeAgentEnablement() keeps 0600 instead of downgrading to 0644', async () => {
    const { createCustomConnectorsStore } = require('../../src/connectors/custom-connectors-store');
    const store = createCustomConnectorsStore(configPath);

    await store.removeAgentEnablement('acme');

    expect(modeOf()).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).agents[0].connectors.acme).toBeUndefined();
  });

  it('tightens a 0644 config to 0600 rather than preserving the looser mode', async () => {
    fs.chmodSync(configPath, 0o644);
    const { createCustomConnectorsStore } = require('../../src/connectors/custom-connectors-store');
    const store = createCustomConnectorsStore(configPath);

    await store.mutate((connectors: Record<string, unknown>) => {
      connectors['acme'] = { label: 'Acme', config: {}, secretNames: [] };
    });

    // rename() replaces the inode, so the target ends at the tmp file's mode —
    // the write imposes 0600, it does not carry the old file's mode forward.
    // Stated as its own test because it IS a behaviour change for an install
    // that had deliberately loosened config.json: the same one the four writers
    // fixed in #461 already make, so this store matching them is the point.
    expect(modeOf()).toBe(0o600);
  });
});

// Regression: session/process.ts writes its own `gateway` and `telegram` MCP
// servers into every session's mcp-config.json, and drops any injected connector
// whose key collides. Correct, but silent — a connector that slugged to one of
// those names stored its secret, reported "Connected ✓" on every status surface,
// and never once reached a session. Nothing in the UI could explain it and
// deleting the connector was the only way out.
describe('reserved connector ids', () => {
  it('slugify() never mints an id the session writer would drop', () => {
    const { slugify, RESERVED_CONNECTOR_IDS } = require('../../src/connectors/custom');

    expect(slugify('Gateway', [])).not.toBe('gateway');
    expect(slugify('Telegram', [])).toBe('telegram-2');
    // The names are reserved regardless of how the label happens to punctuate.
    expect(slugify('gateway!', [])).toBe('gateway-2');
    for (const reserved of RESERVED_CONNECTOR_IDS) {
      expect(slugify(reserved, [])).not.toBe(reserved);
    }
  });

  it('exposes the reserved set as one shared list, not a per-call-site copy', () => {
    const { RESERVED_CONNECTOR_IDS, isReservedConnectorId } = require('../../src/connectors/custom');
    expect(isReservedConnectorId('gateway')).toBe(true);
    expect(isReservedConnectorId('telegram')).toBe(true);
    expect(isReservedConnectorId('firecrawl')).toBe(false);
    expect([...RESERVED_CONNECTOR_IDS].sort()).toEqual(['gateway', 'telegram']);
    // That this set actually covers every server session/process.ts writes is
    // asserted against the real written mcp-config.json — see
    // session-process.test.ts, 'reserves every mcpServers name the gateway
    // writes itself'.
  });

  it('POST /oauth/receive 400s a reserved id — the one route that takes an id verbatim', async () => {
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reserved-id-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ gateway: {}, agents: [] }, null, 2));

    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath));

    const body = {
      access_token: 'tok',
      config: { type: 'http', url: 'https://x.example', headers: { Authorization: 'Bearer {access_token}' } },
      label: 'Impostor',
    };

    for (const id of ['gateway', 'telegram']) {
      const res = await request(app)
        .post(`/api/v1/connectors/${id}/oauth/receive`)
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('reserved');
    }

    // Nothing was persisted for either rejected id.
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(cfg.gateway.customConnectors ?? {}).toEqual({});

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

// Regression: the discovery cache's TTL bounds how stale an entry can be, not
// how many entries exist. An expired entry for a URL that is never discovered
// again is never looked up, so its expiry check never runs — every connector
// URL edit and every deleted connector left one behind for the process lifetime.
describe('OAuth metadata cache eviction', () => {
  /**
   * Stub the three discovery round-trips at the network boundary rather than
   * spying on `discoverOAuthMetadata`: the cached wrapper calls it through the
   * module-local binding, which a `jest.spyOn` on the module object never
   * replaces — that spy would sit unused while the real fetch went out.
   */
  function stubDiscovery(): jest.Mock {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ authorization_servers: ['https://as.example'] }),
        };
      }
      if (url.includes('/.well-known/oauth-authorization-server')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            authorization_endpoint: 'https://as.example/authorize',
            token_endpoint: 'https://as.example/token',
          }),
        };
      }
      // The MCP probe itself, which is *expected* to 401 and point at its PRM.
      const origin = new URL(url).origin;
      return {
        ok: false,
        status: 401,
        headers: {
          get: (k: string) =>
            k.toLowerCase() === 'www-authenticate'
              ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
              : null,
        },
        json: async () => ({}),
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('drops expired entries and holds the map under its cap', async () => {
    const {
      discoverOAuthMetadataCached,
      clearOAuthMetadataCache,
    } = require('../../src/connectors/mcp-oauth');
    clearOAuthMetadataCache();
    const fetchMock = stubDiscovery();

    const nowSpy = jest.spyOn(Date, 'now');
    const base = 1_700_000_000_000;
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    // Observed through re-discovery cost rather than a size getter: an entry the
    // cache still holds costs 0 fetches, one it has dropped costs 3 (probe + PRM
    // + AS metadata). That is the property callers actually depend on.
    const fetchesFor = async (url: string): Promise<number> => {
      fetchMock.mockClear();
      await discoverOAuthMetadataCached(url);
      return fetchMock.mock.calls.length;
    };

    nowSpy.mockReturnValue(base);
    expect(await fetchesFor('https://a.example/mcp')).toBe(3);
    expect(await fetchesFor('https://a.example/mcp')).toBe(0); // live: cached

    // Six hours and change later that entry is past its TTL, so it is no longer
    // served — and the write below is what physically drops it from the map.
    nowSpy.mockReturnValue(base + SIX_HOURS + 1000);
    expect(await fetchesFor('https://a.example/mcp')).toBe(3);

    // And a flood of live (unexpired) URLs is capped rather than unbounded: the
    // oldest insertions are evicted while recent ones stay.
    for (let i = 0; i < 400; i++) {
      await discoverOAuthMetadataCached(`https://flood-${i}.example/mcp`);
    }
    expect(await fetchesFor('https://flood-399.example/mcp')).toBe(0); // recent: kept
    expect(await fetchesFor('https://flood-0.example/mcp')).toBe(3); // oldest: evicted

    nowSpy.mockRestore();
    clearOAuthMetadataCache();
  });

  it('still serves a live entry from cache rather than re-discovering', async () => {
    const {
      discoverOAuthMetadataCached,
      clearOAuthMetadataCache,
    } = require('../../src/connectors/mcp-oauth');
    clearOAuthMetadataCache();
    const fetchMock = stubDiscovery();

    await discoverOAuthMetadataCached('https://a.example/mcp');
    expect(fetchMock).toHaveBeenCalledTimes(3); // probe + PRM + AS metadata
    await discoverOAuthMetadataCached('https://a.example/mcp');
    expect(fetchMock).toHaveBeenCalledTimes(3); // served from cache

    clearOAuthMetadataCache();
  });
});

// GET /v1/connectors/:id/status used to derive `connected` from one or more
// hasSecret() calls and `refresh` from a separate readTokenEnv() — different
// snapshots of a file the refresh sweep rewrites wholesale. A sweep landing
// between the two reads could give up on a connector (deleting every credential)
// and still be reported as connected with no refresh trouble at all.
describe('single-connector status reads one snapshot of the token env', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-status-'));
    configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          customConnectors: {
            acme: {
              label: 'Acme',
              config: { type: 'http', url: 'https://acme.example/mcp' },
              secretNames: ['access_token', 'workspace_id'],
              credentialOwner: 'gateway',
            },
          },
        },
        agents: [],
      }),
    );
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reads the file once for both connected and refresh', async () => {
    const { setSecret } = require('../../src/connectors/token-env');
    setSecret('CUSTOM__acme__access_token', 'tok');
    setSecret('CUSTOM__acme__workspace_id', 'ws');

    const tokenEnv = require('../../src/connectors/token-env');
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath, undefined));

    // Every cross-module read of the file goes through one of these two. The old
    // code spent one hasSecret per secret name PLUS one readTokenEnv: three reads
    // of a file that can change between them.
    const reads = jest.spyOn(tokenEnv, 'readTokenEnv');
    const perKeyReads = jest.spyOn(tokenEnv, 'hasSecret');

    const res = await request(app)
      .get('/api/v1/connectors/acme/status')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`);

    const total = reads.mock.calls.length + perKeyReads.mock.calls.length;
    reads.mockRestore();
    perKeyReads.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'acme', connected: true });
    expect(total).toBe(1);
  });

  // `secretNames` is declared on CustomConnectorEntry but nothing validates it
  // when config.json is read, so an entry written by hand or by an older build
  // reaches the handler without it. `.every()` on undefined throws — inside an
  // `async` Express 4 handler, which does NOT catch rejections. The request got
  // no response at all: the panel's status poll hung until its own timeout,
  // repeatedly, instead of showing one connector as unreadable.
  it('answers 500 for an entry with no secretNames instead of hanging the request', async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { customConnectors: { broken: { label: 'Broken', config: {} } } },
        agents: [],
      }),
    );

    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath, undefined));

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app)
        .get('/api/v1/connectors/broken/status')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .timeout(2000);
      expect(res.status).toBe(500);
      expect(res.body.error).toContain('unreadable configuration');

      // And the list route degrades that one row rather than 500ing the panel.
      const list = await request(app)
        .get('/api/v1/connectors')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .timeout(2000);
      expect(list.status).toBe(200);
      expect(list.body.connectors.find((c: { id: string }) => c.id === 'broken')).toMatchObject({
        id: 'broken',
        connected: false,
      });
    } finally {
      errSpy.mockRestore();
    }
  });
});

/**
 * Round-6 regressions.
 *
 * The previous round made `readTokenEnv` rethrow every non-ENOENT errno so a
 * read-modify-write could never silently erase what it had failed to read. That
 * was right for the write path and wrong for every read-only caller: the same
 * throw now escaped `GET /v1/connectors` — an `async` handler on Express 4,
 * which does not catch rejections — into the process-wide `unhandledRejection`
 * hook in index.ts, which shuts the gateway down and exits. One root-owned
 * mcp-token.env therefore killed every agent and every channel on the box, and
 * the panel's next status poll after restart killed it again.
 */
describe('an unreadable mcp-token.env degrades instead of taking the gateway down', () => {
  let dir: string;
  let configPath: string;

  const acmeEntry = {
    label: 'Acme',
    config: { type: 'http', url: 'https://acme.example/mcp', headers: { Authorization: 'Bearer {access_token}' } },
    secretNames: ['access_token'],
    credentialOwner: 'gateway',
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-unreadable-'));
    configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { customConnectors: { acme: acmeEntry } }, agents: [] }),
    );
    // A directory where the file should be is the cheapest errno that is
    // deterministic regardless of who runs the suite (EISDIR). Production
    // reaches the same branch through a root-owned file after one `sudo` or a
    // restored volume (EACCES), or through the gateway simply being out of
    // descriptors mid-spawn-storm (EMFILE). Only ENOENT means "nothing is
    // connected yet"; every other errno used to be fatal.
    fs.mkdirSync(TOKEN_ENV, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(TOKEN_ENV, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('answers GET /v1/connectors with everything "not connected" instead of never answering', async () => {
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath, undefined));

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app)
        .get('/api/v1/connectors')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .timeout(2000);

      expect(res.status).toBe(200);
      expect(res.body.connectors.find((c: { id: string }) => c.id === 'acme')).toMatchObject({
        id: 'acme',
        connected: false,
      });
    } finally {
      errSpy.mockRestore();
    }
  });

  it('resolves zero connectors for a session spawn instead of failing the spawn', () => {
    const { resolveEnabledConnectors } = require('../../src/connectors/resolve');
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // session/process.ts calls this while building an MCP config. A throw here
      // rejected writeMcpConfig, so the agent's session never started at all —
      // an unreadable secrets file took out chat, not just connectors.
      const out = resolveEnabledConnectors({ connectors: {} }, { acme: acmeEntry });
      expect(out['acme']).toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('still fails a WRITE loudly rather than erasing what it could not read', () => {
    // The other half of the same seam, and the guarantee this must not undo:
    // `setSecret` rewrites the file whole from what it just read, so a soft read
    // there would destroy every other connector's token. Strict for the
    // read-modify-write, soft for the look-only readers.
    const { setSecret } = require('../../src/connectors/token-env');
    expect(() => setSecret('CUSTOM__acme__access_token', 'tok')).toThrow();
  });

  it('logs the failure at most once a minute rather than once per status poll', () => {
    const { readTokenEnv } = require('../../src/connectors/token-env');
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The web panel polls connector status every couple of seconds for as long
      // as the file stays unreadable. Logging every read buries the rest of the
      // log; logging none of them is how an EACCES goes unnoticed for a week.
      expect(readTokenEnv()).toEqual({});
      expect(readTokenEnv()).toEqual({});
      expect(readTokenEnv()).toEqual({});
      const lines = errSpy.mock.calls.filter((c) => String(c[0]).startsWith('token-env: cannot read'));
      expect(lines).toHaveLength(1);
      expect(String(lines[0][0])).toContain('EISDIR');
    } finally {
      errSpy.mockRestore();
    }
  });
});

// `__dcr_client_id`/`__client_redirect_uri` were added to the OAuth start path
// and never added to any delete path. Disconnect left the cached registration
// behind, so the one recovery a user can perform from the UI — disconnect, then
// reconnect — read the dead client back out, saw its redirect_uri still matched,
// skipped re-registration, and failed again every time.
describe('DELETE /v1/connectors/:id clears the cached DCR registration too', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-dcr-delete-'));
    configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          customConnectors: {
            acme: {
              label: 'Acme',
              config: { type: 'http', url: 'https://acme.example/mcp' },
              secretNames: ['access_token'],
              credentialOwner: 'gateway',
            },
          },
        },
        agents: [],
      }),
    );
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('leaves no sweep-internal key behind for a disconnected oauth connector', async () => {
    const { setSecrets, readTokenEnv } = require('../../src/connectors/token-env');
    const sweep = require('../../src/connectors/oauth-refresh-sweep');

    const internal = sweep.internalSecretKeysOf('acme');
    setSecrets({
      'CUSTOM__acme__access_token': 'tok',
      ...Object.fromEntries(internal.map((k: string) => [k, 'v'])),
    });

    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath, undefined));

    const res = await request(app)
      .delete('/api/v1/connectors/acme')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
    expect(res.status).toBe(200);

    const env = readTokenEnv();
    expect(env['CUSTOM__acme__access_token']).toBeUndefined();
    // Every key the writers can produce, enumerated from the same list the
    // deleter uses — so a key added in the future cannot be added to one side
    // and forgotten by the other without this failing.
    for (const key of internal) expect(env[key]).toBeUndefined();
    expect(internal).toContain(sweep.dcrClientIdSecretKey('acme'));
    expect(internal).toContain(sweep.clientRedirectUriSecretKey('acme'));
  });
});

/**
 * The same seam as the mcp-token.env one above, on the other file. `read()`
 * swallowed every error into `{}`, so an EACCES config.json or a hand-edit that
 * left invalid JSON was indistinguishable from "no connectors are configured" —
 * the panel showed an empty list, the refresh sweep concluded there was nothing
 * to refresh, and nothing anywhere said why.
 *
 * Soft-degrading is still correct here (a throw out of the async listing handler
 * reaches index.ts's unhandledRejection hook), so the fix is the log, not a
 * rethrow. ENOENT stays silent: no file yet is the ordinary pre-first-write state.
 */
describe('an unreadable config.json says so instead of reporting zero connectors', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-store-read-'));
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('logs once, throttled, when the file is there but unreadable', async () => {
    const { createCustomConnectorsStore } = require('../../src/connectors/custom-connectors-store');
    // EISDIR — deterministic for any uid, unlike chmod 000 which root ignores.
    // Production reaches the same branch via EACCES after a `sudo` or a restored
    // volume.
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(configPath);
    const store = createCustomConnectorsStore(configPath);

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await store.read()).toEqual({});
      expect(await store.read()).toEqual({});
      expect(await store.read()).toEqual({});
      const lines = errSpy.mock.calls.filter((c) =>
        String(c[0]).startsWith('custom-connectors-store: cannot read'),
      );
      // Three reads, one line — the panel polls this every couple of seconds.
      expect(lines).toHaveLength(1);
      expect(String(lines[0][0])).toContain('EISDIR');
      expect(String(lines[0][0])).toContain(configPath);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs when the JSON is corrupt, which has no errno at all', async () => {
    const { createCustomConnectorsStore } = require('../../src/connectors/custom-connectors-store');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '{"gateway": {"customConnectors": {'); // truncated write
    const store = createCustomConnectorsStore(configPath);

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await store.read()).toEqual({});
      const lines = errSpy.mock.calls.filter((c) =>
        String(c[0]).startsWith('custom-connectors-store: cannot read'),
      );
      expect(lines).toHaveLength(1);
      // A SyntaxError carries no `code`, so the message has to name the cause
      // itself rather than print `undefined`.
      expect(String(lines[0][0])).toContain('invalid JSON');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('stays silent when the file simply does not exist yet', async () => {
    const { createCustomConnectorsStore } = require('../../src/connectors/custom-connectors-store');
    const store = createCustomConnectorsStore(path.join(dir, 'not-written-yet.json'));

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await store.read()).toEqual({});
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('reads normally once the file is valid', async () => {
    const { createCustomConnectorsStore } = require('../../src/connectors/custom-connectors-store');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { customConnectors: { acme: { label: 'Acme' } } } }),
    );
    const store = createCustomConnectorsStore(configPath);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await store.read()).toEqual({ acme: { label: 'Acme' } });
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

// `GET /v1/connectors` is an `async` handler on Express 4, which does not catch
// rejections — anything that escapes it reaches the process-wide
// `unhandledRejection` hook in index.ts, and that hook calls
// emergencyShutdown().finally(() => process.exit(1)). A status poll for a
// read-only listing must never be able to end the process; the worst it may do
// is answer 500.
describe('the connector listing answers rather than escaping the handler', () => {
  it('500s when status assembly throws instead of rejecting into the process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-list-throw-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ gateway: {}, agents: [] }));
    try {
      const resolve = require('../../src/connectors/resolve');
      const { createConnectorsRouter } = require('../../src/api/connectors-router');
      const app = express();
      app.use(express.json());
      app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath, undefined));

      const boom = jest
        .spyOn(resolve, 'listConnectorStatus')
        .mockImplementation(() => { throw new Error('catalog blew up'); });
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await request(app)
          .get('/api/v1/connectors')
          .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
          .timeout(2000);
        expect(res.status).toBe(500);
        // The reason stays in the log; the response says only that the config
        // could not be read.
        expect(res.body.error).toMatch(/could not be read/);
        expect(res.body.error).not.toContain('catalog blew up');
      } finally {
        boom.mockRestore();
        errSpy.mockRestore();
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
