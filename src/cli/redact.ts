/**
 * Redaction for the debug bundle. A gateway session log can contain arbitrary
 * text; before any of it is put into a shareable bundle, mask the things that
 * must never leave the machine — bearer tokens, API-key/secret assignments, and
 * long opaque token-like strings. submit-diag lines are already redacted at the
 * source (length + hash), so this is defense in depth.
 *
 * Pure and deterministic so it can be unit-tested.
 */
const RULES: Array<[RegExp, string]> = [
  // URI userinfo is a credential even when its variable name is generic.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1«redacted»@'],
  // Environment-style assignments, including DATABASE_URL and SECRET_TOKEN.
  [/\b([A-Za-z_][A-Za-z0-9_]*(?:_URL|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_API_KEY|_KEY))(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi, '$1$2«redacted»'],
  // Authorization: Bearer <token>  /  "Bearer xxxxx"
  [/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer «redacted»'],
  // key/token/secret/password : "value"  or  = value  (json/env/prose)
  [/\b(api[_-]?key|apikey|token|secret|password|passwd|authorization)\b(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi, '$1$2«redacted»'],
  // OpenAI/Anthropic-style keys
  [/\b(sk|pk|ak)-[A-Za-z0-9]{8,}/g, '«redacted-key»'],
  // Long opaque tokens (>=32 chars of key-ish alphabet) not already handled
  [/\b[A-Za-z0-9_\-]{32,}\b/g, '«redacted-token»'],
];

/** A process log or argv item may contain malformed quoting, so discard its whole item on a secret assignment. */
const SECRET_ASSIGNMENT = /\b(?:[A-Za-z_][A-Za-z0-9_]*(?:_URL|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_API_KEY|_KEY)|api[_-]?key|apikey|token|secret|password|passwd|authorization)["']?\s*[:=]/i;

export function redactUntrustedItem(item: string): string {
  return SECRET_ASSIGNMENT.test(item) ? '«redacted»' : redactLine(item);
}

export function redactLine(line: string): string {
  let out = line;
  for (const [re, repl] of RULES) out = out.replace(re, repl);
  return out;
}

export function redactLines(lines: string[]): string[] {
  return lines.map(redactLine);
}
