import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  detectMigration,
  applyMigration,
  loadCleanTemplate,
  stripIgnoredPaths,
  BIND_PRESERVED_WARNING,
  compareSemver,
} from '../../src/config/migrator';

/**
 * Real-artifact upgrade tests for gateway.bind (Issue #204).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The unit tests in config-migrator.test.ts build a *hand-written mirror* of
 * config.template.json. That mirror can silently drift from the real template
 * (e.g. someone bumps configVersion or changes the shipped bind default), so a
 * green suite did NOT prove the real upgrade works — v1.3.29 shipped a broken
 * migration that every unit test passed. These tests close that gap by driving
 * the migration exactly like src/index.ts main() does:
 *
 *   - the ACTUAL repo config.template.json (not a stub), and
 *   - a REAL config.json captured from the published v1.3.25 package
 *     (tests/fixtures/configs/baseline-v1.3.25.json).
 *
 * If the real template or the migrator regresses the bind-preservation ordering,
 * scenario A goes red — before release, not in production.
 */

// The real files that ship to users.
const REAL_TEMPLATE = path.join(__dirname, '..', '..', 'config.template.json');
const V1325_BASELINE = path.join(
  __dirname,
  '..',
  'fixtures',
  'configs',
  'baseline-v1.3.25.json',
);

const templateVersion = (): string =>
  JSON.parse(fs.readFileSync(REAL_TEMPLATE, 'utf-8')).configVersion as string;

/** Drive the migration the same way src/index.ts main() does on startup. */
function runRealUpgrade(configPath: string): {
  needed: boolean;
  addedFields: string[];
  warnings: string[];
} {
  const tv = templateVersion();
  const detection = detectMigration(configPath, REAL_TEMPLATE, tv);
  if (!detection.needed) {
    return { needed: false, addedFields: [], warnings: [] };
  }
  const { ignorePaths, removePaths } = loadCleanTemplate(REAL_TEMPLATE);
  const result = applyMigration(
    configPath,
    detection.config,
    detection.template,
    tv,
    ignorePaths,
    removePaths,
  );
  return { needed: true, addedFields: result.addedFields, warnings: result.warnings };
}

describe('config migration — real v1.3.25 -> current upgrade (Issue #204)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-upgrade-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(data: unknown): string {
    const p = path.join(tmpDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
    return p;
  }

  /** Reproduce a fresh install: create-agent copies the template minus ignorePaths. */
  function freshInstallConfig(): string {
    const { template, ignorePaths } = loadCleanTemplate(REAL_TEMPLATE);
    stripIgnoredPaths(template, ignorePaths);
    (template as Record<string, unknown>).agents = [];
    const p = path.join(tmpDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify(template, null, 2), 'utf-8');
    return p;
  }

  // Sanity: the fixture is a genuine pre-1.0.13 config with no bind key. If this
  // ever fails, the fixture was mangled and the upgrade tests below are meaningless.
  it('the v1.3.25 baseline fixture is pre-localhost-default and never set bind', () => {
    const baseline = JSON.parse(fs.readFileSync(V1325_BASELINE, 'utf-8'));
    expect(baseline.configVersion).toBe('1.0.11');
    expect('bind' in baseline.gateway).toBe(false);
  });

  // A) The regression that bit prod three times: an upgrading user from v1.3.25
  //    must keep external access. Bound to the REAL template, so a migrator
  //    ordering regression (deepMerge before preserve) makes this go red.
  it('A) real v1.3.25 config upgrades to gateway.bind = "0.0.0.0" with a warning', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.copyFileSync(V1325_BASELINE, configPath);

    const result = runRealUpgrade(configPath);

    expect(result.needed).toBe(true);
    expect(result.addedFields).toContain('gateway.bind');
    expect(result.warnings).toContain(BIND_PRESERVED_WARNING);

    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(migrated.gateway.bind).toBe('0.0.0.0');
    expect(migrated.configVersion).toBe(templateVersion());
  });

  // B) A brand-new install must NOT be forced open — it keeps the secure
  //    localhost default shipped in the real template.
  it('B) a fresh install keeps gateway.bind = "127.0.0.1" and needs no migration', () => {
    const configPath = freshInstallConfig();

    const result = runRealUpgrade(configPath);

    expect(result.needed).toBe(false);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.gateway.bind).toBe('127.0.0.1');
  });

  // C) An ancient config with no configVersion at all is also pre-default.
  it('C) a config with no configVersion and no bind upgrades to "0.0.0.0"', () => {
    const configPath = writeConfig({ gateway: { logDir: '/logs' }, agents: [] });

    const result = runRealUpgrade(configPath);

    expect(result.warnings).toContain(BIND_PRESERVED_WARNING);
    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(migrated.gateway.bind).toBe('0.0.0.0');
  });

  // D) Documents the known limitation the user hit: a config already "poisoned"
  //    by a broken intermediate build (bind persisted + configVersion already at
  //    the template version) is NOT auto-repaired — no migration runs, and the
  //    migrator must never override a bind the user might have set on purpose.
  //    Such configs need a one-line manual fix (set bind to "0.0.0.0").
  it('D) an already-migrated config with a persisted bind is left untouched', () => {
    const configPath = writeConfig({
      configVersion: templateVersion(),
      gateway: { bind: '127.0.0.1', logDir: '/logs' },
      agents: [],
    });

    const result = runRealUpgrade(configPath);

    expect(result.needed).toBe(false);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.gateway.bind).toBe('127.0.0.1');
  });

  // E) An explicit localhost choice on an old config is honoured, not clobbered.
  it('E) an explicit bind on a pre-1.0.13 config is preserved, not overwritten', () => {
    const configPath = writeConfig({
      configVersion: '1.0.11',
      gateway: { bind: '127.0.0.1', logDir: '/logs' },
      agents: [],
    });

    const result = runRealUpgrade(configPath);

    expect(result.warnings).not.toContain(BIND_PRESERVED_WARNING);
    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(migrated.gateway.bind).toBe('127.0.0.1');
  });

  // F) The exact field report: a config stamped at the PREVIOUS template
  //    version (1.0.13) with no bind key was stuck on the 127.0.0.1 runtime
  //    default because migration either did not run or was version-gated out.
  //    With the current template ahead of it, the upgrade must now reach it and
  //    pin 0.0.0.0. Uses the literal 1.0.13 (the version that shipped the
  //    localhost default) rather than templateVersion() so the regression stays
  //    pinned to the real broken value even after future version bumps.
  it('F) a 1.0.13 config with no bind key upgrades to "0.0.0.0"', () => {
    // Guard: this scenario is only meaningful while the template is ahead of
    // 1.0.13, otherwise no migration runs and there is nothing to assert.
    expect(templateVersion()).not.toBe('1.0.13');
    const configPath = writeConfig({
      configVersion: '1.0.13',
      gateway: { logDir: '/logs' },
      agents: [],
    });

    const result = runRealUpgrade(configPath);

    expect(result.needed).toBe(true);
    expect(result.warnings).toContain(BIND_PRESERVED_WARNING);
    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(migrated.gateway.bind).toBe('0.0.0.0');
  });
});

/**
 * Real-artifact upgrade tests for Opus 5 support.
 *
 * An existing install pins its own gateway.models list in config.json (it
 * overrides DEFAULT_MODELS), so shipping Opus 5 only in the code registry would
 * never reach upgrading users. migrateModels() merges the template's models by
 * id on migration — but that only runs when the template configVersion is ahead
 * of the user's. These tests drive the REAL template exactly like src/index.ts,
 * so if someone adds Opus 5 to the registry but forgets to bump configVersion
 * (or forgets the template entry), the upgrade goes red here — before release.
 */
describe('config migration — Opus 5 support reaches existing installs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus5-upgrade-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const tv = (): string =>
    JSON.parse(fs.readFileSync(REAL_TEMPLATE, 'utf-8')).configVersion as string;

  /** A realistic pre-Opus-5 install: bind already set (so bind isn't the trigger),
   *  a models list where `opus` still points at 4.8, plus a custom BYOK model. */
  function writePreOpus5Config(): string {
    const p = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          configVersion: '1.0.14',
          gateway: {
            bind: '0.0.0.0',
            models: [
              { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)', alias: 'opus[1m]', contextWindow: 1000000 },
              { id: 'claude-opus-4-8', label: 'Opus 4.8', alias: 'opus', contextWindow: 200000 },
              { id: 'claude-sonnet-5', label: 'Sonnet 5', alias: 'sonnet', contextWindow: 200000 },
              { id: 'openrouter/custom-model', label: 'My BYOK', alias: 'mine', contextWindow: 128000 },
            ],
          },
          agents: [],
        },
        null,
        2,
      ),
      'utf-8',
    );
    return p;
  }

  function runRealUpgrade(configPath: string) {
    const version = tv();
    const detection = detectMigration(configPath, REAL_TEMPLATE, version);
    if (!detection.needed) return { needed: false, addedFields: [] as string[] };
    const { ignorePaths, removePaths } = loadCleanTemplate(REAL_TEMPLATE);
    const result = applyMigration(
      configPath,
      detection.config,
      detection.template,
      version,
      ignorePaths,
      removePaths,
    );
    return { needed: true, addedFields: result.addedFields };
  }

  // Guard: the whole point is that the template is ahead of the fixture so a
  // migration runs. If the template ever drops back to 1.0.14 this is moot.
  it('the real template is ahead of the pre-Opus-5 fixture (migration will run)', () => {
    expect(tv()).not.toBe('1.0.14');
  });

  it('adds both Opus 5 variants to an existing install on upgrade', () => {
    const configPath = writePreOpus5Config();

    const result = runRealUpgrade(configPath);

    expect(result.needed).toBe(true);
    expect(result.addedFields).toContain('gateway.models[claude-opus-5]');
    expect(result.addedFields).toContain('gateway.models[claude-opus-5[1m]]');

    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const ids = migrated.gateway.models.map((m: { id: string }) => m.id);
    expect(ids).toContain('claude-opus-5');
    expect(ids).toContain('claude-opus-5[1m]');
  });

  it('repoints the bare `opus` aliases to Opus 5 and demotes 4.8 to `opus48`', () => {
    const configPath = writePreOpus5Config();
    runRealUpgrade(configPath);

    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const byAlias = (a: string) =>
      migrated.gateway.models.find((m: { alias: string }) => m.alias === a)?.id;

    expect(byAlias('opus')).toBe('claude-opus-5');
    expect(byAlias('opus[1m]')).toBe('claude-opus-5[1m]');
    expect(byAlias('opus48')).toBe('claude-opus-4-8');
    expect(byAlias('opus48[1m]')).toBe('claude-opus-4-8[1m]');
  });

  it('gives Opus 5 the correct context windows (1M variant not defaulted to 200k)', () => {
    const configPath = writePreOpus5Config();
    runRealUpgrade(configPath);

    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const ctx = (id: string) =>
      migrated.gateway.models.find((m: { id: string }) => m.id === id)?.contextWindow;

    expect(ctx('claude-opus-5[1m]')).toBe(1000000);
    expect(ctx('claude-opus-5')).toBe(200000);
  });

  it('preserves a user BYOK model that is not in the template', () => {
    const configPath = writePreOpus5Config();
    runRealUpgrade(configPath);

    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const custom = migrated.gateway.models.find(
      (m: { id: string }) => m.id === 'openrouter/custom-model',
    );
    expect(custom).toBeDefined();
    expect(custom.alias).toBe('mine');
  });
});

/**
 * Existing installs persist their own gateway.models list. The version bump is
 * therefore part of the feature: without it, migrateModels() is never reached.
 */
describe('config migration — GPT models reach existing installs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-model-upgrade-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePreGptConfig(): string {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          configVersion: '1.0.29',
          gateway: {
            bind: '0.0.0.0',
            models: [
              { id: 'gpt-5.6-terra', label: 'Old GPT Terra', alias: 'oldterra', contextWindow: 1000000 },
              { id: 'openrouter/custom-model', label: 'My BYOK', alias: 'mine', contextWindow: 128000 },
            ],
          },
          agents: [
            {
              id: 'legacy-gpt-agent',
              claude: { model: 'gpt-5.6-terra', extraFlags: [] },
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );
    return configPath;
  }

  it('uses a template version newer than the pre-GPT registry', () => {
    expect(compareSemver(templateVersion(), '1.0.29')).toBeGreaterThan(0);
  });

  it('adds missing GPT models and corrects metadata for an existing GPT entry', () => {
    const configPath = writePreGptConfig();

    const result = runRealUpgrade(configPath);

    expect(result.needed).toBe(true);
    expect(result.addedFields).toContain('gateway.models[gpt-5.6-sol[1m]]');
    expect(result.addedFields).not.toContain('gateway.models[gpt-5.6-terra[1m]]');
    expect(result.addedFields).toContain('gateway.models[gpt-5.6-luna[1m]]');
    expect(result.addedFields).toContain('gateway.models[gpt-5.5[1m]]');

    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(migrated.configVersion).toBe(templateVersion());
    expect(migrated.gateway.models).toContainEqual({
      id: 'gpt-5.6-terra[1m]',
      label: 'GPT 5.6 Terra',
      alias: 'gpt56terra',
      contextWindow: 1050000,
    });
    expect(migrated.gateway.models.some((model: { id: string }) => model.id === 'gpt-5.6-terra')).toBe(false);
    expect(migrated.agents[0].claude.model).toBe('gpt-5.6-terra[1m]');
  });

  it('preserves a user-owned model that is not in the template', () => {
    const configPath = writePreGptConfig();
    runRealUpgrade(configPath);

    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(migrated.gateway.models).toContainEqual({
      id: 'openrouter/custom-model',
      label: 'My BYOK',
      alias: 'mine',
      contextWindow: 128000,
    });
  });
});

/**
 * Fable 5.1 reaches existing installs.
 *
 * Same shape as the GPT block above, and for the same reason: an install that
 * already pins its own gateway.models list never sees a model added only to
 * DEFAULT_MODELS. The template entry AND the configVersion bump are both part
 * of the feature — migrateModels() only runs when the template version is
 * ahead of the user's, so forgetting the bump ships a model nobody receives.
 *
 * The pre-Fable-5.1 fixture pins configVersion 1.0.30, the version immediately
 * before this change: that makes the first test fail if the bump is reverted,
 * rather than passing on the slack left by some older bump.
 */
describe('config migration — Fable 5.1 reaches existing installs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable51-upgrade-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A realistic pre-Fable-5.1 install: bind already set (so bind isn't the
   *  migration trigger), the previous Fable rows, plus a custom BYOK model. */
  function writePreFable51Config(): string {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          configVersion: '1.0.30',
          gateway: {
            bind: '0.0.0.0',
            models: [
              { id: 'claude-fable-5[1m]', label: 'Fable 5 (1M)', alias: 'fable[1m]', contextWindow: 1000000 },
              { id: 'claude-fable-5', label: 'Fable 5', alias: 'fable', contextWindow: 200000 },
              { id: 'openrouter/custom-model', label: 'My BYOK', alias: 'mine', contextWindow: 128000 },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    return configPath;
  }

  it('uses a template version newer than the pre-Fable-5.1 registry', () => {
    expect(compareSemver(templateVersion(), '1.0.30')).toBeGreaterThan(0);
  });

  it('adds both Fable 5.1 variants with the right aliases and windows', () => {
    const configPath = writePreFable51Config();

    const result = runRealUpgrade(configPath);

    expect(result.needed).toBe(true);
    expect(result.addedFields).toContain('gateway.models[claude-fable-5-1]');
    expect(result.addedFields).toContain('gateway.models[claude-fable-5-1[1m]]');

    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(migrated.configVersion).toBe(templateVersion());
    expect(migrated.gateway.models).toContainEqual({
      id: 'claude-fable-5-1',
      label: 'Fable 5.1',
      alias: 'fable',
      contextWindow: 200000,
    });
    expect(migrated.gateway.models).toContainEqual({
      id: 'claude-fable-5-1[1m]',
      label: 'Fable 5.1 (1M)',
      alias: 'fable[1m]',
      contextWindow: 1000000,
    });
  });

  /**
   * The upgrade repoints `fable` from Fable 5 to Fable 5.1, so an existing
   * install's own claude-fable-5 row — which stores alias `fable` — has to be
   * rewritten to `fable5`. If it were merely left alone, the migrated config
   * would carry two rows both claiming `fable`, and /model fable would resolve
   * to whichever came first. This is the guard for that.
   */
  it('rewrites the existing Fable 5 rows to the demoted `fable5` alias', () => {
    const configPath = writePreFable51Config();
    runRealUpgrade(configPath);

    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const byAlias = (alias: string) =>
      migrated.gateway.models.find((m: { alias: string }) => m.alias === alias);
    const byId = (id: string) =>
      migrated.gateway.models.find((m: { id: string }) => m.id === id);

    expect(byId('claude-fable-5')?.alias).toBe('fable5');
    expect(byId('claude-fable-5[1m]')?.alias).toBe('fable5[1m]');
    expect(byAlias('fable')?.id).toBe('claude-fable-5-1');
    expect(byAlias('fable[1m]')?.id).toBe('claude-fable-5-1[1m]');

    const aliases = migrated.gateway.models.map((m: { alias: string }) => m.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('preserves a user-owned model that is not in the template', () => {
    const configPath = writePreFable51Config();
    runRealUpgrade(configPath);

    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(migrated.gateway.models).toContainEqual({
      id: 'openrouter/custom-model',
      label: 'My BYOK',
      alias: 'mine',
      contextWindow: 128000,
    });
  });
});
