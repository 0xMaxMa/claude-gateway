import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawnSync } from 'child_process';

/**
 * Small interactive-prompt helpers shared by CLI wizards (`agents create`,
 * `agents update`). Deliberately minimal — plain readline, no raw-mode
 * arrow-key UI — so it works over any TTY without extra terminal handling.
 */

export function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
}

export function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer)));
}

/** Reads lines until a blank line (after at least one non-blank line). */
export async function askMultiline(rl: readline.Interface, intro: string): Promise<string> {
  console.log(intro);
  const lines: string[] = [];
  while (true) {
    const line = await ask(rl, '');
    if (line.trim() === '' && lines.length > 0) break;
    if (line.trim() !== '') lines.push(line);
  }
  return lines.join('\n');
}

const SEPARATOR_WIDTH = 42;

/** `write` defaults to stdout via console.log (the wizards' channel). Commands
 *  that reserve stdout for JSON results pass a stderr writer instead. */
export function printFilePreview(
  filename: string,
  content: string,
  write: (line: string) => void = (line) => console.log(line),
): void {
  const label = `─── ${filename} `;
  const padding = Math.max(0, SEPARATOR_WIDTH - label.length);
  write('\n' + label + '─'.repeat(padding));
  write(content);
  write('─'.repeat(SEPARATOR_WIDTH));
}

/** Open $VISUAL/$EDITOR/vim/vi/nano on a temp copy of `content`; returns the
 *  edited text, or null if no editor could be launched. */
export function editInEditor(content: string, tmpName: string): string | null {
  const tmpFile = path.join(os.tmpdir(), `claude-gateway-${tmpName}`);
  fs.writeFileSync(tmpFile, content, 'utf8');
  const candidates = [process.env['VISUAL'], process.env['EDITOR'], 'vim', 'vi', 'nano'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, [tmpFile], { stdio: 'inherit' });
    if (!result.error) {
      const edited = fs.readFileSync(tmpFile, 'utf8');
      fs.unlinkSync(tmpFile);
      return edited;
    }
  }
  try { fs.unlinkSync(tmpFile); } catch { /* nothing written */ }
  return null;
}

/** Preview each file and let the user accept / edit / skip it. Required files
 *  (not in `optional`) cannot be skipped. Returns the accepted map in the same
 *  order as `files`. */
export async function previewAndAccept(
  rl: readline.Interface,
  files: Map<string, string>,
  optional: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const accepted = new Map<string, string>();
  for (const [filename, content] of files) {
    printFilePreview(filename, content);
    while (true) {
      const answer = (await ask(rl, 'Accept? (y/edit/skip) [y]: ')).trim().toLowerCase() || 'y';
      if (answer === 'y' || answer === 'yes') {
        accepted.set(filename, content);
        break;
      }
      if (answer === 'edit') {
        const edited = editInEditor(content, filename);
        if (edited === null) {
          console.log('  Could not open an editor (set $EDITOR and try again, or choose y/skip).');
          continue;
        }
        printFilePreview(filename, edited);
        console.log('  (edited, accepted)');
        accepted.set(filename, edited);
        break;
      }
      if (answer === 'skip') {
        if (optional.has(filename)) {
          console.log(`  Skipping ${filename}`);
          break;
        }
        console.log(`  Cannot skip ${filename} — it is required.`);
        continue;
      }
      console.log('  Please enter y, edit, or skip.');
    }
  }
  return accepted;
}
