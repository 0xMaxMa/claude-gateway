import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ensureConfigExists } from '../../src/config/bootstrap';
import { loadConfig } from '../../src/config/loader';

const TEMPLATE_PATH = path.join(__dirname, '../../config.template.json');

describe('config-bootstrap', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-test-'));
    configPath = path.join(tmpDir, 'nested', 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates config.json with a random admin key when none exists', () => {
    const result = ensureConfigExists(configPath, TEMPLATE_PATH);

    expect(result.created).toBe(true);
    expect(result.adminKey).toBeTruthy();
    expect(result.adminKey!.length).toBeGreaterThanOrEqual(32);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('the generated config loads cleanly via loadConfig with agents: []', () => {
    const result = ensureConfigExists(configPath, TEMPLATE_PATH);
    const config = loadConfig(configPath);

    expect(config.agents).toEqual([]);
    expect(config.gateway.api?.keys).toHaveLength(1);
    expect(config.gateway.api?.keys?.[0].key).toBe(result.adminKey);
    expect(config.gateway.api?.keys?.[0].admin).toBe(true);
  });

  it('two separate bootstraps generate different admin keys', () => {
    const a = ensureConfigExists(configPath, TEMPLATE_PATH);
    fs.rmSync(configPath);
    const b = ensureConfigExists(configPath, TEMPLATE_PATH);

    expect(a.adminKey).not.toBe(b.adminKey);
  });

  it('never overwrites an existing config.json', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const existing = { gateway: { logDir: '~/x' }, agents: [{ id: 'keep-me' }] };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf-8');

    const result = ensureConfigExists(configPath, TEMPLATE_PATH);

    expect(result.created).toBe(false);
    expect(result.adminKey).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual(existing);
  });

  it('falls back to a minimal config if the template is unreadable', () => {
    const result = ensureConfigExists(configPath, path.join(tmpDir, 'does-not-exist.json'));

    expect(result.created).toBe(true);
    expect(result.adminKey).toBeTruthy();
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.agents).toEqual([]);
    expect(written.gateway.api.keys[0].key).toBe(result.adminKey);
  });

  it('writes config.json with owner-only permissions (0600)', () => {
    ensureConfigExists(configPath, TEMPLATE_PATH);

    const mode = fs.statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('loses a concurrent-first-boot race safely instead of overwriting the winner', () => {
    // Simulate a second process racing to create the same file first, after
    // this call already decided (via existsSync) that no config exists yet.
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const winner = { gateway: { logDir: '~/winner' }, agents: [] };
    fs.writeFileSync(configPath, JSON.stringify(winner), { flag: 'wx' });

    const result = ensureConfigExists(configPath, TEMPLATE_PATH);

    expect(result.created).toBe(false);
    expect(result.adminKey).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual(winner);
  });
});
