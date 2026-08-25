import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDebugBundle } from '../../src/cli/commands/debug-bundle';

/**
 * End-to-end tests for `debug-bundle` — it reads real log files off disk (no
 * gateway needs to be running) and writes a small redacted bundle to cwd.
 * selectDiagnosticLines()/redactLine() already have focused unit tests in
 * cli-redact.test.ts; this file exercises the full command: file selection,
 * --session filtering, the no-logs-found paths, and the output file itself.
 */
describe('cli debug-bundle', () => {
  let logDir: string;
  let cwdDir: string;
  let originalCwd: string;
  let stdout: string[];
  let stderr: string[];
  let writeSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-debug-bundle-logs-'));
    cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-debug-bundle-cwd-'));
    originalCwd = process.cwd();
    process.chdir(cwdDir);
    stdout = [];
    stderr = [];
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(chunk.toString());
      return true;
    });
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(originalCwd);
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(cwdDir, { recursive: true, force: true });
  });

  function writeSessionLog(name: string, content: string, mtimeOffsetMs = 0): void {
    const file = path.join(logDir, name);
    fs.writeFileSync(file, content);
    if (mtimeOffsetMs) {
      const t = new Date(Date.now() - mtimeOffsetMs);
      fs.utimesSync(file, t, t);
    }
  }

  function outFile(): string {
    return stdout.join('').trim();
  }

  it('writes a bundle from the most recently modified session log by default', async () => {
    writeSessionLog('session-old.log', 'WARN old warning\n', 10_000);
    writeSessionLog('session-new.log', 'ERROR new failure with token abcdefghijklmnopqrstuvwxyz012345\n', 0);

    const code = await runDebugBundle({ logDir });

    expect(code).toBe(0);
    const outPath = outFile();
    expect(fs.existsSync(outPath)).toBe(true);
    const content = fs.readFileSync(outPath, 'utf8');
    expect(content).toContain('session-new.log');
    expect(content).not.toContain('session-old.log');
    expect(content).toContain('new failure');
    expect(content).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(content).toContain('«redacted-token»');
  });

  it('--session <filter> selects a specific log by filename substring', async () => {
    writeSessionLog('session-alpha.log', 'WARN alpha warning\n');
    writeSessionLog('session-beta.log', 'WARN beta warning\n');

    const code = await runDebugBundle({ logDir, session: 'beta' });

    expect(code).toBe(0);
    const content = fs.readFileSync(outFile(), 'utf8');
    expect(content).toContain('session-beta.log');
    expect(content).not.toContain('session-alpha.log');
  });

  it('--session <filter> with no match fails without writing a file', async () => {
    writeSessionLog('session-alpha.log', 'WARN alpha warning\n');

    const code = await runDebugBundle({ logDir, session: 'nonexistent' });

    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/No session log matching "nonexistent"/);
    expect(fs.readdirSync(cwdDir)).toHaveLength(0);
  });

  it('no session logs at all fails without writing a file', async () => {
    const code = await runDebugBundle({ logDir });
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/No session logs found/);
    expect(fs.readdirSync(cwdDir)).toHaveLength(0);
  });

  it('includes an environment header and the redaction warning banner', async () => {
    writeSessionLog('session-x.log', 'WARN hello\n');

    const code = await runDebugBundle({ logDir });

    expect(code).toBe(0);
    const content = fs.readFileSync(outFile(), 'utf8');
    expect(content).toContain('claude-gateway debug bundle');
    expect(content).toContain('gatewayVersion:');
    expect(content).toContain('node:');
    expect(content).toMatch(/Please skim this file before sharing/);
  });

  it('only includes session*.log files, ignoring other files in the log dir', async () => {
    writeSessionLog('session-included.log', 'WARN included\n');
    fs.writeFileSync(path.join(logDir, 'unrelated.log'), 'WARN should be ignored (no "session" in name)\n');
    fs.writeFileSync(path.join(logDir, 'session-included.txt'), 'WARN wrong extension\n');

    const code = await runDebugBundle({ logDir });

    expect(code).toBe(0);
    const content = fs.readFileSync(outFile(), 'utf8');
    expect(content).toContain('session-included.log');
    expect(content).not.toContain('unrelated.log');
    expect(content).not.toContain('session-included.txt');
  });
});
