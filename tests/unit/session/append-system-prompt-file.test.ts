import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendSystemPromptViaFile, runtimeProfileArgs } from '../../../src/session/runtime-profile';

test('an agent profile prompt moves into a private file and every other arg stays in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-file-'));
  try {
    const context = 'x'.repeat(40000);
    const args = runtimeProfileArgs({ role: 'agent', mcpConfigPath: join(dir, 'mcp.json'), overlay: 'Overlay', context, responseSchema: { type: 'object' } }, []);
    const file = join(dir, 'system-prompt.md');
    const moved = appendSystemPromptViaFile(args, file);
    const at = args.indexOf('--append-system-prompt');
    expect(moved).toEqual([...args.slice(0, at), '--append-system-prompt-file', file, ...args.slice(at + 2)]);
    expect(readFileSync(file, 'utf8')).toBe(`${context}\n\nOverlay`);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(moved.reduce((n, a) => n + a.length + 3, 0)).toBeLessThan(32767);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('args without an appended prompt are returned untouched', () => {
  const args = ['--model', 'm', '--print'];
  expect(appendSystemPromptViaFile(args, join(tmpdir(), 'never-written.md'))).toBe(args);
});
