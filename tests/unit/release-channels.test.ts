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

  it('a tag push publishes to the latest dist-tag', () => {
    const publishCommands = release.match(/npm publish[^\n]*/g) ?? [];
    expect(publishCommands.length).toBeGreaterThan(0);
    for (const command of publishCommands) {
      expect(command).not.toMatch(/--tag/);
    }
    expect(release).not.toMatch(/prerelease: true/);
  });

  it('promotion moves only the stable dist-tag', () => {
    const distTagCommands = promote.match(/npm dist-tag add[^\n]*/g) ?? [];
    expect(distTagCommands).toEqual(['npm dist-tag add "@0xmaxma/claude-gateway@$VERSION" stable']);
  });

  it('promotion runs the preflight checks before touching the dist-tag', () => {
    const checkIndex = promote.indexOf('scripts/release/promote-check.sh');
    const distTagIndex = promote.indexOf('npm dist-tag add');
    expect(checkIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeLessThan(distTagIndex);
  });
});

/** Fake `npm` and `gh` on PATH. npm answers from env; gh records its arguments to $GH_LOG. */
function makeFakeBin(): string {
  const binDir = mkdtempSync(join(tmpdir(), 'promote-'));
  const fakeNpm = join(binDir, 'npm');
  writeFileSync(
    fakeNpm,
    [
      '#!/usr/bin/env bash',
      'case "$*" in',
      '  *" version") echo "$FAKE_PUBLISHED" ;;',
      '  *"time --json") echo "$FAKE_TIMES" ;;',
      '  *"dist-tags --json") echo "$FAKE_TAGS" ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  const fakeGh = join(binDir, 'gh');
  writeFileSync(fakeGh, '#!/usr/bin/env bash\necho "$*" >>"$GH_LOG"\n');
  chmodSync(fakeNpm, 0o755);
  chmodSync(fakeGh, 0o755);
  return binDir;
}

describe('promote-check.sh', () => {
  let binDir: string;
  beforeAll(() => (binDir = makeFakeBin()));
  afterAll(() => rmSync(binDir, { recursive: true, force: true }));

  function runCheck(version: string, published: string) {
    const result = spawnSync('bash', [join(REPO_ROOT, 'scripts/release/promote-check.sh'), version], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_PUBLISHED: published },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('passes any published version, with no soak or downgrade restriction', () => {
    expect(runCheck('1.0.1', '1.0.1').status).toBe(0);
  });

  it('refuses a version that is not on npm', () => {
    const result = runCheck('1.0.9', '');
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/is not published on npm/);
  });

  it('refuses a version that is not plain x.y.z', () => {
    const result = runCheck('v1.0.1', 'v1.0.1');
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/not plain x\.y\.z/);
  });
});

describe('promote.sh', () => {
  let binDir: string;
  let ghLog: string;
  const TIMES = {
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-05T00:00:00.000Z',
    '1.0.0': '2026-01-01T00:00:00.000Z',
    '1.0.1': '2026-01-02T00:00:00.000Z',
    '1.1.0-beta.1': '2026-01-03T00:00:00.000Z',
    '1.1.0': '2026-01-04T00:00:00.000Z',
  };

  beforeEach(() => {
    binDir = makeFakeBin();
    ghLog = join(binDir, 'gh.log');
    writeFileSync(ghLog, '');
  });
  afterEach(() => rmSync(binDir, { recursive: true, force: true }));

  function runPromote(input: string, times: string = JSON.stringify(TIMES)) {
    const result = spawnSync('bash', [join(REPO_ROOT, 'scripts/promote.sh')], {
      encoding: 'utf8',
      input,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_TIMES: times,
        FAKE_TAGS: JSON.stringify({ latest: '1.1.0', stable: '1.0.1' }),
        GH_LOG: ghLog,
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, gh: readFileSync(ghLog, 'utf8') };
  }

  it('lists stable versions newest first and marks latest and stable', () => {
    const { output } = runPromote('\n');
    const listed = [...output.matchAll(/^\s+\d+\) (\S+)/gm)].map((m) => m[1]);
    expect(listed).toEqual(['1.1.0', '1.0.1', '1.0.0']);
    expect(output).toMatch(/1\) 1\.1\.0 .*← latest/);
    expect(output).toMatch(/2\) 1\.0\.1 .*← stable/);
  });

  it('dispatches the Promote workflow for the picked version', () => {
    const result = runPromote('1\ny\n');
    expect(result.status).toBe(0);
    expect(result.gh.trim()).toBe('workflow run promote.yml --ref main -f version=1.1.0');
  });

  it('can roll stable back to an older version', () => {
    const result = runPromote('3\ny\n');
    expect(result.status).toBe(0);
    expect(result.gh.trim()).toBe('workflow run promote.yml --ref main -f version=1.0.0');
  });

  it('dispatches nothing when the confirmation is declined', () => {
    const result = runPromote('1\nn\n');
    expect(result.output).toMatch(/Aborted/);
    expect(result.gh).toBe('');
  });

  it('refuses an out-of-range choice', () => {
    const result = runPromote('9\ny\n');
    expect(result.status).toBe(1);
    expect(result.gh).toBe('');
  });

  it('fails closed when npm publish times cannot be parsed', () => {
    const result = runPromote('1\ny\n', 'not json');
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/could not parse npm publish times/);
    expect(result.gh).toBe('');
  });
});
