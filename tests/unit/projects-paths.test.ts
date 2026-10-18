import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseProjectName, resolveInside } from '../../src/projects/paths';

describe('parseProjectName', () => {
  it.each(['app', 'my-app_1.2', 'A', 'a'.repeat(64)])('accepts %p', (name) => {
    expect(parseProjectName(name)).toEqual({ ok: true, value: name });
  });

  it.each(['../x', 'a/b', '.', '..', 'a'.repeat(65), '', '.hidden', '-x', 'a b', 'a\\b', 'a\0b', 42, undefined])(
    'rejects %p',
    (name) => {
      expect(parseProjectName(name)).toEqual({ ok: false, error: 'invalid_name' });
    },
  );
});

describe('resolveInside', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-paths-')));
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
