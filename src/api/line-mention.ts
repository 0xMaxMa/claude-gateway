/**
 * LINE bot-mention detection — pure helper for the group/room activation gate.
 *
 * In groups/rooms the bot answers only when it is @mentioned (see
 * `line.requireMention`), and only via LINE's NATIVE mention:
 * `message.mention.mentionees[]`, each carrying `isSelf` — true when that
 * mentionee IS the bot receiving the webhook. This is the reliable signal and
 * needs no knowledge of the bot's own userId.
 *
 * A user who merely TYPES the bot's name as plain text (no native mention) is
 * intentionally NOT treated as calling the bot — that message is let through
 * silently. `@All` (mentionee `type: 'all'`) is likewise NOT a bot mention —
 * otherwise the bot would wake on every group-wide announcement.
 */

interface MentioneeLike {
  type?: string;
  isSelf?: boolean;
}

interface MentionLike {
  mentionees?: MentioneeLike[];
}

export interface LineMessageLike {
  type?: string;
  text?: string;
  mention?: MentionLike;
}

/** True if the bot itself is a named mentionee (excludes @All). */
export function hasNativeBotMention(message: LineMessageLike | undefined | null): boolean {
  const mentionees = message?.mention?.mentionees;
  if (!Array.isArray(mentionees)) return false;
  return mentionees.some((m) => m?.type === 'user' && m?.isSelf === true);
}

/**
 * Whether the bot was mentioned in this message. Native `isSelf` only — a typed
 * `@name` in plain text does not count, and `@All` never counts.
 */
export function wasBotMentioned(message: LineMessageLike | undefined | null): boolean {
  return hasNativeBotMention(message);
}
