import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  detectMigration,
  applyMigration,
  loadCleanTemplate,
  stripIgnoredPaths,
  BIND_PRESERVED_WARNING,
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
});
