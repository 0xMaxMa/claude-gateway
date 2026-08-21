import crypto from 'crypto';
import { type ChatChannel, isChatChannel } from '../history/types';

/**
 * Chat channel a `/cli` pairing originated from. The channel already
 * authenticated the requesting user (allowlist / pairing gate) before a pairing
 * is ever created, so the channel + user id recorded here is a trusted binding.
 */
export type CliChannel = ChatChannel;

/** Runtime guard for the trusted channel set (payloads cross a process boundary). */
export const isCliChannel = isChatChannel;

/**
 * Pairing lifecycle:
 *   pending   — created by `/cli`, waiting for proof (chat-approve or initData).
 *   approved  — the authenticated chat user approved (or initData verified).
 *   consumed  — a browser exchanged the approval for an access session cookie.
 *   denied    — the user explicitly rejected.
 */
export type CliPairingStatus = 'pending' | 'approved' | 'consumed' | 'denied';

export interface CliPairing {
  /** Random, URL-safe id in the `/cli/<id>` link. NOT a secret on its own —
   *  approval on an authenticated channel is still required to unlock. */
  pairingId: string;
  agentId: string;
  channel: CliChannel;
  /** Channel user id the pairing was minted for. Approval must come from this
   *  same user, and (Telegram) initData's user id must match it. */
  userId: string;
  /** Short human-readable code shown both in chat and in the browser so the
   *  operator can visually confirm the browser they opened is the right one. */
  code: string;
  status: CliPairingStatus;
  /** Bound to the first browser that opens the link (first-writer-wins). The
   *  access session is only ever issued to the browser holding this token, so a
   *  later opener (e.g. a leaked link) cannot ride someone else's approval. */
  browserToken?: string;
  /** Issued once, at consume time; carried by the `cli_session` cookie and
   *  resolved back to this (agent-scoped) pairing on every viewer request. */
  accessToken?: string;
  createdAt: number;
  /** Approval window — a pending pairing past this is dead. */
  expiresAt: number;
  /** Access session lifetime — set at consume; the viewer is locked out after. */
  accessExpiresAt?: number;
}

/** Approval window: how long the operator has to approve after `/cli`. */
const PAIRING_TTL_MS = 3 * 60 * 1000;
/** Viewer session lifetime once unlocked. Short — re-run `/cli` to renew. */
const ACCESS_TTL_MS = 30 * 60 * 1000;

export interface CreatedPairing {
  pairingId: string;
  code: string;
}

/**
 * In-memory store of `/cli` webview pairings (device-authorization flow).
 *
 * A single process-wide instance is shared by the runner's callback handler
 * (which creates and approves pairings on behalf of the authenticated chat) and
 * the gateway HTTP routes (which serve the browser side). Mirrors the singleton
 * shape of `pty-stream-registry` so both sides reference one source of truth
 * without threading a dependency through constructors.
 *
 * Security model: the pairing id in the URL is not a credential. Unlocking a
 * viewer requires EITHER a chat approval from the pairing's own user (Discord /
 * LINE) OR a verified Telegram initData whose user id matches — both gated by
 * the channel's existing allowlist. The resulting access session is scoped to a
 * single agent; it never carries admin/dashboard authority.
 */
export class CliPairingStore {
  private readonly pairings = new Map<string, CliPairing>();

  /** Create a pending pairing for an authenticated chat user. */
  create(agentId: string, channel: CliChannel, userId: string): CreatedPairing {
    const pairingId = crypto.randomBytes(18).toString('hex');
    // 4-digit visual-confirm code (0000–9999). Not a secret — it only helps the
    // operator confirm the browser matches; security rests on channel approval.
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const now = Date.now();
    this.pairings.set(pairingId, {
      pairingId,
      agentId,
      channel,
      userId,
      code,
      status: 'pending',
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
    });
    return { pairingId, code };
  }

  /** Raw lookup (no expiry filtering) — callers decide how to treat state. */
  get(pairingId: string): CliPairing | undefined {
    return this.pairings.get(pairingId);
  }

  /** True when a pairing is still within its pre-consume approval window. */
  private isLive(p: CliPairing | undefined): p is CliPairing {
    return !!p && p.status !== 'consumed' && p.status !== 'denied' && p.expiresAt > Date.now();
  }

  /**
   * Bind (or re-check) the browser that opened the link. First-writer-wins: the
   * first browser to GET the link owns the pairing. A different browser (no or
   * mismatched token) gets `'already'` — a leaked/forwarded link opened
   * elsewhere is visibly rejected rather than silently sharing the session.
   */
  bindBrowser(pairingId: string, browserToken: string): 'bound' | 'already' | 'gone' {
    const p = this.pairings.get(pairingId);
    // A consumed pairing is still reachable by its own bound browser (the viewer
    // keeps loading), so allow the matching token through even post-consume.
    if (!p || p.status === 'denied' || (p.status !== 'consumed' && p.expiresAt <= Date.now())) {
      return 'gone';
    }
    if (!p.browserToken) {
      p.browserToken = browserToken;
      return 'bound';
    }
    return p.browserToken === browserToken ? 'bound' : 'already';
  }

  /**
   * Approve via an authenticated chat action (Discord / LINE) or a verified
   * Telegram initData. The approving user and channel must match the pairing.
   */
  approve(pairingId: string, channel: CliChannel, userId: string): 'ok' | 'mismatch' | 'gone' {
    const p = this.pairings.get(pairingId);
    if (!this.isLive(p)) return 'gone';
    if (p.channel !== channel || p.userId !== userId) return 'mismatch';
    if (p.status === 'pending') p.status = 'approved';
    return 'ok';
  }

  /** Explicit rejection from the authenticated chat user. */
  deny(pairingId: string, channel: CliChannel, userId: string): 'ok' | 'mismatch' | 'gone' {
    const p = this.pairings.get(pairingId);
    if (!this.isLive(p)) return 'gone';
    if (p.channel !== channel || p.userId !== userId) return 'mismatch';
    p.status = 'denied';
    return 'ok';
  }

  /**
   * Exchange an approval for an access session. Returns the access token exactly
   * once per pairing. `requireBrowserToken` enforces that only the bound browser
   * (Discord / LINE device flow) may consume; the Telegram initData path proves
   * identity cryptographically in the same request and passes it through here
   * with the freshly-bound token.
   */
  consume(pairingId: string, browserToken: string): { accessToken: string } | null {
    const p = this.pairings.get(pairingId);
    if (!p) return null;
    // Idempotent for the owning browser: a repeat call returns the same token so
    // a re-poll after unlock still works.
    if (p.status === 'consumed') {
      if (p.accessToken && p.browserToken === browserToken && (p.accessExpiresAt ?? 0) > Date.now()) {
        return { accessToken: p.accessToken };
      }
      return null;
    }
    if (p.status !== 'approved' || p.expiresAt <= Date.now()) return null;
    if (!p.browserToken || p.browserToken !== browserToken) return null;
    const accessToken = crypto.randomBytes(32).toString('hex');
    p.accessToken = accessToken;
    p.status = 'consumed';
    p.accessExpiresAt = Date.now() + ACCESS_TTL_MS;
    return { accessToken };
  }

  /**
   * Issue an access session for the Telegram initData fast-path. Identity is
   * already proven cryptographically (the caller verified the signed initData and
   * that its user matches the pairing), so — unlike the Discord/LINE device flow —
   * this does NOT depend on the first-writer browser binding: a Telegram Mini App
   * webview may not replay the `cli_pair` cookie set on the initial page load, so
   * we (re)bind this browser and issue. Idempotent for the same browser.
   */
  issueAccessForVerifiedUser(pairingId: string, browserToken: string): { accessToken: string } | null {
    const p = this.pairings.get(pairingId);
    if (!p || p.status === 'denied') return null;
    if (p.status === 'consumed') {
      if (p.accessToken && p.browserToken === browserToken && (p.accessExpiresAt ?? 0) > Date.now()) {
        return { accessToken: p.accessToken };
      }
      return null;
    }
    if (p.expiresAt <= Date.now()) return null;
    p.browserToken = browserToken;
    const accessToken = crypto.randomBytes(32).toString('hex');
    p.accessToken = accessToken;
    p.status = 'consumed';
    p.accessExpiresAt = Date.now() + ACCESS_TTL_MS;
    return { accessToken };
  }

  /**
   * Resolve an access-session token to its (agent-scoped) pairing. Used by every
   * viewer request to authorize and to learn which single agent it may touch.
   */
  resolveAccess(accessToken: string): CliPairing | null {
    if (!accessToken) return null;
    for (const p of this.pairings.values()) {
      if (
        p.status === 'consumed' &&
        p.accessToken === accessToken &&
        (p.accessExpiresAt ?? 0) > Date.now()
      ) {
        return p;
      }
    }
    return null;
  }

  /** Drop dead pairings: expired-and-unconsumed, or access sessions past TTL. */
  prune(): void {
    const now = Date.now();
    for (const [id, p] of this.pairings) {
      const deadPending = p.status !== 'consumed' && p.expiresAt <= now;
      const deadAccess = p.status === 'consumed' && (p.accessExpiresAt ?? 0) <= now;
      if (deadPending || deadAccess) this.pairings.delete(id);
    }
  }

  /** Test/introspection helper. */
  size(): number {
    return this.pairings.size;
  }
}

/** Process-wide singleton shared by the runner callback and the gateway routes. */
export const cliPairingStore = new CliPairingStore();
