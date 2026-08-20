/**
 * Slack DM/channel access control — pure, stateless sender gate.
 *
 * Direct structural port of `line-access.ts` (same closed-by-default posture,
 * same policy/allowlist shape) — see that file's own doc comment for the
 * broader lineage (hermes-agent's three-list gate, openclaw's `dmPolicy`).
 * The webhook router reads `slack` config directly and calls this once per
 * inbound event — no env plumbing, no state files.
 *
 * `kind` uses LINE's own `'user' | 'group' | 'room' | 'other'` vocabulary,
 * narrowed to `'user' | 'group'` here since Slack has no room-equivalent —
 * kept as a subset (not a separate type) so `isResolvedSourceAllowed`-shaped
 * dispatch logic reads identically across both channels.
 *
 * Default (policy absent) is CLOSED: only ids in the allowlist pass. Set
 * `dmPolicy'/'groupPolicy': 'open'` to restore "reply to anyone" behavior.
 *
 * Allowlist entries MUST be stable Slack ids ("U..." for users, "C..." for
 * channels) — never display names or channel names. Slack channel names can
 * be renamed or are ambiguous across workspaces; a name-keyed allowlist entry
 * silently never matches (see openclaw's docs, which call this out as a
 * common footgun).
 */
export function isSlackSenderAllowed(
  policy: 'open' | 'allowlist' | 'disabled' | undefined,
  allowlist: string[] | undefined,
  id: string,
): boolean {
  if (policy === 'open') return true;
  if (policy === 'disabled') return false;
  // 'allowlist' OR undefined (closed default) → only listed ids pass.
  return !!id && (allowlist ?? []).includes(id);
}

/**
 * Structural view of a Slack Events API `event` — the only fields the gate
 * needs. Kept local (not the Slack SDK type) so this module stays pure and
 * trivially testable. Slack sources are one of:
 *   im (DM)  → { channel_type: 'im',      channel, user }
 *   channel  → { channel_type: 'channel', channel, user }  (also 'group'/'mpim', both treated as 'group' here)
 */
export interface SlackEventLike {
  channel?: string;
  channel_type?: string;
  user?: string;
}

export type SlackSourceKind = 'user' | 'group' | 'other';

export interface ResolvedSlackSource {
  /** Conversation key — the reply target: the Slack channel id (DM channel id for `im`, channel id for `channel`/`group`/`mpim`). */
  conversationId: string;
  /** The human who sent the event. */
  senderId: string;
  kind: SlackSourceKind;
}

/** Map a raw Slack event to {conversationId, senderId, kind}. */
export function resolveSlackSource(event: SlackEventLike | undefined | null): ResolvedSlackSource {
  const channelType = event?.channel_type;
  const conversationId = event?.channel ?? '';
  const senderId = event?.user ?? '';
  if (!conversationId) return { conversationId: '', senderId: '', kind: 'other' };
  if (channelType === 'im') return { conversationId, senderId, kind: 'user' };
  if (channelType === 'channel' || channelType === 'group' || channelType === 'mpim') {
    return { conversationId, senderId, kind: 'group' };
  }
  return { conversationId: '', senderId: '', kind: 'other' };
}

/** The subset of `slack` config the conversation gate reads. */
export interface SlackAccessConfig {
  dmPolicy?: 'open' | 'allowlist' | 'disabled';
  dmAllowlist?: string[];
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  groupAllowlist?: string[];
}

/**
 * Gate an already-resolved Slack source. DMs are gated on the sender's user
 * id against `dmPolicy`/`dmAllowlist`; channels are gated on the
 * conversation id (the channel id) against `groupPolicy`/`groupAllowlist`,
 * closed by default — same posture as DMs. Unknown source kinds are denied.
 */
export function isResolvedSourceAllowed(
  cfg: SlackAccessConfig | undefined,
  resolved: ResolvedSlackSource,
): boolean {
  const { conversationId, senderId, kind } = resolved;
  if (kind === 'user') {
    return isSlackSenderAllowed(cfg?.dmPolicy, cfg?.dmAllowlist, senderId || conversationId);
  }
  if (kind === 'group') {
    return isSlackSenderAllowed(cfg?.groupPolicy, cfg?.groupAllowlist, conversationId);
  }
  return false;
}

/**
 * Convenience wrapper that resolves a raw event and gates it in one call.
 * Equivalent to `isResolvedSourceAllowed(cfg, resolveSlackSource(event))`.
 */
export function isSlackConversationAllowed(
  cfg: SlackAccessConfig | undefined,
  event: SlackEventLike | undefined | null,
): boolean {
  return isResolvedSourceAllowed(cfg, resolveSlackSource(event));
}
