import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

describe('release channels', () => {
  const release = readRepoFile('.github/workflows/release.yml');
  const promote = readRepoFile('.github/workflows/promote.yml');

  it('a tag push never moves the latest dist-tag', () => {
    const publishCommands = release.match(/npm publish[^\n]*/g) ?? [];
    expect(publishCommands.length).toBeGreaterThan(0);
    for (const command of publishCommands) {
      expect(command).toMatch(/--tag next(\s|$)/);
    }
  });

  it('a tag push never marks its GitHub Release as the latest release', () => {
    const start = release.indexOf('softprops/action-gh-release');
    expect(start).toBeGreaterThan(-1);
    const end = release.indexOf('- name:', start);
    const ghReleaseStep = release.slice(start, end === -1 ? undefined : end);
    expect(ghReleaseStep).toMatch(/^\s+prerelease: true$/m);
  });

  it('promotion moves the latest dist-tag', () => {
    expect(promote).toMatch(/npm dist-tag add "@0xmaxma\/claude-gateway@\$VERSION" latest/);
  });

  it('promotion runs the preflight checks before touching the latest dist-tag', () => {
    const checkIndex = promote.indexOf('scripts/release/promote-check.sh');
    const distTagIndex = promote.indexOf('npm dist-tag add');
    expect(checkIndex).toBeGreaterThan(-1);
    expect(distTagIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeLessThan(distTagIndex);
  });
});

describe('promote-check.sh', () => {
  const HOUR_MS = 3_600_000;
  let binDir: string;

  beforeAll(() => {
    // Stand-in for the three npm view calls the script makes; answers come from env.
    binDir = mkdtempSync(join(tmpdir(), 'promote-check-'));
    const fakeNpm = join(binDir, 'npm');
    writeFileSync(
      fakeNpm,
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *" version") echo "$FAKE_PUBLISHED" ;;',
        '  *dist-tags.latest) echo "$FAKE_LATEST" ;;',
        '  *"time --json") echo "$FAKE_TIMES" ;;',
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(fakeNpm, 0o755);
  });

  afterAll(() => rmSync(binDir, { recursive: true, force: true }));

  function hoursAgo(hours: number): string {
    return new Date(Date.now() - hours * HOUR_MS).toISOString();
  }

  function runCheck(version: string, times: Record<string, string>) {
    const result = spawnSync('bash', [join(REPO_ROOT, 'scripts/release/promote-check.sh'), version], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_PUBLISHED: version,
        FAKE_LATEST: '1.0.0',
        FAKE_TIMES: JSON.stringify(times),
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('passes a version that soaked for over 24 hours with no follow-up', () => {
    const result = runCheck('1.0.1', { created: hoursAgo(1000), '1.0.0': hoursAgo(900), '1.0.1': hoursAgo(30) });
    expect(result.output).toContain('soaked on next');
    expect(result.status).toBe(0);
  });

  it('refuses a version published less than 24 hours ago', () => {
    const result = runCheck('1.0.1', { '1.0.0': hoursAgo(900), '1.0.1': hoursAgo(2) });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/must soak on next for at least 24h/);
  });

  it('refuses a version followed by a fix within 24 hours', () => {
    const result = runCheck('1.0.1', { '1.0.0': hoursAgo(900), '1.0.1': hoursAgo(30), '1.0.2': hoursAgo(20) });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/follow-up release within 24h of 1\.0\.1: 1\.0\.2/);
  });

  it('fails closed when a publish time cannot be parsed', () => {
    const result = runCheck('1.0.1', { '1.0.0': 'not-a-date', '1.0.1': hoursAgo(30) });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/could not parse npm publish times/);
  });
});
