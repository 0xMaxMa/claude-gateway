jest.mock('../../src/packages/registry', () => ({
  PACKAGES: {
    'claude-gateway': { npm: '@0xmaxma/claude-gateway', detect: 'npm', update: 'npm' },
    'claude-code': { npm: '@anthropic-ai/claude-code', detect: 'binary', bin: 'claude', update: 'native' },
  },
  resolveCurrent: jest.fn(),
  getLatestVersion: jest.fn(),
  getNpmListVersion: jest.fn(),
  installNpmLatest: jest.fn(),
  runNativeUpdate: jest.fn(),
  updateAvailable: jest.requireActual('../../src/packages/registry').updateAvailable,
}));
jest.mock('../../src/cli/manager', () => ({ detectManager: jest.fn(() => 'systemd-user'), readLocalGateway: () => ({ pid: 1 }) }));

import {
  resolveCurrent,
  getLatestVersion,
  getNpmListVersion,
  installNpmLatest,
  runNativeUpdate,
} from '../../src/packages/registry';
import { runUpdate, runClaude } from '../../src/cli/commands/update';

/**
 * `update` shells out to a package installer, so the two properties that
 * matter are: nothing is installed without an explicit confirmation, and the
 * install strategy matches the one the dashboard uses (npm for the gateway,
 * the native updater for Claude Code — an `npm install -g` there would write a
 * copy that is not the binary on PATH).
 */

const mockResolveCurrent = resolveCurrent as jest.MockedFunction<typeof resolveCurrent>;
const mockGetLatest = getLatestVersion as jest.MockedFunction<typeof getLatestVersion>;
const mockNpmList = getNpmListVersion as jest.MockedFunction<typeof getNpmListVersion>;
const mockInstall = installNpmLatest as jest.MockedFunction<typeof installNpmLatest>;
const mockNative = runNativeUpdate as jest.MockedFunction<typeof runNativeUpdate>;

let stdout: string[];
let stderr: string[];
let outSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
let ttyDescriptor: PropertyDescriptor | undefined;

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInstall.mockReturnValue(null);
  mockNative.mockReturnValue(null);
  stdout = [];
  stderr = [];
  outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(chunk.toString());
    return true;
  });
  errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString());
    return true;
  });
  ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  setTty(false);
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
});

describe('update check — read-only', () => {
  it('reports current/latest/hasUpdate and installs nothing', async () => {
    mockResolveCurrent.mockReturnValue('1.7.9');
    mockGetLatest.mockResolvedValue('1.8.0');

    const code = await runUpdate('claude-gateway', ['check'], {});

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toEqual({
      package: '@0xmaxma/claude-gateway',
      current: '1.7.9',
      latest: '1.8.0',
      hasUpdate: true,
    });
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('does not claim "up to date" when the registry is unreachable', async () => {
    mockResolveCurrent.mockReturnValue('1.7.9');
    mockGetLatest.mockRejectedValue(new Error('ENOTFOUND'));

    const code = await runUpdate('claude-gateway', ['check'], {});

    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/registry/i);
    expect(stdout.join('')).toBe('');
  });

  it('reports no update when the installed version is ahead of the registry latest', async () => {
    mockResolveCurrent.mockReturnValue('1.9.0');
    mockGetLatest.mockResolvedValue('1.8.0');

    expect(await runUpdate('claude-gateway', ['check'], {})).toBe(0);
    expect(JSON.parse(stdout.join('')).hasUpdate).toBe(false);
  });

  it('rejects an unknown subcommand', async () => {
    expect(await runUpdate('claude-gateway', ['now'], {})).toBe(1);
    expect(mockInstall).not.toHaveBeenCalled();
  });
});

describe('update — confirmation gate', () => {
  it('refuses to install non-interactively without --yes', async () => {
    mockResolveCurrent.mockReturnValue('1.7.9');
    mockGetLatest.mockResolvedValue('1.8.0');

    const code = await runUpdate('claude-gateway', [], {});

    expect(code).toBe(1);
    expect(mockInstall).not.toHaveBeenCalled();
    expect(stderr.join('')).toMatch(/--yes/);
  });

  it('shows current → target and the release notes before asking', async () => {
    mockResolveCurrent.mockReturnValue('1.7.9');
    mockGetLatest.mockResolvedValue('1.8.0');

    await runUpdate('claude-gateway', [], {});

    const shown = stderr.join('');
    expect(shown).toContain('1.7.9');
    expect(shown).toContain('1.8.0');
    expect(shown).toContain('releases/tag/v1.8.0');
  });

  it('is a no-op (exit 0, no install) when already on the latest version', async () => {
    mockResolveCurrent.mockReturnValue('1.8.0');
    mockGetLatest.mockResolvedValue('1.8.0');

    const code = await runUpdate('claude-gateway', [], { yes: true });

    expect(code).toBe(0);
    expect(mockInstall).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join('')).updated).toBe(false);
  });
});

describe('update — install path', () => {
  it('installs the gateway through npm and points at the restart it still needs', async () => {
    mockResolveCurrent.mockReturnValue('1.7.9');
    mockGetLatest.mockResolvedValue('1.8.0');
    mockNpmList.mockReturnValue('1.8.0');

    const code = await runUpdate('claude-gateway', [], { yes: true });

    expect(code).toBe(0);
    expect(mockInstall).toHaveBeenCalledWith('@0xmaxma/claude-gateway');
    expect(mockNative).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join(''))).toEqual({
      package: '@0xmaxma/claude-gateway',
      from: '1.7.9',
      to: '1.8.0',
      updated: true,
    });
    expect(stderr.join('')).toMatch(/gateway restart/);
  });

  it('surfaces an install failure instead of reporting success', async () => {
    mockResolveCurrent.mockReturnValue('1.7.9');
    mockGetLatest.mockResolvedValue('1.8.0');
    mockInstall.mockReturnValue('npm ERR! EACCES');

    const code = await runUpdate('claude-gateway', [], { yes: true });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('npm ERR! EACCES');
  });
});

describe('claude — the Claude Code binary', () => {
  it('`claude version` prints the detected binary version', async () => {
    mockResolveCurrent.mockReturnValue('2.1.207');
    expect(await runClaude(['version'], {})).toBe(0);
    expect(stdout.join('').trim()).toBe('2.1.207');
  });

  it('`claude version` fails clearly when the binary is absent', async () => {
    mockResolveCurrent.mockReturnValue(null);
    expect(await runClaude(['version'], {})).toBe(1);
    expect(stdout.join('')).toBe('');
  });

  it('`claude update` uses the native updater, never npm install -g', async () => {
    mockResolveCurrent.mockReturnValueOnce('2.1.207').mockReturnValueOnce('2.2.0');
    mockGetLatest.mockResolvedValue('2.2.0');

    const code = await runClaude(['update'], { yes: true });

    expect(code).toBe(0);
    expect(mockNative).toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join('')).to).toBe('2.2.0');
  });

  it('reports honestly when the native updater is a no-op', async () => {
    mockResolveCurrent.mockReturnValue('2.1.207');
    mockGetLatest.mockResolvedValue('2.2.0');

    const code = await runClaude(['update'], { yes: true });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join('')).updated).toBe(false);
  });

  it('`claude update check` stays read-only', async () => {
    mockResolveCurrent.mockReturnValue('2.1.207');
    mockGetLatest.mockResolvedValue('2.2.0');

    expect(await runClaude(['update', 'check'], {})).toBe(0);
    expect(mockNative).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join('')).hasUpdate).toBe(true);
  });

  it('a bare `claude` is a usage error (1); `claude --help` is a help request (0)', async () => {
    expect(await runClaude([], {})).toBe(1);
    expect(await runClaude([], { help: true })).toBe(0);
  });

  it('rejects unknown verbs without touching the installer', async () => {
    expect(await runClaude(['frobnicate'], {})).toBe(1);
    expect(await runClaude(['update', 'now'], {})).toBe(1);
    expect(mockNative).not.toHaveBeenCalled();
  });
});

describe('registry runNativeUpdate guard', () => {
  it('refuses a package with no native updater instead of shelling out', () => {
    const actual = jest.requireActual('../../src/packages/registry') as typeof import('../../src/packages/registry');
    const err = actual.runNativeUpdate({ npm: '@scope/pkg', detect: 'npm', update: 'native' });
    expect(err).toMatch(/no native updater/);
  });
});
