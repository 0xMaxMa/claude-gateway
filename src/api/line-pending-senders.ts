/**
 * LINE "pending senders" — in-memory discovery aid for the Tier 1 allowlist.
 * When the webhook access gate drops a sender that is not on the allowlist, we
 * remember them here (with their LINE display name, best-effort) so the admin
 * can see who is pending and one-click-add them from the UI instead of grepping
 * `line-webhook.log`.
 *
 * Intentionally ephemeral: a process-lifetime Map, no persistence. Adding to the
 * allowlist is the durable action (config.json via the agent PATCH API); this is
 * just a transient "pending list". Bounded per agent so a flood can't grow it.
 */
import { randomBytes } from 'crypto';

export interface PendingSender {
  /** The conversation/sender id: a userId (DM), groupId, or roomId. */
  userId: string;
  /** Best-effort display name: LINE profile name (user) or group name (group). */
  displayName?: string;
  /** Source kind, so the UI can label rooms and filter against the right list. */
  kind?: 'user' | 'group' | 'room';
  /**
   * One-time pairing code (pairing mode). Minted once when the entry is created
   * and never overwritten on dedup, so it stays stable for the admin to match
   * against what the sender reports. Absent when pairing is off.
   */
  code?: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

/** Mint a short visual-match pairing code (6 uppercase hex). */
export function generatePairingCode(): string {
  return randomBytes(3).toString('hex').toUpperCase();
}

/**
 * Max distinct senders retained per agent (oldest evicted first). Kept at 5 to
 * match the per-kind pending cap in the Telegram/Discord gate (countPending ⇒ 5
 * for each of DM and group), so every channel bounds unapproved knocks the same
 * way and a flood can't exhaust memory.
 */
export const MAX_PENDING_PER_AGENT = 5;

// agentId -> (id -> entry)  (id = userId | groupId | roomId)
const store = new Map<string, Map<string, PendingSender>>();

/**
 * Record a denied knock (DM sender or group/room conversation). Dedups by id
 * (bumps count + lastSeen, fills in a name/kind if newly resolved). Evicts the
 * least-recently-seen entry when the per-agent cap is exceeded.
 *
 * `code` is set only when the entry is newly created (never overwritten on
 * dedup), so a pairing code stays stable. Returns `true` when this call created
 * a new entry (first contact) — the webhook uses this to send the pairing code
 * exactly once.
 */
function recordDenied(
  agentId: string,
  id: string,
  kind: 'user' | 'group' | 'room',
  displayName: string | undefined,
  now: number,
  code?: string,
): boolean {
  if (!agentId || !id) return false;
  let byId = store.get(agentId);
  if (!byId) {
    byId = new Map<string, PendingSender>();
    store.set(agentId, byId);
  }

  const existing = byId.get(id);
  if (existing) {
    existing.lastSeen = now;
    existing.count += 1;
    if (displayName && !existing.displayName) existing.displayName = displayName;
    if (!existing.kind) existing.kind = kind;
    return false;
  }

  byId.set(id, { userId: id, displayName, kind, code, firstSeen: now, lastSeen: now, count: 1 });

  if (byId.size > MAX_PENDING_PER_AGENT) {
    let oldestId: string | null = null;
    let oldestTs = Infinity;
    for (const [eid, entry] of byId) {
      if (entry.lastSeen < oldestTs) {
        oldestTs = entry.lastSeen;
        oldestId = eid;
      }
    }
    if (oldestId) byId.delete(oldestId);
  }
  return true;
}

/**
 * Record a denied 1:1 DM sender (Tier 1 discovery). Returns true on first
 * contact (entry newly created).
 */
export function recordDeniedSender(
  agentId: string,
  userId: string,
  displayName?: string,
  now: number = Date.now(),
  code?: string,
): boolean {
  return recordDenied(agentId, userId, 'user', displayName, now, code);
}

/**
 * Record a denied group/room conversation (Tier 3 discovery). Returns true on
 * first contact (entry newly created).
 */
export function recordDeniedConversation(
  agentId: string,
  conversationId: string,
  kind: 'group' | 'room',
  name?: string,
  now: number = Date.now(),
  code?: string,
): boolean {
  return recordDenied(agentId, conversationId, kind, name, now, code);
}

/** Pending senders for an agent, most-recent first. */
export function getPendingSenders(agentId: string): PendingSender[] {
  const byId = store.get(agentId);
  if (!byId) return [];
  return [...byId.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/** One pending-sender entry by id (used to reuse an already-minted pairing code). */
export function getPendingSender(agentId: string, id: string): PendingSender | undefined {
  return store.get(agentId)?.get(id);
}

/** Drop an entry from the pending list (e.g. once added to an allowlist). */
export function clearPendingSender(agentId: string, id: string): void {
  store.get(agentId)?.delete(id);
}

/** Test/maintenance helper — wipe all retained senders. */
export function _resetPendingSenders(): void {
  store.clear();
}
