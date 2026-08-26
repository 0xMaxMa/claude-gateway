import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── os.homedir mock (set per-test, for the ~-expansion specs) ────────────────
let mockHomeDir: string | null = null;
jest.mock('os', () => {
  const real = jest.requireActual<typeof os>('os');
  return {
    ...real,
    homedir: () => mockHomeDir ?? real.homedir(),
  };
});

import { resolveUrl, resolveUrlPlan, resolveLocalUrl, resolveKey, buildRequestUrl, loadCliConfig, request, DEFAULT_PORT } from '../../src/cli/http-client';
import type { ApiKey } from '../../src/types';

describe('cli http-client resolveUrl', () => {
  it('prefers --url over everything', () => {
    expect(resolveUrl({ flagUrl: 'http://flag:1', env: { CLAUDE_GATEWAY_URL: 'http://env:2' }, config: { publicUrl: 'http://cfg:3' } })).toBe('http://flag:1');
  });

  it('falls back to $CLAUDE_GATEWAY_URL, then publicUrl', () => {
    const dead = () => null;
    expect(resolveUrl({ env: { CLAUDE_GATEWAY_URL: 'http://env:2' }, config: { publicUrl: 'http://cfg:3' }, localGateway: dead })).toBe('http://env:2');
    expect(resolveUrl({ env: {}, config: { publicUrl: 'http://cfg:3' }, localGateway: dead })).toBe('http://cfg:3');
  });

  /**
   * publicUrl describes *this* gateway from outside, so on the gateway's own
   * host both addresses are the same server — the public one just adds a
   * reverse-proxy hop. Routing through it makes every command depend on that
   * proxy, and a proxy with its own authentication answers 401 to commands
   * that work over loopback.
   */
  it('prefers the local bind over publicUrl when a gateway is live on this host', () => {
    expect(resolveUrl({ env: {}, config: { publicUrl: 'http://cfg:3', bind: '0.0.0.0' }, localGateway: () => ({ pid: 7 }) })).toBe(
      `http://127.0.0.1:${DEFAULT_PORT}`,
    );
  });

  it('an explicit --url or $CLAUDE_GATEWAY_URL still overrides a live local gateway', () => {
    const live = () => ({ pid: 7 });
    expect(resolveUrl({ flagUrl: 'http://flag:1', env: {}, config: { publicUrl: 'http://cfg:3' }, localGateway: live })).toBe('http://flag:1');
    expect(resolveUrl({ env: { CLAUDE_GATEWAY_URL: 'http://env:2' }, config: { publicUrl: 'http://cfg:3' }, localGateway: live })).toBe(
      'http://env:2',
    );
  });

  it('reads the pidfile even with no publicUrl configured — it carries the port', () => {
    // The bind URL is the answer either way, but only the pidfile knows which
    // port the running gateway actually bound.
    const probe = jest.fn(() => ({ pid: 7, port: 4321 }));
    expect(resolveUrl({ env: {}, config: { bind: '127.0.0.1' }, localGateway: probe })).toBe('http://127.0.0.1:4321');
    expect(probe).toHaveBeenCalled();
  });

  /**
   * $PORT describes the shell running the CLI, not the one the server was
   * started from: `PORT=9000 make start` in one terminal and a plain CLI in
   * another used to address port 10850, where nothing listens, and every
   * command failed at an address the gateway never bound.
   */
  it("prefers the running gateway's recorded port over the CLI's own $PORT", () => {
    const live = () => ({ pid: 7, port: 9000 });
    expect(resolveUrl({ env: {}, config: { bind: '127.0.0.1' }, localGateway: live })).toBe('http://127.0.0.1:9000');
    expect(resolveUrl({ env: { PORT: '10850' }, config: { bind: '127.0.0.1' }, localGateway: live })).toBe('http://127.0.0.1:9000');
    expect(resolveLocalUrl({ env: { PORT: '10850' }, config: { bind: '127.0.0.1' }, localGateway: live })).toBe('http://127.0.0.1:9000');
  });

  it('falls back to $PORT when the pidfile records no port (written by an older version)', () => {
    const live = () => ({ pid: 7 });
    expect(resolveUrl({ env: { PORT: '9000' }, config: { bind: '127.0.0.1' }, localGateway: live })).toBe('http://127.0.0.1:9000');
  });

  describe('resolveUrlPlan fallback', () => {
    /**
     * The pidfile can lie: a gateway killed without cleanup leaves one behind
     * and the OS may reissue that pid. The local address is still the right
     * first choice, but publicUrl names the same gateway, so an unreachable
     * local address has somewhere to fall back to instead of failing outright.
     */
    it('offers publicUrl as a fallback when the local address was chosen', () => {
      const plan = resolveUrlPlan({ env: {}, config: { bind: '127.0.0.1', publicUrl: 'https://cfg/gw' }, localGateway: () => ({ pid: 7 }) });
      expect(plan).toEqual({ baseUrl: `http://127.0.0.1:${DEFAULT_PORT}`, fallbackUrl: 'https://cfg/gw' });
    });

    it('offers no fallback for an address the caller named', () => {
      const live = () => ({ pid: 7 });
      expect(resolveUrlPlan({ flagUrl: 'http://flag:1', config: { publicUrl: 'https://cfg/gw' }, env: {}, localGateway: live })).toEqual({
        baseUrl: 'http://flag:1',
      });
      expect(
        resolveUrlPlan({ env: { CLAUDE_GATEWAY_URL: 'http://env:2' }, config: { publicUrl: 'https://cfg/gw' }, localGateway: live }),
      ).toEqual({ baseUrl: 'http://env:2' });
    });

    it('offers no fallback when publicUrl is absent, or is the address already chosen', () => {
      expect(resolveUrlPlan({ env: {}, config: { bind: '127.0.0.1' }, localGateway: () => ({ pid: 7 }) }).fallbackUrl).toBeUndefined();
      expect(
        resolveUrlPlan({
          env: {},
          config: { bind: '127.0.0.1', publicUrl: `http://127.0.0.1:${DEFAULT_PORT}/` },
          localGateway: () => ({ pid: 7 }),
        }).fallbackUrl,
      ).toBeUndefined();
    });

    it('uses publicUrl outright, with no fallback, when no gateway runs here', () => {
      expect(resolveUrlPlan({ env: {}, config: { bind: '127.0.0.1', publicUrl: 'https://cfg/gw' }, localGateway: () => null })).toEqual({
        baseUrl: 'https://cfg/gw',
      });
    });
  });

  it('composes from bind + port when nothing explicit is set', () => {
    expect(resolveUrl({ env: {}, config: { bind: '127.0.0.1' } })).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
    expect(resolveUrl({ env: { PORT: '9999' }, config: { bind: '127.0.0.1' } })).toBe('http://127.0.0.1:9999');
  });

  it('rewrites a wildcard bind to loopback for dialing', () => {
    expect(resolveUrl({ env: {}, config: { bind: '0.0.0.0' } })).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
    expect(resolveUrl({ env: {}, config: { bind: '::' } })).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
  });

  it('defaults to loopback:10850 with an empty config', () => {
    expect(resolveUrl({ env: {}, config: {} })).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
  });

  it('strips a trailing slash', () => {
    expect(resolveUrl({ flagUrl: 'http://x:1/', env: {}, config: {} })).toBe('http://x:1');
  });
});

/**
 * Health probes must reach the gateway process on THIS host. publicUrl is
 * usually a reverse proxy: unreachable from the box itself in some setups, and
 * in others still answering from a different instance — which would report a
 * dead local service as healthy.
 */
describe('cli http-client resolveLocalUrl', () => {
  it('ignores publicUrl and $CLAUDE_GATEWAY_URL, using the bind address', () => {
    expect(
      resolveLocalUrl({
        env: { CLAUDE_GATEWAY_URL: 'http://env:2' },
        config: { publicUrl: 'https://proxy.example.com/gateway', bind: '127.0.0.1' },
      }),
    ).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
  });

  it('still honours an explicit --url, for deliberately checking another host', () => {
    expect(resolveLocalUrl({ flagUrl: 'http://other:1/', env: {}, config: { publicUrl: 'http://cfg:3' } })).toBe('http://other:1');
  });

  it('rewrites a wildcard bind to loopback and honours $PORT', () => {
    expect(resolveLocalUrl({ env: { PORT: '9999' }, config: { bind: '0.0.0.0' } })).toBe('http://127.0.0.1:9999');
    expect(resolveLocalUrl({ env: {}, config: { bind: '::' } })).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
  });
});

describe('cli http-client resolveKey', () => {
  const keys: ApiKey[] = [
    { key: 'scoped-1', description: '', agents: ['a'] },
    { key: 'admin-1', description: '', agents: '*', admin: true },
  ];

  it('prefers --key, then env, then admin key, then first key', () => {
    expect(resolveKey({ flagKey: 'flag', env: { CLAUDE_GATEWAY_API_KEY: 'env' }, config: { keys } })).toBe('flag');
    expect(resolveKey({ env: { CLAUDE_GATEWAY_API_KEY: 'env' }, config: { keys } })).toBe('env');
    expect(resolveKey({ env: {}, config: { keys } })).toBe('admin-1'); // admin preferred over scoped-1
    expect(resolveKey({ env: {}, config: { keys: [keys[0]] } })).toBe('scoped-1'); // no admin → first
  });

  it('returns undefined when no key is available', () => {
    expect(resolveKey({ env: {}, config: {} })).toBeUndefined();
  });
});

describe('cli http-client buildRequestUrl', () => {
  it('mounts the path under /api and appends query', () => {
    expect(buildRequestUrl('http://x:1', '/v1/crons', { agent: 'bob' })).toBe('http://x:1/api/v1/crons?agent=bob');
  });
  it('omits empty/undefined query values', () => {
    expect(buildRequestUrl('http://x:1', '/v1/crons', { agent: undefined, limit: '' })).toBe('http://x:1/api/v1/crons');
  });
  it('tolerates a base URL with a trailing slash and a path without a leading slash', () => {
    expect(buildRequestUrl('http://x:1/', 'v1/agents')).toBe('http://x:1/api/v1/agents');
  });
});

describe('cli http-client loadCliConfig', () => {
  it('returns an empty view when the file is missing', () => {
    expect(loadCliConfig('/nonexistent/path/config.json')).toEqual({});
  });

  it('expands a leading ~ in an explicit config path', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-http-client-'));
    mockHomeDir = tmpHome;
    try {
      fs.writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({ gateway: { publicUrl: 'http://tilde:1' } }));
      expect(loadCliConfig('~/config.json')).toEqual({ publicUrl: 'http://tilde:1', bind: undefined, keys: undefined, logDir: undefined });
    } finally {
      mockHomeDir = null;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('expands a leading ~ when the path comes from $GATEWAY_CONFIG (unexpanded by env, e.g. Docker/systemd)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-http-client-'));
    mockHomeDir = tmpHome;
    const prevEnv = process.env.GATEWAY_CONFIG;
    process.env.GATEWAY_CONFIG = '~/.claude-gateway/config.json';
    try {
      fs.mkdirSync(path.join(tmpHome, '.claude-gateway'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpHome, '.claude-gateway', 'config.json'),
        JSON.stringify({ gateway: { api: { keys: [{ key: 'admin-key', admin: true }] } } })
      );
      expect(loadCliConfig().keys).toEqual([{ key: 'admin-key', admin: true }]);
    } finally {
      mockHomeDir = null;
      if (prevEnv === undefined) delete process.env.GATEWAY_CONFIG;
      else process.env.GATEWAY_CONFIG = prevEnv;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

/**
 * The retry exists for one case only: the pidfile said a gateway was live here,
 * so the local address was preferred, and nothing is actually listening on it.
 * A gateway that answered — even with an error — has been reached, and asking a
 * second address the same question would hide its answer.
 */
describe('cli http-client request fallback', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('retries the fallback address when the first cannot be reached at all', async () => {
    const seen: string[] = [];
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      if (String(url).includes('127.0.0.1')) throw new Error('connect ECONNREFUSED');
      return jsonResponse(200, { jobs: [] });
    }) as unknown as typeof fetch;

    const onFallback = jest.fn();
    const res = await request({
      method: 'GET',
      path: '/v1/crons',
      baseUrl: 'http://127.0.0.1:10850',
      fallbackBaseUrl: 'https://public/gw',
      onFallback,
    });

    expect(res.data).toEqual({ jobs: [] });
    expect(seen).toEqual(['http://127.0.0.1:10850/api/v1/crons', 'https://public/gw/api/v1/crons']);
    // The switch is announced, never silent — the operator must be able to see
    // that the answer came from somewhere other than the address they expected.
    expect(onFallback).toHaveBeenCalledWith('http://127.0.0.1:10850', 'https://public/gw', expect.stringContaining('ECONNREFUSED'));
  });

  it('does not retry an HTTP error — the gateway answered', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(401, { error: 'unauthorized' }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      request({ method: 'GET', path: '/v1/crons', baseUrl: 'http://127.0.0.1:10850', fallbackBaseUrl: 'https://public/gw' }),
    ).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the first address when there is no fallback to try', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(request({ method: 'GET', path: '/v1/crons', baseUrl: 'http://127.0.0.1:10850' })).rejects.toThrow(
      /Cannot reach gateway at http:\/\/127\.0\.0\.1:10850/,
    );
  });

  it('surfaces the fallback address when that fails too', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      request({
        method: 'GET',
        path: '/v1/crons',
        baseUrl: 'http://127.0.0.1:10850',
        fallbackBaseUrl: 'https://public/gw',
        onFallback: () => undefined,
      }),
    ).rejects.toThrow(/Cannot reach gateway at https:\/\/public\/gw/);
  });
});
