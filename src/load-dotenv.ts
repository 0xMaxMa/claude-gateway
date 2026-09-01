/**
 * Load `~/.claude-gateway/.env` into `process.env`.
 *
 * Both entry points need this before anything else runs: the server reads these
 * variables while booting, and the CLI resolves the gateway's address from the
 * same `$GATEWAY_BIND` the server booted with. Existing variables win, so a
 * value exported in the shell still overrides the file.
 *
 * Kept dependency-free and side-effect-only-on-call so the CLI path can run it
 * without pulling in anything else.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Parse `.env` text into key/value pairs, in file order.
 *
 * Shared with the per-agent loader (`src/config/agent-env.ts`) so that both
 * agree on what a line means. They must: a value that survives one parser and
 * not the other is not a parse error anyone sees. Surrounding quotes are the
 * case that bites — `TOKEN="123:ABC"` is ordinary `.env` style, and a parser
 * that keeps the quotes still resolves the `${VAR}` in `config.json`. The
 * config loads, nothing is skipped, nothing is logged, and the receiver simply
 * 401s on every poll with a token that has quotes in it.
 *
 * Blank lines, `#` comments and lines with no key (`=value`) are dropped.
 */
export function parseDotenv(text: string): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    pairs.push({ key, value });
  }
  return pairs;
}

export function loadGatewayDotenv(): void {
  const envFile = path.join(os.homedir(), '.claude-gateway', '.env');
  if (!fs.existsSync(envFile)) return;
  for (const { key, value } of parseDotenv(fs.readFileSync(envFile, 'utf8'))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}
