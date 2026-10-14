import { InlineKeyboard } from 'grammy'

/** One /pstack-setup screen as the gateway renders it (`telegram_pstack`). `done`: a final result, shown without buttons. */
export type PstackMenu = { text: string; keyboard: Array<Array<{ text: string; data: string }>>; closed?: boolean; done?: boolean; toast?: string }

/** Telegram caps callback_data at 64 UTF-8 bytes and text at 4096 characters. */
const MAX_DATA_BYTES = 64
const MAX_TEXT = 4096

/** Validate the gateway's screen and build its keyboard; a malformed button is dropped, not sent. */
export function pstackMenuMarkup(value: unknown): { text: string; reply_markup: InlineKeyboard; closed: boolean; done: boolean; toast?: string } {
  const menu = value as Partial<PstackMenu>
  if (typeof menu?.text !== 'string' || !Array.isArray(menu.keyboard)) throw Error('INVALID_PSTACK_MENU')
  const rows = menu.keyboard.filter(Array.isArray).map(row => row
    .filter(button => typeof button?.text === 'string' && typeof button?.data === 'string' && button.data.startsWith('ps:') && Buffer.byteLength(button.data, 'utf8') <= MAX_DATA_BYTES)
    .map(button => InlineKeyboard.text(button.text.slice(0, 64), button.data))).filter(row => row.length)
  const keyboard = new InlineKeyboard(rows)
  return { text: menu.text.slice(0, MAX_TEXT), reply_markup: keyboard, closed: menu.closed === true, done: menu.done === true, ...(typeof menu.toast === 'string' ? { toast: menu.toast.slice(0, 180) } : {}) }
}

/** `/pstack-setup` or `/pstack_setup` with nothing after it opens the menu; with arguments it is the text command. */
export const PSTACK_MENU_COMMAND = /^\/pstack[-_]setup(?:@\w+)?\s*$/i
