import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ensureConfigExists, firstRunNotice } from '../../src/config/bootstrap';
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

  it('creates the config directory with owner-only permissions (0700), not the 0755 default (#460)', () => {
    ensureConfigExists(configPath, TEMPLATE_PATH);

    const dirMode = fs.statSync(path.dirname(configPath)).mode & 0o777;
    expect(dirMode).toBe(0o700);
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

/**
 * The first-run notice. `ensureConfigExists` writes config.json 0600 to keep
 * the generated admin key from other local users; printing that key to stdout
 * put a second, unprotected copy in the service journal, which outlives the
 * process and is readable by anyone who can read logs.
 */
describe('firstRunNotice', () => {
  const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

  // U-CB-375a — the property that matters, asserted against the real generated
  // key rather than a placeholder.
  it('U-CB-375a: never contains the admin key', () => {
    const text = firstRunNotice('/home/u/.claude-gateway/config.json', KEY).join('\n');

    expect(text).not.toContain(KEY);
    // Nor any workable prefix of it — a long fragment is as good as the key.
    expect(text).not.toContain(KEY.slice(0, 16));
  });

  // U-CB-375b — but it must still identify which key was generated, or an
  // operator holding two of them cannot tell which one this install uses.
  it('U-CB-375b: identifies the key by its last four characters only', () => {
    const text = firstRunNotice('/home/u/.claude-gateway/config.json', KEY).join('\n');

    expect(text).toContain(`…${KEY.slice(-4)}`);
    expect(text).not.toContain(KEY.slice(-8));
  });

  it('U-CB-375c: points at the file the key actually lives in', () => {
    const text = firstRunNotice('/etc/cg/config.json', KEY).join('\n');

    expect(text).toContain('/etc/cg/config.json');
    expect(text).toContain('0600');
  });
});
