import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectMigration, migrateConfig } from '../../src/config/migrator';
import { DEFAULT_MODELS } from '../../src/agent/model-registry';

const templatePath = path.join(__dirname, '..', '..', 'config.template.json');
const oldDefaults = [
  { id: 'gpt-5.6-sol[1m]', label: 'GPT 5.6 Sol', alias: 'gpt56sol', contextWindow: 1050000 },
  { id: 'gpt-5.6-terra[1m]', label: 'GPT 5.6 Terra', alias: 'gpt56terra', contextWindow: 1050000 },
  { id: 'gpt-5.6-luna[1m]', label: 'GPT 5.6 Luna', alias: 'gpt56luna', contextWindow: 1050000 },
];

describe('retired GPT defaults in config migration', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-retirement-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function upgrade(models: object[], agentModel = 'gpt-5.6-terra[1m]') {
    const configPath = path.join(dir, 'config.json');
    const original = {
      configVersion: '1.0.37',
      gateway: { customSetting: { keep: true }, models },
      agents: [{ id: 'test-agent', claude: { model: agentModel } }],
    };
    fs.writeFileSync(configPath, JSON.stringify(original));
    const version = JSON.parse(fs.readFileSync(templatePath, 'utf8')).configVersion as string;
    const dryRun = detectMigration(configPath, templatePath, version);
    const result = migrateConfig(configPath, templatePath, version);
    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { configPath, original, version, dryRun, result, migrated };
  }

  it('ships the exact new IDs without retired defaults in both registries', () => {
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    const ids = template.gateway.models.map((m: { id: string }) => m.id);
    const fallbackIds = DEFAULT_MODELS.map(m => m.id);
    expect(template.configVersion).toBe('1.0.38');
    for (const id of ['gpt-6-terra', 'gpt-6.1-sol']) {
      expect(ids).toContain(id);
      expect(fallbackIds).toContain(id);
    }
    for (const { id } of oldDefaults) {
      expect(ids).not.toContain(id);
      expect(fallbackIds).not.toContain(id);
    }
  });

  it('removes shipped defaults, updates agent references, and preserves a backup', () => {
    const { configPath, original, version, dryRun, result, migrated } = upgrade([
      ...oldDefaults,
      { id: 'openrouter/custom-model', label: 'Mine', alias: 'mine', contextWindow: 128000 },
    ]);
    expect(dryRun.needed).toBe(true);
    expect(dryRun.removedFields).toEqual(result.removedFields);
    expect(result.removedFields).toEqual(oldDefaults.map(m => `gateway.models[${m.id}]`));
    expect(JSON.parse(fs.readFileSync(configPath + '.bak', 'utf8'))).toEqual(original);
    expect(migrated.configVersion).toBe(version);
    expect(migrated.gateway.models.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(['gpt-6-terra', 'gpt-6.1-sol', 'openrouter/custom-model']));
    for (const { id } of oldDefaults) expect(migrated.gateway.models.some((m: { id: string }) => m.id === id)).toBe(false);
    expect(migrated.agents[0].claude.model).toBe('gpt-6-terra');
    expect(migrated.gateway.customSetting).toEqual({ keep: true });
    expect(migrateConfig(configPath, templatePath, version).migrated).toBe(false);
  });

  it('keeps customized retired IDs and new-ID metadata, including agent selection', () => {
    const custom = { ...oldDefaults[1], label: 'My Terra', alias: 'my-terra', contextWindow: 64000 };
    const newModel = { id: 'gpt-6-terra', label: 'My New Terra', alias: 'new-terra', contextWindow: 128000 };
    const { result, migrated } = upgrade([custom, newModel]);
    expect(result.removedFields).not.toContain(`gateway.models[${custom.id}]`);
    expect(migrated.gateway.models).toContainEqual(custom);
    expect(migrated.gateway.models).toContainEqual(newModel);
    expect(migrated.agents[0].claude.model).toBe(custom.id);
  });

  it('keeps a customized duplicate when a shipped row has the same retired ID', () => {
    const custom = { ...oldDefaults[0], label: 'Private Sol', alias: 'private-sol' };
    const { migrated } = upgrade([oldDefaults[0], custom], oldDefaults[0].id);
    expect(migrated.gateway.models.filter((m: { id: string }) => m.id === custom.id)).toEqual([custom]);
    expect(migrated.agents[0].claude.model).toBe(custom.id);
  });

  it.each([
    ['gpt-5.6-sol[1m]', 'gpt-6.1-sol'],
    ['gpt-5.6-terra[1m]', 'gpt-6-terra'],
    ['gpt-5.6-luna[1m]', 'gpt-6-luna[1m]'],
  ])('moves an agent from retired %s to %s', (from, to) => {
    const { migrated } = upgrade(oldDefaults, from);
    expect(migrated.agents[0].claude.model).toBe(to);
  });

  it('does not retire defaults when applying an earlier template version', () => {
    const configPath = path.join(dir, 'old-config.json');
    const olderTemplatePath = path.join(dir, 'older-template.json');
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    template.configVersion = '1.0.37';
    fs.writeFileSync(olderTemplatePath, JSON.stringify(template));
    fs.writeFileSync(configPath, JSON.stringify({ configVersion: '1.0.36', gateway: { models: oldDefaults } }));

    const result = migrateConfig(configPath, olderTemplatePath, '1.0.37');
    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(result.removedFields).not.toContain('gateway.models[gpt-5.6-terra[1m]]');
    expect(migrated.gateway.models).toContainEqual(oldDefaults[1]);
  });
});
