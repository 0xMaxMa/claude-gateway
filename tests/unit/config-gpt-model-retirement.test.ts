import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectMigration, migrateConfig } from '../../src/config/migrator';
import { DEFAULT_MODELS, findModel, resolveModelId } from '../../src/agent/model-registry';
import { AgentRunner } from '../../src/agent/runner';

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
    expect(ids).toContain('gpt-6.1-sol[1m]');
    expect(fallbackIds).toContain('gpt-6.1-sol[1m]');
    for (const id of [...ids, ...fallbackIds]) {
      expect(id).not.toMatch(/^gpt-6-terr?a(?:\[1m\])?$/);
      expect(id).not.toBe('gpt-6.1-sol');
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
    expect(migrated.gateway.models.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(['gpt-6.1-sol[1m]', 'openrouter/custom-model']));
    for (const { id } of oldDefaults) expect(migrated.gateway.models.some((m: { id: string }) => m.id === id)).toBe(false);
    expect(migrated.agents[0].claude.model).toBe('gpt-6.1-sol[1m]');
    expect(migrated.gateway.customSetting).toEqual({ keep: true });
    expect(migrateConfig(configPath, templatePath, version).migrated).toBe(false);
  });

  it('migrates a selected retired model when gateway.models was absent', () => {
    const configPath = path.join(dir, 'no-models.json');
    fs.writeFileSync(configPath, JSON.stringify({
      configVersion: '1.0.37', gateway: {},
      agents: [{ id: 'test-agent', claude: { model: 'gpt-5.6-terra[1m]' } }],
    }));
    const version = JSON.parse(fs.readFileSync(templatePath, 'utf8')).configVersion as string;
    migrateConfig(configPath, templatePath, version);
    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(migrated.agents[0].claude.model).toBe('gpt-6.1-sol[1m]');
    expect(migrated.gateway.models.some((m: { id: string }) => m.id === 'gpt-5.6-terra[1m]')).toBe(false);
  });

  it('lists and resolves the exact requested IDs after disposable migration', async () => {
    const { migrated } = upgrade(oldDefaults);
    const models = migrated.gateway.models;
    const ids = ['gpt-6.1-sol[1m]'];
    for (const id of ids) {
      expect(resolveModelId(models, id).id).toBe(id);
      expect(findModel(models, id)?.id).toBe(id);
      expect(models.find((m: { id: string }) => m.id === id)?.contextWindow).toBe(1050000);
    }
    const runner = {
      gatewayConfig: { gateway: { models } },
      agentConfig: { claude: { model: migrated.agents[0].claude.model } },
      availableModels: async () => models,
    } as unknown as AgentRunner;
    const listed = await (AgentRunner.prototype as unknown as {
      modelList: (this: AgentRunner, hint: string) => Promise<{ text: string; models: Array<{ id: string }> }>;
    }).modelList.call(runner, 'Switch with /model <id or alias>');
    for (const id of ids) expect(listed.text).toContain('`' + id + '`');
    for (const { id } of listed.models) {
      expect(id).not.toMatch(/^gpt-6-terr?a(?:\[1m\])?$/);
      expect(id).not.toBe('gpt-6.1-sol');
    }
    for (const { id } of oldDefaults) expect(listed.models.some(m => m.id === id)).toBe(false);
  });

  it('keeps customized retired IDs and new-ID metadata, including agent selection', () => {
    const custom = { ...oldDefaults[1], label: 'My Terra', alias: 'my-terra', contextWindow: 64000 };
    const newModel = { id: 'gpt-6.1-sol[1m]', label: 'My New Sol', alias: 'new-sol', contextWindow: 128000 };
    const { result, migrated } = upgrade([custom, newModel]);
    expect(result.removedFields).not.toContain(`gateway.models[${custom.id}]`);
    expect(migrated.gateway.models).toContainEqual(custom);
    expect(migrated.gateway.models).toContainEqual(newModel);
    expect(migrated.agents[0].claude.model).toBe(custom.id);
  });

  it('preserves customized new-ID metadata on a later template upgrade', () => {
    const customized = { id: 'gpt-6.1-sol[1m]', label: 'Private Sol', alias: 'private-sol', contextWindow: 1000000 };
    const configPath = path.join(dir, 'later-config.json');
    const laterTemplatePath = path.join(dir, 'later-template.json');
    const laterTemplate = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    laterTemplate.configVersion = '1.0.39';
    fs.writeFileSync(laterTemplatePath, JSON.stringify(laterTemplate));
    fs.writeFileSync(configPath, JSON.stringify({ configVersion: '1.0.38', gateway: { models: [customized] } }));
    migrateConfig(configPath, laterTemplatePath, '1.0.39');
    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(migrated.gateway.models.find((m: { id: string }) => m.id === customized.id)).toEqual(customized);
  });

  it('keeps a customized duplicate when a shipped row has the same retired ID', () => {
    const custom = { ...oldDefaults[0], label: 'Private Sol', alias: 'private-sol' };
    const { migrated } = upgrade([oldDefaults[0], custom], oldDefaults[0].id);
    expect(migrated.gateway.models.filter((m: { id: string }) => m.id === custom.id)).toEqual([custom]);
    expect(migrated.agents[0].claude.model).toBe(custom.id);
  });

  it.each([
    ['gpt-5.6-sol[1m]', 'gpt-6.1-sol[1m]'],
    ['gpt-5.6-terra[1m]', 'gpt-6.1-sol[1m]'],
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
