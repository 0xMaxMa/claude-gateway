import { readFileSync } from 'fs';
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
