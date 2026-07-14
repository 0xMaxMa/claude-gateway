/**
 * Unit tests for src/shell/control-channel.ts — the closed control-key
 * vocabulary the gateway may send to the PTY wrapper (Epic #195, Phase 3b).
 * All pure: parse/validate and map to keystrokes.
 */

import {
  parseControlCommand,
  keystrokesFor,
  CONTROL_KEYS,
  MAX_CONTROL_OPTION,
  KEY_ESC,
  KEY_ENTER,
  KEY_UP,
  KEY_DOWN,
} from '../../src/shell/control-channel'

describe('parseControlCommand — closed vocabulary', () => {
  test('U-CC-01: accepts each simple control key', () => {
    for (const key of CONTROL_KEYS) {
      if (key === 'select-option') continue
      expect(parseControlCommand({ key })).toEqual({ key })
    }
  })

  test('U-CC-02: rejects an unknown key', () => {
    expect(parseControlCommand({ key: 'rm-rf' })).toBeNull()
    expect(parseControlCommand({ key: 'type', text: 'hi' })).toBeNull()
  })

  test('U-CC-03: rejects a missing / non-string key', () => {
    expect(parseControlCommand({})).toBeNull()
    expect(parseControlCommand({ key: 5 as unknown as string })).toBeNull()
  })

  test('U-CC-04: select-option requires a bounded positive integer option', () => {
    expect(parseControlCommand({ key: 'select-option', option: 1 })).toEqual({
      key: 'select-option',
      option: 1,
    })
    expect(parseControlCommand({ key: 'select-option', option: MAX_CONTROL_OPTION })).toEqual({
      key: 'select-option',
      option: MAX_CONTROL_OPTION,
    })
  })

  test('U-CC-05: select-option rejects out-of-range / non-integer / missing option', () => {
    expect(parseControlCommand({ key: 'select-option' })).toBeNull()
    expect(parseControlCommand({ key: 'select-option', option: 0 })).toBeNull()
    expect(parseControlCommand({ key: 'select-option', option: -1 })).toBeNull()
    expect(parseControlCommand({ key: 'select-option', option: 1.5 })).toBeNull()
    expect(parseControlCommand({ key: 'select-option', option: MAX_CONTROL_OPTION + 1 })).toBeNull()
    expect(parseControlCommand({ key: 'select-option', option: '2' as unknown as number })).toBeNull()
  })

  test('U-CC-06: an extra key is ignored, not honoured', () => {
    // No arbitrary keystroke smuggled through an extra field.
    expect(parseControlCommand({ key: 'enter', raw: '\x04' })).toEqual({ key: 'enter' })
  })
})

describe('keystrokesFor — VT100 mapping', () => {
  test('U-CC-07: simple keys map to the expected sequences', () => {
    expect(keystrokesFor({ key: 'esc' })).toEqual([KEY_ESC])
    expect(keystrokesFor({ key: 'esc-esc' })).toEqual([KEY_ESC, KEY_ESC])
    expect(keystrokesFor({ key: 'enter' })).toEqual([KEY_ENTER])
    expect(keystrokesFor({ key: 'up' })).toEqual([KEY_UP])
    expect(keystrokesFor({ key: 'down' })).toEqual([KEY_DOWN])
  })

  test('U-CC-08: select-option maps to the digit only (Enter is screen-gated by the caller)', () => {
    expect(keystrokesFor({ key: 'select-option', option: 3 })).toEqual(['3'])
  })
})
