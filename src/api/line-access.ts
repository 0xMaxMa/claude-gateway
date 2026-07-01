/**
 * LINE DM access control (Tier 1) — pure, stateless sender gate.
 *
 * Mirrors the simple DM branches of `mcp/tools/discord/access.ts` (minus the
 * pairing/state machine) and the closed-by-default posture of hermes-agent's
 * three-list gate (`plugins/platforms/line/adapter.py:_allowed_for_source`) and
 * openclaw's LINE `dmPolicy`. The webhook router reads `line` config directly
 * and calls this once per inbound event — no env plumbing, no state files.
 *
 * Default (policy absent) is CLOSED: only userIds in the allowlist pass. Set
 * `dmPolicy: 'open'` to restore "reply to anyone" behavior.
 */
export function isLineSenderAllowed(
  policy: 'open' | 'allowlist' | 'disabled' | undefined,
  allowlist: string[] | undefined,
  userId: string,
): boolean {
  if (policy === 'open') return true;
  if (policy === 'disabled') return false;
  // 'allowlist' OR undefined (closed default) → only listed senders pass.
  return !!userId && (allowlist ?? []).includes(userId);
}

/**
 * Structural view of a LINE event `source` block — the only fields the gate
 * needs. Kept local (not the SDK type) so this module stays pure and trivially
 * testable. LINE sources are one of:
 *   user  → { type: 'user',  userId }
 *   group → { type: 'group', groupId, userId? }   (userId present if the sender
 *   room  → { type: 'room',  roomId,  userId? }     consented to profile access)
 */
export interface LineSourceLike {
  type?: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export type LineSourceKind = 'user' | 'group' | 'room' | 'other';

export interface ResolvedLineSource {
  /** Conversation key — the reply/push target: userId (DM) / groupId / roomId. */
  conversationId: string;
  /** The human who sent the event (may be '' in groups w/o profile consent). */
  senderId: string;
  kind: LineSourceKind;
}

/** Map a raw LINE source to {conversationId, senderId, kind}. */
export function resolveLineSource(source: LineSourceLike | undefined | null): ResolvedLineSource {
  const type = source?.type;
  if (type === 'user') {
    const userId = source?.userId ?? '';
    return { conversationId: userId, senderId: userId, kind: 'user' };
  }
  if (type === 'group') {
    return { conversationId: source?.groupId ?? '', senderId: source?.userId ?? '', kind: 'group' };
  }
  if (type === 'room') {
    return { conversationId: source?.roomId ?? '', senderId: source?.userId ?? '', kind: 'room' };
  }
  return { conversationId: '', senderId: '', kind: 'other' };
}

/** The subset of `line` config the conversation gate reads. */
export interface LineAccessConfig {
  dmPolicy?: 'open' | 'allowlist' | 'disabled';
  dmAllowlist?: string[];
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  groupAllowlist?: string[];
}

/**
 * Gate an already-resolved LINE source (the hermes three-list model). DMs keep
 * the exact `isLineSenderAllowed` behavior; group/room are gated on the
 * conversation id (groupId/roomId) against `groupPolicy` + `groupAllowlist`,
 * closed by default — same posture as DMs. Unknown source kinds are denied.
 *
 * The webhook resolves the source once per event and reuses that result here (and
 * for `normalizeLineEvent`) rather than re-parsing the raw source three times.
 */
export function isResolvedSourceAllowed(
  cfg: LineAccessConfig | undefined,
  resolved: ResolvedLineSource,
): boolean {
  const { conversationId, kind } = resolved;
  if (kind === 'user') {
    return isLineSenderAllowed(cfg?.dmPolicy, cfg?.dmAllowlist, conversationId);
  }
  if (kind === 'group' || kind === 'room') {
    // Reuse the same closed-by-default semantics, keyed on the group/room id.
    return isLineSenderAllowed(cfg?.groupPolicy, cfg?.groupAllowlist, conversationId);
  }
  return false;
}

/**
 * Convenience wrapper that resolves a raw source and gates it in one call.
 * Equivalent to `isResolvedSourceAllowed(cfg, resolveLineSource(source))`.
 */
export function isLineConversationAllowed(
  cfg: LineAccessConfig | undefined,
  source: LineSourceLike | undefined | null,
): boolean {
  return isResolvedSourceAllowed(cfg, resolveLineSource(source));
}
