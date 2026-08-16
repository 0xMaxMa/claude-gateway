import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { detectMigration, applyMigration, loadCleanTemplate } from '../../../src/config/migrator';

/**
 * Real-artifact migration test (planning-62): a config at the previous version
 * (no `gateway.skillLearning`) must auto-migrate to the shipped template version
 * with the block injected (enabled:true) and every sibling preserved. Driven
 * against the REAL config.template.json so a version/shape drift goes red.
 */
const REAL_TEMPLATE = path.join(__dirname, '..', '..', '..', 'config.template.json');
const templateVersion = (): string => JSON.parse(fs.readFileSync(REAL_TEMPLATE, 'utf-8')).configVersion as string;

function runRealUpgrade(configPath: string) {
  const tv = templateVersion();
  const detection = detectMigration(configPath, REAL_TEMPLATE, tv);
  if (!detection.needed) return { needed: false, addedFields: [] as string[] };
  const { ignorePaths, removePaths } = loadCleanTemplate(REAL_TEMPLATE);
  const result = applyMigration(configPath, detection.config, detection.template, tv, ignorePaths, removePaths);
  return { needed: true, addedFields: result.addedFields };
}

describe('config migration — skillLearning injection (planning-62)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-migrate-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the shipped template is at >= 1.0.17 and carries skillLearning', () => {
    const tpl = JSON.parse(fs.readFileSync(REAL_TEMPLATE, 'utf-8'));
    expect(tpl.gateway.skillLearning).toBeDefined();
    expect(tpl.gateway.skillLearning.enabled).toBe(true);
    expect(tpl.gateway.skillLearning.mode).toBe('auto');
  });

  it('a pre-1.0.17 config with no skillLearning migrates with the block injected + siblings preserved', () => {
    const configPath = path.join(tmpDir, 'config.json');
    const old = {
      configVersion: '1.0.16',
      gateway: {
        logDir: '/logs',
        timezone: 'Asia/Bangkok',
        appBackup: { retention: 7 }, // a custom sibling value that must survive
      },
      agents: [],
    };
    fs.writeFileSync(configPath, JSON.stringify(old, null, 2), 'utf-8');

    const result = runRealUpgrade(configPath);
    expect(result.needed).toBe(true);
    expect(result.addedFields).toContain('gateway.skillLearning');

    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(migrated.gateway.skillLearning.enabled).toBe(true);
    expect(migrated.gateway.appBackup.retention).toBe(7); // preserved
    expect(migrated.gateway.logDir).toBe('/logs'); // preserved
    expect(migrated.configVersion).toBe(templateVersion());
  });

  it('a config that already sets skillLearning is not clobbered', () => {
    const configPath = path.join(tmpDir, 'config.json');
    const existing = {
      configVersion: '1.0.16',
      gateway: {
        logDir: '/logs',
        skillLearning: { enabled: false, mode: 'propose' }, // operator opted out
      },
      agents: [],
    };
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');

    runRealUpgrade(configPath);
    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(migrated.gateway.skillLearning.enabled).toBe(false); // user value preserved
    expect(migrated.gateway.skillLearning.mode).toBe('propose');
  });
});
