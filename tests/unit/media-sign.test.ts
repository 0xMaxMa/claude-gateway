/**
 * Unit tests for the signed short-lived media-URL crypto core (src/api/media-sign.ts).
 *
 * These tokens gate the public `/media-public/:token` route (LINE image delivery):
 * an HMAC-SHA256 over { agentId, relPath, exp } keyed by the pod's gateway API key.
 * The whole security story rests on this pair of pure functions, so we lock in the
 * roundtrip AND every failure mode (wrong key, tamper, expiry, malformed input).
 *
 * The signing half is DUPLICATED in mcp/tools/line/media-sign.ts (the MCP subprocess
 * cannot import from src/), so the final block cross-checks that the two copies stay
 * byte-for-byte in sync — sign with the MCP copy, verify with the src copy.
 */
import {
  signMediaToken,
  verifyMediaToken,
  type MediaSignPayload,
} from '../../src/api/media-sign';
import { signMediaToken as signMediaTokenMcp } from '../../mcp/tools/line/media-sign';

const KEY = 'gw-api-key-abc123';
const OTHER_KEY = 'gw-api-key-different-999';

// A payload that expires far in the future so time never interferes with the
// non-expiry cases (the expiry case builds its own past-dated payload).
function freshPayload(over: Partial<MediaSignPayload> = {}): MediaSignPayload {
  return { a: 'agentA', p: 'media/chat1/pic.png', e: Date.now() + 60_000, ...over };
}

describe('signMediaToken() / verifyMediaToken() roundtrip', () => {
  test('valid token signed with KEY verifies with the same KEY → returns payload', () => {
    const payload = freshPayload();
    const token = signMediaToken(payload, KEY);
    expect(verifyMediaToken(token, KEY)).toEqual(payload);
  });

  test('token shape is base64url(body) "." base64url(mac)', () => {
    const token = signMediaToken(freshPayload(), KEY);
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    // base64url alphabet only — no +, /, or = padding
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe('verifyMediaToken() rejects forgeries', () => {
  test('wrong key → null (cannot forge without the signing key)', () => {
    const token = signMediaToken(freshPayload(), KEY);
    expect(verifyMediaToken(token, OTHER_KEY)).toBeNull();
  });

  test('tampered body (flip a char in the base64url payload) → null', () => {
    const token = signMediaToken(freshPayload(), KEY);
    const dot = token.indexOf('.');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    // Flip the first body char to a different base64url char.
    const flipped = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    expect(verifyMediaToken(`${flipped}.${sig}`, KEY)).toBeNull();
  });

  test('tampered signature (flip a char in the mac) → null', () => {
    const token = signMediaToken(freshPayload(), KEY);
    const dot = token.indexOf('.');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(verifyMediaToken(`${body}.${flipped}`, KEY)).toBeNull();
  });

  test('expired token (e in the past) → null even with the correct key', () => {
    const token = signMediaToken(freshPayload({ e: Date.now() - 1 }), KEY);
    expect(verifyMediaToken(token, KEY)).toBeNull();
  });

  test('empty secret → null (never verifies against no key)', () => {
    const token = signMediaToken(freshPayload(), KEY);
    expect(verifyMediaToken(token, '')).toBeNull();
  });
});

describe('verifyMediaToken() rejects malformed tokens', () => {
  test('no "." separator → null', () => {
    expect(verifyMediaToken('notoken', KEY)).toBeNull();
  });

  test('leading "." (empty body) → null', () => {
    expect(verifyMediaToken('.abc', KEY)).toBeNull();
  });

  test('garbage / non-base64 body → null', () => {
    expect(verifyMediaToken('!!!.@@@', KEY)).toBeNull();
  });

  test('empty string → null', () => {
    expect(verifyMediaToken('', KEY)).toBeNull();
  });

  test('body decodes to JSON with wrong field types → null', () => {
    // a=number, p=missing → schema check in verify rejects before HMAC compare.
    const badBody = Buffer.from(JSON.stringify({ a: 1, e: 'soon' }), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyMediaToken(`${badBody}.AAAA`, KEY)).toBeNull();
  });
});

describe('MCP sign copy stays in sync with the src verify copy', () => {
  test('sign with mcp/tools/line/media-sign, verify with src/api/media-sign → payload', () => {
    const payload = freshPayload({ a: 'agentSync', p: 'media/x/y.png' });
    const token = signMediaTokenMcp(payload, KEY);
    expect(verifyMediaToken(token, KEY)).toEqual(payload);
  });

  test('the two copies produce byte-identical tokens for the same input', () => {
    const payload = freshPayload({ a: 'agentSync', p: 'media/x/y.png' });
    expect(signMediaTokenMcp(payload, KEY)).toBe(signMediaToken(payload, KEY));
  });
});
