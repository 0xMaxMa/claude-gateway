import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  captureRuntimeProvenance, isRecordedRuntimeAlive, readRuntimeProvenance, writeRuntimeProvenance,
} from '../../../src/safemode/provenance';

describe('runtime provenance', () => {
  let root: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-provenance-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.0.4' }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function initGit(): void {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n');
    git('add', '.'); git('commit', '-qm', 'initial');
  }
  function build(): void {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../../scripts/write-build-provenance.cjs'), path.join(root, 'scripts/write-build-provenance.cjs'));
    git('add', '.'); git('commit', '-qm', 'add manifest script');
    execFileSync(process.execPath, [path.join(root, 'scripts/write-build-provenance.cjs')]);
  }
  test('legacy package version is evidence, but never implies a commit', () => {
    const record = captureRuntimeProvenance({ packageRoot: root });
    expect(record.packageVersion).toBe('2.0.4');
    expect(record.build).toBeNull();
    expect(record.checkoutAtStartup).toBeNull();
    expect(record.sourceConfidence).toBe('unknown');
  });
  test('build commit remains distinct from a checkout moved after compilation', () => {
    initGit(); build();
    const compiled = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'new-file'), 'new revision');
    git('add', '.'); git('commit', '-qm', 'move checkout');
    const record = captureRuntimeProvenance({ packageRoot: root });
    expect(record.build?.commit).toBe(compiled);
    expect(record.checkoutAtStartup?.commit).toBe(git('rev-parse', 'HEAD'));
    expect(record.checkoutAtStartup?.commit).not.toBe(compiled);
    expect(record.sourceConfidence).toBe('exact-build');
    fs.writeFileSync(path.join(root, 'new-file'), 'uncommitted edits');
    expect(captureRuntimeProvenance({ packageRoot: root }).checkoutAtStartup?.dirty).toBe(true);
    expect(record.checkoutAtStartup?.dirty).toBe(false);
  });
  test('release installation retains build evidence without a checkout', () => {
    initGit(); build();
    const commit = git('rev-parse', 'HEAD');
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    const record = captureRuntimeProvenance({ packageRoot: root });
    expect(record.installKind).toBe('package');
    expect(record.checkoutAtStartup).toBeNull();
    expect(record.build?.commit).toBe(commit);
    expect(record.sourceConfidence).toBe('exact-build');
  });
  test('dirty build and mismatched release cannot claim an exact source match', () => {
    initGit(); build();
    fs.writeFileSync(path.join(root, 'new-file'), 'uncommitted edits');
    execFileSync(process.execPath, [path.join(root, 'scripts/write-build-provenance.cjs')]);
    expect(captureRuntimeProvenance({ packageRoot: root }).sourceConfidence).toBe('modified-build');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.0.0' }));
    expect(captureRuntimeProvenance({ packageRoot: root }).sourceConfidence).toBe('unknown');
  });
  test('record atomically replaces a permissive old file and rejects corrupt data', () => {
    const record = captureRuntimeProvenance({ packageRoot: root });
    const file = path.join(root, 'state/runtime-provenance.json');
    fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, '{}', { mode: 0o644 });
    writeRuntimeProvenance(record, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readRuntimeProvenance(file)).toEqual(record);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['runtime-provenance.json']);
    fs.writeFileSync(file, '{broken'); expect(readRuntimeProvenance(file)).toBeNull();
  });
  test('PID alone is insufficient to identify the recorded live runtime', () => {
    const record = captureRuntimeProvenance({ packageRoot: root });
    if (process.platform === 'linux') expect(isRecordedRuntimeAlive(record)).toBe(true);
    expect(isRecordedRuntimeAlive({ ...record, processStartTicks: 'not-the-current-process' })).toBe(false);
    expect(isRecordedRuntimeAlive({ ...record, processStartTicks: null })).toBe(false);
  });
});
