/**
 * Live chat-model catalog (issue #409).
 *
 * Before this, `gateway.models` in config.json was the only source of the
 * model list — written once at provisioning and never re-read from anywhere.
 * These tests pin the two halves of the fix: the parse (what a catalog
 * response turns into, and what it must inherit from the static list), and the
 * fetch policy (when it is safe to call, what caches, and that every failure
 * degrades to "use the static list" rather than throwing at a picker).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseModelCatalog,
  fetchModelCatalog,
  catalogBaseUrl,
  baseUrlIsSecure,
  resetModelCatalogCache,
  resetSettingsEnvCache,
  DEFAULT_CONTEXT_WINDOW,
} from '../../src/agent/model-catalog';
import type { ModelConfig } from '../../src/types';

const STATIC: ModelConfig[] = [
  { id: 'claude-opus-5', label: 'Opus 5', alias: 'opus', contextWindow: 200000 },
  { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M)', alias: 'opus[1m]', contextWindow: 1000000, multiplier: 2 },
];

const ENV_KEYS = [
  'MODELS_BASE_URL', 'ANTHROPIC_BASE_URL', 'MODELS_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
] as const;

describe('model catalog — parse', () => {
  it('parses the real bare-array response with model_id and token_multiplier', () => {
    const parsed = parseModelCatalog([
      { model_id: 'live-a', display_name: 'Live A', token_multiplier: 1 },
      { model_id: 'live-b', display_name: 'Live B', token_multiplier: 2 },
    ], STATIC);
    expect(parsed).toEqual([
      ...STATIC,
      { id: 'live-a', label: 'Live A', alias: 'live-a', contextWindow: DEFAULT_CONTEXT_WINDOW, multiplier: 1 },
      { id: 'live-b', label: 'Live B', alias: 'live-b', contextWindow: DEFAULT_CONTEXT_WINDOW, multiplier: 2 },
    ]);
  });

  it('keeps static entries authoritative when live ids collide', () => {
    const parsed = parseModelCatalog([{ model_id: 'claude-opus-5', display_name: 'Changed', token_multiplier: 9 }], STATIC);
    expect(parsed).toEqual(STATIC);
  });

  it("reads Anthropic's { data: [{ id, display_name }] } shape", () => {
    const parsed = parseModelCatalog({
      data: [{ id: 'live-model', display_name: 'Live Model', type: 'model' }],
      has_more: false,
    }, STATIC);
    expect(parsed).toEqual([
      ...STATIC,
      { id: 'live-model', label: 'Live Model', alias: 'live-model', contextWindow: DEFAULT_CONTEXT_WINDOW },
    ]);
  });

  it("reads this gateway's own { models: [{ id, label }] } shape", () => {
    const parsed = parseModelCatalog({ models: [{ id: 'a', label: 'A' }] }, STATIC);
    expect(parsed).toEqual([
      ...STATIC,
      { id: 'a', label: 'A', alias: 'a', contextWindow: DEFAULT_CONTEXT_WINDOW },
    ]);
  });

  it('carries alias, contextWindow and multiplier over from the static entry', () => {
    // A catalog response has no alias/contextWindow/multiplier. Losing them
    // would silently report a 1M model's context use against 200k in /session
    // and size /compact's window wrong.
    const parsed = parseModelCatalog({ data: [{ id: 'claude-opus-5[1m]' }] }, STATIC);
    expect(parsed).toEqual(STATIC);
  });

  it('keeps the static context window even when the response states a different one', () => {
    const parsed = parseModelCatalog(
      { data: [{ id: 'claude-opus-5', display_name: 'Opus 5', context_window: 400000 }] },
      STATIC,
    );
    expect(parsed!.find((m) => m.id === 'claude-opus-5')!.contextWindow).toBe(200000);
  });

  it('keeps the catalog order and drops duplicate ids', () => {
    const parsed = parseModelCatalog({
      data: [{ id: 'b', display_name: 'B' }, { id: 'a', display_name: 'A' }, { id: 'b', display_name: 'B again' }],
    }, STATIC);
    expect(parsed!.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-opus-5[1m]', 'b', 'a']);
    expect(parsed![2].label).toBe('B');
  });

  it('skips rows with no usable id instead of emitting blanks', () => {
    const parsed = parseModelCatalog({ data: [{ id: '' }, { id: '  ' }, null, 'x', { id: 'ok' }] }, STATIC);
    expect(parsed!.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-opus-5[1m]', 'ok']);
  });

  it('drops models that say they are not chat models', () => {
    // A proxy fronting image generation alongside chat may serve one catalog
    // for both — the image tool asks for its half with `?kind=image`. An image
    // model in the chat picker is selectable and cannot chat.
    const parsed = parseModelCatalog({
      data: [
        { id: 'chat-model', display_name: 'Chat' },
        { id: 'flux-1', display_name: 'Flux', kind: 'image' },
        { id: 'whisper', display_name: 'Whisper', type: 'audio' },
        { id: 'embed-1', display_name: 'Embed', kind: 'embedding' },
      ],
    }, STATIC);
    expect(parsed!.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-opus-5[1m]', 'chat-model']);
  });

  it("keeps a row whose type says nothing useful — Anthropic's is the constant 'model'", () => {
    // Dropping unlabelled rows would empty most catalogs.
    const parsed = parseModelCatalog({
      data: [{ id: 'a', display_name: 'A', type: 'model' }, { id: 'b', display_name: 'B' }],
    }, STATIC);
    expect(parsed!.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-opus-5[1m]', 'a', 'b']);
  });

  it('returns null for an empty catalog — an empty picker is worse than a stale one', () => {
    expect(parseModelCatalog({ data: [] }, STATIC)).toBeNull();
    expect(parseModelCatalog({ models: [] }, STATIC)).toBeNull();
  });

  it('returns null for anything that is not a catalog', () => {
    expect(parseModelCatalog(null, STATIC)).toBeNull();
    expect(parseModelCatalog('nope', STATIC)).toBeNull();
    expect(parseModelCatalog({ data: 'nope' }, STATIC)).toBeNull();
    expect(parseModelCatalog({}, STATIC)).toBeNull();
  });
});

describe('model catalog — base URL safety', () => {
  it('accepts https anywhere', () => {
    expect(baseUrlIsSecure('https://api.example.com')).toBe(true);
  });

  it('accepts http only for a local or internal host', () => {
    expect(baseUrlIsSecure('http://localhost:8080')).toBe(true);
    expect(baseUrlIsSecure('http://127.0.0.1:1234')).toBe(true);
    expect(baseUrlIsSecure('http://host.docker.internal')).toBe(true);
    expect(baseUrlIsSecure('http://10.0.0.4')).toBe(true);
  });

  it('accepts an IPv6 loopback host, whose URL hostname keeps its brackets', () => {
    // new URL('http://[::1]:8080').hostname is '[::1]', so comparing against
    // the bare '::1' never matched and a local IPv6 proxy was rejected as
    // insecure — with a misleading cleartext warning.
    expect(new URL('http://[::1]:8080').hostname).toBe('[::1]');
    expect(baseUrlIsSecure('http://[::1]:8080')).toBe(true);
  });

  it('rejects http to a public host and anything unparseable', () => {
    expect(baseUrlIsSecure('http://api.example.com')).toBe(false);
    expect(baseUrlIsSecure('not a url')).toBe(false);
    expect(baseUrlIsSecure('')).toBe(false);
  });
});

describe('model catalog — fetch policy', () => {
  const realFetch = global.fetch;
  const saved: Record<string, string | undefined> = {};
  let fetchMock: jest.Mock;

  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    // Point the CLI settings lookup at a directory with no settings.json, so a
    // real ~/.claude on the machine running the suite cannot leak in.
    process.env.CLAUDE_CONFIG_DIR = '/nonexistent-claude-config-for-tests';
    resetModelCatalogCache();
    resetSettingsEnvCache();
    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    (global as unknown as { fetch: unknown }).fetch = realFetch;
    resetModelCatalogCache();
    resetSettingsEnvCache();
  });

  const ok = (body: unknown) => ({ ok: true, json: async () => body });

  it('does not fetch at all when no base URL is configured', async () => {
    expect(catalogBaseUrl()).toBe('');
    await expect(fetchModelCatalog(STATIC)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches {base}/v1/models and returns the live list', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com/';
    fetchMock.mockResolvedValue(ok({ data: [{ id: 'live', display_name: 'Live' }] }));

    const models = await fetchModelCatalog(STATIC);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Trailing slash trimmed — '//v1/models' is a different path on many proxies.
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.example.com/v1/models');
    expect(models!.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-opus-5[1m]', 'live']);
  });

  it('sends the auth token as a bearer header', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    process.env.ANTHROPIC_AUTH_TOKEN = 'secret-token';
    fetchMock.mockResolvedValue(ok({ data: [{ id: 'live' }] }));

    await fetchModelCatalog(STATIC);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer secret-token');
  });

  it('MODELS_BASE_URL overrides ANTHROPIC_BASE_URL', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://messages.example.com';
    process.env.MODELS_BASE_URL = 'https://catalog.example.com';
    fetchMock.mockResolvedValue(ok({ data: [{ id: 'live' }] }));

    await fetchModelCatalog(STATIC);

    expect(fetchMock.mock.calls[0][0]).toBe('https://catalog.example.com/v1/models');
  });

  it('refuses to send the token over cleartext http to a public host', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://proxy.example.com';
    process.env.ANTHROPIC_AUTH_TOKEN = 'secret-token';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(fetchModelCatalog(STATIC)).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the static list on a non-ok response', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(fetchModelCatalog(STATIC)).resolves.toBeNull();
  });

  it('falls back to the static list when the request throws or times out', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'));
    await expect(fetchModelCatalog(STATIC)).resolves.toBeNull();
  });

  it('falls back when the body is not JSON', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error('invalid json'); } });
    await expect(fetchModelCatalog(STATIC)).resolves.toBeNull();
  });

  it('reuses a successful fetch within the TTL', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockResolvedValue(ok({ data: [{ id: 'live' }] }));

    await fetchModelCatalog(STATIC);
    await fetchModelCatalog(STATIC);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL has passed', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockResolvedValue(ok({ data: [{ id: 'live' }] }));

    await fetchModelCatalog(STATIC);
    await fetchModelCatalog(STATIC, Date.now() + 61_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure — one blip must not pin the static list for a minute', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
    fetchMock.mockResolvedValue(ok({ data: [{ id: 'live' }] }));

    await expect(fetchModelCatalog(STATIC)).resolves.toBeNull();
    await expect(fetchModelCatalog(STATIC)).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves the last good catalog while fetches are failing', async () => {
    // Dropping to the static list on a blip would make a user's own model
    // vanish from its picker when that model exists only upstream.
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockResolvedValueOnce(ok({ data: [{ id: 'live' }] }));
    await fetchModelCatalog(STATIC);

    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const afterTtl = await fetchModelCatalog(STATIC, Date.now() + 61_000);

    expect(afterTtl!.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-opus-5[1m]', 'live']);
  });

  it('stops serving a stale catalog once it is too old', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockResolvedValueOnce(ok({ data: [{ id: 'live' }] }));
    await fetchModelCatalog(STATIC);

    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    // Past the one-hour bound: an unrefreshable list must not be pinned forever.
    await expect(fetchModelCatalog(STATIC, Date.now() + 61 * 60_000)).resolves.toBeNull();
  });

  it('a later success replaces the stale catalog', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockResolvedValueOnce(ok({ data: [{ id: 'old' }] }));
    await fetchModelCatalog(STATIC);

    fetchMock.mockResolvedValue(ok({ data: [{ id: 'new' }] }));
    const refreshed = await fetchModelCatalog(STATIC, Date.now() + 61_000);

    expect(refreshed!.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-opus-5[1m]', 'new']);
  });

  it('re-reads settings.json for the auth token once the settings TTL has passed', async () => {
    // A long-lived gateway daemon must not pin whatever ~/.claude/settings.json
    // said at its own startup forever — someone editing that file (e.g.
    // switching ANTHROPIC_BASE_URL/token to point at a different deployment)
    // must be picked up without a full process restart.
    //
    // resetModelCatalogCache() between calls forces a real fetch each time
    // (standing in for separate, unrelated catalog fetches later in the
    // process's life) without touching resetSettingsEnvCache — the settings
    // cache must expire on its own, the same way it would in the daemon.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-settings-'));
    process.env.CLAUDE_CONFIG_DIR = dir;
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'old-token' } }));
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockResolvedValue(ok({ data: [{ id: 'live' }] }));

    const t0 = Date.now();
    await fetchModelCatalog(STATIC, t0);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer old-token');

    // Edit the file mid-run, without calling resetSettingsEnvCache — the real
    // failure mode was exactly this: the file changes but the running process
    // never notices.
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'new-token' } }));

    // Still within the settings TTL: the stale token is reused, not the new one.
    resetModelCatalogCache();
    await fetchModelCatalog(STATIC, t0 + 30_000);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer old-token');

    // Past the TTL: the file is re-read and the new token is used.
    resetModelCatalogCache();
    await fetchModelCatalog(STATIC, t0 + 61_000);
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer new-token');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shares one request between concurrent callers', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => { release = r; });
    fetchMock.mockImplementation(async () => { await gate; return ok({ data: [{ id: 'live' }] }); });

    const all = Promise.all([fetchModelCatalog(STATIC), fetchModelCatalog(STATIC), fetchModelCatalog(STATIC)]);
    release(null);
    const results = await all;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r!.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-opus-5[1m]', 'live']);
  });
});
