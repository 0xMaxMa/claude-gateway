/**
 * Pure parsing logic for .menu files written by AgentRunner.writeMenuForward.
 * Kept in a separate module so tests can import it without pulling in the full
 * bot runtime (receiver-server.ts imports grammy + all its dependencies).
 */

export type InlineKeyboardButton = { text: string; callback_data: string };

export type MenuMessage = {
  text: string;
  inline_keyboard: Array<Array<InlineKeyboardButton>>;
};

/**
 * Parse raw .menu file content into a Telegram sendMessage payload.
 * Returns null if the content is malformed or missing required fields.
 */
export function parseMenuFileContent(raw: string): MenuMessage | null {
  let parsed: { text?: unknown; options?: unknown };
  try {
    parsed = JSON.parse(raw) as { text?: unknown; options?: unknown };
  } catch {
    return null;
  }
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const options = Array.isArray(parsed.options)
    ? (parsed.options as Array<{ label?: unknown }>)
        .map(o => (typeof o?.label === 'string' ? o.label : ''))
        .filter((l): l is string => l.length > 0)
    : [];
  if (!text || options.length === 0) return null;
  const inline_keyboard = options.map((label, i) => [{
    text: `${i + 1}. ${label}`.slice(0, 60),
    callback_data: `choice:${i + 1}`,
  }]);
  // Always append a cancel button so the user can dismiss the menu without
  // sending a numbered reply. Tapping it sends ESC to the PTY, clearing
  // pendingMenu cleanly without injecting spurious text into Claude's context.
  inline_keyboard.push([{ text: '❌ Cancel', callback_data: 'menu:cancel' }]);
  return { text, inline_keyboard };
}
