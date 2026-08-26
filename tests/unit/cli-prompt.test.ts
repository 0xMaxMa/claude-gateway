import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { editInEditor } from '../../src/cli/prompt';

jest.mock('child_process', () => ({ spawnSync: jest.fn() }));
const spawnMock = spawnSync as unknown as jest.Mock;

/**
 * The scratch file used to live at a fixed path (`/tmp/claude-gateway-AGENTS.md`)
 * written with a plain `writeFileSync`. On a shared host another local user can
 * pre-create that name as a symlink: the write lands on their target, and the
 * read-back feeds their content into the file the wizard uploads (CWE-377).
 */
describe('cli prompt editInEditor', () => {
  beforeEach(() => spawnMock.mockReset());

  it('writes into a private per-invocation directory, not a predictable path', () => {
    let seen: string | undefined;
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      seen = args[0];
      fs.writeFileSync(args[0], 'edited by the user\n');
      return {};
    });

    expect(editInEditor('original\n', 'AGENTS.md')).toBe('edited by the user\n');

    expect(seen).toBeDefined();
    expect(path.basename(seen!)).toBe('AGENTS.md');
    // Not directly in the shared temp directory — one level down, in its own dir.
    expect(path.dirname(seen!)).not.toBe(os.tmpdir());
    expect(path.dirname(path.dirname(seen!))).toBe(fs.realpathSync(os.tmpdir()));
  });

  it('creates that directory owner-only', () => {
    let dir: string | undefined;
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      dir = path.dirname(args[0]);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      return {};
    });

    editInEditor('x\n', 'AGENTS.md');
    expect(dir).toBeDefined();
  });

  it('removes the directory afterwards', () => {
    let dir: string | undefined;
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      dir = path.dirname(args[0]);
      return {};
    });

    editInEditor('x\n', 'AGENTS.md');

    expect(fs.existsSync(dir!)).toBe(false);
  });

  it('cleans up when no editor could be launched, and returns null', () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('claude-gateway-'));
    spawnMock.mockReturnValue({ error: new Error('ENOENT') });

    expect(editInEditor('x\n', 'AGENTS.md')).toBeNull();

    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('claude-gateway-'));
    expect(after).toEqual(before);
  });

  it('keeps a caller-supplied name inside the scratch directory', () => {
    let seen: string | undefined;
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      seen = args[0];
      return {};
    });

    editInEditor('x\n', '../escaped.md');

    expect(path.basename(seen!)).toBe('escaped.md');
    // `..` did not escape: the file's parent is still the scratch directory.
    expect(path.dirname(path.dirname(seen!))).toBe(fs.realpathSync(os.tmpdir()));
  });
});
