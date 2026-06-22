/**
 * Connector secret storage — ~/.claude-gateway/mcp-token.env
 *
 * A plain dotenv file (mode 0600) of `KEY=value` lines, one per connector secret
 * (e.g. GITHUB_TOKEN=ghp_...). This mirrors the gateway's existing secret posture
 * (~/.claude-gateway/.env holds bot tokens in plaintext); config.json only ever holds
 * the env-var NAME, never the value.
 *
 * The file is parsed fresh on every read so a web "connect" takes effect on the next
 * session spawn with no daemon restart. All ops fail soft.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Resolve the mcp-token.env path (override via GATEWAY_MCP_TOKEN_ENV, used by tests). */
function tokenEnvPath(): string {
  return (
    process.env.GATEWAY_MCP_TOKEN_ENV ??
    path.join(os.homedir(), '.claude-gateway', 'mcp-token.env')
  );
}

/** Parse a dotenv file body into a flat map. Ignores blank lines and `#` comments. */
function parse(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** Read all connector secrets. Returns {} if the file is missing or unreadable. */
export function readTokenEnv(): Record<string, string> {
  try {
    return parse(fs.readFileSync(tokenEnvPath(), 'utf-8'));
  } catch {
    return {};
  }
}

/** Get a single secret value, or null if absent. */
export function getSecret(envName: string): string | null {
  const v = readTokenEnv()[envName];
  return v === undefined || v === '' ? null : v;
}

/** True when the secret is present and non-empty. */
export function hasSecret(envName: string): boolean {
  return getSecret(envName) !== null;
}

/** Atomically rewrite the file (mode 0600) from a map. */
function writeAll(map: Record<string, string>): void {
  const file = tokenEnvPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body =
    Object.entries(map)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Upsert a secret line (creates the file if needed). */
export function setSecret(envName: string, value: string): void {
  const map = readTokenEnv();
  map[envName] = value;
  writeAll(map);
}

/** Remove a secret line. No-op if absent. */
export function deleteSecret(envName: string): void {
  const map = readTokenEnv();
  if (!(envName in map)) return;
  delete map[envName];
  writeAll(map);
}
