import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AppsRegistry, AppEntry } from '../../../src/apps/registry';

function makeEntry(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'test-app',
    version: '1.0.0',
    commit: 'abc123def456abc123def456abc123def456abc1',
    githubUrl: 'https://github.com/test/test-app',
    installPath: '/home/ubuntu/.claude-gateway/apps/test-app',
    ports: [],
    sockets: {},
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    source: 'registry',
    ...overrides,
  };
}

function makeTmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-registry-test-'));
  return path.join(dir, 'apps.json');
}

describe('AppsRegistry', () => {
  describe('list()', () => {
    it('returns empty array when file does not exist', async () => {
      const reg = new AppsRegistry(makeTmpPath());
      expect(await reg.list()).toEqual([]);
    });

    it('returns empty array when file is empty JSON object', async () => {
      const p = makeTmpPath();
      fs.writeFileSync(p, JSON.stringify({ apps: [] }), 'utf-8');
      const reg = new AppsRegistry(p);
      expect(await reg.list()).toEqual([]);
    });

    it('returns empty array when file contains invalid JSON', async () => {
      const p = makeTmpPath();
      fs.writeFileSync(p, 'not json', 'utf-8');
      const reg = new AppsRegistry(p);
      expect(await reg.list()).toEqual([]);
    });

    it('returns entries from existing file', async () => {
      const p = makeTmpPath();
      const entry = makeEntry();
      fs.writeFileSync(p, JSON.stringify({ apps: [entry] }), 'utf-8');
      const reg = new AppsRegistry(p);
      const result = await reg.list();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test-app');
    });
  });

  describe('get()', () => {
    it('returns undefined when app not found', async () => {
      const reg = new AppsRegistry(makeTmpPath());
      expect(await reg.get('nonexistent')).toBeUndefined();
    });

    it('returns the matching entry', async () => {
      const p = makeTmpPath();
      const reg = new AppsRegistry(p);
      await reg.upsert(makeEntry({ name: 'app-a' }));
      await reg.upsert(makeEntry({ name: 'app-b' }));
      const result = await reg.get('app-a');
      expect(result?.name).toBe('app-a');
    });
  });

  describe('upsert()', () => {
    it('creates new entry when app does not exist', async () => {
      const p = makeTmpPath();
      const reg = new AppsRegistry(p);
      await reg.upsert(makeEntry());
      const list = await reg.list();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('test-app');
    });

    it('updates existing entry with same name', async () => {
      const p = makeTmpPath();
      const reg = new AppsRegistry(p);
      await reg.upsert(makeEntry({ version: '1.0.0', status: 'building' }));
      await reg.upsert(makeEntry({ version: '2.0.0', status: 'running' }));
      const list = await reg.list();
      expect(list).toHaveLength(1);
      expect(list[0].version).toBe('2.0.0');
      expect(list[0].status).toBe('running');
    });

    it('stores multiple distinct apps', async () => {
      const p = makeTmpPath();
      const reg = new AppsRegistry(p);
      await reg.upsert(makeEntry({ name: 'app-a' }));
      await reg.upsert(makeEntry({ name: 'app-b' }));
      const list = await reg.list();
      expect(list).toHaveLength(2);
    });

    it('writes atomically — file is valid JSON after each upsert', async () => {
      const p = makeTmpPath();
      const reg = new AppsRegistry(p);
      await reg.upsert(makeEntry());
      const raw = fs.readFileSync(p, 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('creates directory if it does not exist', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-mkdir-'));
      const p = path.join(tmpDir, 'nested', 'dir', 'apps.json');
      const reg = new AppsRegistry(p);
      await reg.upsert(makeEntry());
      expect(fs.existsSync(p)).toBe(true);
    });
  });

  describe('remove()', () => {
    it('removes an existing entry', async () => {
      const p = makeTmpPath();
      const reg = new AppsRegistry(p);
      await reg.upsert(makeEntry({ name: 'keep-me' }));
      await reg.upsert(makeEntry({ name: 'remove-me' }));
      await reg.remove('remove-me');
      const list = await reg.list();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('keep-me');
    });

    it('is a no-op when app does not exist', async () => {
      const p = makeTmpPath();
      const reg = new AppsRegistry(p);
      await reg.upsert(makeEntry());
      await reg.remove('does-not-exist');
      expect(await reg.list()).toHaveLength(1);
    });
  });

  describe('updateStatus()', () => {
    it('updates status and updatedAt of an existing entry', async () => {
      const p = makeTmpPath();
      const reg = new AppsRegistry(p);
      const before = new Date(Date.now() - 1000).toISOString();
      await reg.upsert(makeEntry({ status: 'building', updatedAt: before }));
      await reg.updateStatus('test-app', 'running');
      const entry = await reg.get('test-app');
      expect(entry?.status).toBe('running');
      expect(entry?.updatedAt).not.toBe(before);
    });

    it('is a no-op when app does not exist', async () => {
      const p = makeTmpPath();
      const reg = new AppsRegistry(p);
      await expect(reg.updateStatus('ghost', 'stopped')).resolves.not.toThrow();
    });
  });

  describe('concurrent access', () => {
    it('serialises concurrent upserts correctly', async () => {
      const p = makeTmpPath();
      const reg = new AppsRegistry(p);

      // Fire 10 concurrent upserts with different names
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          reg.upsert(makeEntry({ name: `app-${i}` })),
        ),
      );

      const list = await reg.list();
      expect(list).toHaveLength(10);
      // All names present (order may vary)
      const names = new Set(list.map((e) => e.name));
      for (let i = 0; i < 10; i++) {
        expect(names.has(`app-${i}`)).toBe(true);
      }
    });
  });

  describe('agentPaths', () => {
    it('preserves optional agentPaths field', async () => {
      const p = makeTmpPath();
      const reg = new AppsRegistry(p);
      const agentPaths = {
        claudeBin: '/usr/local/bin/claude',
        nodeBin: '/usr/local/bin/node',
        npmRoot: '/usr/local/lib/node_modules',
      };
      await reg.upsert(makeEntry({ agentPaths }));
      const entry = await reg.get('test-app');
      expect(entry?.agentPaths).toEqual(agentPaths);
    });
  });
});
