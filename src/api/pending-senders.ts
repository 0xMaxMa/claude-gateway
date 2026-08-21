/**
 * "Pending senders" — in-memory discovery aid for the Tier 1 allowlist,
 * shared across every webhook channel (LINE first, Slack now). When a
 * webhook access gate drops a sender that is not on the allowlist, we
 * remember them here (with their display name, best-effort) so the admin
 * can see who is pending and one-click-add them from the UI instead of
 * grepping the channel's webhook log.
 *
 * Namespaced by `channel` (not just `agentId`): an agent can have more than
 * one webhook channel connected at once (e.g. LINE + Slack), and their ids
 * are drawn from unrelated id spaces — without the channel dimension, two
 * channels' pending lists would merge into one and a same-shaped id from
 * one channel could collide with (or be evicted by) an unrelated one from
 * another. `channel` is always a literal like `'line'`/`'slack'`, supplied
 * by that channel's own webhook router — this module has no channel-specific
 * knowledge itself.
 *
 * Intentionally ephemeral: a process-lifetime Map, no persistence. Adding to
 * the allowlist is the durable action (config.json via the agent PATCH API);
 * this is just a transient "pending list". Bounded per (channel, agent) so a
 * flood can't grow it.
 */
import { randomBytes } from 'crypto';

export interface PendingSender {
  /** The conversation/sender id: a userId (DM), groupId, or roomId/channel id. */
  userId: string;
  /** Best-effort display name: the channel's own profile/group name. */
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
 * Max distinct senders retained per (channel, agent) (oldest evicted first).
 * Kept at 5 to match the per-kind pending cap in the Telegram/Discord gate
 * (countPending ⇒ 5 for each of DM and group), so every channel bounds
 * unapproved knocks the same way and a flood can't exhaust memory.
 */
export const MAX_PENDING_PER_AGENT = 5;

// "channel:agentId" -> (id -> entry)  (id = userId | groupId | roomId, meaning is channel-specific)
const store = new Map<string, Map<string, PendingSender>>();

function storeKey(channel: string, agentId: string): string {
  return `${channel}:${agentId}`;
}

/**
 * Record a denied knock (DM sender or group/room conversation). Dedups by id
 * within (channel, agentId) (bumps count + lastSeen, fills in a name/kind if
 * newly resolved). Evicts the least-recently-seen entry when the per-(channel,
 * agent) cap is exceeded.
 *
 * `code` is set only when the entry is newly created (never overwritten on
 * dedup), so a pairing code stays stable. Returns `true` when this call created
 * a new entry (first contact) — the webhook uses this to send the pairing code
 * exactly once.
 */
function recordDenied(
  channel: string,
  agentId: string,
  id: string,
  kind: 'user' | 'group' | 'room',
  displayName: string | undefined,
  now: number,
  code?: string,
): boolean {
  if (!channel || !agentId || !id) return false;
  const key = storeKey(channel, agentId);
  let byId = store.get(key);
  if (!byId) {
    byId = new Map<string, PendingSender>();
    store.set(key, byId);
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
  channel: string,
  agentId: string,
  userId: string,
  displayName?: string,
  now: number = Date.now(),
  code?: string,
): boolean {
  return recordDenied(channel, agentId, userId, 'user', displayName, now, code);
}

/**
 * Record a denied group/room conversation (Tier 3 discovery). Returns true on
 * first contact (entry newly created).
 */
export function recordDeniedConversation(
  channel: string,
  agentId: string,
  conversationId: string,
  kind: 'group' | 'room',
  name?: string,
  now: number = Date.now(),
  code?: string,
): boolean {
  return recordDenied(channel, agentId, conversationId, kind, name, now, code);
}

/** Pending senders for a (channel, agent), most-recent first. */
export function getPendingSenders(channel: string, agentId: string): PendingSender[] {
  const byId = store.get(storeKey(channel, agentId));
  if (!byId) return [];
  return [...byId.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/** One pending-sender entry by id (used to reuse an already-minted pairing code). */
export function getPendingSender(channel: string, agentId: string, id: string): PendingSender | undefined {
  return store.get(storeKey(channel, agentId))?.get(id);
}

/** Drop an entry from the pending list (e.g. once added to an allowlist). */
export function clearPendingSender(channel: string, agentId: string, id: string): void {
  store.get(storeKey(channel, agentId))?.delete(id);
}

/** Test/maintenance helper — wipe all retained senders. */
export function _resetPendingSenders(): void {
  store.clear();
}
