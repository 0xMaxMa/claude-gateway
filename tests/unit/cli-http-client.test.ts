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

import { resolveUrl, resolveUrlPlan, resolveLocalUrl, resolveReachableUrl, resolveKey, buildRequestUrl, loadCliConfig, request, expandHome, DEFAULT_PORT } from '../../src/cli/http-client';
import type { ApiKey } from '../../src/types';

/** No gateway running on this host — injected wherever a test would otherwise
 *  read the real pidfile and describe the developer's machine. */
const dead = () => null;

describe('cli http-client bind resolution', () => {
  const live = () => ({ pid: 7, port: 10850 });

  // U-HC-375a — the server resolves its bind as $GATEWAY_BIND → gateway.bind →
  // loopback (resolveBindHost, api/gateway-router). The CLI read the config
  // alone, so a gateway bound through ~/.claude-gateway/.env was dialled at
  // 127.0.0.1 and reported down by `gateway status` while it was serving fine.
  it('U-HC-375a: $GATEWAY_BIND wins over gateway.bind, matching the server', () => {
    expect(resolveLocalUrl({ env: { GATEWAY_BIND: '192.168.1.10' }, config: {}, localGateway: live })).toBe(
      'http://192.168.1.10:10850',
    );
    expect(
      resolveLocalUrl({ env: { GATEWAY_BIND: '192.168.1.10' }, config: { bind: '10.0.0.1' }, localGateway: live }),
    ).toBe('http://192.168.1.10:10850');
  });

  it('U-HC-375b: a blank $GATEWAY_BIND falls through to the config, then to loopback', () => {
    expect(resolveLocalUrl({ env: { GATEWAY_BIND: '   ' }, config: { bind: '10.0.0.1' }, localGateway: live })).toBe(
      'http://10.0.0.1:10850',
    );
    expect(resolveLocalUrl({ env: { GATEWAY_BIND: '' }, config: {}, localGateway: live })).toBe('http://127.0.0.1:10850');
  });

  it('U-HC-375c: a wildcard bind is dialled on loopback, from either source', () => {
    expect(resolveLocalUrl({ env: { GATEWAY_BIND: '0.0.0.0' }, config: {}, localGateway: live })).toBe(
      'http://127.0.0.1:10850',
    );
    expect(resolveLocalUrl({ env: {}, config: { bind: '::' }, localGateway: live })).toBe('http://127.0.0.1:10850');
  });

  // U-HC-375d — bare IPv6 produced `http://::1:10850`, which fetch() rejects as
  // an invalid URL, so every command failed with a parse error naming a URL the
  // user never typed.
  it('U-HC-375d: an IPv6 literal is bracketed and the result parses', () => {
    const url = resolveLocalUrl({ env: {}, config: { bind: '::1' }, localGateway: live });
    expect(url).toBe('http://[::1]:10850');
    expect(new URL(url).hostname).toBe('[::1]');
    expect(resolveLocalUrl({ env: { GATEWAY_BIND: 'fd00::1' }, config: {}, localGateway: live })).toBe(
      'http://[fd00::1]:10850',
    );
  });

  it('U-HC-375e: an already-bracketed literal is left alone, not double-wrapped', () => {
    expect(resolveLocalUrl({ env: { GATEWAY_BIND: '[fd00::1]' }, config: {}, localGateway: live })).toBe(
      'http://[fd00::1]:10850',
    );
  });
});

describe('cli http-client resolveUrl', () => {
  it('prefers --url over everything', () => {
    expect(resolveUrl({ flagUrl: 'http://flag:1', env: { CLAUDE_GATEWAY_URL: 'http://env:2' }, config: { publicUrl: 'http://cfg:3' } })).toBe('http://flag:1');
  });

  it('falls back to $CLAUDE_GATEWAY_URL, then publicUrl', () => {
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

  // `localGateway` is injected in these three: left out, resolveUrl() reads the
  // real ~/.claude-gateway/gateway.pid, so on a machine with a gateway actually
  // running the recorded port wins over $PORT and the assertions describe that
  // host rather than the code. They passed only where no gateway was live.
  it('composes from bind + port when nothing explicit is set', () => {
    expect(resolveUrl({ env: {}, config: { bind: '127.0.0.1' }, localGateway: dead })).toBe(
      `http://127.0.0.1:${DEFAULT_PORT}`,
    );
    expect(resolveUrl({ env: { PORT: '9999' }, config: { bind: '127.0.0.1' }, localGateway: dead })).toBe(
      'http://127.0.0.1:9999',
    );
  });

  it('rewrites a wildcard bind to loopback for dialing', () => {
    expect(resolveUrl({ env: {}, config: { bind: '0.0.0.0' }, localGateway: dead })).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
    expect(resolveUrl({ env: {}, config: { bind: '::' }, localGateway: dead })).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
  });

  it('defaults to loopback:10850 with an empty config', () => {
    expect(resolveUrl({ env: {}, config: {}, localGateway: dead })).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
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

  // Same reason as above: without `localGateway` this reads the real pidfile.
  it('rewrites a wildcard bind to loopback and honours $PORT', () => {
    expect(resolveLocalUrl({ env: { PORT: '9999' }, config: { bind: '0.0.0.0' }, localGateway: dead })).toBe(
      'http://127.0.0.1:9999',
    );
    expect(resolveLocalUrl({ env: {}, config: { bind: '::' }, localGateway: dead })).toBe(
      `http://127.0.0.1:${DEFAULT_PORT}`,
    );
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

describe('cli http-client expandHome', () => {
  it('expands a leading ~ and leaves everything else alone', () => {
    mockHomeDir = '/home/tester';
    expect(expandHome('~/logs')).toBe(path.join('/home/tester', 'logs'));
    expect(expandHome('~')).toBe('/home/tester');
    expect(expandHome('/absolute/logs')).toBe('/absolute/logs');
    expect(expandHome('relative/logs')).toBe('relative/logs');
    // Only a *leading* tilde: `~` inside a path is an ordinary character.
    expect(expandHome('/var/~/logs')).toBe('/var/~/logs');
    mockHomeDir = null;
  });
});

/**
 * The per-request fallback suits one-shot commands. `agents` and `channels`
 * thread one base URL through a whole interactive session, so they settle on a
 * reachable address up front instead — without it, a stale pidfile stranded
 * every request in the session on a dead address while `crons` recovered.
 */
describe('cli http-client resolveReachableUrl', () => {
  const saved = global.fetch;
  let errs: string[];
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    errs = [];
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      errs.push(chunk.toString());
      return true;
    });
  });
  afterEach(() => {
    errSpy.mockRestore();
    global.fetch = saved;
  });

  it('returns the primary untouched when there is no fallback (never probes)', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(resolveReachableUrl({ baseUrl: 'https://public/gw' })).resolves.toBe('https://public/gw');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the primary when it answers', async () => {
    global.fetch = jest.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await expect(
      resolveReachableUrl({ baseUrl: 'http://127.0.0.1:10850', fallbackUrl: 'https://public/gw' }),
    ).resolves.toBe('http://127.0.0.1:10850');
    expect(errs.join('')).toBe('');
  });

  it('keeps the primary even on a non-2xx — the gateway was reached', async () => {
    global.fetch = jest.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(
      resolveReachableUrl({ baseUrl: 'http://127.0.0.1:10850', fallbackUrl: 'https://public/gw' }),
    ).resolves.toBe('http://127.0.0.1:10850');
  });

  it('switches to the fallback, and says so, when nothing answers', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      resolveReachableUrl({ baseUrl: 'http://127.0.0.1:10850', fallbackUrl: 'https://public/gw' }),
    ).resolves.toBe('https://public/gw');
    expect(errs.join('')).toMatch(/Cannot reach the gateway at http:\/\/127\.0\.0\.1:10850 .*using https:\/\/public\/gw/);
  });
});

/**
 * `fetch` resolves once the response headers arrive, so clearing the abort
 * timer there left the body read unbounded: a gateway that wedged after its
 * headers hung the CLI forever instead of failing at the deadline.
 */
describe('cli http-client request body deadline', () => {
  const saved = global.fetch;
  afterEach(() => {
    global.fetch = saved;
  });

  it('aborts a body that never arrives, and does not fall back over it', async () => {
    const onFallback = jest.fn();
    global.fetch = jest.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    })) as unknown as typeof fetch;

    await expect(
      request({
        method: 'GET',
        path: '/v1/crons',
        baseUrl: 'http://127.0.0.1:10850',
        fallbackBaseUrl: 'https://public/gw',
        onFallback,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/answered but the response body failed: timed out after 50ms/);
    // The gateway responded; retrying elsewhere would only re-ask the same process.
    expect(onFallback).not.toHaveBeenCalled();
  });
});
