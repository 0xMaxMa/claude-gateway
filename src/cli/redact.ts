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
  // Authorization: Bearer <token>  /  "Bearer xxxxx"
  [/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer «redacted»'],
  // key/token/secret/password : "value"  or  = value  (json/env/prose)
  [/\b(api[_-]?key|apikey|token|secret|password|passwd|authorization)\b(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi, '$1$2«redacted»'],
  // OpenAI/Anthropic-style keys
  [/\b(sk|pk|ak)-[A-Za-z0-9]{8,}/g, '«redacted-key»'],
  // Long opaque tokens (>=32 chars of key-ish alphabet) not already handled
  [/\b[A-Za-z0-9_\-]{32,}\b/g, '«redacted-token»'],
];

export function redactLine(line: string): string {
  let out = line;
  for (const [re, repl] of RULES) out = out.replace(re, repl);
  return out;
}

export function redactLines(lines: string[]): string[] {
  return lines.map(redactLine);
}
