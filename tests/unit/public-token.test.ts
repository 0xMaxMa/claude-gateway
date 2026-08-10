/**
 * Unit tests for the signed short-lived public-token crypto core (src/api/public-token.ts).
 *
 * These tokens gate the public `/public/:token` route (LINE image delivery today,
 * kind `media`): an HMAC-SHA256 over { kind, agentId, relPath, exp } keyed by the
 * pod's gateway API key. The whole security story rests on this pair of pure
 * functions, so we lock in the roundtrip AND every failure mode (wrong key, tamper,
 * expiry, malformed input) — including that tampering the `k` kind breaks the HMAC,
 * so a token minted for one kind can never cross-verify as another.
 *
 * The signing half is DUPLICATED in mcp/tools/line/public-token.ts (the MCP subprocess
 * cannot import from src/), so the final block cross-checks that the two copies stay
 * byte-for-byte in sync — sign with the MCP copy, verify with the src copy.
 */
import {
  signPublicToken,
  verifyPublicToken,
  type PublicToken,
} from '../../src/api/public-token';
import { signPublicToken as signPublicTokenMcp } from '../../mcp/tools/line/public-token';

const KEY = 'gw-api-key-abc123';
const OTHER_KEY = 'gw-api-key-different-999';

// A payload that expires far in the future so time never interferes with the
// non-expiry cases (the expiry case builds its own past-dated payload).
function freshPayload(over: Partial<PublicToken> = {}): PublicToken {
  return { k: 'media', a: 'agentA', p: 'media/chat1/pic.png', e: Date.now() + 60_000, ...over };
}

describe('signPublicToken() / verifyPublicToken() roundtrip', () => {
  test('valid token signed with KEY verifies with the same KEY → returns payload', () => {
    const payload = freshPayload();
    const token = signPublicToken(payload, KEY);
    expect(verifyPublicToken(token, KEY)).toEqual(payload);
  });

  test('token shape is base64url(body) "." base64url(mac)', () => {
    const token = signPublicToken(freshPayload(), KEY);
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    // base64url alphabet only — no +, /, or = padding
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe('verifyPublicToken() rejects forgeries', () => {
  test('wrong key → null (cannot forge without the signing key)', () => {
    const token = signPublicToken(freshPayload(), KEY);
    expect(verifyPublicToken(token, OTHER_KEY)).toBeNull();
  });

  test('tampered body (flip a char in the base64url payload) → null', () => {
    const token = signPublicToken(freshPayload(), KEY);
    const dot = token.indexOf('.');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    // Flip the first body char to a different base64url char.
    const flipped = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    expect(verifyPublicToken(`${flipped}.${sig}`, KEY)).toBeNull();
  });

  test('tampered signature (flip a char in the mac) → null', () => {
    const token = signPublicToken(freshPayload(), KEY);
    const dot = token.indexOf('.');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(verifyPublicToken(`${body}.${flipped}`, KEY)).toBeNull();
  });

  test('tampered kind → null (a token of one kind never cross-verifies as another)', () => {
    // Mint a valid 'media' token, keep its signature, but rewrite the body's `k`
    // to 'share'. Because `k` is part of the signing message, the HMAC no longer
    // matches ⇒ verify rejects it. This is the cross-kind isolation guarantee.
    const token = signPublicToken(freshPayload({ k: 'media' }), KEY);
    const sig = token.slice(token.indexOf('.') + 1);
    const forgedBody = Buffer.from(JSON.stringify(freshPayload({ k: 'share' })), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyPublicToken(`${forgedBody}.${sig}`, KEY)).toBeNull();
  });

  test('expired token (e in the past) → null even with the correct key', () => {
    const token = signPublicToken(freshPayload({ e: Date.now() - 1 }), KEY);
    expect(verifyPublicToken(token, KEY)).toBeNull();
  });

  test('empty secret → null (never verifies against no key)', () => {
    const token = signPublicToken(freshPayload(), KEY);
    expect(verifyPublicToken(token, '')).toBeNull();
  });
});

describe('verifyPublicToken() rejects malformed tokens', () => {
  test('no "." separator → null', () => {
    expect(verifyPublicToken('notoken', KEY)).toBeNull();
  });

  test('leading "." (empty body) → null', () => {
    expect(verifyPublicToken('.abc', KEY)).toBeNull();
  });

  test('garbage / non-base64 body → null', () => {
    expect(verifyPublicToken('!!!.@@@', KEY)).toBeNull();
  });

  test('empty string → null', () => {
    expect(verifyPublicToken('', KEY)).toBeNull();
  });

  test('body decodes to JSON with wrong field types → null', () => {
    // k=missing, a=number, p=missing → schema check in verify rejects before HMAC compare.
    const badBody = Buffer.from(JSON.stringify({ a: 1, e: 'soon' }), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyPublicToken(`${badBody}.AAAA`, KEY)).toBeNull();
  });
});

describe('MCP sign copy stays in sync with the src verify copy', () => {
  test('sign with mcp/tools/line/public-token, verify with src/api/public-token → payload', () => {
    const payload = freshPayload({ a: 'agentSync', p: 'media/x/y.png' });
    const token = signPublicTokenMcp(payload, KEY);
    expect(verifyPublicToken(token, KEY)).toEqual(payload);
  });

  test('the two copies produce byte-identical tokens for the same input', () => {
    const payload = freshPayload({ a: 'agentSync', p: 'media/x/y.png' });
    expect(signPublicTokenMcp(payload, KEY)).toBe(signPublicToken(payload, KEY));
  });
});

describe('canonicalization is delimiter-safe (signs over the base64url body)', () => {
  // Old scheme signed "${k}\n${a}\n${p}\n${e}". Because a field may itself contain
  // "\n", two DISTINCT payloads could produce the identical signing string, so one
  // signature validated both — a real forgery across agent id + path.
  const E = 1_900_000_000_000; // fixed future expiry so both payloads share it
  //  a='x',  p='y\nz'  → "media\nx\ny\nz\nE"
  //  a='x\ny', p='z'   → "media\nx\ny\nz\nE"   (IDENTICAL under the old join)
  const pA: PublicToken = { k: 'media', a: 'x', p: 'y\nz', e: E };
  const pB: PublicToken = { k: 'media', a: 'x\ny', p: 'z', e: E };

  const b64url = (s: string) =>
    Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  test('a relPath containing a newline still round-trips exactly', () => {
    const payload = freshPayload({ p: 'media/chat/evil\n999/pic.png' });
    const token = signPublicToken(payload, KEY);
    expect(verifyPublicToken(token, KEY)).toEqual(payload);
  });

  test('a token minted for pA cannot be reused to forge pB (boundary-shift attack)', () => {
    // Attacker legitimately holds a token for pA, then swaps in pB's body while
    // keeping pA's MAC. Under the old "\n"-join both share a signing string, so
    // the forged token would verify as pB. Signing over the body defeats it.
    const macA = signPublicToken(pA, KEY).split('.')[1];
    const forged = `${b64url(JSON.stringify(pB))}.${macA}`;
    expect(verifyPublicToken(forged, KEY)).toBeNull();
  });

  test('pA and pB get DISTINCT signatures (no cross-payload collision)', () => {
    expect(signPublicToken(pA, KEY).split('.')[1]).not.toBe(signPublicToken(pB, KEY).split('.')[1]);
    expect(verifyPublicToken(signPublicToken(pA, KEY), KEY)).toEqual(pA);
    expect(verifyPublicToken(signPublicToken(pB, KEY), KEY)).toEqual(pB);
  });

  test('MCP copy also signs the body (newline path stays in sync)', () => {
    const payload = freshPayload({ a: 'agentSync', p: 'media/x/ev\nil.png' });
    expect(signPublicTokenMcp(payload, KEY)).toBe(signPublicToken(payload, KEY));
    expect(verifyPublicToken(signPublicTokenMcp(payload, KEY), KEY)).toEqual(payload);
  });
});
