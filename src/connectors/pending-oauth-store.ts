import crypto from 'crypto';
import type { OAuthMetadata } from './mcp-oauth';

/**
 * In-memory bridge between a `POST .../oauth/start` call and the later
 * `GET /oauth/mcp/callback` the provider redirects the user's browser to.
 * Modeled directly on `cli-viewer/pairing-store.ts`'s `CliPairingStore`: a
 * `Map` keyed by a random, single-use, TTL'd id (the OAuth `state` value
 * here), pruned on the same interval as that store.
 *
 * Deliberately NOT persisted to disk — a flow is only ever a few minutes
 * from start to callback; a gateway restart mid-flow just means the user
 * clicks "Connect" again.
 */
export interface PendingOAuth {
  connectorId: string;
  metadata: OAuthMetadata;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  createdAt: number;
  expiresAt: number;
}

const FLOW_TTL_MS = 5 * 60 * 1000;

export class PendingOAuthStore {
  private readonly flows = new Map<string, PendingOAuth>();

  /** Start a flow, returning the `state` value to embed in the authorize URL. */
  create(entry: Omit<PendingOAuth, 'createdAt' | 'expiresAt'>): string {
    const state = crypto.randomBytes(16).toString('base64url');
    const now = Date.now();
    this.flows.set(state, { ...entry, createdAt: now, expiresAt: now + FLOW_TTL_MS });
    return state;
  }

  /**
   * Consume (single-use) the flow for `state`. Returns null if unknown,
   * expired, or already consumed — the callback handler treats all three the
   * same way (a generic "this sign-in link expired, try again" response).
   */
  consume(state: string): PendingOAuth | null {
    const flow = this.flows.get(state);
    if (!flow) return null;
    this.flows.delete(state);
    if (flow.expiresAt <= Date.now()) return null;
    return flow;
  }

  /** Drop expired flows. Call on the same interval as `cliPairingStore.prune()`. */
  prune(): void {
    const now = Date.now();
    for (const [state, flow] of this.flows) {
      if (flow.expiresAt <= now) this.flows.delete(state);
    }
  }

  /** Test/introspection helper. */
  size(): number {
    return this.flows.size;
  }
}

/** Process-wide singleton — mirrors `cliPairingStore`'s shape. */
export const pendingOAuthStore = new PendingOAuthStore();
