/**
 * WeChat DM access control — pure, stateless sender gate.
 *
 * Structural port of `line-access.ts`'s DM tier, minus the group/room tier
 * entirely: the iLink Bot API bridge this channel runs on cannot deliver
 * WeChat group events reliably (confirmed by both the Hermes-agent and
 * OpenClaw source docs this channel was researched from), so every inbound
 * WeChat message is treated as a 1:1 conversation gated on `dmPolicy`/
 * `dmAllowlist` alone — same shape as `sms-access.ts` in that respect, but
 * WeChat also supports the `pairing` knock-discovery aid every other
 * allowlisted channel (LINE/Slack) has, so it keeps that field.
 *
 * Default (policy absent) is CLOSED: only ids in the allowlist pass. Set
 * `dmPolicy: 'open'` to restore "reply to anyone" behavior.
 */
export function isWeChatSenderAllowed(
  policy: 'open' | 'allowlist' | 'disabled' | undefined,
  allowlist: string[] | undefined,
  senderId: string,
): boolean {
  if (policy === 'open') return true;
  if (policy === 'disabled') return false;
  // 'allowlist' OR undefined (closed default) → only listed senders pass.
  return !!senderId && (allowlist ?? []).includes(senderId);
}

/**
 * Structural view of an inbound iLink message — the only field the gate
 * needs. Every inbound WeChat message resolves to a 1:1 conversation: the
 * conversation id and sender id are both the sender's iLink user id.
 */
export interface WeChatMessageLike {
  fromId?: string;
}

export interface ResolvedWeChatSource {
  /** Conversation key — the reply target: the sender's iLink user id. */
  conversationId: string;
  /** The human who sent the message — same as conversationId for WeChat. */
  senderId: string;
}

/** Map a raw inbound iLink message to {conversationId, senderId}. */
export function resolveWeChatSource(
  message: WeChatMessageLike | undefined | null,
): ResolvedWeChatSource {
  const fromId = message?.fromId ?? '';
  return { conversationId: fromId, senderId: fromId };
}

/** The subset of `wechat` config the conversation gate reads. */
export interface WeChatAccessConfig {
  dmPolicy?: 'open' | 'allowlist' | 'disabled';
  dmAllowlist?: string[];
}

/** Gate an already-resolved WeChat source against `dmPolicy`/`dmAllowlist`. */
export function isResolvedSourceAllowed(
  cfg: WeChatAccessConfig | undefined,
  resolved: ResolvedWeChatSource,
): boolean {
  if (!resolved.senderId) return false;
  return isWeChatSenderAllowed(cfg?.dmPolicy, cfg?.dmAllowlist, resolved.senderId);
}

/**
 * Convenience wrapper that resolves a raw inbound message and gates it in
 * one call. Equivalent to `isResolvedSourceAllowed(cfg, resolveWeChatSource(message))`.
 */
export function isWeChatConversationAllowed(
  cfg: WeChatAccessConfig | undefined,
  message: WeChatMessageLike | undefined | null,
): boolean {
  return isResolvedSourceAllowed(cfg, resolveWeChatSource(message));
}
