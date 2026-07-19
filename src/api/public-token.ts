import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed short-lived media URLs — used to hand a media file to a channel that
 * needs a public HTTPS URL it can fetch WITHOUT the gateway API key (LINE image
 * messages: the normal /api/v1/agents/:id/media route is API-key-gated, so LINE's
 * servers cannot fetch it directly — see plan-image-gen §7 / contract E-storage).
 *
 * A token embeds { agentId, relPath, exp } and an HMAC over those fields keyed by
 * the agent's gateway API key (already provisioned on every pod, so no separate
 * media-sign secret is needed). The public route (`/media-public/:token`) resolves
 * that agent's key, verifies the signature + expiry, and streams the file. The
 * signing half lives in the MCP LINE module (mcp/tools/line/media-sign.ts) —
 * KEEP THE ALGORITHM IN SYNC with this file.
 */

export type MediaSignPayload = {
  /** agent id — locates the runner + media root */
  a: string;
  /** relative media path (e.g. "media/<chat>/<file>.png") */
  p: string;
  /** expiry, epoch milliseconds */
  e: number;
};

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function signingMessage(p: MediaSignPayload): string {
  return `${p.a}\n${p.p}\n${p.e}`;
}

/** Produce a signed token: base64url(payload) + "." + base64url(hmac). */
export function signMediaToken(payload: MediaSignPayload, secret: string): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const mac = createHmac('sha256', secret).update(signingMessage(payload)).digest();
  return `${body}.${b64urlEncode(mac)}`;
}

/**
 * Verify a token. Returns the payload when the signature is valid and the token
 * has not expired; otherwise null.
 */
export function verifyMediaToken(token: string, secret: string): MediaSignPayload | null {
  if (!secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const bodyPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  let payload: MediaSignPayload;
  try {
    payload = JSON.parse(b64urlDecode(bodyPart).toString('utf-8')) as MediaSignPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.a !== 'string' || typeof payload.p !== 'string' || typeof payload.e !== 'number') {
    return null;
  }
  const expected = createHmac('sha256', secret).update(signingMessage(payload)).digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(sigPart);
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  if (Date.now() > payload.e) return null;
  return payload;
}
