import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCliConfig } from '../http-client';
import { redactLine } from '../redact';

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

/** Pure: pick the diagnostic lines (warn/error/submit-diag) from a log's text,
 *  redact them, and keep at most `maxLines` (from the tail — most recent). */
export function selectDiagnosticLines(content: string, maxLines = MAX_DIAG_LINES): string[] {
  const picked: string[] = [];
  for (const line of content.split('\n')) {
    if (/\bWARN\b|\bERROR\b|submit-diag/i.test(line)) {
      picked.push(redactLine(line));
    }
  }
  return picked.length > maxLines ? picked.slice(picked.length - maxLines) : picked;
}

function resolveLogDir(flags: Record<string, string | boolean>): string {
  if (typeof flags.logDir === 'string') return flags.logDir;
  const cfg = loadCliConfig(typeof flags.config === 'string' ? flags.config : undefined);
  if (cfg.logDir) return cfg.logDir;
  return path.join(os.homedir(), '.claude-gateway', 'logs');
}

function listSessionLogs(dir: string): Array<{ file: string; mtimeMs: number }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
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

export async function runDebugBundle(flags: Record<string, string | boolean>): Promise<number> {
  const logDir = resolveLogDir(flags);
  const sessionFilter = typeof flags.session === 'string' ? flags.session : undefined;

  let logs = listSessionLogs(logDir);
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
  process.stderr.write(`Wrote debug bundle: ${outFile}\nAttach this single file to a GitHub issue or send it to the team.\n`);
  return 0;
}
