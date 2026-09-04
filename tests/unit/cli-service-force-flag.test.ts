/**
 * `--force` (added for `service install`, issue #450) has to survive real CLI
 * parsing, not just the pre-parsed `flags` object `cli-service.test.ts` hands
 * `runService` directly. `runCli` parses raw argv through `GLOBAL_BOOLEAN_FLAGS`
 * before any command sees a `flags` object at all — if `force` isn't declared
 * boolean there, a `--force` placed before the verb (`service --force install`)
 * swallows `install` as its value instead of leaving it as the positional verb.
 */
jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  readFileSync: jest.fn(),
  chmodSync: jest.fn(),
}));
jest.mock('../../src/cli/http-client', () => ({
  ...jest.requireActual('../../src/cli/http-client'),
  loadCliConfig: () => ({ keys: [] }),
}));

import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { runCli } from '../../src/cli';

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;
const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>;

let stderr: string[];
let errSpy: jest.SpyInstance;
let ttyDescriptor: PropertyDescriptor | undefined;
let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  (fs.existsSync as jest.Mock).mockReturnValue(true);
  stderr = [];
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString());
    return true;
  });
  ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
  // A same-named unit already exists at system scope and is enabled — only
  // `--force` should get past this.
  mockExecFileSync.mockImplementation(((file: string, args: string[]) => {
    if (file === 'systemctl' && !args.includes('--user') && args[0] === 'is-enabled') {
      return Buffer.from('enabled\n');
    }
    return Buffer.from('');
  }) as unknown as typeof execFileSync);
});

afterEach(() => {
  errSpy.mockRestore();
  fetchSpy.mockRestore();
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
});

describe('`service --force install` — --force placed before the verb (issue #450)', () => {
  it('does not swallow `install` as --force\'s value — the install proceeds', async () => {
    const code = await runCli(['service', '--force', 'install', '--yes', '--manager', 'systemd']);
    expect(code).toBe(0);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('`--force=true` (equals form) also installs despite the conflict', async () => {
    // parseCliArgs used to return the raw string 'true' for a declared
    // boolean flag's `--flag=value` form; service.ts's strict
    // `flags.force !== true` check then refused as if --force were absent.
    const code = await runCli(['service', 'install', '--force=true', '--yes', '--manager', 'systemd']);
    expect(code).toBe(0);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});
