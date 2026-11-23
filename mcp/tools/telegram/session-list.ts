import { InlineKeyboard } from 'grammy'
import { CallbackHttpError, callbackRejection } from './callback-failure'

export type SessionListEntry = { id: string; name: string; messageCount: number; lastActive: number }

/** Sessions shown per /sessions page. Each costs up to two buttons, so a page
 * stays far below Telegram's 100-button limit on one inline keyboard. */
export const SESSIONS_PER_PAGE = 8
/** Telegram caps callback_data at 64 UTF-8 bytes. */
const MAX_DATA_BYTES = 64

const fits = (data: string) => Buffer.byteLength(data, 'utf8') <= MAX_DATA_BYTES
const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

function age(now: number, lastActive: number): string {
  const minutes = Math.max(0, Math.round((now - lastActive) / 60000))
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

/** Builds one page of the /sessions menu, newest first. `page` is clamped, so a
 * stale Prev/Next button after a delete still lands on a real page. */
export function sessionListMenu(sessions: SessionListEntry[], activeId: string, page: number, now = Date.now()): { text: string; reply_markup: InlineKeyboard; page: number; pages: number } {
  // A session whose callback would exceed 64 bytes cannot be switched to or
  // deleted from a button, so it is listed in the count but never sent as one.
  const sorted = [...sessions].sort((a, b) => b.lastActive - a.lastActive || a.id.localeCompare(b.id))
  const pages = Math.max(1, Math.ceil(sorted.length / SESSIONS_PER_PAGE))
  const current = Math.min(Math.max(0, Number.isInteger(page) ? page : 0), pages - 1)
  const shown = sorted.slice(current * SESSIONS_PER_PAGE, (current + 1) * SESSIONS_PER_PAGE)

  const keyboard = new InlineKeyboard()
  for (const s of shown) {
    const switchData = `session_switch:${s.id}`
    if (!fits(switchData)) continue
    const label = clip(s.id === activeId ? `🟢 ${s.name}` : s.name, 40)
    keyboard.text(label, switchData)
    if (sorted.length > 1 && fits(`session_delete_confirm:${s.id}`)) keyboard.text('🗑', `session_delete:${s.id}`)
    keyboard.row()
  }
  if (current > 0) keyboard.text('‹ Prev', `session_page:${current - 1}`)
  if (current + 1 < pages) keyboard.text('Next ›', `session_page:${current + 1}`)
  if (pages > 1) keyboard.row()
  keyboard.text('➕ New Session', 'session_new').row()
  keyboard.text('Dismiss', 'session_back')

  const lines = [`🗂 Sessions (${sorted.length})${pages > 1 ? ` · Page ${current + 1}/${pages}` : ''}`, '']
  for (const s of shown) {
    lines.push(`${s.id === activeId ? '🟢' : '⚪'} ${clip(s.name, 60)} · ${s.messageCount} msgs · ${age(now, s.lastActive)}`)
  }
  lines.push('', 'Tap a session to switch, 🗑 to delete')
  return { text: lines.join('\n'), reply_markup: keyboard, page: current, pages }
}

/** Reads the chat's sessions from the agent (`list_sessions`). Throws with the
 * HTTP status or the agent's reason so the failure log keeps the cause. */
export async function listSessionsRequest(base: string | undefined, chatId: string, timeoutMs = 10000): Promise<{ sessions: SessionListEntry[]; activeId: string }> {
  if (!base) throw Error('not_configured')
  const response = await fetch(base + '/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ command: 'list_sessions', chat_id: chatId }),
  })
  const result = await response.json().catch(error => { throw response.ok ? error : new CallbackHttpError(response.status) }) as { success?: boolean; sessions?: unknown; activeSessionId?: unknown } | null
  if (!response.ok) throw new CallbackHttpError(response.status, result)
  // A successful list_sessions reply carries `sessions` and no `success` flag.
  if (result?.success === false || !Array.isArray(result?.sessions)) throw callbackRejection(result)
  const sessions = (result.sessions as Array<Partial<SessionListEntry> | null>).filter((s): s is SessionListEntry =>
    typeof s?.id === 'string' && typeof s.name === 'string' && typeof s.messageCount === 'number' && typeof s.lastActive === 'number')
  return { sessions, activeId: typeof result.activeSessionId === 'string' ? result.activeSessionId : '' }
}
