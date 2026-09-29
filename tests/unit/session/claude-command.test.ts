import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  claudeCommand,
  executableCandidates,
  parseClaudeBin,
  pathWithNativeBin,
  resolveClaudeBin,
} from '../../../src/session/claude-bin';

// Runs natively on Linux, macOS and Windows (cross-platform CI).
describe('claude command resolution across platforms', () => {
  let dir: string;
  const realPlatform = process.platform;
  const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value });
  const mkExec = (p: string): string => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '#!/bin/sh\necho ok\n');
    fs.chmodSync(p, 0o755);
    return p;
  };

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude cmd-')); });
  afterEach(() => {
    setPlatform(realPlatform);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('parseClaudeBin', () => {
    it('keeps an existing path with spaces whole', () => {
      const bin = mkExec(path.join(dir, 'John Doe', 'claude'));
      expect(parseClaudeBin(bin)).toEqual({ command: bin, args: [] });
      expect(parseClaudeBin(` ${bin} `)).toEqual({ command: bin, args: [] });
    });

    it('splits a command that carries arguments, as before', () => {
      expect(parseClaudeBin('node /opt/claude/cli.js')).toEqual({ command: 'node', args: ['/opt/claude/cli.js'] });
      expect(parseClaudeBin('claude')).toEqual({ command: 'claude', args: [] });
    });

    it('reads double-quoted words with spaces', () => {
      expect(parseClaudeBin('"C:\\Program Files\\nodejs\\node.exe" "D:\\my tools\\cli.js" --flag')).toEqual({
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['D:\\my tools\\cli.js', '--flag'],
      });
    });

    it('spawns a quoted interpreter and script under directories with spaces', () => {
      const script = path.join(dir, 'John Doe', 'cli.js');
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, 'console.log("ran " + process.argv.slice(2).join(","))');
      const { command, args } = parseClaudeBin(`"${process.execPath}" "${script}"`);
      const result = spawnSync(command, [...args, '--print'], { encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.stdout.trim()).toBe('ran --print');
    });
  });

  describe('claudeCommand', () => {
    it('never splits a resolved binary', () => {
      const bin = path.join(dir, 'John Doe', '.local', 'bin', 'claude');
      const cmd = claudeCommand(undefined, () => ({ bin, source: 'native-bin', searched: [] }));
      expect(cmd).toMatchObject({ command: bin, args: [] });
      expect(cmd.resolution?.source).toBe('native-bin');
    });

    it('prefers an explicit value and ignores an empty one', () => {
      const resolve = jest.fn(() => ({ bin: 'claude', source: 'PATH' as const, searched: [] }));
      expect(claudeCommand('node /opt/cli.js', resolve)).toEqual({ command: 'node', args: ['/opt/cli.js'] });
      expect(resolve).not.toHaveBeenCalled();
      expect(claudeCommand('', resolve)).toMatchObject({ command: 'claude', args: [] });
    });

    (realPlatform === 'win32' ? it.skip : it)('spawns a native install under a home with spaces', () => {
      const home = path.join(dir, 'John Doe');
      mkExec(path.join(home, '.local', 'bin', 'claude'));
      const { command, args } = claudeCommand(undefined, () => resolveClaudeBin({ PATH: path.join(dir, 'none') }, home));
      const result = spawnSync(command, args, { encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.stdout.trim()).toBe('ok');
    });
  });

  describe('win32 executable names', () => {
    beforeEach(() => setPlatform('win32'));

    it('lists only .exe and .com', () => {
      expect(executableCandidates('C:\\bin\\claude')).toEqual(['C:\\bin\\claude.exe', 'C:\\bin\\claude.com']);
      expect(executableCandidates('C:\\bin\\claude.EXE')).toEqual(['C:\\bin\\claude.EXE']);
      expect(executableCandidates('/bin/claude', 'linux')).toEqual(['/bin/claude']);
    });

    it('finds claude.exe on PATH', () => {
      const bin = path.join(dir, 'sidecar', 'bin');
      mkExec(path.join(bin, 'claude.exe'));
      const home = path.join(dir, 'home');
      fs.mkdirSync(home);
      expect(resolveClaudeBin({ PATH: bin }, home)).toMatchObject({ bin: 'claude', source: 'PATH' });
    });

    it('ignores .cmd shims and extensionless files, which cannot be spawned without a shell', () => {
      const bin = path.join(dir, 'npm');
      mkExec(path.join(bin, 'claude.cmd'));
      mkExec(path.join(bin, 'claude'));
      const home = path.join(dir, 'home');
      fs.mkdirSync(home);
      expect(resolveClaudeBin({ PATH: bin }, home).source).toBe('fallback');
    });

    it('finds the native ~/.local/bin/claude.exe and prepends its directory to PATH', () => {
      const home = path.join(dir, 'John Doe');
      const exe = mkExec(path.join(home, '.local', 'bin', 'claude.exe'));
      expect(resolveClaudeBin({ PATH: path.join(dir, 'none') }, home)).toMatchObject({ bin: exe, source: 'native-bin' });
      expect(pathWithNativeBin(home, 'X')).toBe(`${path.join(home, '.local', 'bin')}${path.delimiter}X`);
    });

    it('finds a native version stored as <version>.exe', () => {
      const home = path.join(dir, 'home');
      const exe = mkExec(path.join(home, '.local', 'share', 'claude', 'versions', '2.1.206.exe'));
      expect(resolveClaudeBin({ PATH: '' }, home)).toMatchObject({ bin: exe, source: 'native-versions' });
    });
  });
});
