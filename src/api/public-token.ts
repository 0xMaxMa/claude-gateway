import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed short-lived public tokens — a neutral, reusable primitive for handing a
 * resource to a caller that needs a public URL it can hit WITHOUT the gateway API
 * key. Today it backs LINE image delivery (kind `media`: the normal
 * /api/v1/agents/:id/media route is API-key-gated, so LINE's servers cannot fetch
 * it directly — see plan-image-gen §7 / contract E-storage), but the `k` (kind)
 * discriminator lets the same primitive back future share-link features (share
 * chat, etc.) without a new token type.
 *
 * A token embeds { kind, agentId, relPath, exp } and an HMAC over those fields
 * keyed by the agent's gateway API key (already provisioned on every pod, so no
 * separate signing secret is needed). The public route (`/public/:token`) resolves
 * that agent's key, verifies the signature + expiry, dispatches on `k`, and serves
 * the resource. The signing half lives in the MCP LINE module
 * (mcp/tools/line/public-token.ts) — KEEP THE ALGORITHM IN SYNC with this file.
 */

export type PublicToken = {
  /** kind discriminator — a token of one kind can never cross-verify as another */
  k: string;
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

function signingMessage(p: PublicToken): string {
  return `${p.k}\n${p.a}\n${p.p}\n${p.e}`;
}

/** Produce a signed token: base64url(payload) + "." + base64url(hmac). */
export function signPublicToken(payload: PublicToken, secret: string): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const mac = createHmac('sha256', secret).update(signingMessage(payload)).digest();
  return `${body}.${b64urlEncode(mac)}`;
}

/**
 * Verify a token. Returns the payload when the signature is valid and the token
 * has not expired; otherwise null.
 */
export function verifyPublicToken(token: string, secret: string): PublicToken | null {
  if (!secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const bodyPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  let payload: PublicToken;
  try {
    payload = JSON.parse(b64urlDecode(bodyPart).toString('utf-8')) as PublicToken;
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.k !== 'string' ||
    typeof payload.a !== 'string' ||
    typeof payload.p !== 'string' ||
    typeof payload.e !== 'number'
  ) {
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
