import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendSystemPromptViaFile, runtimeProfileArgs } from '../../../src/session/runtime-profile';

test('an agent profile prompt moves to a file arg, every other arg stays in place, and nothing is written', () => {
  const context = 'x'.repeat(40000);
  const args = runtimeProfileArgs({ role: 'agent', mcpConfigPath: join(tmpdir(), 'mcp.json'), overlay: 'Overlay', context, responseSchema: { type: 'object' } }, []);
  const file = join(tmpdir(), `never-written-${process.pid}.md`);
  const moved = appendSystemPromptViaFile(args, file);
  const at = args.indexOf('--append-system-prompt');
  expect(moved.args).toEqual([...args.slice(0, at), '--append-system-prompt-file', file, ...args.slice(at + 2)]);
  expect(moved.prompt).toBe(`${context}\n\nOverlay`);
  expect(existsSync(file)).toBe(false);
  expect(moved.args.reduce((n, a) => n + a.length + 3, 0)).toBeLessThan(32767);
});

test('args without an appended prompt are returned untouched', () => {
  const args = ['--model', 'm', '--print'];
  expect(appendSystemPromptViaFile(args, join(tmpdir(), 'never-written.md'))).toEqual({ args });
});
