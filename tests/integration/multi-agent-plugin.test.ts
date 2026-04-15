/**
 * Integration tests for multi-agent plugin isolation.
 * Tests that two plugin instances with separate state dirs are fully isolated.
 * Also tests scripts/pair.ts behavior via direct function simulation.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  gateLogic,
  defaultAccess,
  readAccessFile,
  saveAccess,
  pruneExpired,
  Access,
} from '../../mcp/gateway/tools/telegram/pure'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-multi-test-'))
}

function makeAgentState(baseDir: string, agentId: string) {
  const stateDir = path.join(baseDir, agentId, '.telegram-state')
  const accessFile = path.join(stateDir, 'access.json')
  const approvedDir = path.join(stateDir, 'approved')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.mkdirSync(approvedDir, { recursive: true })

  const initialAccess = defaultAccess()
  initialAccess.dmPolicy = 'pairing'
  saveAccess(stateDir, initialAccess)

  const loadAccess = () => readAccessFile(accessFile)
  const saveAccessFn = (a: Access) => saveAccess(stateDir, a)
  let codeCounter = 0
  const generateCode = () => `${agentId}-code-${++codeCounter}`

  return { stateDir, accessFile, approvedDir, loadAccess, saveAccessFn, generateCode }
}

/**
 * Simulate what scripts/pair.ts does (without reading config file)
 */
function doPair(stateDir: string, code: string, now = Date.now()): { success: boolean; error?: string } {
  const accessFile = path.join(stateDir, 'access.json')
  const approvedDir = path.join(stateDir, 'approved')

  let access: Access
  try {
    access = readAccessFile(accessFile)
  } catch {
    return { success: false, error: 'cannot read access.json' }
  }

  const entry = access.pending[code]
  if (!entry) {
    return { success: false, error: `code "${code}" not found in pending` }
  }
  if (entry.expiresAt < now) {
    return { success: false, error: `code "${code}" has expired` }
  }

  const { senderId, chatId } = entry
  delete access.pending[code]
  if (!access.allowFrom.includes(senderId)) {
    access.allowFrom.push(senderId)
  }

  const tmp = accessFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, accessFile)

  fs.mkdirSync(approvedDir, { recursive: true })
  fs.writeFileSync(path.join(approvedDir, senderId), chatId)

  return { success: true }
}

describe('Multi-agent Plugin Isolation', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  test('two plugin instances with separate STATE_DIRs are isolated', () => {
    const agentA = makeAgentState(baseDir, 'agent-a')
    const agentB = makeAgentState(baseDir, 'agent-b')

    // Agent A: user 111 pairs
    const resultA = gateLogic(
      { fromId: '111', chatType: 'private', chatId: '111' },
      agentA.loadAccess, agentA.saveAccessFn, agentA.generateCode
    )
    expect(resultA.action).toBe('pair')

    // Agent B: user 222 pairs
    const resultB = gateLogic(
      { fromId: '222', chatType: 'private', chatId: '222' },
      agentB.loadAccess, agentB.saveAccessFn, agentB.generateCode
    )
    expect(resultB.action).toBe('pair')

    // Agent A pending should NOT contain agent B's user
    const accessA = agentA.loadAccess()
    expect(Object.values(accessA.pending).some(p => p.senderId === '222')).toBe(false)

    // Agent B pending should NOT contain agent A's user
    const accessB = agentB.loadAccess()
    expect(Object.values(accessB.pending).some(p => p.senderId === '111')).toBe(false)
  })

  test('TELEGRAM_STATE_DIR separate: agent A allowlist does not bleed into agent B', () => {
    const agentA = makeAgentState(baseDir, 'agent-a')
    const agentB = makeAgentState(baseDir, 'agent-b')

    // Allow user 111 in agent A
    const accessA = agentA.loadAccess()
    accessA.allowFrom = ['111']
    agentA.saveAccessFn(accessA)

    // Agent B should not see user 111 as allowed
    const accessB = agentB.loadAccess()
    expect(accessB.allowFrom).not.toContain('111')

    // In agent B, user 111 should be pairable (not already allowed)
    const resultB = gateLogic(
      { fromId: '111', chatType: 'private', chatId: '111' },
      agentB.loadAccess, agentB.saveAccessFn, agentB.generateCode
    )
    expect(resultB.action).toBe('pair') // not 'deliver'
  })

  test('pending entry in agent A is not visible when pairing agent B', () => {
    const agentA = makeAgentState(baseDir, 'agent-a')
    const agentB = makeAgentState(baseDir, 'agent-b')

    // Generate a pending entry in agent A
    gateLogic(
      { fromId: '555', chatType: 'private', chatId: '555' },
      agentA.loadAccess, agentA.saveAccessFn, agentA.generateCode
    )

    // Agent B should have empty pending
    const accessB = agentB.loadAccess()
    expect(Object.keys(accessB.pending)).toHaveLength(0)
  })

  test('approved/ file written to agent A dir is only seen by agent A', () => {
    const agentA = makeAgentState(baseDir, 'agent-a')
    const agentB = makeAgentState(baseDir, 'agent-b')

    // Write approved file in agent A
    fs.writeFileSync(path.join(agentA.approvedDir, '111'), '111')

    // Agent B approved dir should be empty
    const filesB = fs.readdirSync(agentB.approvedDir)
    expect(filesB).toHaveLength(0)

    // Agent A approved dir should have the file
    const filesA = fs.readdirSync(agentA.approvedDir)
    expect(filesA).toContain('111')
  })

  describe('scripts/pair.ts simulation', () => {
    test('pair --agent=A --code=<valid> → updates A access.json + writes approved/<senderId>', () => {
      const agentA = makeAgentState(baseDir, 'agent-a')
      const now = Date.now()

      // Setup pending entry
      const access = agentA.loadAccess()
      access.pending['abc123'] = {
        senderId: '111',
        chatId: '111',
        createdAt: now - 1000,
        expiresAt: now + 3600000,
        replies: 1,
      }
      agentA.saveAccessFn(access)

      const result = doPair(agentA.stateDir, 'abc123', now)
      expect(result.success).toBe(true)

      const updated = agentA.loadAccess()
      expect(updated.allowFrom).toContain('111')
      expect(updated.pending['abc123']).toBeUndefined()

      expect(fs.existsSync(path.join(agentA.approvedDir, '111'))).toBe(true)
      expect(fs.readFileSync(path.join(agentA.approvedDir, '111'), 'utf8')).toBe('111')
    })

    test('pair --agent=B --code=<valid> → updates B access.json independently', () => {
      const agentA = makeAgentState(baseDir, 'agent-a')
      const agentB = makeAgentState(baseDir, 'agent-b')
      const now = Date.now()

      // Setup pending in both
      const accessA = agentA.loadAccess()
      accessA.pending['codeA'] = { senderId: '111', chatId: '111', createdAt: now, expiresAt: now + 3600000, replies: 1 }
      agentA.saveAccessFn(accessA)

      const accessB = agentB.loadAccess()
      accessB.pending['codeB'] = { senderId: '222', chatId: '222', createdAt: now, expiresAt: now + 3600000, replies: 1 }
      agentB.saveAccessFn(accessB)

      // Pair only agent B
      const result = doPair(agentB.stateDir, 'codeB', now)
      expect(result.success).toBe(true)

      // Agent B updated
      const updatedB = agentB.loadAccess()
      expect(updatedB.allowFrom).toContain('222')
      expect(updatedB.pending['codeB']).toBeUndefined()

      // Agent A untouched
      const updatedA = agentA.loadAccess()
      expect(updatedA.allowFrom).not.toContain('222')
      expect(updatedA.pending['codeA']).toBeDefined()
    })

    test('pair --agent=A --code=<expired> → exits with error, no state change', () => {
      const agentA = makeAgentState(baseDir, 'agent-a')
      const now = Date.now()

      const access = agentA.loadAccess()
      access.pending['expired'] = {
        senderId: '111',
        chatId: '111',
        createdAt: now - 7200000,
        expiresAt: now - 3600000, // expired 1h ago
        replies: 1,
      }
      agentA.saveAccessFn(access)

      const result = doPair(agentA.stateDir, 'expired', now)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/expired/)

      // No state change
      const updated = agentA.loadAccess()
      expect(updated.allowFrom).not.toContain('111')
      expect(updated.pending['expired']).toBeDefined() // still there
    })

    test('pair --agent=A --code=<wrong> → exits with error', () => {
      const agentA = makeAgentState(baseDir, 'agent-a')
      const result = doPair(agentA.stateDir, 'doesnotexist')
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/not found/)
    })

    test('pair --agent=A when no pending → exits with error', () => {
      const agentA = makeAgentState(baseDir, 'agent-a')
      // No pending entries in default access
      const result = doPair(agentA.stateDir, 'anything')
      expect(result.success).toBe(false)
    })

    test('pair after approval: approved file triggers deliver on next gate call', () => {
      const agentA = makeAgentState(baseDir, 'agent-a')
      const now = Date.now()

      // Setup pending
      const access = agentA.loadAccess()
      access.pending['paircode'] = {
        senderId: '777',
        chatId: '777',
        createdAt: now - 1000,
        expiresAt: now + 3600000,
        replies: 1,
      }
      agentA.saveAccessFn(access)

      // Simulate pairing
      doPair(agentA.stateDir, 'paircode', now)

      // Now user 777 should be in allowFrom
      const result = gateLogic(
        { fromId: '777', chatType: 'private', chatId: '777' },
        agentA.loadAccess, agentA.saveAccessFn, agentA.generateCode, now
      )
      expect(result.action).toBe('deliver')
    })
  })
})
