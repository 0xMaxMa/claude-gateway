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
  pruneAgentPaths,
  repairInjectedAgentFields,
  AGENT_CREDENTIAL_FIELDS,
  BIND_PRESERVED_WARNING,
} from '../../src/config/migrator';

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
            telegram: { botToken: '${TOKEN}' },
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
            telegram: { botToken: '${TOKEN}' },
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

    it('strips telegram.allowedUsers and telegram.dmPolicy via removePaths in _migration', () => {
      const configPath = writeJson('config.json', {
        configVersion: '1.0.3',
        agents: [
          { id: 'alfred', telegram: { botToken: 'tok-a', allowedUsers: [1, 2], dmPolicy: 'allowlist' } },
          { id: 'baerbel', telegram: { botToken: 'tok-b', allowedUsers: [], dmPolicy: 'open' } },
        ],
      });
      const templatePath = writeJson('template.json', {
        _migration: {
          removePaths: ['telegram.allowedUsers', 'telegram.dmPolicy'],
        },
        configVersion: '1.0.4',
        agents: [
          { id: 'example', telegram: { botToken: '${TOKEN}' } },
        ],
      });

      const result = migrateConfig(configPath, templatePath, '1.0.4');

      expect(result.migrated).toBe(true);
      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // allowedUsers and dmPolicy should be gone from both agents
      expect(updated.agents[0].telegram.allowedUsers).toBeUndefined();
      expect(updated.agents[0].telegram.dmPolicy).toBeUndefined();
      expect(updated.agents[0].telegram.botToken).toBe('tok-a');

      expect(updated.agents[1].telegram.allowedUsers).toBeUndefined();
      expect(updated.agents[1].telegram.dmPolicy).toBeUndefined();
      expect(updated.agents[1].telegram.botToken).toBe('tok-b');

      // removedFields should list the pruned paths
      expect(result.removedFields).toContain('agents[0].telegram.allowedUsers');
      expect(result.removedFields).toContain('agents[0].telegram.dmPolicy');
      expect(result.removedFields).toContain('agents[1].telegram.allowedUsers');
      expect(result.removedFields).toContain('agents[1].telegram.dmPolicy');

      // version bumped to 1.0.4
      expect(updated.configVersion).toBe('1.0.4');
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

    it('is a no-op when removePaths fields do not exist in agents', () => {
      const configPath = writeJson('config.json', {
        configVersion: '1.0.3',
        agents: [
          { id: 'alfred', telegram: { botToken: 'tok-a' } },
        ],
      });
      const templatePath = writeJson('template.json', {
        _migration: {
          removePaths: ['telegram.allowedUsers', 'telegram.dmPolicy'],
        },
        configVersion: '1.0.4',
        agents: [{ id: 'example', telegram: { botToken: '${TOKEN}' } }],
      });

      const result = migrateConfig(configPath, templatePath, '1.0.4');

      expect(result.migrated).toBe(true);
      // Fields never existed — nothing to remove
      expect(result.removedFields).toEqual([]);
      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.agents[0].telegram.botToken).toBe('tok-a');
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

  // ---------------------------------------------------------------------------
  // pruneAgentPaths (unit)
  // ---------------------------------------------------------------------------
  describe('pruneAgentPaths', () => {
    it('removes telegram.allowedUsers and telegram.dmPolicy from agents', () => {
      const agents: Array<Record<string, unknown>> = [
        { id: 'alfred', telegram: { botToken: 'tok-a', allowedUsers: [1, 2], dmPolicy: 'allowlist' } },
        { id: 'baerbel', telegram: { botToken: 'tok-b', allowedUsers: [], dmPolicy: 'open' } },
      ];

      const removed = pruneAgentPaths(agents, ['telegram.allowedUsers', 'telegram.dmPolicy']);

      expect((agents[0].telegram as Record<string, unknown>).allowedUsers).toBeUndefined();
      expect((agents[0].telegram as Record<string, unknown>).dmPolicy).toBeUndefined();
      expect((agents[0].telegram as Record<string, unknown>).botToken).toBe('tok-a');

      expect((agents[1].telegram as Record<string, unknown>).allowedUsers).toBeUndefined();
      expect((agents[1].telegram as Record<string, unknown>).dmPolicy).toBeUndefined();
      expect((agents[1].telegram as Record<string, unknown>).botToken).toBe('tok-b');

      expect(removed).toContain('agents[0].telegram.allowedUsers');
      expect(removed).toContain('agents[0].telegram.dmPolicy');
      expect(removed).toContain('agents[1].telegram.allowedUsers');
      expect(removed).toContain('agents[1].telegram.dmPolicy');
    });

    it('is a no-op when the fields do not exist', () => {
      const agents: Array<Record<string, unknown>> = [
        { id: 'alfred', telegram: { botToken: 'tok-a' } },
      ];

      const removed = pruneAgentPaths(agents, ['telegram.allowedUsers', 'telegram.dmPolicy']);

      expect(removed).toEqual([]);
      expect((agents[0].telegram as Record<string, unknown>).botToken).toBe('tok-a');
    });

    it('returns empty array for empty agents list', () => {
      const removed = pruneAgentPaths([], ['telegram.allowedUsers']);
      expect(removed).toEqual([]);
    });

    it('handles empty removePaths without error', () => {
      const agents: Array<Record<string, unknown>> = [
        { id: 'alfred', telegram: { botToken: 'tok-a', allowedUsers: [1] } },
      ];

      const removed = pruneAgentPaths(agents, []);

      expect(removed).toEqual([]);
      // field untouched
      expect((agents[0].telegram as Record<string, unknown>).allowedUsers).toEqual([1]);
    });
  });

  // ---------------------------------------------------------------------------
  // auto-migration flow (simulates gateway startup behaviour)
  // ---------------------------------------------------------------------------
  describe('auto-migration flow', () => {
    it('migrates automatically when version mismatch detected', () => {
      const config = { configVersion: '1.0.0', gateway: { port: 3000 }, agents: [] };
      const template = {
        configVersion: '1.1.0',
        _migration: { ignorePaths: [], removePaths: [] },
        gateway: { port: 3000, newField: 'default' },
        agents: [],
      };
      const configPath = writeJson('config.json', config);
      const templatePath = writeJson('config.template.json', template);

      const detection = detectMigration(configPath, templatePath, '1.1.0');
      expect(detection.needed).toBe(true);

      // simulate gateway auto-migrate (no prompt)
      const { ignorePaths, removePaths } = loadCleanTemplate(templatePath);
      const migration = applyMigration(
        configPath,
        detection.config,
        detection.template,
        '1.1.0',
        ignorePaths,
        removePaths,
      );

      expect(migration.addedFields).toContain('gateway.newField');
      const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(written.configVersion).toBe('1.1.0');
      expect(written.gateway.newField).toBe('default');
      expect(written.gateway.port).toBe(3000); // existing value preserved
    });

    it('does not inject credential fields from template into API-only agents (regression #136)', () => {
      const configPath = writeJson('config.json', {
        configVersion: '1.0.5',
        agents: [
          { id: 'getpod', description: 'API-only agent' },
          { id: 'feedback-me', description: 'API-only agent' },
        ],
      });
      const templatePath = writeJson('template.json', {
        _migration: { ignorePaths: ['gateway.api'] },
        configVersion: '1.0.6',
        agents: [
          {
            id: 'alfred',
            env: '~/.claude-gateway/agents/alfred/.env',
            telegram: { botToken: '${ALFRED_BOT_TOKEN}' },
            signatureEmoji: '🤖',
          },
        ],
      });

      const result = migrateConfig(configPath, templatePath, '1.0.6');

      expect(result.migrated).toBe(true);
      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // credential fields must NOT leak into API-only agents
      expect(updated.agents[0].telegram).toBeUndefined();
      expect(updated.agents[0].env).toBeUndefined();
      expect(updated.agents[0].id).toBe('getpod');

      expect(updated.agents[1].telegram).toBeUndefined();
      expect(updated.agents[1].env).toBeUndefined();
      expect(updated.agents[1].id).toBe('feedback-me');

      // non-credential fields should still be merged
      expect(updated.agents[0].signatureEmoji).toBe('🤖');
      expect(updated.agents[1].signatureEmoji).toBe('🤖');
    });

    it('does not migrate when versions match', () => {
      const config = { configVersion: '1.1.0', gateway: { port: 3000 }, agents: [] };
      const template = {
        configVersion: '1.1.0',
        _migration: { ignorePaths: [], removePaths: [] },
        gateway: { port: 3000 },
        agents: [],
      };
      const configPath = writeJson('config.json', config);
      const templatePath = writeJson('config.template.json', template);

      const detection = detectMigration(configPath, templatePath, '1.1.0');
      expect(detection.needed).toBe(false);
    });

    it('creates a .bak backup before writing', () => {
      const config = { configVersion: '1.0.0', gateway: {}, agents: [] };
      const template = {
        configVersion: '1.1.0',
        _migration: { ignorePaths: [], removePaths: [] },
        gateway: { newField: 'x' },
        agents: [],
      };
      const configPath = writeJson('config.json', config);
      const templatePath = writeJson('config.template.json', template);

      const detection = detectMigration(configPath, templatePath, '1.1.0');
      const { ignorePaths, removePaths } = loadCleanTemplate(templatePath);
      applyMigration(configPath, detection.config, detection.template, '1.1.0', ignorePaths, removePaths);

      expect(fs.existsSync(`${configPath}.bak`)).toBe(true);
      const bak = JSON.parse(fs.readFileSync(`${configPath}.bak`, 'utf-8'));
      expect(bak.configVersion).toBe('1.0.0'); // backup has original
    });
  });

  // ---------------------------------------------------------------------------
  // repairInjectedAgentFields
  // ---------------------------------------------------------------------------
  describe('repairInjectedAgentFields', () => {
    it('removes telegram block only when botToken exactly matches a template credential', () => {
      const templateCreds = new Set(['${ALFRED_BOT_TOKEN}']);
      const agents: Array<Record<string, unknown>> = [
        // leaked from template — should be removed
        { id: 'getpod', telegram: { botToken: '${ALFRED_BOT_TOKEN}' } },
        // user's own placeholder — must NOT be removed
        { id: 'feedback', telegram: { botToken: '${FEEDBACK_BOT_TOKEN}' } },
      ];
      const removed = repairInjectedAgentFields(agents, templateCreds);
      expect(agents[0].telegram).toBeUndefined();
      expect(agents[1].telegram).toBeDefined();
      expect(removed).toContain('agents[0].telegram');
      expect(removed).not.toContain('agents[1].telegram');
    });

    it('preserves telegram when botToken is a real resolved value', () => {
      const agents: Array<Record<string, unknown>> = [
        { id: 'alfred', telegram: { botToken: '123456789:AAHfiq...' } },
      ];
      const removed = repairInjectedAgentFields(agents, new Set());
      expect(agents[0].telegram).toBeDefined();
      expect(removed).toHaveLength(0);
    });

    it('is a no-op when agents have no telegram', () => {
      const agents: Array<Record<string, unknown>> = [
        { id: 'api-only', description: 'no telegram' },
      ];
      const removed = repairInjectedAgentFields(agents, new Set());
      expect(removed).toHaveLength(0);
    });

    it('is a no-op for telegram when templateCredentials is empty', () => {
      // Even if botToken is a placeholder, empty templateCreds = no leaked values to detect
      const agents: Array<Record<string, unknown>> = [
        { id: 'getpod', telegram: { botToken: '${GETPOD_BOT_TOKEN}' } },
      ];
      const removed = repairInjectedAgentFields(agents, new Set());
      expect(agents[0].telegram).toBeDefined();
      expect(removed).toHaveLength(0);
    });

    it('removes env path that references a different agent directory', () => {
      const agents: Array<Record<string, unknown>> = [
        { id: 'getpod', env: '~/.claude-gateway/agents/alfred/.env' },
        { id: 'alfred', env: '~/.claude-gateway/agents/alfred/.env' },
      ];
      const removed = repairInjectedAgentFields(agents, new Set());
      // getpod's env references alfred — should be removed
      expect(agents[0].env).toBeUndefined();
      expect(removed).toContain('agents[0].env');
      // alfred's env references itself — should be kept
      expect(agents[1].env).toBe('~/.claude-gateway/agents/alfred/.env');
      expect(removed).not.toContain('agents[1].env');
    });

    it('repairs configs broken by the 1.2.26 bug during next migration', () => {
      const configPath = writeJson('config.json', {
        configVersion: '1.0.6',
        agents: [
          { id: 'getpod', telegram: { botToken: '${ALFRED_BOT_TOKEN}' }, env: '~/.claude-gateway/agents/alfred/.env' },
        ],
      });
      const templatePath = writeJson('template.json', {
        configVersion: '1.0.7',
        agents: [{ id: 'alfred', telegram: { botToken: '${ALFRED_BOT_TOKEN}' }, signatureEmoji: '' }],
      });

      const result = migrateConfig(configPath, templatePath, '1.0.7');

      expect(result.migrated).toBe(true);
      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      // placeholder telegram and mismatched env should be removed
      expect(updated.agents[0].telegram).toBeUndefined();
      expect(updated.agents[0].env).toBeUndefined();
      expect(result.removedFields).toContain('agents[0].telegram');
      expect(result.removedFields).toContain('agents[0].env');
      // non-credential fields merged normally
      expect(updated.agents[0].signatureEmoji).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // AGENT_CREDENTIAL_FIELDS — ensure all known instance-specific fields covered
  // ---------------------------------------------------------------------------
  describe('AGENT_CREDENTIAL_FIELDS', () => {
    it('contains all instance-specific fields', () => {
      const expected = ['env', 'telegram', 'discord', 'workspace', 'avatar', 'id', 'name', 'description'];
      for (const field of expected) {
        expect(AGENT_CREDENTIAL_FIELDS.has(field)).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // gateway.bind behavior-preserving migration (Issue #204)
  // ---------------------------------------------------------------------------
  // The localhost-only bind default landed at configVersion 1.0.13 (package
  // v1.3.26). configVersion is a 1.0.x series, SEPARATE from the release
  // version — these tests use the real configVersion scale, not 1.3.x.
  describe('gateway.bind behavior-preserving migration', () => {
    // Mirror the real config.template.json, which ships gateway.bind = "127.0.0.1".
    // The template MUST carry bind here, otherwise the test misses the deepMerge
    // interaction that leaks the localhost default into old configs (Issue #204).
    const template = (): string =>
      writeJson('template.json', {
        configVersion: '1.0.14',
        gateway: { timezone: 'UTC', bind: '127.0.0.1' },
      });

    it('pins gateway.bind to 0.0.0.0 when migrating a pre-1.0.13 config that never set it', () => {
      const configPath = writeJson('config.json', {
        configVersion: '1.0.12',
        gateway: { logDir: '/logs' },
      });
      const result = migrateConfig(configPath, template(), '1.0.14');

      expect(result.migrated).toBe(true);
      expect(result.addedFields).toContain('gateway.bind');
      expect(result.warnings).toContain(BIND_PRESERVED_WARNING);

      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.gateway.bind).toBe('0.0.0.0');
    });

    it('does not pin at the 1.0.13 boundary — takes the template localhost default instead', () => {
      const configPath = writeJson('config.json', {
        configVersion: '1.0.13',
        gateway: { logDir: '/logs' },
      });
      const result = migrateConfig(configPath, template(), '1.0.14');

      expect(result.migrated).toBe(true); // migration still runs (1.0.13 < 1.0.14)
      // Our preserve logic must NOT fire (no 0.0.0.0, no warning); the config
      // simply inherits the template's secure localhost default via deepMerge.
      expect(result.warnings).not.toContain(BIND_PRESERVED_WARNING);
      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.gateway.bind).toBe('127.0.0.1');
    });

    it('never overwrites an explicit bind on a pre-1.0.13 config', () => {
      const configPath = writeJson('config.json', {
        configVersion: '1.0.12',
        gateway: { bind: '127.0.0.1', logDir: '/logs' },
      });
      const result = migrateConfig(configPath, template(), '1.0.14');

      expect(result.addedFields).not.toContain('gateway.bind');
      expect(result.warnings).not.toContain(BIND_PRESERVED_WARNING);
      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.gateway.bind).toBe('127.0.0.1'); // preserved as-is
    });

    it('detectMigration dry-run reports gateway.bind without writing to disk', () => {
      const configPath = writeJson('config.json', {
        configVersion: '1.0.12',
        gateway: { logDir: '/logs' },
      });
      const result = detectMigration(configPath, template(), '1.0.14');

      expect(result.needed).toBe(true);
      expect(result.addedFields).toContain('gateway.bind');
      expect(result.warnings).toContain(BIND_PRESERVED_WARNING);

      // Dry-run must not mutate the file on disk.
      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(onDisk.configVersion).toBe('1.0.12');
      expect(onDisk.gateway.bind).toBeUndefined();
    });

    it('does not pin bind for a fresh install (no prior config)', () => {
      const missingConfigPath = path.join(tmpDir, 'does-not-exist.json');
      const result = detectMigration(missingConfigPath, template(), '1.0.14');

      expect(result.needed).toBe(false);
      expect(result.addedFields).not.toContain('gateway.bind');
      expect(result.warnings).not.toContain(BIND_PRESERVED_WARNING);
    });
  });
});
