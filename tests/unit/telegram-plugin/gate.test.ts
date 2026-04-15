/**
 * Unit tests for gate() logic using gateLogic() from mcp/gateway/tools/telegram/pure.ts
 */
import { gateLogic, defaultAccess, pruneExpired, Access, GateInput } from '../../../mcp/gateway/tools/telegram/pure'

function makeGateHelpers(initial?: Partial<Access>) {
  let access: Access = { ...defaultAccess(), ...initial }
  const saved: Access[] = []

  const loadAccess = () => ({ ...access, pending: { ...access.pending }, allowFrom: [...access.allowFrom], groups: { ...access.groups } })
  const saveAccessFn = (a: Access) => {
    access = { ...a, pending: { ...a.pending }, allowFrom: [...a.allowFrom] }
    saved.push({ ...a })
  }
  let codeCounter = 0
  const generateCode = () => `code${++codeCounter}`

  return { loadAccess, saveAccessFn, generateCode, getSaved: () => saved, getAccess: () => access }
}

describe('gate() — DM (private chat)', () => {
  test('drop — dmPolicy: disabled', () => {
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers({ dmPolicy: 'disabled' })
    const input: GateInput = { fromId: '123', chatType: 'private', chatId: '123' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('drop')
  })

  test('drop — dmPolicy: allowlist, sender not in allowFrom', () => {
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers({ dmPolicy: 'allowlist', allowFrom: ['999'] })
    const input: GateInput = { fromId: '123', chatType: 'private', chatId: '123' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('drop')
  })

  test('deliver — sender in allowFrom', () => {
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers({ dmPolicy: 'allowlist', allowFrom: ['123'] })
    const input: GateInput = { fromId: '123', chatType: 'private', chatId: '123' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('deliver')
  })

  test('deliver — sender in allowFrom (pairing policy)', () => {
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers({ dmPolicy: 'pairing', allowFrom: ['123'] })
    const input: GateInput = { fromId: '123', chatType: 'private', chatId: '123' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('deliver')
  })

  test('pair — new sender, dmPolicy: pairing → code generated + saved to pending', () => {
    const { loadAccess, saveAccessFn, generateCode, getAccess } = makeGateHelpers({ dmPolicy: 'pairing' })
    const input: GateInput = { fromId: '123', chatType: 'private', chatId: '123' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.isResend).toBe(false)
      expect(result.code).toBe('code1')
    }
    const access = getAccess()
    expect(access.pending['code1']).toBeDefined()
    expect(access.pending['code1'].senderId).toBe('123')
    expect(access.pending['code1'].replies).toBe(1)
  })

  test('pair — isResend: true when sender has existing pending code', () => {
    const now = Date.now()
    const initial: Partial<Access> = {
      dmPolicy: 'pairing',
      pending: {
        existingCode: {
          senderId: '123',
          chatId: '123',
          createdAt: now - 1000,
          expiresAt: now + 3600000,
          replies: 1,
        },
      },
    }
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(initial)
    const input: GateInput = { fromId: '123', chatType: 'private', chatId: '123' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode, now)
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.isResend).toBe(true)
      expect(result.code).toBe('existingCode')
    }
  })

  test('drop — replies >= 2 (silent cap after 2 reminders)', () => {
    const now = Date.now()
    const initial: Partial<Access> = {
      dmPolicy: 'pairing',
      pending: {
        someCode: {
          senderId: '123',
          chatId: '123',
          createdAt: now - 1000,
          expiresAt: now + 3600000,
          replies: 2,
        },
      },
    }
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(initial)
    const input: GateInput = { fromId: '123', chatType: 'private', chatId: '123' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode, now)
    expect(result.action).toBe('drop')
  })

  test('drop — pending count >= 3 (anti-spam cap)', () => {
    const now = Date.now()
    const initial: Partial<Access> = {
      dmPolicy: 'pairing',
      pending: {
        c1: { senderId: '1', chatId: '1', createdAt: now, expiresAt: now + 3600000, replies: 1 },
        c2: { senderId: '2', chatId: '2', createdAt: now, expiresAt: now + 3600000, replies: 1 },
        c3: { senderId: '3', chatId: '3', createdAt: now, expiresAt: now + 3600000, replies: 1 },
      },
    }
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(initial)
    // New sender (not in any pending)
    const input: GateInput = { fromId: '999', chatType: 'private', chatId: '999' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode, now)
    expect(result.action).toBe('drop')
  })

  test('pruneExpired — removes expired pending entries before gate check', () => {
    const now = Date.now()
    const initial: Partial<Access> = {
      dmPolicy: 'pairing',
      pending: {
        expired1: { senderId: '1', chatId: '1', createdAt: now - 9999, expiresAt: now - 1, replies: 2 },
        expired2: { senderId: '2', chatId: '2', createdAt: now - 9999, expiresAt: now - 1, replies: 2 },
        expired3: { senderId: '3', chatId: '3', createdAt: now - 9999, expiresAt: now - 1, replies: 2 },
      },
    }
    // Without prune, 3 expired entries would hit pending cap.
    // With prune, they're cleared → new sender gets a code.
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(initial)
    const input: GateInput = { fromId: '999', chatType: 'private', chatId: '999' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode, now)
    // After pruning 3 expired, pending count = 0, so new sender gets a code
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.isResend).toBe(false)
    }
  })

  test('drop — no fromId', () => {
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers()
    const input: GateInput = { chatType: 'private', chatId: '123' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('drop')
  })
})

describe('gate() — group chat', () => {
  test('group — drop if groupId not in access.groups', () => {
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers()
    const input: GateInput = { fromId: '123', chatType: 'group', chatId: '-100999' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('drop')
  })

  test('group — drop if requireMention=true and no mention', () => {
    const initial: Partial<Access> = {
      groups: { '-100123': { requireMention: true, allowFrom: [] } },
    }
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(initial)
    const input: GateInput = {
      fromId: '123',
      chatType: 'group',
      chatId: '-100123',
      botUsername: 'mybot',
      messageText: 'hello there',
      messageEntities: [],
    }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('drop')
  })

  test('group — deliver if bot is @mentioned', () => {
    const initial: Partial<Access> = {
      groups: { '-100123': { requireMention: true, allowFrom: [] } },
    }
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(initial)
    const text = '@mybot hello'
    const input: GateInput = {
      fromId: '123',
      chatType: 'group',
      chatId: '-100123',
      botUsername: 'mybot',
      messageText: text,
      messageEntities: [{ type: 'mention', offset: 0, length: 6 }],
    }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('deliver')
  })

  test('group — deliver via reply_to a bot message (implicit mention)', () => {
    const initial: Partial<Access> = {
      groups: { '-100123': { requireMention: true, allowFrom: [] } },
    }
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(initial)
    const input: GateInput = {
      fromId: '123',
      chatType: 'group',
      chatId: '-100123',
      botUsername: 'mybot',
      replyToUsername: 'mybot',
      messageText: 'sure',
      messageEntities: [],
    }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('deliver')
  })

  test('group — drop if sender not in group.allowFrom', () => {
    const initial: Partial<Access> = {
      groups: { '-100123': { requireMention: false, allowFrom: ['999'] } },
    }
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(initial)
    const input: GateInput = {
      fromId: '123',
      chatType: 'group',
      chatId: '-100123',
      botUsername: 'mybot',
      messageText: 'hello',
    }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('drop')
  })

  test('group — deliver if no requireMention and sender in group.allowFrom', () => {
    const initial: Partial<Access> = {
      groups: { '-100123': { requireMention: false, allowFrom: ['123'] } },
    }
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(initial)
    const input: GateInput = {
      fromId: '123',
      chatType: 'group',
      chatId: '-100123',
      messageText: 'hello',
    }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('deliver')
  })

  test('supergroup — treated same as group', () => {
    const initial: Partial<Access> = {
      groups: { '-100123': { requireMention: false, allowFrom: [] } },
    }
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(initial)
    const input: GateInput = {
      fromId: '123',
      chatType: 'supergroup',
      chatId: '-100123',
    }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('deliver')
  })

  test('unknown chat type → drop', () => {
    const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers()
    const input: GateInput = { fromId: '123', chatType: 'channel', chatId: '-100123' }
    const result = gateLogic(input, loadAccess, saveAccessFn, generateCode)
    expect(result.action).toBe('drop')
  })
})
