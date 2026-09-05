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

  it('withEntry() remove keeps 0600 instead of downgrading to 0644', async () => {
    const { createCustomConnectorsStore } = require('../../src/connectors/custom-connectors-store');
    const store = createCustomConnectorsStore(configPath);

    await store.withEntry('acme', ({ remove }: { remove: () => void }) => remove());

    expect(modeOf()).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).agents[0].connectors.acme).toBeUndefined();
  });

  it('withEntry() remove drops the entry and its per-agent enablement in ONE write', async () => {
    // Two writes would reopen the orphan window this method exists to close: a
    // crash between them leaves the entry gone and the enablement flags behind,
    // and with the entry gone nothing ever comes back for them.
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: { customConnectors: { acme: { label: 'Acme', config: {}, secretNames: [], credentialOwner: 'none' } } },
          agents: [{ id: 'a1', connectors: { acme: { enabled: true }, other: { enabled: true } } }],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const { createCustomConnectorsStore } = require('../../src/connectors/custom-connectors-store');
    const store = createCustomConnectorsStore(configPath);

    // writeConfigAtomic finishes every write with a rename onto the target, so
    // renames onto configPath ARE the write count.
    const realRename = fs.promises.rename;
    const renames: string[] = [];
    const spy = jest
      .spyOn(fs.promises, 'rename')
      .mockImplementation(async (from: fs.PathLike, to: fs.PathLike) => {
        renames.push(String(to));
        return realRename(from, to);
      });
    try {
      await store.withEntry('acme', ({ remove }: { remove: () => void }) => remove());
    } finally {
      spy.mockRestore();
    }

    expect(renames).toEqual([configPath]);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.gateway.customConnectors.acme).toBeUndefined();
    expect(after.agents[0].connectors.acme).toBeUndefined();
    // Only this connector's enablement goes — the agent's other flags survive.
    expect(after.agents[0].connectors.other).toEqual({ enabled: true });
  });

  // Regression (round 10). Both writers ended in `rename(tmp, configPath)` with
  // no cleanup, and the randomUUID suffix that makes the 0600 reliable — a fixed
  // tmp path gets reused at whatever mode it already had — is exactly what stops
  // a later write from overwriting the leftover. So every failed rename leaks a
  // permanent, uniquely-named, full plaintext copy of config.json (admin API key,
  // every agent's channel bot tokens) into the same directory as the real one.
  it('removes the tmp file when the rename fails, instead of leaking a plaintext copy', async () => {
    const { writeConfigAtomic, writeConfigAtomicSync } = require('../../src/config/config-write-lock');
    const dir = path.dirname(configPath);
    // A real rename failure rather than a mock: renaming a file onto a non-empty
    // directory is EISDIR/ENOTEMPTY on every platform this runs on. (fs.renameSync
    // is non-configurable under this jest setup and cannot be spied on anyway.)
    const target = path.join(dir, 'occupied-target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'x');
    const before = fs.readdirSync(dir).sort();

    await expect(writeConfigAtomic(target, { gateway: {} })).rejects.toThrow();
    expect(fs.readdirSync(dir).sort()).toEqual(before);

    expect(() => writeConfigAtomicSync(target, { gateway: {} })).toThrow();
    expect(fs.readdirSync(dir).sort()).toEqual(before);
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
    const {
      refreshTokenSecretKey,
      expiresAtSecretKey,
    } = require('../../src/connectors/oauth-refresh-sweep');
    setSecret('CUSTOM__acme__access_token', 'tok');
    setSecret('CUSTOM__acme__workspace_id', 'ws');
    // A healthy sign-in's leftovers, so the response below carries no `refresh`
    // block to distract from the read count: an access_token with no
    // refresh_token beside it is a connector nothing can renew, which
    // refreshStatusOf reports on.
    setSecret(refreshTokenSecretKey('acme'), 'rt');
    setSecret(expiresAtSecretKey('acme'), String(Date.now() + 3600_000));

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

/**
 * ── Round 11 ────────────────────────────────────────────────────────────────
 *
 * Each block below fails against the code as it stood at b0f8d06:
 *
 *   connectors admin gate  — a non-admin `write` key could enable any connector
 *                            on the box for its own agent
 *   restart rejections     — two call sites could reject out of an Express 4
 *                            async handler and reach emergencyShutdown()
 *   ~ in the token path    — the documented GATEWAY_MCP_TOKEN_ENV_PATH override
 *                            was used verbatim, creating a literal `~` directory
 *   delete semantics       — a 'none'-owner delete restarted nothing, and a
 *                            'gateway'-owner delete wiped placeholders no route
 *                            could ever restore
 *   hot-added agents       — got a config snapshot that hot-reload never reaches
 *   receive-route race     — the previous entry was read outside the write lock
 */

// The one field on PATCH /v1/agents/:id that reaches somebody else's
// credential. Every route in connectors-router.ts is admin-only; enabling a
// connector here is what actually resolves that connector's secret into the
// agent's MCP config at spawn, so leaving it at the route's `write` level let a
// key scoped to a single agent hand that agent any token an admin had connected.
describe('PATCH /v1/agents/:id — the connectors field is admin-gated', () => {
  const WRITE_KEY: ApiKey = { key: 'test-write-key', agents: ['alfred'], write: true };
  const agentConfig = {
    id: 'alfred',
    description: 'a',
    workspace: '/tmp/alfred',
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };

  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-connector-authz-'));
    configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { logDir: '~/logs', timezone: 'UTC' }, agents: [agentConfig] }, null, 2),
    );
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeApp(runner: unknown) {
    const { createApiRouter } = require('../../src/api/router');
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createApiRouter(
        new Map([['alfred', runner]]),
        new Map([['alfred', { ...agentConfig }]]),
        [ADMIN_KEY, WRITE_KEY],
        configPath,
      ),
    );
    return app;
  }

  it('403s a write key and persists nothing', async () => {
    const restartOrDefer = jest.fn().mockResolvedValue({ immediate: 0, deferred: 0, skipped: 0 });
    const app = makeApp({ updateAgentConfig: jest.fn(), restartOrDefer });

    const res = await request(app)
      .patch('/api/v1/agents/alfred')
      .set('Authorization', `Bearer ${WRITE_KEY.key}`)
      .send({ connectors: { github: { enabled: true } } });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/[Aa]dmin/);
    // Refused before the write and before any session teardown.
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).agents[0].connectors).toBeUndefined();
    expect(restartOrDefer).not.toHaveBeenCalled();
  });

  // The gate is on the FIELD, not the route: the rest of PATCH is documented as
  // a `write`-key operation on the caller's own agent and has to stay that way,
  // or this fix quietly takes renaming and re-modelling away from every
  // non-admin caller.
  it('still lets a write key change the fields it always could', async () => {
    const app = makeApp({ updateAgentConfig: jest.fn(), restartOrDefer: jest.fn() });

    const res = await request(app)
      .patch('/api/v1/agents/alfred')
      .set('Authorization', `Bearer ${WRITE_KEY.key}`)
      .send({ description: 'renamed by a write key' });

    expect(res.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).agents[0].description).toBe(
      'renamed by a write key',
    );
  });

  it('an admin key still gets through', async () => {
    const app = makeApp({
      updateAgentConfig: jest.fn(),
      restartOrDefer: jest.fn().mockResolvedValue({ immediate: 0, deferred: 0, skipped: 0 }),
    });

    const res = await request(app)
      .patch('/api/v1/agents/alfred')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send({ connectors: { github: { enabled: true } } });

    expect(res.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).agents[0].connectors).toEqual({
      github: { enabled: true },
    });
  });

  // This restart sits AFTER the handler's try/catch closes, and restartOrDefer
  // awaits proc.stop() unguarded. On Express 4 a rejection there escapes the
  // handler into index.ts's `unhandledRejection` hook, which calls
  // emergencyShutdown() — every agent on the box killed because one PATCH
  // toggled a connector. The caller must get its answer instead: the config is
  // already written and the runner already updated by this point.
  it('answers 200 when the session teardown rejects, instead of escaping the handler', async () => {
    const app = makeApp({
      updateAgentConfig: jest.fn(),
      restartOrDefer: jest.fn().mockRejectedValue(new Error('stop() wedged')),
    });

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app)
        .patch('/api/v1/agents/alfred')
        .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
        .send({ connectors: { github: { enabled: true } } })
        .timeout(2000);
      expect(res.status).toBe(200);
      // The enablement really did land — only the convenience restart failed.
      expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).agents[0].connectors).toEqual({
        github: { enabled: true },
      });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('stop() wedged'));
    } finally {
      errSpy.mockRestore();
    }
  });
});

// Same class as the /connect route's, on the sibling handler: `store.read()`
// does no runtime shape validation, so an entry hand-written into config.json
// without `config` turned `entry.config.url` into a TypeError thrown outside
// every try — an unhandled rejection out of an async Express 4 handler, which
// index.ts answers with emergencyShutdown().
describe('POST /oauth/start answers a malformed entry rather than escaping the handler', () => {
  let dir: string;

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('400s an entry with no config at all', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-oauth-start-shape-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          publicUrl: 'https://gw.example.com',
          // No `config` key — the TypeScript type says there is one; the file
          // on disk is under no such obligation.
          customConnectors: { broken: { label: 'Broken', secretNames: ['access_token'], credentialOwner: 'gateway' } },
        },
        agents: [],
      }),
    );

    const { createCustomConnectorsStore } = require('../../src/connectors/custom-connectors-store');
    const { createOauthConnectorsRouter } = require('../../src/api/oauth-connectors-router');
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createOauthConnectorsRouter(
        [ADMIN_KEY],
        { gateway: { publicUrl: 'https://gw.example.com' } },
        createCustomConnectorsStore(configPath),
      ),
    );

    const res = await request(app)
      .post('/api/v1/connectors/custom/broken/oauth/start')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .timeout(2000);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/config\.url is missing/);
  });
});

// .env.example ships the override commented out as
// `~/.claude-gateway/mcp-token.env`, and index.ts expands `~` for its sibling
// GATEWAY_CONFIG. A shell does not expand `~` inside a .env file, so using the
// value verbatim created a literal `~` directory under the gateway's cwd:
// every existing connector read as disconnected and freshly minted OAuth tokens
// were written to the wrong file, with nothing logged to say so.
describe('GATEWAY_MCP_TOKEN_ENV_PATH expands ~ the way its own documentation writes it', () => {
  it('writes under the home directory, not into a literal "~" folder', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-fake-home-'));
    // A module mock rather than jest.spyOn(os, 'homedir') (the property is
    // non-configurable here) or $HOME (jest's process.env is a copy the native
    // os.homedir() never sees). Registry-wide, so utils/paths — which does the
    // expansion — gets the same fake home token-env resolves against.
    jest.resetModules();
    jest.doMock('os', () => ({ ...jest.requireActual('os'), homedir: () => home }));
    process.env.GATEWAY_MCP_TOKEN_ENV_PATH = '~/.claude-gateway/mcp-token.env';
    // The literal-`~` check below is about the process cwd, so give the test one
    // of its own: on the unfixed code the directory is really created, and in
    // the repo root it would survive the run.
    const cwd = process.cwd();
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-cwd-'));
    process.chdir(sandbox);
    try {
      const { setSecret, getSecret } = require('../../src/connectors/token-env');
      setSecret('CUSTOM__acme__access_token', 'tok');

      expect(fs.existsSync(path.join(home, '.claude-gateway', 'mcp-token.env'))).toBe(true);
      expect(getSecret('CUSTOM__acme__access_token')).toBe('tok');
      // The failure mode this replaces, named directly: mkdirSync happily
      // creates `./~/.claude-gateway` relative to wherever the gateway was
      // started, and nothing ever reports it.
      expect(fs.existsSync(path.join(sandbox, '~'))).toBe(false);
    } finally {
      process.chdir(cwd);
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
      jest.dontMock('os');
      jest.resetModules();
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
      process.env.GATEWAY_MCP_TOKEN_ENV_PATH = TOKEN_ENV;
    }
  });

  it('leaves an absolute override alone', () => {
    process.env.GATEWAY_MCP_TOKEN_ENV_PATH = TOKEN_ENV;
    const { setSecret } = require('../../src/connectors/token-env');
    setSecret('CUSTOM__acme__access_token', 'tok');
    expect(fs.existsSync(TOKEN_ENV)).toBe(true);
  });
});

// A hard delete removes the entry, and for a 'none'-owner connector that is the
// ONLY thing that changes: there are no secrets whose disappearance would move
// the fingerprint. The runners' view of config.json is refreshed by a file
// watcher that has almost certainly not fired for the write just made, so
// without an overlay saying "gone" every live session still resolved the
// connector exactly as it was spawned with, nothing restarted, and agents kept
// the tool after the API reported it deleted.
describe("deleting a connector tells the runners it is gone", () => {
  let dir: string;
  let configPath: string;

  function writeConfig(connectors: Record<string, unknown>) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-delete-overlay-'));
    configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC', customConnectors: connectors }, agents: [{ id: 'a1' }] }),
    );
    return configPath;
  }

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function appWith(cfgPath: string) {
    const restartSessionsUsingConnector = jest.fn().mockResolvedValue({ restarted: true });
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createConnectorsRouter([ADMIN_KEY], cfgPath, new Map([['a1', { restartSessionsUsingConnector }]])),
    );
    return { app, restartSessionsUsingConnector };
  }

  it("passes a removal overlay for a 'none'-owner connector, whose secrets cannot signal the change", async () => {
    const cfgPath = writeConfig({
      docs: {
        label: 'Docs',
        config: { type: 'http', url: 'https://docs.example/mcp' },
        secretNames: [],
        credentialOwner: 'none',
      },
    });
    const { app, restartSessionsUsingConnector } = appWith(cfgPath);

    const res = await request(app).delete('/api/v1/connectors/docs').set('Authorization', `Bearer ${ADMIN_KEY.key}`);
    expect(res.status).toBe(200);
    expect(restartSessionsUsingConnector).toHaveBeenCalledWith('docs', { overlay: { docs: null } });
    // And the entry really is gone from config.json, so the overlay is telling
    // the runners the truth rather than papering over a failed write.
    expect(
      JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).gateway.customConnectors.docs,
    ).toBeUndefined();
  });

  it('still passes no overlay on a soft disconnect, where the cleared secret is the change', async () => {
    const cfgPath = writeConfig({
      stripe: {
        label: 'Stripe',
        config: { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer {api_key}' } },
        secretNames: ['api_key'],
        credentialOwner: 'static',
      },
    });
    const { app, restartSessionsUsingConnector } = appWith(cfgPath);

    const res = await request(app).delete('/api/v1/connectors/stripe').set('Authorization', `Bearer ${ADMIN_KEY.key}`);
    expect(res.status).toBe(200);
    expect(restartSessionsUsingConnector).toHaveBeenCalledWith('stripe', { overlay: undefined });
    // The entry survives a soft disconnect — its definition exists nowhere else.
    expect(
      JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).gateway.customConnectors.stripe,
    ).toBeDefined();
  });
});

// The runner half of the same fix: `null` in an overlay has to mean "removed",
// not "an entry whose value is null". Spreading it in unchanged left a null
// sitting in the map that resolveEnabledConnectors then walked.
describe('AgentRunner.restartSessionsUsingConnector — a null overlay entry means removed', () => {
  let base: string;
  let workspace: string;

  const entry = {
    label: 'Docs',
    config: { type: 'http', url: 'https://docs.example/mcp' },
    secretNames: [],
    credentialOwner: 'none',
  };

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-runner-overlay-'));
    workspace = path.join(base, 'a1', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** What each live session is asked to compare itself against. */
  async function resolvedTargetFor(overlay?: Record<string, unknown>) {
    const { AgentRunner } = require('../../src/agent/runner');
    const runner = new AgentRunner(
      { id: 'a1', description: 'a', workspace, env: '', claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] } },
      { gateway: { logDir: os.tmpdir(), timezone: 'UTC', customConnectors: { docs: entry } }, agents: [] },
    );
    let seen: unknown = 'filter never ran';
    jest
      .spyOn(runner, 'restartOrDefer')
      .mockImplementation((async (opts: { filter?: (proc: unknown) => boolean }) => {
        opts.filter?.({
          connectorConfigChanged: (_id: string, resolvedServer: unknown) => {
            seen = resolvedServer;
            return false;
          },
        });
        return { immediate: 0, deferred: 0, skipped: 0 };
      }) as never);
    await runner.restartSessionsUsingConnector('docs', { overlay });
    return seen;
  }

  it('resolves to nothing when the overlay says null, and to the entry when it does not', async () => {
    // Without the overlay the runner's own (stale) config still has the entry,
    // it needs no secrets to resolve, and so every session compares equal —
    // which is precisely why the delete path has to say so explicitly.
    expect(await resolvedTargetFor(undefined)).toEqual(entry.config);
    // With it, the connector resolves to nothing: the change each session's
    // spawn-time fingerprint is compared against.
    expect(await resolvedTargetFor({ docs: null })).toBeUndefined();
  });
});

// Disconnecting a gateway-owned connector used to clear every name in
// `secretNames`. Only `access_token` is the gateway's to re-mint at the next
// sign-in — a second placeholder pasted at add time ({workspace_id}, say) can be
// restored by no route at all: /connect refuses a 'gateway' owner and the add
// route mints a new id. One Disconnect therefore made a multi-placeholder OAuth
// connector permanently unconnectable, reporting "Not connected" after a
// successful sign-in with no way back short of hand-editing config.json.
describe('disconnecting an OAuth connector keeps the placeholders sign-in cannot restore', () => {
  let dir: string;

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('clears the access_token and the sweep bookkeeping, and nothing else', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-oauth-delete-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          customConnectors: {
            acme: {
              label: 'Acme',
              config: {
                type: 'http',
                url: 'https://acme.example/mcp/{workspace_id}',
                headers: { Authorization: 'Bearer {access_token}' },
              },
              secretNames: ['access_token', 'workspace_id'],
              credentialOwner: 'gateway',
            },
          },
        },
        agents: [],
      }),
    );

    const { setSecrets, readTokenEnv } = require('../../src/connectors/token-env');
    const sweep = require('../../src/connectors/oauth-refresh-sweep');
    const internal = sweep.internalSecretKeysOf('acme');
    setSecrets({
      'CUSTOM__acme__access_token': 'tok',
      'CUSTOM__acme__workspace_id': 'ws-123',
      ...Object.fromEntries(internal.map((k: string) => [k, 'v'])),
    });

    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath, undefined));

    const res = await request(app).delete('/api/v1/connectors/acme').set('Authorization', `Bearer ${ADMIN_KEY.key}`);
    expect(res.status).toBe(200);

    const env = readTokenEnv();
    // The credential the user asked to revoke is gone, and so is everything
    // that could mint a new one behind their back.
    expect(env['CUSTOM__acme__access_token']).toBeUndefined();
    for (const key of internal) expect(env[key]).toBeUndefined();
    // The pasted value survives, so reconnecting is one sign-in.
    expect(env['CUSTOM__acme__workspace_id']).toBe('ws-123');
  });

  it('still clears every secret of a static connector, which /connect can re-supply', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-static-delete-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          customConnectors: {
            acme: {
              label: 'Acme',
              config: { type: 'http', url: 'https://acme.example/mcp', headers: { Authorization: 'Bearer {api_key}' } },
              secretNames: ['api_key'],
              credentialOwner: 'static',
            },
          },
        },
        agents: [],
      }),
    );

    const { setSecrets, readTokenEnv } = require('../../src/connectors/token-env');
    setSecrets({ 'CUSTOM__acme__api_key': 'sk-live' });

    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath, undefined));

    const res = await request(app).delete('/api/v1/connectors/acme').set('Authorization', `Bearer ${ADMIN_KEY.key}`);
    expect(res.status).toBe(200);
    expect(readTokenEnv()['CUSTOM__acme__api_key']).toBeUndefined();
  });
});

// /oauth/receive decides what to clean up from the entry it is REPLACING: the
// previous owner (whose sweep-internal keys nothing else will ever collect once
// the id turns 'external') and the previous secret names this route does not
// reuse. Reading that entry outside the write lock is a race against the very
// writers this route has to account for — a browser sign-in completing, or
// /connect storing a pasted token — and losing it leaves a live refresh_token in
// mcp-token.env for a grant this gateway has stopped managing.
describe('POST /oauth/receive reads the entry it replaces under the write lock', () => {
  let dir: string;

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("collects the internal keys of an owner that changed while the request was in flight", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-receive-race-'));
    const configPath = path.join(dir, 'config.json');
    const staticEntry = {
      label: 'Acme',
      config: { type: 'http', url: 'https://acme.example/mcp', headers: { Authorization: 'Bearer {access_token}' } },
      secretNames: ['access_token'],
      credentialOwner: 'static',
    };
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { customConnectors: { acme: staticEntry } }, agents: [] }),
    );

    const { setSecrets, readTokenEnv } = require('../../src/connectors/token-env');
    const sweep = require('../../src/connectors/oauth-refresh-sweep');
    const internal = sweep.internalSecretKeysOf('acme');
    setSecrets(Object.fromEntries(internal.map((k: string) => [k, 'v'])));

    const { withConfigWriteLock } = require('../../src/config/config-write-lock');
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath, undefined));

    // Hold the lock, then complete a sign-in inside it: exactly what an admin
    // finishing an OAuth flow does to this id while the push is in flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const concurrentSignIn = withConfigWriteLock(configPath, async () => {
      await gate;
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      cfg.gateway.customConnectors.acme.credentialOwner = 'gateway';
      fs.writeFileSync(configPath, JSON.stringify(cfg));
    });

    // `.then()` is what dispatches a superagent request — awaiting the Test
    // object later would send it AFTER the sign-in below, which is the one
    // ordering this test must not have.
    const pending = request(app)
      .post('/api/v1/connectors/acme/oauth/receive')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send({
        access_token: 'pushed-token',
        label: 'Acme',
        config: { type: 'http', url: 'https://acme.example/mcp', headers: { Authorization: 'Bearer {access_token}' } },
      })
      .then((r) => r);

    // Let the handler get as far as it can — up to the locked write, and no
    // further — before the sign-in lands.
    await new Promise((r) => setTimeout(r, 25));
    release();
    await concurrentSignIn;

    const res = await pending;
    expect(res.status).toBe(200);

    // The entry is now 'external', so nothing will ever come back for the
    // sweep's keys: the refresh sweep skips a non-'gateway' entry and DELETE
    // clears internal keys only under that same guard.
    const env = readTokenEnv();
    for (const key of internal) expect(env[key]).toBeUndefined();
    expect(env['CUSTOM__acme__access_token']).toBe('pushed-token');
  });
});

// Round 12, finding 5. `isValidConnectorId` accepts `constructor`, `toString`,
// `valueOf` — legitimate slugs of a label like "Constructor" — and every router
// lookup is a bare `map[id]` against a plain `JSON.parse` result, which inherits
// all three. So an id nobody had ever added resolved to a Function instead of to
// nothing, and each route fell over on it in its own way instead of 404ing.
describe('a connector id that names an Object.prototype member is simply unknown', () => {
  let dir: string;

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function appWithOneConnector() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-proto-id-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          customConnectors: {
            stripe: {
              label: 'Stripe',
              config: { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer {api_key}' } },
              secretNames: ['api_key'],
              credentialOwner: 'static',
            },
          },
        },
        agents: [],
      }),
    );
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath, undefined));
    return { app, configPath };
  }

  // Before the fix: `custom.secretNames` was read off `Object`'s constructor and
  // threw, which the handler reported as 500 "has an unreadable configuration" —
  // the answer reserved for a real entry that is malformed.
  it('404s status instead of blaming an unreadable configuration', async () => {
    const { app } = appWithOneConnector();
    const res = await request(app)
      .get('/api/v1/connectors/constructor/status')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown connector 'constructor'/);
  });

  // Before the fix: 500 "Cannot read properties of undefined (reading 'map')" —
  // an internal TypeError message handed to the caller as the API's answer.
  it('404s DELETE instead of leaking an internal TypeError', async () => {
    const { app, configPath } = appWithOneConnector();
    const before = fs.readFileSync(configPath, 'utf-8');
    const res = await request(app)
      .delete('/api/v1/connectors/constructor')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown connector 'constructor'/);
    // …and nothing was rewritten for an id that was never there. `'constructor'
    // in {}` is true, so the delete path's own `in` check reported a change and
    // rewrote config.json having deleted nothing.
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  // Before the fix: 500 "Cannot read properties of undefined (reading 'length')".
  it('404s connect instead of leaking an internal TypeError', async () => {
    const { app } = appWithOneConnector();
    const res = await request(app)
      .post('/api/v1/connectors/constructor/connect')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send({ token: 'sk_live_x' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown connector 'constructor'/);
  });

  // The other half: an id like this is not reserved, so ADDING one has to keep
  // working — and then every route above must find it.
  it('still stores and finds a connector actually named after one', async () => {
    const { app } = appWithOneConnector();
    const add = await request(app)
      .post('/api/v1/connectors/custom')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send({ label: 'constructor', config: { type: 'http', url: 'https://c.example/mcp' } });
    expect(add.status).toBe(200);
    expect(add.body.id).toBe('constructor');

    const status = await request(app)
      .get('/api/v1/connectors/constructor/status')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`);
    expect(status.status).toBe(200);
    // No placeholders at all, so it is vacuously connected — the 'none' owner.
    expect(status.body).toEqual({ id: 'constructor', connected: true });
  });
});

// Same hazard one level down: `restartSessionsUsingConnector` asks the resolver
// what a single id resolves to, and read that answer off a plain object too.
describe('resolveEnabledConnectors answers about an unknown prototype-named id', () => {
  it('resolves nothing for `constructor` rather than an inherited Function', () => {
    const { resolveEnabledConnectors } = require('../../src/connectors/resolve');
    const resolved = resolveEnabledConnectors({}, {}, true);
    expect(resolved['constructor']).toBeUndefined();
    expect(resolved['toString']).toBeUndefined();
  });
});

// Round 12, findings 1 and 4. DELETE and /connect both read the entry with an
// unlocked `store.read()` and then acted on that snapshot, while POST
// /oauth/receive rewrites `credentialOwner`, `secretNames` and `config` on an
// existing id in one locked write. Every decision either route makes comes off
// exactly those fields, so a push landing in the window between the read and the
// act made the route do the wrong thing to the entry that is actually there.
describe('DELETE and /connect decide on the entry they read under the write lock', () => {
  let dir: string;

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** One connector at `acme` with the given owner, plus a router over it. */
  function appWithAcme(credentialOwner: string, secretNames: string[]) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-entry-race-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          customConnectors: {
            acme: {
              label: 'Acme',
              config: { type: 'http', url: 'https://acme.example/mcp', headers: { Authorization: 'Bearer {api_key}' } },
              secretNames,
              credentialOwner,
            },
          },
        },
        agents: [],
      }),
    );
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath, undefined));
    return { app, configPath };
  }

  /**
   * Hold the write lock, mutate `acme` inside it, and hand back the gate that
   * lets it run — the same shape the /oauth/receive race test above uses, and
   * for the same reason: this is what a control plane pushing an updated entry
   * does to this id while another request is in flight.
   */
  function concurrentPush(configPath: string, patch: Record<string, unknown>) {
    const { withConfigWriteLock } = require('../../src/config/config-write-lock');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const done = withConfigWriteLock(configPath, async () => {
      await gate;
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      Object.assign(cfg.gateway.customConnectors.acme, patch);
      fs.writeFileSync(configPath, JSON.stringify(cfg));
    });
    return { release: () => { release(); return done; } };
  }

  it('DELETE soft-disconnects an entry that became static while it was in flight', async () => {
    // 'none' hard-deletes, 'static' keeps the entry. Reading outside the lock,
    // DELETE saw 'none' and destroyed a static connector's whole definition —
    // its label, its pasted config, its per-agent enablement — for a user who
    // asked only to revoke a credential.
    const { app, configPath } = appWithAcme('none', []);
    const push = concurrentPush(configPath, { credentialOwner: 'static', secretNames: ['api_key'] });

    // `.then()` is what dispatches a superagent request — see the /oauth/receive
    // race above.
    const pending = request(app)
      .delete('/api/v1/connectors/acme')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 25));
    await push.release();

    const res = await pending;
    expect(res.status).toBe(200);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.gateway.customConnectors.acme).toBeDefined();
    expect(after.gateway.customConnectors.acme.label).toBe('Acme');
  });

  it('/connect refuses a token for an entry that became gateway-owned while it was in flight', async () => {
    // /connect is closed to 'gateway' and 'external' owners: the gateway mints
    // those itself and a pasted token is the wrong credential for them. Reading
    // outside the lock, it filed the paste anyway — overwriting the access_token
    // the sign-in that just landed had written.
    const { setSecrets, readTokenEnv } = require('../../src/connectors/token-env');
    const { app, configPath } = appWithAcme('static', ['api_key']);
    const push = concurrentPush(configPath, { credentialOwner: 'gateway', secretNames: ['access_token'] });
    setSecrets({ CUSTOM__acme__access_token: 'minted-by-sign-in' });

    const pending = request(app)
      .post('/api/v1/connectors/acme/connect')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send({ token: 'pasted-by-hand' })
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 25));
    await push.release();

    const res = await pending;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uses OAuth sign-in/);
    const env = readTokenEnv();
    // Neither under the name the stale snapshot declared, nor over the token the
    // sign-in minted.
    expect(env['CUSTOM__acme__api_key']).toBeUndefined();
    expect(env['CUSTOM__acme__access_token']).toBe('minted-by-sign-in');
  });
});

// Round 12, finding 3. `oauth: true` makes the entry 'gateway'-owned, and a
// 'gateway' token is renewed from the refresh_token the sign-in stores. A token
// pasted at add-time comes with no refresh_token — the gateway never saw the
// exchange — so nothing could ever renew it, while the row reported connected
// off `secretNames.every(hasSecret)` and the sweep recorded no failure because
// it skips a connector it cannot refresh.
describe('an oauth connector cannot be created around a pasted access_token', () => {
  let dir: string;

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeApp() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-oauth-paste-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ gateway: {}, agents: [] }));
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter([ADMIN_KEY], configPath, undefined));
    return { app, configPath };
  }

  const oauthBody = (secrets?: Record<string, string>) => ({
    label: 'Acme',
    oauth: true,
    config: {
      type: 'http',
      url: 'https://acme.example/mcp',
      headers: { Authorization: 'Bearer {access_token}' },
    },
    ...(secrets ? { secrets } : {}),
  });

  it('400s the paste instead of storing a token nothing can renew', async () => {
    const { app, configPath } = makeApp();
    const res = await request(app)
      .post('/api/v1/connectors/custom')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send(oauthBody({ access_token: 'ya29.pasted' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/access_token cannot be pasted/);
    // Neither the secret nor the entry: a 400 that half-created the connector
    // would leave the same unrenewable row behind under a different name.
    const { readTokenEnv } = require('../../src/connectors/token-env');
    expect(Object.keys(readTokenEnv())).toEqual([]);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).gateway.customConnectors).toBeUndefined();
  });

  it('still accepts an oauth connector that pastes only its non-minted placeholders', async () => {
    // The sign-in writes access_token and nothing else, so a {workspace_id} on an
    // oauth connector is inert configuration the user must supply. Rejecting the
    // whole `secrets` map would have made those connectors unaddable.
    const { app } = makeApp();
    const body = oauthBody({ workspace_id: 'T123' });
    body.config.headers = {
      Authorization: 'Bearer {access_token}',
      'X-Workspace': '{workspace_id}',
    } as never;

    const res = await request(app)
      .post('/api/v1/connectors/custom')
      .set('Authorization', `Bearer ${ADMIN_KEY.key}`)
      .send(body);

    expect(res.status).toBe(200);
    // Not connected: access_token is still missing until the sign-in runs.
    expect(res.body.connected).toBe(false);
  });

  it('reports an already-stored pasted token as unrefreshable rather than healthy', async () => {
    // Rows created before the check above exist and must not stay silent. A
    // 'gateway' access_token with no recorded expiry is one this gateway never
    // minted — every path that writes a token writes an expiry beside it,
    // defaulting to an hour when the AS omits expires_in.
    const { setSecrets } = require('../../src/connectors/token-env');
    setSecrets({ CUSTOM__acme__access_token: 'ya29.pasted' });
    const { readTokenEnv } = require('../../src/connectors/token-env');
    const { refreshStatusOf } = require('../../src/connectors/resolve');

    expect(refreshStatusOf('acme', readTokenEnv())).toEqual(
      expect.objectContaining({ unrefreshable: true }),
    );
  });

  it('says nothing about a connector that has not been signed in yet', async () => {
    // No access_token at all is the ordinary pre-sign-in state — the row already
    // reads "not connected", and flagging it would put a warning on every
    // connector between being added and being used.
    const { readTokenEnv } = require('../../src/connectors/token-env');
    const { refreshStatusOf } = require('../../src/connectors/resolve');
    expect(refreshStatusOf('acme', readTokenEnv())).toBeUndefined();
  });

  it('says nothing about a healthy gateway-minted token', async () => {
    const { setSecrets } = require('../../src/connectors/token-env');
    const { refreshTokenSecretKey, expiresAtSecretKey } = require('../../src/connectors/oauth-refresh-sweep');
    setSecrets({
      CUSTOM__acme__access_token: 'ya29.minted',
      [refreshTokenSecretKey('acme')]: 'rt',
      [expiresAtSecretKey('acme')]: String(Date.now() + 3600_000),
    });
    const { readTokenEnv } = require('../../src/connectors/token-env');
    const { refreshStatusOf } = require('../../src/connectors/resolve');
    expect(refreshStatusOf('acme', readTokenEnv())).toBeUndefined();
  });
});
