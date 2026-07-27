/**
 * Unit tests for telegramDisplayName() from mcp/tools/telegram/pure.ts
 *
 * Guards the cron Target picker fix: the display name recorded to history (and
 * surfaced by listChats().displayName) must be a human-readable name, not the
 * bare numeric chat id that the old `username ?? id` fallback produced for users
 * without a @handle.
 */
import { telegramDisplayName, TelegramSender } from '../../../mcp/tools/telegram/pure'

describe('telegramDisplayName', () => {
  it('uses first + last name when both are present', () => {
    const from: TelegramSender = { id: 42, first_name: 'Elizabeth', last_name: 'Churchill', username: 'liz' }
    expect(telegramDisplayName(from)).toBe('Elizabeth Churchill')
  })

  it('uses first name alone when last name is absent', () => {
    const from: TelegramSender = { id: 42, first_name: 'Elizabeth', username: 'liz' }
    expect(telegramDisplayName(from)).toBe('Elizabeth')
  })

  it('uses last name alone when first name is absent', () => {
    // Unrealistic for Telegram (first_name is guaranteed), but completes the name-branch matrix.
    const from: TelegramSender = { id: 42, last_name: 'Churchill', username: 'liz' }
    expect(telegramDisplayName(from)).toBe('Churchill')
  })

  it('prefers the real name over the @username handle', () => {
    // The regression: a user WITH a name should never surface as their handle.
    const from: TelegramSender = { id: 42, first_name: 'Elizabeth', username: 'liz' }
    expect(telegramDisplayName(from)).not.toBe('liz')
    expect(telegramDisplayName(from)).toBe('Elizabeth')
  })

  it('falls back to the username when no name is set', () => {
    const from: TelegramSender = { id: 42, username: 'liz' }
    expect(telegramDisplayName(from)).toBe('liz')
  })

  it('falls back to the id only when neither name nor username exists', () => {
    // This is the exact case the fix targets: previously the picker showed this number.
    const from: TelegramSender = { id: 7144530640 }
    expect(telegramDisplayName(from)).toBe('7144530640')
  })

  it('stringifies a numeric id in the last-resort fallback', () => {
    const from: TelegramSender = { id: 12345 }
    expect(telegramDisplayName(from)).toBe('12345')
    expect(typeof telegramDisplayName(from)).toBe('string')
  })

  it('ignores an empty-string first name and falls through to username', () => {
    const from: TelegramSender = { id: 42, first_name: '', username: 'liz' }
    expect(telegramDisplayName(from)).toBe('liz')
  })

  it('trims surrounding whitespace from the composed name', () => {
    const from: TelegramSender = { id: 42, first_name: ' Elizabeth ', last_name: '' }
    expect(telegramDisplayName(from)).toBe('Elizabeth')
  })
})
