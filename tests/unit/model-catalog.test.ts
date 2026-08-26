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
  it("reads Anthropic's { data: [{ id, display_name }] } shape", () => {
    const parsed = parseModelCatalog({
      data: [{ id: 'live-model', display_name: 'Live Model', type: 'model' }],
      has_more: false,
    }, STATIC);
    expect(parsed).toEqual([
      { id: 'live-model', label: 'Live Model', alias: 'live-model', contextWindow: DEFAULT_CONTEXT_WINDOW },
    ]);
  });

  it("reads this gateway's own { models: [{ id, label }] } shape", () => {
    const parsed = parseModelCatalog({ models: [{ id: 'a', label: 'A' }] }, STATIC);
    expect(parsed).toEqual([{ id: 'a', label: 'A', alias: 'a', contextWindow: DEFAULT_CONTEXT_WINDOW }]);
  });

  it('carries alias, contextWindow and multiplier over from the static entry', () => {
    // A catalog response has no alias/contextWindow/multiplier. Losing them
    // would silently report a 1M model's context use against 200k in /session
    // and size /compact's window wrong.
    const parsed = parseModelCatalog({ data: [{ id: 'claude-opus-5[1m]' }] }, STATIC);
    expect(parsed).toEqual([
      { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M)', alias: 'opus[1m]', contextWindow: 1000000, multiplier: 2 },
    ]);
  });

  it('prefers a context window the response states over the static one', () => {
    const parsed = parseModelCatalog(
      { data: [{ id: 'claude-opus-5', display_name: 'Opus 5', context_window: 400000 }] },
      STATIC,
    );
    expect(parsed![0].contextWindow).toBe(400000);
  });

  it('keeps the catalog order and drops duplicate ids', () => {
    const parsed = parseModelCatalog({
      data: [{ id: 'b', display_name: 'B' }, { id: 'a', display_name: 'A' }, { id: 'b', display_name: 'B again' }],
    }, STATIC);
    expect(parsed!.map((m) => m.id)).toEqual(['b', 'a']);
    expect(parsed![0].label).toBe('B');
  });

  it('skips rows with no usable id instead of emitting blanks', () => {
    const parsed = parseModelCatalog({ data: [{ id: '' }, { id: '  ' }, null, 'x', { id: 'ok' }] }, STATIC);
    expect(parsed!.map((m) => m.id)).toEqual(['ok']);
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
    expect(models!.map((m) => m.id)).toEqual(['live']);
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

    expect(afterTtl!.map((m) => m.id)).toEqual(['live']);
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

    expect(refreshed!.map((m) => m.id)).toEqual(['new']);
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
    for (const r of results) expect(r!.map((m) => m.id)).toEqual(['live']);
  });
});
