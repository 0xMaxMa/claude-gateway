import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { confirmAction, editInEditor } from '../../src/cli/prompt';

jest.mock('child_process', () => ({ spawnSync: jest.fn() }));
// `readline`'s exports are non-configurable, so `jest.spyOn` cannot replace
// `createInterface` — mock the module instead. `editInEditor` never touches it.
jest.mock('readline', () => ({ createInterface: jest.fn() }));
const spawnMock = spawnSync as unknown as jest.Mock;
const createInterfaceMock = readline.createInterface as unknown as jest.Mock;

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

/**
 * `confirmAction` was three byte-identical private copies (commands/service.ts,
 * commands/app.ts, commands/update.ts) differing only in the verb they name
 * when refusing. These pin the contract now that one shared copy answers for
 * all of them: consent is `--yes` or an interactive "y"/"yes", nothing else —
 * in particular a non-interactive stdin is a refusal, never a hang and never
 * an assumed yes.
 */
describe('cli prompt confirmAction (code-review round)', () => {
  let stderr: string[];
  let errSpy: jest.SpyInstance;
  let ttyDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    stderr = [];
    createInterfaceMock.mockReset();
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(chunk.toString());
      return true;
    });
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    errSpy.mockRestore();
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  });

  it('--yes consents without prompting, even with no TTY', async () => {
    await expect(confirmAction({ yes: true }, 'uninstall', 'Remove it?')).resolves.toBe(true);
    expect(stderr.join('')).toBe('');
  });

  it.each(['uninstall', 'install', 'update'])(
    'refuses a non-interactive stdin without --yes, naming the %s action',
    async (action) => {
      await expect(confirmAction({}, action, 'Remove it?')).resolves.toBe(false);
      expect(stderr.join('')).toBe(`Refusing to ${action} non-interactively without --yes.\n`);
    },
  );

  it.each([
    ['y', true],
    ['yes', true],
    ['  Y  ', true],
    ['n', false],
    ['', false],
    ['yep', false],
  ])('on a TTY, treats %p as %p', async (answer, expected) => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const close = jest.fn();
    const question = jest.fn((_q: string, cb: (a: string) => void) => cb(answer as string));
    createInterfaceMock.mockReturnValue({ question, close });
    await expect(confirmAction({}, 'uninstall', 'Remove it?')).resolves.toBe(expected);
    expect(question).toHaveBeenCalledWith('Remove it? (y/N): ', expect.any(Function));
    // Closed however it answered — a left-open readline keeps the process alive.
    expect(close).toHaveBeenCalled();
  });
});
