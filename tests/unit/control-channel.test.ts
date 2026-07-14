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
  isAcceptablePtyInput,
  shouldRoutePtyInput,
  MAX_PTY_INPUT_BYTES,
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

describe('interactive input gate (Issue #201)', () => {
  test('U-CC-09: isAcceptablePtyInput accepts a non-empty bounded string', () => {
    expect(isAcceptablePtyInput('a')).toBe(true)
    expect(isAcceptablePtyInput('\x03')).toBe(true) // Ctrl-C is valid input
    expect(isAcceptablePtyInput('x'.repeat(MAX_PTY_INPUT_BYTES))).toBe(true)
  })

  test('U-CC-10: isAcceptablePtyInput rejects empty, oversized, and non-string', () => {
    expect(isAcceptablePtyInput('')).toBe(false)
    expect(isAcceptablePtyInput('x'.repeat(MAX_PTY_INPUT_BYTES + 1))).toBe(false)
    expect(isAcceptablePtyInput(123 as unknown)).toBe(false)
    expect(isAcceptablePtyInput(null)).toBe(false)
    expect(isAcceptablePtyInput(undefined)).toBe(false)
    expect(isAcceptablePtyInput({ toString: () => 'x' } as unknown)).toBe(false)
  })

  test('U-CC-10b: isAcceptablePtyInput bounds real UTF-8 bytes, not UTF-16 code units', () => {
    // '😀' is 2 UTF-16 code units but 4 UTF-8 bytes. A run whose code-unit
    // length is under the bound while its byte length exceeds it must be
    // rejected — otherwise multi-byte input could smuggle past the cap.
    const overByBytes = '😀'.repeat(MAX_PTY_INPUT_BYTES / 4 + 1) // ~1 byte over
    expect(overByBytes.length).toBeLessThan(MAX_PTY_INPUT_BYTES) // under by code units
    expect(Buffer.byteLength(overByBytes, 'utf8')).toBeGreaterThan(MAX_PTY_INPUT_BYTES)
    expect(isAcceptablePtyInput(overByBytes)).toBe(false)
    // Multi-byte input that fits the byte budget is still accepted.
    expect(isAcceptablePtyInput('café ✓')).toBe(true)
  })

  test('U-CC-11: shouldRoutePtyInput requires a text frame + acceptable payload', () => {
    expect(shouldRoutePtyInput(false, 'ls\r')).toBe(true)
    // binary frame → dropped
    expect(shouldRoutePtyInput(true, 'ls\r')).toBe(false)
    // empty / oversized → dropped
    expect(shouldRoutePtyInput(false, '')).toBe(false)
    expect(shouldRoutePtyInput(false, 'x'.repeat(MAX_PTY_INPUT_BYTES + 1))).toBe(false)
  })
})
