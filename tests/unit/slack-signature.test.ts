/**
 * Unit tests for verifySlackSignature (src/api/slack-webhook-router.ts) —
 * the security-critical HMAC check that gates every inbound Slack webhook
 * request. Pure crypto, no network. Previously untested: a comment in
 * slack-mcp.test.ts claimed coverage in a nonexistent "slack.test.ts".
 */
import { createHmac } from 'crypto';
import { verifySlackSignature } from '../../src/api/slack-webhook-router';

const SECRET = 'test-signing-secret';

function sign(timestamp: string, rawBody: string, secret = SECRET): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
}

describe('verifySlackSignature()', () => {
  test('accepts a correctly signed, fresh request', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from('{"type":"event_callback"}');
    const sig = sign(ts, body.toString('utf8'));
    expect(verifySlackSignature(body, SECRET, ts, sig)).toBe(true);
  });

  test('rejects a signature computed with the wrong secret', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from('{"a":1}');
    const sig = sign(ts, body.toString('utf8'), 'wrong-secret');
    expect(verifySlackSignature(body, SECRET, ts, sig)).toBe(false);
  });

  test('rejects when the body was tampered with after signing', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signedBody = 'original';
    const sig = sign(ts, signedBody);
    const tamperedBody = Buffer.from('tampered');
    expect(verifySlackSignature(tamperedBody, SECRET, ts, sig)).toBe(false);
  });

  test('rejects a stale timestamp (older than the 5-minute window)', () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const body = Buffer.from('{"a":1}');
    const sig = sign(staleTs, body.toString('utf8'));
    expect(verifySlackSignature(body, SECRET, staleTs, sig)).toBe(false);
  });

  test('rejects a timestamp from the future beyond the window', () => {
    const futureTs = String(Math.floor(Date.now() / 1000) + 6 * 60);
    const body = Buffer.from('{"a":1}');
    const sig = sign(futureTs, body.toString('utf8'));
    expect(verifySlackSignature(body, SECRET, futureTs, sig)).toBe(false);
  });

  test('rejects a non-numeric timestamp', () => {
    const body = Buffer.from('{"a":1}');
    const sig = sign('not-a-number', body.toString('utf8'));
    expect(verifySlackSignature(body, SECRET, 'not-a-number', sig)).toBe(false);
  });

  test('rejects when the signing secret is empty', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from('{"a":1}');
    const sig = sign(ts, body.toString('utf8'));
    expect(verifySlackSignature(body, '', ts, sig)).toBe(false);
  });

  test('rejects when the timestamp header is missing', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySlackSignature(body, SECRET, undefined, 'v0=deadbeef')).toBe(false);
  });

  test('rejects when the signature header is missing', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from('{"a":1}');
    expect(verifySlackSignature(body, SECRET, ts, undefined)).toBe(false);
  });

  test('rejects a signature of a different length (no timing-unsafe throw)', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from('{"a":1}');
    expect(verifySlackSignature(body, SECRET, ts, 'v0=short')).toBe(false);
  });
});
