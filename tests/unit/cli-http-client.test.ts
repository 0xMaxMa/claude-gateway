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

import { resolveUrl, resolveKey, buildRequestUrl, loadCliConfig, DEFAULT_PORT } from '../../src/cli/http-client';
import type { ApiKey } from '../../src/types';

describe('cli http-client resolveUrl', () => {
  it('prefers --url over everything', () => {
    expect(resolveUrl({ flagUrl: 'http://flag:1', env: { CLAUDE_GATEWAY_URL: 'http://env:2' }, config: { publicUrl: 'http://cfg:3' } })).toBe('http://flag:1');
  });

  it('falls back to $CLAUDE_GATEWAY_URL, then publicUrl', () => {
    expect(resolveUrl({ env: { CLAUDE_GATEWAY_URL: 'http://env:2' }, config: { publicUrl: 'http://cfg:3' } })).toBe('http://env:2');
    expect(resolveUrl({ env: {}, config: { publicUrl: 'http://cfg:3' } })).toBe('http://cfg:3');
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
