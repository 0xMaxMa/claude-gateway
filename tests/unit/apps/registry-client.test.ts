import { RegistryClient } from '../../../src/apps/registry-client';

const VALID_REGISTRY = {
  updated_at: '2026-05-18T12:00:00Z',
  apps: [
    {
      name: 'getpod-manager',
      description: 'VM resize, SSH keys, and usage metrics',
      repo: 'https://github.com/0xMaxMa/getpod-manager',
      author: '0xMaxMa',
      versions: [
        {
          version: '1.0.0',
          commit: 'abc123def456abc123def456abc123def456abc1',
          approved_at: '2026-05-18',
        },
      ],
    },
    {
      name: 'agent-note',
      description: 'Personal notes app',
      repo: 'https://github.com/0xMaxMa/agent-note',
      author: '0xMaxMa',
      versions: [
        {
          version: '1.0.0',
          commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          approved_at: '2026-05-18',
        },
        {
          version: '1.1.0',
          commit: 'cafebabecafebabecafebabecafebabecafebabe',
          approved_at: '2026-05-19',
        },
      ],
    },
  ],
};

function makeFetch(
  status: number,
  body: unknown,
): jest.MockedFunction<typeof fetch> {
  return jest.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function makeFailingFetch(err: Error): jest.MockedFunction<typeof fetch> {
  return jest.fn().mockRejectedValueOnce(err);
}

beforeEach(() => {
  jest.restoreAllMocks();
});

describe('RegistryClient', () => {
  describe('fetchRegistry()', () => {
    it('fetches and returns valid registry', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(makeFetch(200, VALID_REGISTRY));
      const client = new RegistryClient();
      const reg = await client.fetchRegistry();
      expect(reg.updated_at).toBe('2026-05-18T12:00:00Z');
      expect(reg.apps).toHaveLength(2);
    });

    it('uses cached result within TTL (no second fetch)', async () => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(makeFetch(200, VALID_REGISTRY));
      const client = new RegistryClient();
      await client.fetchRegistry();
      await client.fetchRegistry();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after cache is cleared', async () => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(makeFetch(200, VALID_REGISTRY));
      const client = new RegistryClient();
      await client.fetchRegistry();
      client.clearCache();
      fetchSpy.mockImplementationOnce(makeFetch(200, VALID_REGISTRY));
      await client.fetchRegistry();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('falls back to stale cache on network error', async () => {
      // Prime cache with a successful fetch
      jest.spyOn(global, 'fetch').mockImplementationOnce(makeFetch(200, VALID_REGISTRY));
      const client = new RegistryClient();
      await client.fetchRegistry();

      // Force TTL expiry then fail the next fetch — stale data should be returned
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60 * 1000);
      jest.spyOn(global, 'fetch').mockImplementationOnce(
        makeFailingFetch(new Error('network down')),
      );

      const stale = await client.fetchRegistry();
      expect(stale.apps).toHaveLength(2);
    });

    it('throws when fetch fails and no cache available', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockImplementation(makeFailingFetch(new Error('no network')));
      const client = new RegistryClient();
      await expect(client.fetchRegistry()).rejects.toThrow('no network');
    });

    it('throws on HTTP error status', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(makeFetch(500, {}));
      const client = new RegistryClient();
      await expect(client.fetchRegistry()).rejects.toThrow('HTTP 500');
    });

    it('throws on invalid registry format — not an object', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(makeFetch(200, 'bad'));
      const client = new RegistryClient();
      await expect(client.fetchRegistry()).rejects.toThrow('Invalid registry format');
    });

    it('throws on missing updated_at', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(
        makeFetch(200, { apps: [] }),
      );
      const client = new RegistryClient();
      await expect(client.fetchRegistry()).rejects.toThrow('updated_at');
    });

    it('throws on missing apps array', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(
        makeFetch(200, { updated_at: '2026-01-01T00:00:00Z' }),
      );
      const client = new RegistryClient();
      await expect(client.fetchRegistry()).rejects.toThrow('apps');
    });

    it('throws on invalid commit hash in version', async () => {
      const bad = {
        ...VALID_REGISTRY,
        apps: [
          {
            name: 'bad-app',
            description: '',
            repo: '',
            author: '',
            versions: [{ version: '1.0.0', commit: 'short', approved_at: '2026-01-01' }],
          },
        ],
      };
      jest.spyOn(global, 'fetch').mockImplementation(makeFetch(200, bad));
      const client = new RegistryClient();
      await expect(client.fetchRegistry()).rejects.toThrow('commit');
    });
  });

  describe('findApp()', () => {
    it('returns matching app', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(makeFetch(200, VALID_REGISTRY));
      const client = new RegistryClient();
      const app = await client.findApp('getpod-manager');
      expect(app?.name).toBe('getpod-manager');
    });

    it('returns undefined for unknown app', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(makeFetch(200, VALID_REGISTRY));
      const client = new RegistryClient();
      expect(await client.findApp('nonexistent')).toBeUndefined();
    });
  });

  describe('findVersion()', () => {
    beforeEach(() => {
      jest.spyOn(global, 'fetch').mockImplementation(makeFetch(200, VALID_REGISTRY));
    });

    it('returns app and version when both exist', async () => {
      const client = new RegistryClient();
      const result = await client.findVersion('getpod-manager', '1.0.0');
      expect(result?.app.name).toBe('getpod-manager');
      expect(result?.ver.commit).toBe('abc123def456abc123def456abc123def456abc1');
    });

    it('returns undefined when app does not exist', async () => {
      const client = new RegistryClient();
      expect(await client.findVersion('nope', '1.0.0')).toBeUndefined();
    });

    it('returns undefined when version does not exist', async () => {
      const client = new RegistryClient();
      expect(await client.findVersion('getpod-manager', '9.9.9')).toBeUndefined();
    });

    it('resolves latest version for multi-version app', async () => {
      const client = new RegistryClient();
      const result = await client.findVersion('agent-note', '1.1.0');
      expect(result?.ver.commit).toBe('cafebabecafebabecafebabecafebabecafebabe');
    });
  });
});
