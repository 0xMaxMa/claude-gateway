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

export function loadGatewayDotenv(): void {
  const envFile = path.join(os.homedir(), '.claude-gateway', '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
