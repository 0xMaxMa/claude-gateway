/**
 * Unit tests for verifyMetaSignature (src/api/whatsapp-cloud-webhook-router.ts)
 * — the security-critical HMAC check that gates every inbound WhatsApp Cloud
 * webhook request. Pure crypto, no network. Ports slack-signature.test.ts's
 * test list MINUS the 2 timestamp-staleness cases — Meta's scheme has no
 * timestamp component at all, unlike Slack's "v0:{ts}:{body}" — plus two new
 * cases specific to Meta's `sha256=<hex>` header format.
 */
import { createHmac } from 'crypto';
import { verifyMetaSignature } from '../../src/api/whatsapp-cloud-webhook-router';

const SECRET = 'test-app-secret';

function sign(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

describe('verifyMetaSignature()', () => {
  test('accepts a correctly signed request', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}');
    const sig = sign(body.toString('utf8'));
    expect(verifyMetaSignature(body, SECRET, sig)).toBe(true);
  });

  test('rejects a signature computed with the wrong secret', () => {
    const body = Buffer.from('{"a":1}');
    const sig = sign(body.toString('utf8'), 'wrong-secret');
    expect(verifyMetaSignature(body, SECRET, sig)).toBe(false);
  });

  test('rejects when the body was tampered with after signing', () => {
    const signedBody = 'original';
    const sig = sign(signedBody);
    const tamperedBody = Buffer.from('tampered');
    expect(verifyMetaSignature(tamperedBody, SECRET, sig)).toBe(false);
  });

  test('rejects when the app secret is empty', () => {
    const body = Buffer.from('{"a":1}');
    const sig = sign(body.toString('utf8'));
    expect(verifyMetaSignature(body, '', sig)).toBe(false);
  });

  test('rejects when the signature header is missing', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyMetaSignature(body, SECRET, undefined)).toBe(false);
  });

  test('rejects a signature of a different length (no timing-unsafe throw)', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyMetaSignature(body, SECRET, 'sha256=short')).toBe(false);
  });

  // New vs. Slack's list: Meta's header format is `sha256=<hex>` specifically
  // (not Slack's `v0=<hex>`) — a header missing the prefix must be rejected
  // outright, not compared byte-for-byte against an expected value that also
  // lacks it.
  test('rejects a signature header missing the "sha256=" prefix', () => {
    const body = Buffer.from('{"a":1}');
    const expectedHex = createHmac('sha256', SECRET).update(body.toString('utf8')).digest('hex');
    expect(verifyMetaSignature(body, SECRET, expectedHex)).toBe(false);
  });

  // Same length as a valid signature, but wrong value — must not slip through
  // via a length-only check.
  test('rejects a same-length-but-wrong-value signature', () => {
    const body = Buffer.from('{"a":1}');
    const valid = sign(body.toString('utf8'));
    const wrongButSameLength = `sha256=${'0'.repeat(valid.length - 'sha256='.length)}`;
    expect(wrongButSameLength.length).toBe(valid.length);
    expect(verifyMetaSignature(body, SECRET, wrongButSameLength)).toBe(false);
  });
});
