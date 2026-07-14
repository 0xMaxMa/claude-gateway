/**
 * Control channel (Epic #195, Phase 3b — item B2).
 *
 * The gateway's recovery executor can ask the PTY wrapper to press a specific
 * key into the interactive TUI — the raw keystrokes the wrapper otherwise only
 * generates internally (a single Enter, a menu digit, an arrow). These reach the
 * wrapper as a NEW stdin message type `{"type":"control","key":...}`, kept
 * distinct from a `type:"user"` message turn so control keystrokes are never
 * confused with prompt text.
 *
 * The vocabulary is CLOSED and validated here, for the same reason the triage
 * schema is closed: the only keystrokes the wrapper will ever emit on behalf of
 * the gateway are the ones in `CONTROL_KEYS`. A malformed or unknown control
 * message is rejected, so no arbitrary byte sequence can be injected into the
 * PTY via this path. This module is pure (parse + map to keystrokes); the
 * wrapper performs the actual `host.writeRaw` and the screen-gated Enter.
 */

/** Closed set of control keys the gateway may request. */
export const CONTROL_KEYS = ['esc', 'esc-esc', 'enter', 'up', 'down', 'select-option'] as const
export type ControlKey = (typeof CONTROL_KEYS)[number]

/** A validated control command. `option` is present only for select-option. */
export interface ControlCommand {
  key: ControlKey
  /** 1-based menu index; only for select-option. */
  option?: number
}

// VT100 keystroke sequences — identical to the ones the wrapper already emits
// internally (menu-probe arrows, handleMenuReply digit/Enter), so a control key
// is indistinguishable from a user pressing it.
export const KEY_ESC = '\x1b'
export const KEY_ENTER = '\r'
export const KEY_UP = '\x1b[A'
export const KEY_DOWN = '\x1b[B'

/**
 * Upper bound for a select-option index. Capped at 9 to match the triage schema:
 * the wrapper selects by typing the digit, which is only unambiguous single-char,
 * so a two-digit index could type a wrong immediate selection. Menus are short.
 */
export const MAX_CONTROL_OPTION = 9

const KEY_SET: ReadonlySet<string> = new Set(CONTROL_KEYS)

/**
 * Parse and validate a raw stdin control object into a closed ControlCommand,
 * or null if it cannot be trusted. Never throws. `select-option` requires a
 * bounded positive-integer `option`; anything else is rejected.
 */
export function parseControlCommand(obj: Record<string, unknown>): ControlCommand | null {
  const key = obj['key']
  if (typeof key !== 'string' || !KEY_SET.has(key)) return null
  if (key === 'select-option') {
    const opt = obj['option']
    if (
      typeof opt !== 'number' ||
      !Number.isInteger(opt) ||
      opt < 1 ||
      opt > MAX_CONTROL_OPTION
    ) {
      return null
    }
    return { key: 'select-option', option: opt }
  }
  return { key: key as ControlKey }
}

/**
 * The raw keystroke sequence(s) a control command maps to. For select-option
 * this is just the digit — the wrapper sends Enter separately, gated on the
 * menu still being on screen (a TUI may confirm on the digit alone), mirroring
 * the existing menu-selection flow.
 */
export function keystrokesFor(cmd: ControlCommand): string[] {
  switch (cmd.key) {
    case 'esc':
      return [KEY_ESC]
    case 'esc-esc':
      return [KEY_ESC, KEY_ESC]
    case 'enter':
      return [KEY_ENTER]
    case 'up':
      return [KEY_UP]
    case 'down':
      return [KEY_DOWN]
    case 'select-option':
      return [String(cmd.option)]
  }
}
