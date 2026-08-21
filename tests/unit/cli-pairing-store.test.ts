import { CliPairingStore, isCliChannel } from '../../src/cli-viewer/pairing-store';

/**
 * `/cli` pairing store — the device-authorization state machine behind the
 * webview terminal viewer. These pin the security-relevant transitions:
 *  - a link is not a credential (approval is required before consume),
 *  - first-writer-wins browser binding (a leaked/forwarded link opened in a
 *    second browser is rejected, and cannot ride the real user's approval),
 *  - approval must come from the pairing's own channel + user,
 *  - the access token is agent-scoped and single-issue.
 */
describe('isCliChannel()', () => {
  // Regression: the CliChannel type union was widened to include 'slack', but
  // the runtime guard was not updated to match — a Slack-originated /cli
  // pairing request would be silently rejected as an invalid channel.
  test('accepts every channel in the CliChannel union', () => {
    expect(isCliChannel('telegram')).toBe(true);
    expect(isCliChannel('discord')).toBe(true);
    expect(isCliChannel('line')).toBe(true);
    expect(isCliChannel('slack')).toBe(true);
  });
  test('rejects anything outside the union', () => {
    expect(isCliChannel('whatsapp')).toBe(false);
    expect(isCliChannel('')).toBe(false);
    expect(isCliChannel(undefined)).toBe(false);
    expect(isCliChannel(42)).toBe(false);
  });
});

describe('CliPairingStore', () => {
  const BROWSER = 'browser-token-aaa';
  const OTHER_BROWSER = 'browser-token-bbb';

  function pending() {
    const store = new CliPairingStore();
    const { pairingId, code } = store.create('agent-1', 'discord', 'user-9');
    return { store, pairingId, code };
  }

  it('creates a pending pairing with a 4-digit code', () => {
    const { store, pairingId, code } = pending();
    expect(pairingId).toMatch(/^[0-9a-f]{36}$/);
    expect(code).toMatch(/^\d{4}$/);
    expect(store.get(pairingId)?.status).toBe('pending');
  });

  it('does NOT consume before approval — a link alone unlocks nothing', () => {
    const { store, pairingId } = pending();
    expect(store.bindBrowser(pairingId, BROWSER)).toBe('bound');
    expect(store.consume(pairingId, BROWSER)).toBeNull();
  });

  it('full happy path: bind → approve → consume → resolveAccess (agent-scoped)', () => {
    const { store, pairingId } = pending();
    expect(store.bindBrowser(pairingId, BROWSER)).toBe('bound');
    expect(store.approve(pairingId, 'discord', 'user-9')).toBe('ok');
    const res = store.consume(pairingId, BROWSER);
    expect(res).not.toBeNull();
    const p = store.resolveAccess(res!.accessToken);
    expect(p?.agentId).toBe('agent-1');
    expect(p?.status).toBe('consumed');
  });

  it('first-writer-wins: a second browser is rejected and cannot consume', () => {
    const { store, pairingId } = pending();
    expect(store.bindBrowser(pairingId, BROWSER)).toBe('bound');
    expect(store.bindBrowser(pairingId, OTHER_BROWSER)).toBe('already');
    expect(store.approve(pairingId, 'discord', 'user-9')).toBe('ok');
    // Even after a real approval, the wrong browser gets nothing.
    expect(store.consume(pairingId, OTHER_BROWSER)).toBeNull();
    // The bound browser still succeeds.
    expect(store.consume(pairingId, BROWSER)).not.toBeNull();
  });

  it('approval must match the pairing channel and user', () => {
    const { store, pairingId } = pending();
    store.bindBrowser(pairingId, BROWSER);
    expect(store.approve(pairingId, 'telegram', 'user-9')).toBe('mismatch');
    expect(store.approve(pairingId, 'discord', 'someone-else')).toBe('mismatch');
    expect(store.get(pairingId)?.status).toBe('pending');
    expect(store.approve(pairingId, 'discord', 'user-9')).toBe('ok');
  });

  it('deny blocks the flow permanently', () => {
    const { store, pairingId } = pending();
    store.bindBrowser(pairingId, BROWSER);
    expect(store.deny(pairingId, 'discord', 'user-9')).toBe('ok');
    expect(store.approve(pairingId, 'discord', 'user-9')).toBe('gone');
    expect(store.consume(pairingId, BROWSER)).toBeNull();
  });

  it('consume is idempotent for the owning browser, single-issue otherwise', () => {
    const { store, pairingId } = pending();
    store.bindBrowser(pairingId, BROWSER);
    store.approve(pairingId, 'discord', 'user-9');
    const first = store.consume(pairingId, BROWSER)!;
    const again = store.consume(pairingId, BROWSER)!;
    expect(again.accessToken).toBe(first.accessToken);
    // A different browser cannot consume a consumed pairing.
    expect(store.consume(pairingId, OTHER_BROWSER)).toBeNull();
  });

  it('resolveAccess rejects unknown / empty tokens', () => {
    const { store } = pending();
    expect(store.resolveAccess('')).toBeNull();
    expect(store.resolveAccess('deadbeef')).toBeNull();
  });

  it('an expired pending pairing is gone; prune drops it', () => {
    const store = new CliPairingStore();
    const { pairingId } = store.create('agent-1', 'line', 'u1');
    const p = store.get(pairingId)!;
    p.expiresAt = Date.now() - 1; // force-expire
    expect(store.bindBrowser(pairingId, BROWSER)).toBe('gone');
    expect(store.approve(pairingId, 'line', 'u1')).toBe('gone');
    store.prune();
    expect(store.get(pairingId)).toBeUndefined();
  });

  it('prune removes access sessions past their TTL', () => {
    const { store, pairingId } = pending();
    store.bindBrowser(pairingId, BROWSER);
    store.approve(pairingId, 'discord', 'user-9');
    const res = store.consume(pairingId, BROWSER)!;
    store.get(pairingId)!.accessExpiresAt = Date.now() - 1; // force-expire access
    expect(store.resolveAccess(res.accessToken)).toBeNull();
    store.prune();
    expect(store.get(pairingId)).toBeUndefined();
  });
});
