import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  migrateConfig,
  compareSemver,
  deepMerge,
  detectMigration,
  applyMigration,
  loadCleanTemplate,
  stripIgnoredPaths,
} from '../../src/config-migrator';

describe('config-migrator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJson(name: string, data: unknown): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
    return p;
  }

  // ---------------------------------------------------------------------------
  // compareSemver
  // ---------------------------------------------------------------------------
  describe('compareSemver', () => {
    it('returns 0 for equal versions', () => {
      expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    });

    it('returns -1 when a < b', () => {
      expect(compareSemver('1.0.0', '1.1.0')).toBe(-1);
      expect(compareSemver('0.9.9', '1.0.0')).toBe(-1);
    });

    it('returns 1 when a > b', () => {
      expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
      expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // deepMerge with ignorePaths
  // ---------------------------------------------------------------------------
  describe('deepMerge with ignorePaths', () => {
    it('skips fields whose path is in ignorePaths', () => {
      const target: Record<string, unknown> = { gateway: { logDir: '/logs' } };
      const template: Record<string, unknown> = {
        gateway: { logDir: '/default', api: { keys: ['key1'] } },
      };
      const added: string[] = [];
      const ignorePaths = new Set(['gateway.api']);

      deepMerge(target, template, '', added, ignorePaths);

      expect((target.gateway as Record<string, unknown>).api).toBeUndefined();
      expect(added).not.toContain('gateway.api');
    });

    it('works normally when ignorePaths is undefined', () => {
      const target: Record<string, unknown> = {};
      const template: Record<string, unknown> = { newField: 'value' };
      const added: string[] = [];

      deepMerge(target, template, '', added);

      expect(target.newField).toBe('value');
      expect(added).toContain('newField');
    });
  });

  // ---------------------------------------------------------------------------
  // loadCleanTemplate
  // ---------------------------------------------------------------------------
  describe('loadCleanTemplate', () => {
    it('returns clean template without _migration key and extracts ignorePaths', () => {
      const templatePath = writeJson('template.json', {
        _migration: {
          ignorePaths: ['gateway.api', 'gateway.api.keys'],
        },
        configVersion: '1.0.0',
        gateway: { logDir: '/logs', api: { keys: [] } },
      });

      const result = loadCleanTemplate(templatePath);

      // _migration stripped
      expect(result.template._migration).toBeUndefined();
      // ignorePaths extracted
      expect(result.ignorePaths).toBeInstanceOf(Set);
      expect(result.ignorePaths.has('gateway.api')).toBe(true);
      expect(result.ignorePaths.has('gateway.api.keys')).toBe(true);
      // Rest of template intact
      expect(result.template.configVersion).toBe('1.0.0');
      expect(result.template.gateway).toBeDefined();
    });

    it('returns empty ignorePaths when _migration is absent', () => {
      const templatePath = writeJson('template.json', {
        configVersion: '1.0.0',
        gateway: {},
      });

      const result = loadCleanTemplate(templatePath);

      expect(result.ignorePaths.size).toBe(0);
      expect(result.template._migration).toBeUndefined();
    });

    it('throws when template file does not exist', () => {
      const templatePath = path.join(tmpDir, 'nonexistent.json');
      expect(() => loadCleanTemplate(templatePath)).toThrow(/Config template not found/);
    });

    it('handles _migration with no ignorePaths array gracefully', () => {
      const templatePath = writeJson('template.json', {
        _migration: { someOtherKey: true },
        configVersion: '1.0.0',
      });

      const result = loadCleanTemplate(templatePath);

      expect(result.ignorePaths.size).toBe(0);
      expect(result.template._migration).toBeUndefined();
    });

    it('filters out non-string entries in ignorePaths', () => {
      const templatePath = writeJson('template.json', {
        _migration: {
          ignorePaths: ['gateway.api', 42, null, 'gateway.secret'],
        },
        configVersion: '1.0.0',
      });

      const result = loadCleanTemplate(templatePath);

      expect(result.ignorePaths.size).toBe(2);
      expect(result.ignorePaths.has('gateway.api')).toBe(true);
      expect(result.ignorePaths.has('gateway.secret')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // stripIgnoredPaths
  // ---------------------------------------------------------------------------
  describe('stripIgnoredPaths', () => {
    it('removes keys matching ignorePaths', () => {
      const obj: Record<string, unknown> = {
        gateway: {
          logDir: '/logs',
          api: { keys: ['k1'], rateLimit: 100 },
        },
      };
      const ignorePaths = new Set(['gateway.api']);

      stripIgnoredPaths(obj, ignorePaths);

      const gw = obj.gateway as Record<string, unknown>;
      expect(gw.api).toBeUndefined();
      expect(gw.logDir).toBe('/logs');
    });

    it('removes nested keys matching ignorePaths', () => {
      const obj: Record<string, unknown> = {
        gateway: {
          api: { keys: ['k1'], rateLimit: 100 },
        },
      };
      const ignorePaths = new Set(['gateway.api.keys']);

      stripIgnoredPaths(obj, ignorePaths);

      const api = (obj.gateway as Record<string, unknown>).api as Record<string, unknown>;
      expect(api.keys).toBeUndefined();
      expect(api.rateLimit).toBe(100);
    });

    it('does nothing when ignorePaths is empty', () => {
      const obj = { a: 1, b: { c: 2 } };
      const original = structuredClone(obj);
      stripIgnoredPaths(obj, new Set());
      expect(obj).toEqual(original);
    });

    it('supports custom prefix for recursive calls', () => {
      const obj: Record<string, unknown> = {
        keys: ['k1'],
        rateLimit: 100,
      };
      const ignorePaths = new Set(['gateway.api.keys']);

      stripIgnoredPaths(obj, ignorePaths, 'gateway.api');

      expect(obj.keys).toBeUndefined();
      expect(obj.rateLimit).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // detectMigration
  // ---------------------------------------------------------------------------
  describe('detectMigration', () => {
    it('returns needed:false when config file does not exist', () => {
      const templatePath = writeJson('template.json', { configVersion: '1.0.0' });
      const configPath = path.join(tmpDir, 'nonexistent.json');
      const result = detectMigration(configPath, templatePath, '1.0.0');
      expect(result.needed).toBe(false);
      expect(result.addedFields).toEqual([]);
    });

    it('returns needed:false when configVersion matches currentVersion', () => {
      const configPath = writeJson('config.json', { configVersion: '1.0.0', gateway: {} });
      const templatePath = writeJson('template.json', { configVersion: '1.0.0', gateway: {} });
      const result = detectMigration(configPath, templatePath, '1.0.0');
      expect(result.needed).toBe(false);
    });

    it('returns needed:true with correct addedFields without writing', () => {
      const configPath = writeJson('config.json', {
        configVersion: '0.0.1',
        gateway: { logDir: '/logs' },
      });
      const templatePath = writeJson('template.json', {
        configVersion: '1.0.0',
        gateway: { logDir: '/default', timezone: 'UTC' },
      });

      const result = detectMigration(configPath, templatePath, '1.0.0');

      expect(result.needed).toBe(true);
      expect(result.fromVersion).toBe('0.0.1');
      expect(result.toVersion).toBe('1.0.0');
      expect(result.addedFields).toContain('gateway.timezone');
      expect(result.addedFields).toContain('configVersion');

      // Verify no writes occurred
      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(onDisk.configVersion).toBe('0.0.1');
      expect(onDisk.gateway.timezone).toBeUndefined();
    });

    it('strips _migration from template before detecting', () => {
      const configPath = writeJson('config.json', {
        configVersion: '0.0.1',
        gateway: {},
      });
      const templatePath = writeJson('template.json', {
        _migration: { ignorePaths: ['gateway.api'] },
        configVersion: '1.0.0',
        gateway: { newField: 'x' },
      });

      const result = detectMigration(configPath, templatePath, '1.0.0');

      expect(result.needed).toBe(true);
      expect(result.template._migration).toBeUndefined();
      expect(result.addedFields).not.toContain('_migration');
    });

    it('throws on invalid JSON in config file', () => {
      const configPath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(configPath, '{ invalid json }', 'utf-8');
      const templatePath = writeJson('template.json', { configVersion: '1.0.0' });

      expect(() => detectMigration(configPath, templatePath, '1.0.0')).toThrow(
        /Config file is not valid JSON/,
      );
    });

    it('treats missing configVersion as 0.0.0', () => {
      const configPath = writeJson('config.json', { gateway: {} });
      const templatePath = writeJson('template.json', {
        configVersion: '1.0.0',
        gateway: { newField: 'x' },
      });

      const result = detectMigration(configPath, templatePath, '1.0.0');

      expect(result.needed).toBe(true);
      expect(result.fromVersion).toBe('0.0.0');
    });
  });

  // ---------------------------------------------------------------------------
  // applyMigration
  // ---------------------------------------------------------------------------
  describe('applyMigration', () => {
    it('writes updated config with backup', () => {
      const original = { configVersion: '0.0.1', gateway: { logDir: '/logs' } };
      const configPath = writeJson('config.json', original);
      const template: Record<string, unknown> = {
        configVersion: '1.0.0',
        gateway: { logDir: '/default', timezone: 'UTC' },
      };
      const config = structuredClone(original) as Record<string, unknown>;

      const result = applyMigration(configPath, config, template, '1.0.0');

      expect(result.migrated).toBe(true);
      expect(result.addedFields).toContain('gateway.timezone');
      expect(result.addedFields).toContain('configVersion');

      // Verify file was written
      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.configVersion).toBe('1.0.0');
      expect(updated.gateway.timezone).toBe('UTC');
      expect(updated.gateway.logDir).toBe('/logs'); // not overwritten

      // Verify backup was created
      const backup = JSON.parse(fs.readFileSync(configPath + '.bak', 'utf-8'));
      expect(backup).toEqual(original);
    });

    it('respects ignorePaths during merge', () => {
      const original = { configVersion: '0.0.1', gateway: { logDir: '/logs' } };
      const configPath = writeJson('config.json', original);
      const template: Record<string, unknown> = {
        configVersion: '1.0.0',
        gateway: { logDir: '/default', api: { keys: ['key1'] }, timezone: 'UTC' },
      };
      const config = structuredClone(original) as Record<string, unknown>;
      const ignorePaths = new Set(['gateway.api']);

      const result = applyMigration(configPath, config, template, '1.0.0', ignorePaths);

      expect(result.migrated).toBe(true);
      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.gateway.api).toBeUndefined();
      expect(updated.gateway.timezone).toBe('UTC');
      expect(result.addedFields).not.toContain('gateway.api');
    });

    it('merges agent arrays correctly', () => {
      const original = {
        configVersion: '0.0.1',
        agents: [{ id: 'agent-a', telegram: { botToken: 'tok-a' } }],
      };
      const configPath = writeJson('config.json', original);
      const template: Record<string, unknown> = {
        configVersion: '1.0.0',
        agents: [
          {
            id: 'example',
            telegram: { botToken: '${TOKEN}', dmPolicy: 'allowlist' },
            signatureEmoji: '',
          },
        ],
      };
      const config = structuredClone(original) as Record<string, unknown>;

      const result = applyMigration(configPath, config, template, '1.0.0');

      expect(result.migrated).toBe(true);
      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.agents[0].id).toBe('agent-a');
      expect(updated.agents[0].signatureEmoji).toBe('');
      expect(updated.agents[0].telegram.botToken).toBe('tok-a');
      expect(updated.agents[0].telegram.dmPolicy).toBe('allowlist');
    });
  });

  // ---------------------------------------------------------------------------
  // migrateConfig (integration — backward compat)
  // ---------------------------------------------------------------------------
  describe('migrateConfig', () => {
    it('returns migrated:false when config file does not exist', () => {
      const templatePath = writeJson('template.json', { configVersion: '1.0.0' });
      const configPath = path.join(tmpDir, 'nonexistent.json');
      const result = migrateConfig(configPath, templatePath, '1.0.0');
      expect(result.migrated).toBe(false);
      expect(result.addedFields).toEqual([]);
    });

    it('throws when template file does not exist', () => {
      const configPath = writeJson('config.json', { configVersion: '0.0.0' });
      const templatePath = path.join(tmpDir, 'missing-template.json');
      expect(() => migrateConfig(configPath, templatePath, '1.0.0')).toThrow(
        /Config template not found/,
      );
    });

    it('returns migrated:false when configVersion matches currentVersion', () => {
      const configPath = writeJson('config.json', { configVersion: '1.0.0', gateway: {} });
      const templatePath = writeJson('template.json', { configVersion: '1.0.0', gateway: {} });
      const result = migrateConfig(configPath, templatePath, '1.0.0');
      expect(result.migrated).toBe(false);
    });

    it('treats missing configVersion as 0.0.0 and migrates', () => {
      const configPath = writeJson('config.json', { gateway: { logDir: '/logs' } });
      const templatePath = writeJson('template.json', {
        configVersion: '1.0.0',
        gateway: { logDir: '/default', timezone: 'UTC' },
      });
      const result = migrateConfig(configPath, templatePath, '1.0.0');
      expect(result.migrated).toBe(true);
      expect(result.addedFields).toContain('configVersion');

      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.configVersion).toBe('1.0.0');
    });

    it('never overwrites existing values', () => {
      const configPath = writeJson('config.json', {
        configVersion: '0.0.1',
        gateway: { logDir: '/my/logs', timezone: 'Asia/Bangkok' },
      });
      const templatePath = writeJson('template.json', {
        configVersion: '1.0.0',
        gateway: { logDir: '/default/logs', timezone: 'UTC', newField: 'hello' },
      });
      const result = migrateConfig(configPath, templatePath, '1.0.0');
      expect(result.migrated).toBe(true);

      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.gateway.logDir).toBe('/my/logs');
      expect(updated.gateway.timezone).toBe('Asia/Bangkok');
      expect(updated.gateway.newField).toBe('hello');
      expect(result.addedFields).toContain('gateway.newField');
    });

    it('adds missing fields to each agent from template schema', () => {
      const configPath = writeJson('config.json', {
        agents: [
          { id: 'agent-a', telegram: { botToken: 'tok-a' } },
          { id: 'agent-b', telegram: { botToken: 'tok-b' } },
        ],
      });
      const templatePath = writeJson('template.json', {
        configVersion: '1.0.0',
        agents: [
          {
            id: 'example',
            telegram: { botToken: '${TOKEN}', dmPolicy: 'allowlist' },
            signatureEmoji: '',
          },
        ],
      });
      const result = migrateConfig(configPath, templatePath, '1.0.0');
      expect(result.migrated).toBe(true);

      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.agents[0].id).toBe('agent-a');
      expect(updated.agents[0].signatureEmoji).toBe('');
      expect(updated.agents[0].telegram.botToken).toBe('tok-a');
      expect(updated.agents[0].telegram.dmPolicy).toBe('allowlist');

      expect(updated.agents[1].id).toBe('agent-b');
      expect(updated.agents[1].signatureEmoji).toBe('');

      expect(result.addedFields).toContain('agents[0].signatureEmoji');
      expect(result.addedFields).toContain('agents[1].signatureEmoji');
    });

    it('creates a .bak backup before writing', () => {
      const original = { gateway: { logDir: '/logs' } };
      const configPath = writeJson('config.json', original);
      const templatePath = writeJson('template.json', {
        configVersion: '1.0.0',
        gateway: { logDir: '/default', newField: true },
      });

      migrateConfig(configPath, templatePath, '1.0.0');

      const backup = JSON.parse(fs.readFileSync(configPath + '.bak', 'utf-8'));
      expect(backup).toEqual(original);
    });

    it('throws on invalid JSON in config file', () => {
      const configPath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(configPath, '{ invalid json }', 'utf-8');
      const templatePath = writeJson('template.json', { configVersion: '1.0.0' });

      expect(() => migrateConfig(configPath, templatePath, '1.0.0')).toThrow(
        /Config file is not valid JSON/,
      );
    });

    it('preserves extra custom fields not in template', () => {
      const configPath = writeJson('config.json', {
        configVersion: '0.0.1',
        gateway: { logDir: '/logs' },
        customSection: { foo: 'bar' },
      });
      const templatePath = writeJson('template.json', {
        configVersion: '1.0.0',
        gateway: { logDir: '/default', newField: 'x' },
      });

      migrateConfig(configPath, templatePath, '1.0.0');

      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.customSection).toEqual({ foo: 'bar' });
    });

    it('recursively adds nested missing fields', () => {
      const configPath = writeJson('config.json', {
        gateway: { api: { keys: [] } },
      });
      const templatePath = writeJson('template.json', {
        configVersion: '1.0.0',
        gateway: { api: { keys: [], rateLimit: 100 }, timezone: 'UTC' },
      });

      const result = migrateConfig(configPath, templatePath, '1.0.0');

      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.gateway.api.rateLimit).toBe(100);
      expect(updated.gateway.timezone).toBe('UTC');
      expect(result.addedFields).toContain('gateway.api.rateLimit');
      expect(result.addedFields).toContain('gateway.timezone');
    });

    it('skips migration when config version is already newer', () => {
      const configPath = writeJson('config.json', { configVersion: '2.0.0', gateway: {} });
      const templatePath = writeJson('template.json', { configVersion: '1.0.0', gateway: {} });
      const result = migrateConfig(configPath, templatePath, '1.0.0');
      expect(result.migrated).toBe(false);
    });

    it('does not merge fields in ignorePaths from _migration', () => {
      const configPath = writeJson('config.json', {
        configVersion: '0.0.1',
        gateway: { logDir: '/logs' },
      });
      const templatePath = writeJson('template.json', {
        _migration: { ignorePaths: ['gateway.api'] },
        configVersion: '1.0.0',
        gateway: {
          logDir: '/default',
          timezone: 'UTC',
          api: { keys: ['key1'], rateLimit: 100 },
        },
      });

      const result = migrateConfig(configPath, templatePath, '1.0.0');

      expect(result.migrated).toBe(true);
      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      // api should NOT be merged because it is in ignorePaths
      expect(updated.gateway.api).toBeUndefined();
      // timezone should be merged normally
      expect(updated.gateway.timezone).toBe('UTC');
      expect(result.addedFields).not.toContain('gateway.api');
      expect(result.addedFields).toContain('gateway.timezone');
    });

    it('strips _migration key from template before merge', () => {
      const configPath = writeJson('config.json', {
        configVersion: '0.0.1',
        gateway: {},
      });
      const templatePath = writeJson('template.json', {
        _migration: { ignorePaths: [] },
        configVersion: '1.0.0',
        gateway: { newField: 'x' },
      });

      const result = migrateConfig(configPath, templatePath, '1.0.0');

      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      // _migration should NOT appear in the migrated config
      expect(updated._migration).toBeUndefined();
      expect(result.addedFields).not.toContain('_migration');
    });
  });
});
