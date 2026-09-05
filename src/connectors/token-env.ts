/**
 * Connector secret storage — ~/.claude-gateway/mcp-token.env
 *
 * A plain dotenv file (mode 0600) of `KEY=value` lines, one per connector secret
 * (e.g. GITHUB_TOKEN=ghp_...). This mirrors the gateway's existing secret posture
 * (~/.claude-gateway/.env holds bot tokens in plaintext); config.json only ever holds
 * the env-var NAME, never the value.
 *
 * The file is parsed fresh on every read so a web "connect" takes effect on the next
 * session spawn with no daemon restart. Reads fail soft (an unreadable file reads as
 * "nothing is connected"); writes do not, because a write that fails soft would erase
 * what it could not read — see `readTokenEnvForUpdate` vs `readTokenEnv`.
 *
 * Nothing outside this module parses the file — it is never handed to a shell or
 * `--env-file` — so the quoting rules are ours and both sides of the round-trip live
 * here. Secret VALUES are not ours, though: a provider's token endpoint decides what
 * `access_token` looks like, and a value containing a newline would otherwise be
 * written as a second `KEY=value` line and read back as a *different* connector's
 * secret. See `encodeValue`/`decodeValue`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { expandHome } from '../utils/paths';

/**
 * Resolve the mcp-token.env path (override via GATEWAY_MCP_TOKEN_ENV_PATH, used by
 * tests and by operators who keep secrets off the default volume).
 *
 * Tilde-expanded, because .env.example ships the override commented out as
 * `~/.claude-gateway/mcp-token.env` and index.ts does the same for its sibling
 * GATEWAY_CONFIG. A shell does not expand `~` inside a .env file, so without this
 * an operator who uncomments the documented line gets a literal `~` directory
 * created under the gateway's cwd by ensureDir() below — every existing connector
 * then reads as disconnected and freshly minted OAuth tokens are written to the
 * wrong file, with nothing logged to say so.
 */
function tokenEnvPath(): string {
  const override = process.env.GATEWAY_MCP_TOKEN_ENV_PATH;
  return override
    ? expandHome(override)
    : path.join(os.homedir(), '.claude-gateway', 'mcp-token.env');
}

/**
 * Keys are env-var names, and the only structural delimiter this format has. Anything
 * outside this shape (a newline, `=`, a space, a quote) could forge extra entries, so
 * it is rejected rather than escaped — every key the gateway writes is
 * `customSecretKey()`/`internalSecretKey()` output, so a rejection means a caller
 * passed unvalidated user input. `-` is allowed because connector ids are slugs
 * (`CUSTOM__google-calendar__…`); these are map keys here, never real env vars.
 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function isValidSecretKey(key: string): boolean {
  return KEY_RE.test(key);
}

/**
 * Encode a value for one `KEY=value` line. Values that survive a raw round-trip (the
 * common case — tokens are base64url/JWT) are written bare so the file stays greppable;
 * anything else is double-quoted and backslash-escaped, which `decodeValue` reverses.
 */
function encodeValue(value: string): string {
  const needsQuoting =
    value !== value.trim() || /["\\\n\r]/.test(value) || value.startsWith('#');
  if (!needsQuoting) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** Reverse of `encodeValue`. Bare values are returned trimmed, as they always were. */
function decodeValue(raw: string): string {
  const v = raw.trim();
  if (v.length < 2 || !v.startsWith('"') || !v.endsWith('"')) return v;
  const inner = v.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') {
      out += inner[i];
      continue;
    }
    const next = inner[++i];
    out += next === 'n' ? '\n' : next === 'r' ? '\r' : (next ?? '');
  }
  return out;
}

/** Parse a dotenv file body into a flat map. Ignores blank lines and `#` comments. */
function parse(body: string): Record<string, string> {
  // Null-prototype so a hostile `__proto__` key can never reach Object.prototype.
  const out: Record<string, string> = Object.create(null);
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!isValidSecretKey(key)) continue;
    out[key] = decodeValue(line.slice(eq + 1));
  }
  return out;
}

/**
 * The read half of a read-modify-write. Only ENOENT means "empty" — every other
 * errno is rethrown, on purpose.
 *
 * `setSecrets`, `updateSecrets` and `deleteSecrets` rewrite the file whole from
 * whatever this returns. Swallowing an EMFILE or a momentary EACCES here turned that
 * into "write only the new entries", silently destroying every other connector's token
 * with no error anywhere. Failing the write is strictly better — the file stays intact.
 *
 * Deliberately NOT exported: the strictness is right only when about to overwrite the
 * file, and wrong for a read-only caller (see `readTokenEnv`).
 */
function readTokenEnvForUpdate(): Record<string, string> {
  try {
    return parse(fs.readFileSync(tokenEnvPath(), 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

// An unreadable file stays unreadable, and status pollers hit this every couple of
// seconds. Logging every failure buries the log; logging none is how an EACCES goes
// unnoticed for a week. One line per minute keeps the signal.
const READ_FAILURE_LOG_INTERVAL_MS = 60 * 1000;
let lastReadFailureLog = 0;

/**
 * Read all connector secrets for a caller that only intends to LOOK at them.
 * Returns {} when the file does not exist — or cannot be read.
 *
 * Degrading here is the whole point: every caller asks "is this connected / when does
 * it expire", and the honest answer for an unreadable file is "as far as we can tell,
 * no". The throw it replaced propagated out of `GET /v1/connectors` — an `async`
 * handler on Express 4, which does not catch rejections — into index.ts's
 * `unhandledRejection` hook, which shuts the gateway down. A root-owned mcp-token.env
 * (one `sudo`, or a restored volume) therefore killed every agent and channel on the
 * box, and the panel's next poll after restart killed it again. Failures are still
 * logged, because silence is its own harm.
 */
export function readTokenEnv(): Record<string, string> {
  try {
    return readTokenEnvForUpdate();
  } catch (err) {
    const now = Date.now();
    if (now - lastReadFailureLog >= READ_FAILURE_LOG_INTERVAL_MS) {
      lastReadFailureLog = now;
      console.error(
        `token-env: cannot read ${tokenEnvPath()} (${(err as NodeJS.ErrnoException).code ?? 'unknown'})` +
          ` — treating every connector as not connected until it is readable: ${(err as Error).message}`,
      );
    }
    return {};
  }
}

/**
 * `getSecret` against an ALREADY-loaded snapshot, for a caller reading several keys
 * at once (`refreshOne`'s due-check, `refreshStatusOf`). Same "an empty value means
 * absent" rule, in one place: it is the difference between "connected" and "not" on
 * every status surface, and it was previously re-stated at each call site.
 */
export function getSecretFrom(map: Record<string, string>, envName: string): string | null {
  const v = map[envName];
  return v === undefined || v === '' ? null : v;
}

/** Get a single secret value, or null if absent (or unreadable — see `readTokenEnv`). */
export function getSecret(envName: string): string | null {
  return getSecretFrom(readTokenEnv(), envName);
}

/**
 * Coerce a raw value from this file into a non-negative, finite counter/timestamp.
 *
 * Every numeric thing stored here — the refresh failure streaks, the backoff deadline,
 * the token expiry — is hand-editable text, and a NaN reached from it poisons whatever
 * reads it: `NaN >= MAX_CONSECUTIVE_FAILURES` is false forever, so the sweep's give-up
 * branch becomes unreachable and a NaN backoff never blocks its skip guard, while the
 * same value serialized into a status response arrives as `null` and makes a caller's
 * `failures >= 3` test quietly false. One floor, used by both the code that decides
 * whether to delete credentials and the code that displays the decision, so the two
 * cannot disagree about what the file says.
 */
export function parseCounter(raw: string | null | undefined): number {
  const n = Number(raw ?? '0');
  return Number.isFinite(n) && n > 0 ? n : 0;
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
      .map(([k, v]) => `${k}=${encodeValue(v)}`)
      .join('\n') + '\n';
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // `tmp` holds every secret this process knows. A rename that fails — a full
    // disk, the directory replaced underneath us, EACCES after a permissions
    // change — leaves that complete copy sitting next to the real file under a
    // name nothing will ever clean up, and no later write reuses the path
    // (pid+timestamp), so it accumulates one leaked credential dump per failure.
    // Best-effort: the original error is what the caller needs to see, so a
    // failed unlink must not replace it.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing better to do — surface the rename failure below */
    }
    throw err;
  }
}

/**
 * Upsert a secret line (creates the file if needed).
 *
 * Throws on a malformed key — unlike the read path, this one cannot fail soft:
 * silently dropping a write would leave the caller believing a secret was stored.
 */
export function setSecret(envName: string, value: string): void {
  setSecrets({ [envName]: value });
}

/**
 * Upsert several secrets in ONE read-modify-write.
 *
 * Not a race fix — each `setSecret` is already atomic against other JS (read, mutate
 * and rename are all synchronous). It fixes *partial* application: storing an OAuth
 * result used to be five separate rewrites, and a crash between them left an
 * access_token with no expiry, which the sweep then treats as "due now" forever. One
 * rename means the whole group lands or none of it does; every key is validated before
 * anything is written, so a bad key aborts the batch rather than half-committing.
 */
export function setSecrets(entries: Record<string, string>): void {
  updateSecrets(entries, []);
}

/**
 * Upsert some secrets and remove others in ONE read-modify-write.
 *
 * `setSecrets` then `deleteSecrets` is two renames, reopening the partial-application
 * hole `setSecrets` closes. The sweep needs this: recording one kind of failure clears
 * the other kind's counter, and a crash between the writes leaves both set — which
 * status reports as a backoff that is not in effect.
 *
 * Removals are applied before upserts, so a key appearing in both is written, not
 * dropped. Validation covers every upserted key before anything is written; removals
 * need none, since removing a key that could never have been written is a no-op.
 */
export function updateSecrets(
  entries: Record<string, string>,
  removals: readonly string[] = [],
): void {
  for (const key of Object.keys(entries)) {
    if (!isValidSecretKey(key)) {
      throw new Error(`Invalid secret key '${key}' — expected /${KEY_RE.source}/`);
    }
  }
  const map = readTokenEnvForUpdate();
  for (const name of removals) delete map[name];
  for (const [key, value] of Object.entries(entries)) map[key] = value;
  writeAll(map);
}

/** Remove several secret lines in one rewrite. No-op for names that aren't present. */
export function deleteSecrets(envNames: readonly string[]): void {
  const map = readTokenEnvForUpdate();
  let changed = false;
  for (const name of envNames) {
    if (!(name in map)) continue;
    delete map[name];
    changed = true;
  }
  if (changed) writeAll(map);
}
