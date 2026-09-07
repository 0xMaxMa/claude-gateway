import { PendingOAuthStore } from '../../src/connectors/pending-oauth-store';
import type { OAuthMetadata } from '../../src/connectors/mcp-oauth';

const metadata: OAuthMetadata = {
  resource: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
  authorizationEndpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
  tokenEndpoint: 'https://www.firecrawl.dev/api/oauth/token',
  scopesSupported: [],
};

function baseEntry() {
  return {
    connectorId: 'firecrawl',
    metadata,
    clientId: 'dyn_abc',
    redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
    codeVerifier: 'verifier-123',
  };
}

describe('PendingOAuthStore', () => {
  it('create() returns a state string, and consume() returns the exact flow that was stored', () => {
    const store = new PendingOAuthStore();
    const state = store.create(baseEntry());
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(10);

    const flow = store.consume(state);
    expect(flow).toMatchObject(baseEntry());
  });

  it('consume() is single-use — a second call for the same state returns null', () => {
    const store = new PendingOAuthStore();
    const state = store.create(baseEntry());
    expect(store.consume(state)).not.toBeNull();
    expect(store.consume(state)).toBeNull();
  });

  it('consume() returns null for an unknown state', () => {
    const store = new PendingOAuthStore();
    expect(store.consume('never-created')).toBeNull();
  });

  it('consume() returns null once the flow has expired, even though it was never consumed', () => {
    const store = new PendingOAuthStore();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const state = store.create(baseEntry());
    nowSpy.mockReturnValue(1_000_000 + 6 * 60 * 1000); // 6 minutes later, TTL is 5
    expect(store.consume(state)).toBeNull();
    nowSpy.mockRestore();
  });

  it('prune() removes expired flows but leaves live ones', () => {
    const store = new PendingOAuthStore();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const expiredState = store.create(baseEntry());
    nowSpy.mockReturnValue(1_000_000 + 6 * 60 * 1000);
    const liveState = store.create(baseEntry());
    expect(store.size()).toBe(2);
    store.prune();
    expect(store.size()).toBe(1);
    expect(store.consume(liveState)).not.toBeNull();
    nowSpy.mockRestore();
    void expiredState;
  });
});
