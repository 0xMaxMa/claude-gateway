import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inspectStartup, repairStartup } from '../../src/cli/startup-diagnostics';

describe('offline startup diagnosis and repair', () => {
  let dir: string, file: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-')); file = path.join(dir, 'config.json'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = (dir: string) => ({ gateway: { logDir: path.join(dir, 'logs'), api: { keys: [{ key: 'secret-never-print' }] } }, agents: [{ id: 'assistant' }] });
  it('plain inspection is read-only and does not leak malformed JSON', () => {
    fs.writeFileSync(file, '{"secret":"secret-never-print",broken', { mode: 0o644 });
    const before = fs.readFileSync(file);
    expect(inspectStartup(file)).toEqual([expect.objectContaining({ name: 'configFile', ok: false })]);
    expect(JSON.stringify(inspectStartup(file))).not.toContain('secret-never-print');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });
  it('fixes BOM and owner permissions with private backups, preserving every value', () => {
    const original = '\ufeff' + JSON.stringify(config(dir));
    fs.writeFileSync(file, original, { mode: 0o644 });
    expect(inspectStartup(file)[0].ok).toBe(false);
    expect(repairStartup(file).every(check => check.ok)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(config(dir));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const backups = fs.readdirSync(dir).filter(name => name.endsWith('.bak'));
    expect(backups.length).toBeGreaterThan(0);
    for (const backup of backups) {
      expect(fs.statSync(path.join(dir, backup)).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(path.join(dir, backup), 'utf8')).toBe(original);
    }
    expect(inspectStartup(file).every(check => check.ok)).toBe(true);
    const names = fs.readdirSync(dir);
    expect(repairStartup(file)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(names);
  });
  it.each([0o200, 0o000])('repairs unreadable owner config mode %s without changing content', mode => {
    if (process.platform !== 'linux' && mode === 0) return;
    const original = JSON.stringify(config(dir));
    fs.writeFileSync(file, original);
    fs.chmodSync(file, mode);
    try {
      expect(repairStartup(file).every(check => check.ok)).toBe(true);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      const backups = fs.readdirSync(dir).filter(name => name.endsWith('.bak'));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).toBe(original);
      expect(fs.statSync(path.join(dir, backups[0])).mode & 0o777).toBe(0o600);
    } finally { fs.chmodSync(file, 0o600); }
  });
  it('does not rewrite invalid JSON or invent credentials', () => {
    fs.writeFileSync(file, '{broken', { mode: 0o600 });
    expect(repairStartup(file).some(check => !check.ok)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });
  it('refuses config symlinks', () => {
    const target = path.join(dir, 'other'); fs.writeFileSync(target, JSON.stringify(config(dir)), { mode: 0o644 }); fs.symlinkSync(target, file);
    expect(repairStartup(file)[0].ok).toBe(false);
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  });
  it('does not repair an unreadable symlink target', () => {
    const target = path.join(dir, 'other');
    fs.writeFileSync(target, JSON.stringify(config(dir)));
    fs.chmodSync(target, 0o200);
    fs.symlinkSync(target, file);
    try {
      expect(repairStartup(file).some(check => !check.ok)).toBe(true);
      expect(fs.statSync(target).mode & 0o777).toBe(0o200);
    } finally { fs.chmodSync(target, 0o600); }
  });
  it('does not chmod a replacement symlink during unreadable-config recovery', () => {
    if (process.platform !== 'linux' || process.getuid?.() === 0) return;
    const target = path.join(dir, 'replacement');
    fs.writeFileSync(target, 'unrelated', { mode: 0o644 });
    fs.writeFileSync(file, JSON.stringify(config(dir)));
    fs.chmodSync(file, 0o000);
    const chmod = fs.chmodSync;
    const spy = jest.spyOn(require('fs') as typeof fs, 'chmodSync').mockImplementation((name, mode) => {
      if (String(name).startsWith('/proc/self/fd/')) {
        fs.renameSync(file, path.join(dir, 'original'));
        fs.symlinkSync(target, file);
      }
      chmod(name, mode);
    });
    try {
      expect(repairStartup(file)).toContainEqual(expect.objectContaining({ ok: false, detail: expect.stringContaining('CONFIG_CHANGED_RETRY') }));
      expect(fs.statSync(target).mode & 0o777).toBe(0o644);
      expect(fs.readFileSync(target, 'utf8')).toBe('unrelated');
    } finally { spy.mockRestore(); }
  });
  it('refuses a foreign-owned descriptor before restoring read access', () => {
    fs.writeFileSync(file, JSON.stringify(config(dir)));
    fs.chmodSync(file, 0o200);
    const original = fs.fstatSync;
    const spy = jest.spyOn(require('fs') as typeof fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = original(fd);
      return Object.assign(stat, { uid: (process.getuid?.() ?? 0) + 1 });
    }) as typeof fs.fstatSync);
    try {
      expect(repairStartup(file).some(check => !check.ok)).toBe(true);
      expect(fs.statSync(file).mode & 0o777).toBe(0o200);
    } finally { spy.mockRestore(); fs.chmodSync(file, 0o600); }
  });
  it('reports only known startup signatures, never raw logs', () => {
    fs.writeFileSync(file, JSON.stringify(config(dir)), { mode: 0o600 }); fs.mkdirSync(path.join(dir, 'logs'));
    fs.writeFileSync(path.join(dir, 'logs', 'gateway.log'), 'secret-never-print EADDRINUSE token=password');
    const checks = inspectStartup(file);
    expect(checks).toContainEqual(expect.objectContaining({ name: 'recentStartupLog', info: true, detail: expect.stringContaining('Port already in use') }));
    expect(JSON.stringify(checks)).not.toMatch(/secret-never-print|password/);
  });
  it('preserves a concurrent config edit during BOM repair', () => {
    fs.writeFileSync(file, '\ufeff' + JSON.stringify(config(dir)), { mode: 0o600 });
    const changed = JSON.stringify({ ...config(dir), userEdit: true });
    const write = fs.writeFileSync;
    const spy = jest.spyOn(require('fs') as typeof fs, 'writeFileSync').mockImplementation((name, data, options) => {
      write(name, data, options);
      if (String(name).endsWith('.tmp')) write(file, changed);
    });
    try {
      expect(repairStartup(file)).toContainEqual(expect.objectContaining({ ok: false, detail: expect.stringContaining('CONFIG_CHANGED_RETRY') }));
      expect(fs.readFileSync(file, 'utf8')).toBe(changed);
    } finally { spy.mockRestore(); }
  });
  it('resolves logDir env vars and never creates literal unresolved paths', () => {
    const previous = process.env.DOCTOR_TEST_LOG_DIR;
    try {
      const raw = { ...config(dir), gateway: { logDir: '${DOCTOR_TEST_LOG_DIR}' } };
      fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
      delete process.env.DOCTOR_TEST_LOG_DIR;
      expect(repairStartup(file)).toContainEqual(expect.objectContaining({ ok: false, detail: expect.stringContaining('UNRESOLVED_LOG_DIR_ENV') }));
      process.env.DOCTOR_TEST_LOG_DIR = path.join(dir, 'actual-logs');
      expect(repairStartup(file).every(check => check.ok)).toBe(true);
      expect(fs.statSync(process.env.DOCTOR_TEST_LOG_DIR).isDirectory()).toBe(true);
    } finally { if (previous === undefined) delete process.env.DOCTOR_TEST_LOG_DIR; else process.env.DOCTOR_TEST_LOG_DIR = previous; }
  });

});
