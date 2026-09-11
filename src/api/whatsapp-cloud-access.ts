/**
 * WhatsApp Business Cloud API DM access control — pure, stateless sender gate.
 *
 * Structural port of `whatsapp-access.ts` (the Baileys sibling), simplified:
 * the Cloud API has no group concept (a Business phone number cannot be added
 * to a group the way a personal/linked number can — every inbound message is
 * a 1:1 conversation with the business), so there is no group tier here at
 * all — `kind` is `'user' | 'other'`, not `'user' | 'group' | 'other'`.
 *
 * ⚠️ FOOTGUN: Cloud API's inbound `from` is a BARE PHONE-NUMBER STRING (e.g.
 * `"66812345678"` — digits only, no `+`, no `@s.whatsapp.net` suffix), NOT a
 * JID like Baileys hands `whatsapp-access.ts`. `dmAllowlist` entries here
 * MUST be bare digits — pasting a JID (`"66812345678@s.whatsapp.net"`) or a
 * `+`-prefixed E.164 string will silently never match. This is the exact
 * same class of footgun Slack/LINE's own doc comments call out for their
 * allowlists, just with a different wrong shape (JID/`+` instead of a name).
 *
 * Default (policy absent) is CLOSED: only ids in the allowlist pass. Set
 * `dmPolicy: 'open'` to restore "reply to anyone" behavior.
 */
export function isWhatsAppCloudSenderAllowed(
  policy: 'open' | 'allowlist' | 'disabled' | undefined,
  allowlist: string[] | undefined,
  id: string,
): boolean {
  if (policy === 'open') return true;
  if (policy === 'disabled') return false;
  // 'allowlist' OR undefined (closed default) → only listed ids pass.
  return !!id && (allowlist ?? []).includes(id);
}

export type WhatsAppCloudSourceKind = 'user' | 'other';

export interface ResolvedWhatsAppCloudSource {
  /** Conversation key — the reply target: the sender's bare phone-number string. */
  conversationId: string;
  /** The human who sent the message — always the same as conversationId (no groups). */
  senderId: string;
  kind: WhatsAppCloudSourceKind;
}

/**
 * Map a raw inbound Cloud API `from` field to {conversationId, senderId, kind}.
 * `from` is always a bare phone-number string on a real webhook payload —
 * empty/missing is the only "other" case, since there is no group tier to
 * misclassify into.
 */
export function resolveWhatsAppCloudSource(from: string | undefined | null): ResolvedWhatsAppCloudSource {
  const id = from ?? '';
  if (!id) return { conversationId: '', senderId: '', kind: 'other' };
  return { conversationId: id, senderId: id, kind: 'user' };
}

/** The subset of `whatsapp_cloud` config the conversation gate reads. */
export interface WhatsAppCloudAccessConfig {
  dmPolicy?: 'open' | 'allowlist' | 'disabled';
  dmAllowlist?: string[];
}

/**
 * Gate an already-resolved WhatsApp Cloud source. Every source is a DM
 * (`kind === 'user'`), gated on the sender's bare phone number against
 * `dmPolicy`/`dmAllowlist`. Unknown/empty source kinds are denied.
 */
export function isResolvedWhatsAppCloudSourceAllowed(
  cfg: WhatsAppCloudAccessConfig | undefined,
  resolved: ResolvedWhatsAppCloudSource,
): boolean {
  const { conversationId, senderId, kind } = resolved;
  if (kind === 'user') {
    return isWhatsAppCloudSenderAllowed(cfg?.dmPolicy, cfg?.dmAllowlist, senderId || conversationId);
  }
  return false;
}
