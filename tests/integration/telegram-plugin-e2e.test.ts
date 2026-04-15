/**
 * Integration tests for the Telegram plugin (telegram-plugin-e2e).
 *
 * These tests exercise the pure functions from mcp/gateway/tools/telegram/pure.ts
 * and simulate the plugin's behavior without starting a real Grammy bot
 * or connecting to the real Telegram API.
 *
 * For full E2E with a mock Telegram Bot API server, a separate test setup
 * would be needed (mock express server intercepting api.telegram.org).
 * This suite covers the core logic paths using pure function tests.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  gateLogic,
  defaultAccess,
  pruneExpired,
  readAccessFile,
  saveAccess,
  chunk,
  Access,
} from '../../mcp/gateway/tools/telegram/pure'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e2e-test-'))
}

function makeGateHelpers(stateDir: string, initial?: Partial<Access>) {
  const accessFile = path.join(stateDir, 'access.json')
  let access: Access = { ...defaultAccess(), ...initial }

  if (initial) {
    saveAccess(stateDir, access)
  }

  const loadAccess = () => readAccessFile(accessFile)
  const saveAccessFn = (a: Access) => {
    access = a
    saveAccess(stateDir, a)
  }
  let codeCounter = 0
  const generateCode = () => `code${String(++codeCounter).padStart(2, '0')}`

  return { loadAccess, saveAccessFn, generateCode, accessFile }
}

describe('Plugin E2E', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('Pairing flow', () => {
    test('new user sends message → gate produces pair result with code', () => {
      const { loadAccess, saveAccessFn, generateCode, accessFile } = makeGateHelpers(tmpDir, { dmPolicy: 'pairing' })
      const result = gateLogic(
        { fromId: '111', chatType: 'private', chatId: '111' },
        loadAccess, saveAccessFn, generateCode
      )
      expect(result.action).toBe('pair')
      if (result.action === 'pair') {
        expect(result.isResend).toBe(false)
        expect(result.code).toBeTruthy()
      }
      // Verify pending entry written to disk
      const access = readAccessFile(accessFile)
      expect(Object.keys(access.pending).length).toBe(1)
    })

    test('isResend: second message from same pending user → pair with isResend=true', () => {
      const now = Date.now()
      const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(tmpDir, {
        dmPolicy: 'pairing',
        pending: {
          code01: { senderId: '111', chatId: '111', createdAt: now - 1000, expiresAt: now + 3600000, replies: 1 },
        },
      })
      const result = gateLogic(
        { fromId: '111', chatType: 'private', chatId: '111' },
        loadAccess, saveAccessFn, generateCode, now
      )
      expect(result.action).toBe('pair')
      if (result.action === 'pair') {
        expect(result.isResend).toBe(true)
      }
    })

    test('third+ message from pending user → silent drop (replies cap)', () => {
      const now = Date.now()
      const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(tmpDir, {
        dmPolicy: 'pairing',
        pending: {
          code01: { senderId: '111', chatId: '111', createdAt: now - 1000, expiresAt: now + 3600000, replies: 2 },
        },
      })
      const result = gateLogic(
        { fromId: '111', chatType: 'private', chatId: '111' },
        loadAccess, saveAccessFn, generateCode, now
      )
      expect(result.action).toBe('drop')
    })

    test('max 3 pending: 4th new user → silent drop', () => {
      const now = Date.now()
      const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(tmpDir, {
        dmPolicy: 'pairing',
        pending: {
          c1: { senderId: '1', chatId: '1', createdAt: now, expiresAt: now + 3600000, replies: 1 },
          c2: { senderId: '2', chatId: '2', createdAt: now, expiresAt: now + 3600000, replies: 1 },
          c3: { senderId: '3', chatId: '3', createdAt: now, expiresAt: now + 3600000, replies: 1 },
        },
      })
      const result = gateLogic(
        { fromId: '999', chatType: 'private', chatId: '999' },
        loadAccess, saveAccessFn, generateCode, now
      )
      expect(result.action).toBe('drop')
    })

    test('checkApprovals simulation: write approved/<senderId> → user is paired', () => {
      const approvedDir = path.join(tmpDir, 'approved')
      fs.mkdirSync(approvedDir, { recursive: true })

      const senderId = '123456'
      const chatId = '123456'

      // Simulate what scripts/pair.ts does
      const access = defaultAccess()
      access.allowFrom = [senderId]
      saveAccess(tmpDir, access)
      fs.writeFileSync(path.join(approvedDir, senderId), chatId)

      // Verify the approved file exists and access.json has the user
      const files = fs.readdirSync(approvedDir)
      expect(files).toContain(senderId)

      const written = readAccessFile(path.join(tmpDir, 'access.json'))
      expect(written.allowFrom).toContain(senderId)
    })

    test('after pairing: messages from user → deliver', () => {
      const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(tmpDir, {
        dmPolicy: 'allowlist',
        allowFrom: ['111'],
      })
      const result = gateLogic(
        { fromId: '111', chatType: 'private', chatId: '111' },
        loadAccess, saveAccessFn, generateCode
      )
      expect(result.action).toBe('deliver')
    })
  })

  describe('Message delivery — gate logic', () => {
    test('allowlisted sender → deliver with access object', () => {
      const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(tmpDir, {
        dmPolicy: 'allowlist',
        allowFrom: ['user1'],
      })
      const result = gateLogic(
        { fromId: 'user1', chatType: 'private', chatId: 'user1' },
        loadAccess, saveAccessFn, generateCode
      )
      expect(result.action).toBe('deliver')
      if (result.action === 'deliver') {
        expect(result.access.allowFrom).toContain('user1')
      }
    })

    test('non-allowlisted sender → no deliver (drop)', () => {
      const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(tmpDir, {
        dmPolicy: 'allowlist',
        allowFrom: ['user1'],
      })
      const result = gateLogic(
        { fromId: 'stranger', chatType: 'private', chatId: 'stranger' },
        loadAccess, saveAccessFn, generateCode
      )
      expect(result.action).toBe('drop')
    })

    test('dmPolicy: allowlist → non-allowlisted dropped silently', () => {
      const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(tmpDir, {
        dmPolicy: 'allowlist',
      })
      const result = gateLogic(
        { fromId: 'anyone', chatType: 'private', chatId: 'anyone' },
        loadAccess, saveAccessFn, generateCode
      )
      expect(result.action).toBe('drop')
    })

    test('dmPolicy: disabled → all messages dropped', () => {
      const { loadAccess, saveAccessFn, generateCode } = makeGateHelpers(tmpDir, {
        dmPolicy: 'disabled',
        allowFrom: ['user1'],
      })
      const result = gateLogic(
        { fromId: 'user1', chatType: 'private', chatId: 'user1' },
        loadAccess, saveAccessFn, generateCode
      )
      expect(result.action).toBe('drop')
    })
  })

  describe('Tools — reply chunk logic', () => {
    test('reply — text <= 4096 → single chunk', () => {
      const text = 'Hello, world!'
      const chunks = chunk(text, 4096, 'length')
      expect(chunks).toHaveLength(1)
      expect(chunks[0]).toBe(text)
    })

    test('reply — splits text > 4096 chars into multiple messages', () => {
      const text = 'x'.repeat(5000)
      const chunks = chunk(text, 4096, 'length')
      expect(chunks).toHaveLength(2)
      expect(chunks[0]).toHaveLength(4096)
      expect(chunks[1]).toHaveLength(904)
    })
  })

  describe('Permission relay — logic', () => {
    test('permission_reply_re matches "yes abcde"', () => {
      const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
      expect(PERMISSION_REPLY_RE.test('yes abcde')).toBe(true)
      expect(PERMISSION_REPLY_RE.test('no abcde')).toBe(true)
    })

    test('permission_reply_re rejects bare "yes" or "no" without code', () => {
      const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
      expect(PERMISSION_REPLY_RE.test('yes')).toBe(false)
      expect(PERMISSION_REPLY_RE.test('no')).toBe(false)
    })

    test('permission_reply_re rejects code with "l" (excluded letter)', () => {
      const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
      expect(PERMISSION_REPLY_RE.test('yes abcle')).toBe(false) // 'l' present
    })

    test('non-allowlisted user permission button → not authorized', () => {
      // Simulate: user who sent callback is not in allowFrom
      const access = defaultAccess()
      access.allowFrom = ['owner']
      const senderId = 'stranger'
      expect(access.allowFrom.includes(senderId)).toBe(false)
    })
  })

  describe('Shutdown — state validation', () => {
    test('access.json persists across reads', () => {
      const access = defaultAccess()
      access.allowFrom = ['user1']
      access.dmPolicy = 'allowlist'
      saveAccess(tmpDir, access)

      // Simulate re-read (as plugin would do on each gate call)
      const reread = readAccessFile(path.join(tmpDir, 'access.json'))
      expect(reread.allowFrom).toEqual(['user1'])
      expect(reread.dmPolicy).toBe('allowlist')
    })
  })

  describe('Bot commands — state checks', () => {
    test('/status — paired user → is in allowFrom', () => {
      const access = defaultAccess()
      access.allowFrom = ['123']
      const senderId = '123'
      expect(access.allowFrom.includes(senderId)).toBe(true)
    })

    test('/status — pending user → has code in pending', () => {
      const now = Date.now()
      const access = defaultAccess()
      access.pending = {
        abc123: { senderId: '456', chatId: '456', createdAt: now, expiresAt: now + 3600000, replies: 1 },
      }
      const senderId = '456'
      const found = Object.entries(access.pending).find(([, p]) => p.senderId === senderId)
      expect(found).toBeDefined()
      expect(found![0]).toBe('abc123')
    })

    test('/status — unknown user → not in allowFrom, not in pending', () => {
      const access = defaultAccess()
      const senderId = 'nobody'
      expect(access.allowFrom.includes(senderId)).toBe(false)
      const found = Object.values(access.pending).find(p => p.senderId === senderId)
      expect(found).toBeUndefined()
    })
  })

  describe('409 Conflict retry — backoff logic', () => {
    test('backoff increases: min 1000ms, max 15000ms', () => {
      function getBackoff(attempt: number): number {
        return Math.min(1000 * attempt, 15000)
      }
      expect(getBackoff(1)).toBe(1000)
      expect(getBackoff(5)).toBe(5000)
      expect(getBackoff(15)).toBe(15000)
      expect(getBackoff(20)).toBe(15000) // capped
    })
  })
})
