import { createHmac } from 'node:crypto';

/**
 * Signing half of the gateway's signed short-lived public tokens.
 *
 * KEEP THIS IN SYNC with src/api/public-token.ts (the verification half). The MCP
 * subprocess cannot import from src/, so the algorithm is duplicated here. Token
 * shape: base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, body))
 * where body = base64url(JSON payload) — the signature covers the exact payload
 * string, which is delimiter-free (unlike a "\n"-joined field list).
 */

export type PublicToken = {
  k: string; // kind discriminator (e.g. "media")
  a: string; // agent id
  p: string; // relative media path, e.g. "media/<chat>/<file>.png"
  e: number; // expiry, epoch milliseconds
};

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Produce a signed token that the gateway `/public/:token` route accepts. */
export function signPublicToken(payload: PublicToken, secret: string): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const mac = createHmac('sha256', secret).update(body).digest();
  return `${body}.${b64urlEncode(mac)}`;
}
