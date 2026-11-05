import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { overlaps, parseEntryName, parseRelPath, resolveInside } from '../../src/files/paths';

describe('parseEntryName', () => {
  it.each(['app', 'my-app_1.2', 'A', 'a'.repeat(64)])('accepts %p', (name) => {
    expect(parseEntryName(name)).toEqual({ ok: true, value: name });
  });

  it.each(['../x', 'a/b', '.', '..', 'a'.repeat(65), '', '.hidden', '-x', 'a b', 'a\\b', 'a\0b', 42, undefined])(
    'rejects %p',
    (name) => {
      expect(parseEntryName(name)).toEqual({ ok: false, error: 'invalid_name' });
    },
  );
});

describe('parseRelPath', () => {
  it('allows dot-prefixed segments only when the delete route opts in', () => {
    expect(parseRelPath('site/.venv')).toEqual({ ok: false, error: 'invalid_name' });
    expect(parseRelPath('site/.venv', true)).toEqual({ ok: true, value: 'site/.venv' });
    for (const name of ['.', '..', '.deleting-old', 'site/.deleting-old', 'site/../x']) {
      expect(parseRelPath(name, true)).toEqual({ ok: false, error: 'invalid_name' });
    }
  });

  it.each(['', 'app', 'app/node_modules', 'a/b.c/d-e_f', Array(32).fill('a').join('/')])('accepts %p', (rel) => {
    expect(parseRelPath(rel)).toEqual({ ok: true, value: rel });
  });

  it.each(['/etc', 'app/', '/', 'a//b', Array(33).fill('a').join('/'), 42, null, undefined, ['app'], { path: 'app' }])(
    'refuses %p as invalid_path',
    (rel) => {
      expect(parseRelPath(rel)).toEqual({ ok: false, error: 'invalid_path' });
    },
  );

  it.each(['..', '../x', 'app/..', 'app/../../etc', '.', 'app/./x', 'app/.git', 'app/.deleting-x', '%2e%2e', 'a\\b', 'a b/c', 'app/a\0b'])(
    'refuses %p as invalid_name, so no segment can climb out or reach a dot entry',
    (rel) => {
      expect(parseRelPath(rel)).toEqual({ ok: false, error: 'invalid_name' });
    },
  );
});

describe('overlaps', () => {
  it.each([
    ['/r/app', '/r/app', true],
    ['/r/app', '/r/app/node_modules', true],
    ['/r/app/node_modules', '/r/app', true],
    ['/r/app', '/r/app2', false],
    ['/r/app', '/r/other', false],
  ])('%s and %s: %s', (a, b, want) => {
    expect(overlaps(a, b)).toBe(want);
  });
});

describe('resolveInside', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-paths-')));
    fs.mkdirSync(path.join(root, 'proj'));
    fs.writeFileSync(path.join(root, 'proj', 'a.txt'), 'a');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns the real path of a target inside the root', async () => {
    expect(await resolveInside(root, 'proj/a.txt')).toEqual({ ok: true, value: path.join(root, 'proj', 'a.txt') });
    expect(await resolveInside(root, '')).toEqual({ ok: true, value: root });
  });

  it('refuses a symlink whose real target is outside the root', async () => {
    fs.symlinkSync('/etc/passwd', path.join(root, 'proj', 'passwd'));
    expect(await resolveInside(root, 'proj/passwd')).toEqual({ ok: false, error: 'path_escape' });
  });

  it('refuses a sibling whose name merely shares the root as a prefix', async () => {
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling);
    try {
      fs.symlinkSync(sibling, path.join(root, 'proj', 'evil'));
      expect(await resolveInside(root, 'proj/evil')).toEqual({ ok: false, error: 'path_escape' });
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('reports a missing target as not_found', async () => {
    expect(await resolveInside(root, 'proj/nope')).toEqual({ ok: false, error: 'not_found' });
  });
});
