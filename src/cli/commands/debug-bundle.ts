import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandHome, loadCliConfig } from '../http-client';
import { redactLine } from '../redact';
import { writeCommandHelp } from '../output';

/**
 * `debug-bundle` — collect a small, redacted diagnostics bundle for a session
 * that went silent, so a user can attach ONE file to an issue/Telegram instead
 * of a multi-MB raw log (which may contain prompts/secrets).
 *
 * Reads the log directory directly, so it works even when the gateway is wedged
 * or dead. Includes only warn/error and submit-diag lines, redacted, plus an
 * environment header.
 */

const MAX_DIAG_LINES = 4000;
/** Cap on a single kept line's length. Guards against one giant serialized
 *  object/stack trace blowing past the "small bundle" goal, and limits how much
 *  of any one line's content (which redaction cannot fully guarantee is clean —
 *  see the banner below) ends up in the file. */
const MAX_LINE_LENGTH = 2000;

function truncateLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) return line;
  return `${line.slice(0, maxLength)} …[truncated, ${line.length - maxLength} more chars]`;
}

/** Pure: pick the diagnostic lines (warn/error/submit-diag) from a log's text,
 *  redact them, cap each line's length, and keep at most `maxLines` (from the
 *  tail — most recent). */
export function selectDiagnosticLines(content: string, maxLines = MAX_DIAG_LINES, maxLineLength = MAX_LINE_LENGTH): string[] {
  const picked: string[] = [];
  for (const line of content.split('\n')) {
    if (/\bWARN\b|\bERROR\b|submit-diag/i.test(line)) {
      picked.push(truncateLine(redactLine(line), maxLineLength));
    }
  }
  return picked.length > maxLines ? picked.slice(picked.length - maxLines) : picked;
}

/** The config file stores `logDir` exactly as written, and the shipped template
 *  writes `~/.claude-gateway/logs`. The server expands that itself on boot, so
 *  the literal tilde survives on disk and only bites a reader that forgets to
 *  expand it — `readdirSync('~/...')` throws ENOENT and looks like "no logs". */
function resolveLogDir(flags: Record<string, string | boolean>): string {
  if (typeof flags.logDir === 'string') return expandHome(flags.logDir);
  const cfg = loadCliConfig(typeof flags.config === 'string' ? flags.config : undefined);
  if (cfg.logDir) return expandHome(cfg.logDir);
  return path.join(os.homedir(), '.claude-gateway', 'logs');
}

/**
 * Session logs in `dir`, or the reason the directory could not be read.
 *
 * The read used to be wrapped in a bare `catch { return [] }`, which reported
 * every failure as "no session logs found". That is how the unexpanded `~`
 * stayed invisible: an ENOENT on a path that was never resolved looked exactly
 * like an empty directory, and a permission problem still would. The caller
 * needs the errno to say anything useful, so it is returned rather than eaten.
 */
function listSessionLogs(dir: string): { logs: Array<{ file: string; mtimeMs: number }>; error?: string } {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { logs: [], error: `${dir} does not exist` };
    if (e.code === 'ENOTDIR') return { logs: [], error: `${dir} is not a directory` };
    return { logs: [], error: `${dir} could not be read (${e.code ?? e.message})` };
  }
  const logs = names
    .filter((n) => n.endsWith('.log') && /session/i.test(n))
    .map((n) => {
      const file = path.join(dir, n);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        /* ignore */
      }
      return { file, mtimeMs };
    });
  return { logs };
}

function claudeCodeVersion(): string {
  try {
    return execSync('claude --version', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function gatewayVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require(path.join(__dirname, '..', '..', '..', 'package.json')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function printHelp(): void {
  writeCommandHelp(
    true,
    'debug-bundle',
    'write a small redacted diagnostics bundle',
    'claude-gateway debug-bundle [--session <id>] [--logDir <path>] [--config <path>]',
    [
      '  --session <id>   Bundle this session instead of the most recent one',
      '  --logDir <path>  Read logs from here instead of the configured directory',
      '  --config <path>  Read logDir from this config file',
      '',
      '  Writes debug-bundle-<stamp>.txt into the current directory.',
    ],
  );
}

export async function runDebugBundle(flags: Record<string, string | boolean>): Promise<number> {
  // `--help` must stay read-only: every other command prints and returns, and
  // this one writes a file into the working directory as its side effect.
  if (flags.help === true) {
    printHelp();
    return 0;
  }
  const logDir = resolveLogDir(flags);
  const sessionFilter = typeof flags.session === 'string' ? flags.session : undefined;

  const found = listSessionLogs(logDir);
  // A directory that could not be read is a different answer from one holding
  // no logs, and only one of them is the operator's to fix.
  if (found.error) {
    process.stderr.write(`Cannot read session logs: ${found.error}\n`);
    return 1;
  }
  let logs = found.logs;
  if (sessionFilter) {
    logs = logs.filter((l) => path.basename(l.file).includes(sessionFilter));
    if (!logs.length) {
      process.stderr.write(`No session log matching "${sessionFilter}" in ${logDir}\n`);
      return 1;
    }
  } else {
    // Most recently modified session log.
    logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    logs = logs.slice(0, 1);
    if (!logs.length) {
      process.stderr.write(`No session logs found in ${logDir}\n`);
      return 1;
    }
  }

  const sections: string[] = [];
  sections.push('=== claude-gateway debug bundle ===');
  sections.push(
    '⚠ Please skim this file before sharing it. Redaction masks common secret ' +
      'patterns (bearer tokens, api-key/secret/password assignments, provider-style ' +
      'keys, long opaque tokens) but cannot guarantee removal of arbitrary free-form ' +
      'text that happened to land in a WARN/ERROR log line.',
  );
  sections.push(`generatedAt: ${new Date().toISOString()}`);
  sections.push(`gatewayVersion: ${gatewayVersion()}`);
  sections.push(`claudeCodeVersion: ${claudeCodeVersion()}`);
  sections.push(`node: ${process.version}`);
  sections.push(`os: ${os.platform()} ${os.release()} (${os.arch()})`);
  sections.push(`logDir: ${logDir}`);
  sections.push('');

  for (const { file } of logs) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      sections.push(`--- ${path.basename(file)} (unreadable: ${(err as Error).message}) ---`);
      continue;
    }
    const lines = selectDiagnosticLines(content);
    sections.push(`--- ${path.basename(file)} (${lines.length} diagnostic lines) ---`);
    sections.push(lines.join('\n'));
    sections.push('');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(process.cwd(), `debug-bundle-${stamp}.txt`);
  fs.writeFileSync(outFile, sections.join('\n'));
  process.stdout.write(`${outFile}\n`);
  process.stderr.write(
    `Wrote debug bundle: ${outFile}\n` +
      'Redaction covers common secret patterns, not all free-form text — please skim it before attaching to a GitHub issue or sending it to the team.\n',
  );
  return 0;
}
