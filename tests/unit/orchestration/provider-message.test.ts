import { sanitizeProviderMessage } from '../../../src/orchestration/provider-message';

describe('sanitizeProviderMessage', () => {
  it('redacts any scheme inside the authorization header, including Token/Digest (F1)', () => {
    // The authorization-header rule redacts the whole value regardless of scheme,
    // so Token/Digest credentials are covered even though the bare-scheme rule
    // only lists Bearer/Basic — the comment now states this accurately.
    expect(sanitizeProviderMessage('authorization: Token abc123def'))
      .toBe('authorization: [redacted]');
    expect(sanitizeProviderMessage('authorization: Digest xyzsecret'))
      .toBe('authorization: [redacted]');
  });

  it('redacts the whole authorization value, including quoted multi-value params', () => {
    // The greedy to-line-end match is deliberate: a Digest header holds quoted
    // params, and stopping at the first quote would leak the rest of the line.
    const out = sanitizeProviderMessage('Authorization: Digest username="private-value", response="private-response"');
    expect(out).toBe('Authorization: [redacted]');
    expect(out).not.toMatch(/private/);
  });

  it('does not over-redact "token"/"digest" as ordinary words (F1)', () => {
    // Extending the bare-scheme rule to Token/Digest would wrongly redact common
    // provider prose such as "token limit"; the deliberate choice is to leave it.
    expect(sanitizeProviderMessage('token limit exceeded for this request'))
      .toBe('token limit exceeded for this request');
    expect(sanitizeProviderMessage('digest of the request body did not match'))
      .toBe('digest of the request body did not match');
  });
});
