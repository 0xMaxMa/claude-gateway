import { createHmac } from 'node:crypto';

/**
 * Signing half of the gateway's signed short-lived media URLs.
 *
 * KEEP THIS IN SYNC with src/api/media-sign.ts (the verification half). The MCP
 * subprocess cannot import from src/, so the algorithm is duplicated here. Token
 * shape: base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, msg))
 * where msg = `${agentId}\n${relPath}\n${exp}`.
 */

export type MediaSignPayload = {
  a: string; // agent id
  p: string; // relative media path, e.g. "media/<chat>/<file>.png"
  e: number; // expiry, epoch milliseconds
};

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Produce a signed token that the gateway `/media-public/:token` route accepts. */
export function signMediaToken(payload: MediaSignPayload, secret: string): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const msg = `${payload.a}\n${payload.p}\n${payload.e}`;
  const mac = createHmac('sha256', secret).update(msg).digest();
  return `${body}.${b64urlEncode(mac)}`;
}
