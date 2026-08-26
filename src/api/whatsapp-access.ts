/**
 * WhatsApp DM/group access control — pure, stateless sender gate.
 *
 * Structural port of `slack-access.ts` (same closed-by-default posture,
 * same two-tier dmPolicy/groupPolicy shape — Slack is the right template
 * here, not the DM-only `sms-access.ts`, because WhatsApp has real groups).
 * The manager reads `whatsapp` config directly and calls this once per
 * inbound message — no env plumbing, no state files.
 *
 * Default (policy absent) is CLOSED: only ids in the allowlist pass. Set
 * `dmPolicy`/`groupPolicy`: 'open' to restore "reply to anyone" behavior.
 *
 * Allowlist entries MUST be WhatsApp JIDs (e.g. "66812345678@s.whatsapp.net"
 * for a DM sender, "1234567890-1234567890@g.us" for a group) — never a
 * bare phone number or a group's display name (renamable/ambiguous, same
 * footgun Slack/LINE's own doc comments call out).
 */
export function isWhatsAppSenderAllowed(
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
 * Structural view of a Baileys inbound message — the only fields the gate
 * needs. Kept local (not the Baileys `WAMessage` type) so this module stays
 * pure and trivially testable.
 */
export interface WhatsAppMessageLike {
  key?: {
    remoteJid?: string | null;
    /** Sender within a group (absent for 1:1 DMs, where remoteJid IS the sender). */
    participant?: string | null;
    /**
     * Phone-number JID for `participant`, present when WhatsApp's Linked ID
     * (LID) privacy system reports `participant` as a `@lid` address instead
     * of the classic `@s.whatsapp.net` phone JID.
     */
    participantPn?: string | null;
    /**
     * Phone-number JID for `remoteJid` on a 1:1 chat, present when LID
     * privacy reports `remoteJid` itself as `@lid` instead of the classic
     * `@s.whatsapp.net` form.
     */
    senderPn?: string | null;
    fromMe?: boolean | null;
  } | null;
  message?: {
    /** @mentioned JIDs, present on group messages that tag someone (including the bot). */
    extendedTextMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
    imageMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
  } | null;
}

export type WhatsAppSourceKind = 'user' | 'group' | 'other';

export interface ResolvedWhatsAppSource {
  /** Conversation key — the reply target: the DM JID or the group JID. */
  conversationId: string;
  /** The human who sent the message — same as conversationId for a DM, the participant JID for a group. */
  senderId: string;
  kind: WhatsAppSourceKind;
  /** @mentioned JIDs on this message (group messages only; empty for DMs). */
  mentionedJids: string[];
}

/** Map a raw Baileys message to {conversationId, senderId, kind, mentionedJids}. */
export function resolveWhatsAppSource(msg: WhatsAppMessageLike | undefined | null): ResolvedWhatsAppSource {
  const remoteJid = msg?.key?.remoteJid ?? '';
  if (!remoteJid) return { conversationId: '', senderId: '', kind: 'other', mentionedJids: [] };

  const mentionedJids =
    msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid ??
    msg?.message?.imageMessage?.contextInfo?.mentionedJid ??
    [];

  if (remoteJid.endsWith('@g.us')) {
    // Group: the sender is `participant`, the conversation is the group JID itself.
    // `participant` arrives as a `@lid` address (not the classic phone JID)
    // for some senders under WhatsApp's Linked ID privacy system — prefer
    // `participantPn` (the real phone-number JID) when Baileys supplies it.
    const participant = msg?.key?.participantPn || msg?.key?.participant || '';
    if (!participant) return { conversationId: '', senderId: '', kind: 'other', mentionedJids: [] };
    return { conversationId: remoteJid, senderId: participant, kind: 'group', mentionedJids };
  }
  if (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid')) {
    // DM: sender and conversation are (normally) the same JID. Under
    // WhatsApp's Linked ID (LID) privacy system, `remoteJid` itself can
    // arrive as `<id>@lid` instead of the classic `<phone>@s.whatsapp.net`
    // — reply on whichever JID we actually received the message on
    // (`remoteJid`), but gate on the real phone-number JID (`senderPn`, when
    // Baileys supplies it): allowlists are documented and configured in
    // phone-number JID form and would never match a bare `@lid`.
    const senderId = msg?.key?.senderPn || remoteJid;
    return { conversationId: remoteJid, senderId, kind: 'user', mentionedJids: [] };
  }
  // Broadcast lists, status updates, newsletters, etc. — not a supported source.
  return { conversationId: '', senderId: '', kind: 'other', mentionedJids: [] };
}

/** The subset of `whatsapp` config the conversation gate reads. */
export interface WhatsAppAccessConfig {
  dmPolicy?: 'open' | 'allowlist' | 'disabled';
  dmAllowlist?: string[];
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  groupAllowlist?: string[];
}

/**
 * Gate an already-resolved WhatsApp source. DMs are gated on the sender's
 * JID against `dmPolicy`/`dmAllowlist`; groups are gated on the group JID
 * against `groupPolicy`/`groupAllowlist`, closed by default — same posture
 * as DMs. Unknown source kinds are denied.
 */
export function isResolvedSourceAllowed(
  cfg: WhatsAppAccessConfig | undefined,
  resolved: ResolvedWhatsAppSource,
): boolean {
  const { conversationId, senderId, kind } = resolved;
  if (kind === 'user') {
    return isWhatsAppSenderAllowed(cfg?.dmPolicy, cfg?.dmAllowlist, senderId || conversationId);
  }
  if (kind === 'group') {
    return isWhatsAppSenderAllowed(cfg?.groupPolicy, cfg?.groupAllowlist, conversationId);
  }
  return false;
}

/**
 * Convenience wrapper that resolves a raw message and gates it in one call.
 * Equivalent to `isResolvedSourceAllowed(cfg, resolveWhatsAppSource(msg))`.
 */
export function isWhatsAppConversationAllowed(
  cfg: WhatsAppAccessConfig | undefined,
  msg: WhatsAppMessageLike | undefined | null,
): boolean {
  return isResolvedSourceAllowed(cfg, resolveWhatsAppSource(msg));
}

/**
 * @mention gate for groups (mirrors `slack`/`line`'s `requireMention`,
 * default true — only effective in groups, DMs always pass). Unlike Slack
 * (which infers "was mentioned" from the event *type* being `app_mention`)
 * Baileys hands every message's mentioned-JID list directly on
 * `contextInfo.mentionedJid` — no separate text-scanning heuristic needed,
 * just check one of the bot's own JIDs is in that list.
 *
 * Under WhatsApp's Linked ID (LID) privacy system a group can report the
 * mentioned bot using its `@lid` identity even though `sock.user.id` (the
 * phone-number JID we log in with) is the classic `@s.whatsapp.net` form —
 * two different strings for the same bot. Pass `botLid` (`sock.user.lid`)
 * alongside `botJid` (`sock.user.id`) so either form matches; omit it if
 * unknown (older Baileys / non-LID accounts) and only `botJid` is checked.
 */
export function wasBotMentioned(
  mentionedJids: string[],
  botJid: string | undefined,
  botLid?: string | null,
): boolean {
  if (!botJid && !botLid) return false;
  // WhatsApp JIDs occasionally carry a ":<device>" suffix on the *user* part
  // (multi-device, e.g. "66811112222:5@s.whatsapp.net") — strip only that
  // segment, not everything after the first colon, or the "@server" half
  // gets dropped too and a same-user-different-device JID never matches at
  // all (splitting on ':' before splitting on '@' would do exactly that).
  const normalize = (jid: string) => {
    const [userPart, server] = jid.split('@');
    return server ? `${userPart.split(':')[0]}@${server}` : userPart.split(':')[0];
  };
  const botIdentities = [botJid, botLid].filter((v): v is string => !!v).map(normalize);
  return mentionedJids.some((jid) => botIdentities.includes(normalize(jid)));
}
