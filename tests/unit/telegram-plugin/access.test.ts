/**
 * Unit tests for readAccessFile(), saveAccess(), pruneExpired() pure functions
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { readAccessFile, saveAccess, pruneExpired, defaultAccess, Access } from '../../../mcp/gateway/tools/telegram/pure'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-access-test-'))
}

describe('readAccessFile()', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('returns defaultAccess() when file does not exist (ENOENT)', () => {
    const nonexistent = path.join(tmpDir, 'access.json')
    const result = readAccessFile(nonexistent)
    expect(result).toEqual(defaultAccess())
  })

  test('parses valid access.json correctly', () => {
    const accessFile = path.join(tmpDir, 'access.json')
    const data: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['123', '456'],
      groups: { '-100123': { requireMention: true, allowFrom: [] } },
      pending: {},
      ackReaction: '👍',
    }
    fs.writeFileSync(accessFile, JSON.stringify(data, null, 2))
    const result = readAccessFile(accessFile)
    expect(result.dmPolicy).toBe('allowlist')
    expect(result.allowFrom).toEqual(['123', '456'])
    expect(result.groups).toEqual({ '-100123': { requireMention: true, allowFrom: [] } })
    expect(result.ackReaction).toBe('👍')
  })

  test('renames corrupt file and returns defaultAccess()', () => {
    const accessFile = path.join(tmpDir, 'access.json')
    fs.writeFileSync(accessFile, 'not valid json{{{{')
    const result = readAccessFile(accessFile)
    expect(result).toEqual(defaultAccess())
    // Original file should be renamed (corrupt file)
    expect(fs.existsSync(accessFile)).toBe(false)
    const files = fs.readdirSync(tmpDir)
    const corrupt = files.find(f => f.startsWith('access.json.corrupt-'))
    expect(corrupt).toBeDefined()
  })

  test('handles partial access.json with missing fields gracefully', () => {
    const accessFile = path.join(tmpDir, 'access.json')
    fs.writeFileSync(accessFile, JSON.stringify({ dmPolicy: 'disabled' }))
    const result = readAccessFile(accessFile)
    expect(result.dmPolicy).toBe('disabled')
    expect(result.allowFrom).toEqual([])
    expect(result.groups).toEqual({})
    expect(result.pending).toEqual({})
  })
})

describe('saveAccess()', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('writes atomically via .tmp + rename', () => {
    const access = defaultAccess()
    access.allowFrom = ['999']
    saveAccess(tmpDir, access)
    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'access.json'), 'utf8'))
    expect(written.allowFrom).toEqual(['999'])
    // No .tmp file left behind
    expect(fs.existsSync(path.join(tmpDir, 'access.json.tmp'))).toBe(false)
  })

  test('creates STATE_DIR if missing', () => {
    const newDir = path.join(tmpDir, 'nested', 'state')
    saveAccess(newDir, defaultAccess())
    expect(fs.existsSync(path.join(newDir, 'access.json'))).toBe(true)
  })

  test('output is valid JSON with correct shape', () => {
    const access: Access = {
      dmPolicy: 'pairing',
      allowFrom: ['111'],
      groups: {},
      pending: {
        abc123: {
          senderId: '111',
          chatId: '111',
          createdAt: 1000,
          expiresAt: 9999999999,
          replies: 1,
        },
      },
    }
    saveAccess(tmpDir, access)
    const raw = fs.readFileSync(path.join(tmpDir, 'access.json'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.dmPolicy).toBe('pairing')
    expect(parsed.allowFrom).toEqual(['111'])
    expect(Object.keys(parsed.pending)).toContain('abc123')
    // Should be pretty-printed (has newlines)
    expect(raw).toContain('\n')
  })

  test('overwrites existing file', () => {
    const access1 = defaultAccess()
    access1.allowFrom = ['111']
    saveAccess(tmpDir, access1)

    const access2 = defaultAccess()
    access2.allowFrom = ['222']
    saveAccess(tmpDir, access2)

    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'access.json'), 'utf8'))
    expect(written.allowFrom).toEqual(['222'])
  })
})

describe('pruneExpired()', () => {
  test('removes only expired entries', () => {
    const now = Date.now()
    const access = defaultAccess()
    access.pending = {
      expired1: { senderId: '1', chatId: '1', createdAt: now - 7200000, expiresAt: now - 3600000, replies: 1 },
      valid1: { senderId: '2', chatId: '2', createdAt: now - 1000, expiresAt: now + 3600000, replies: 1 },
      expired2: { senderId: '3', chatId: '3', createdAt: now - 9000000, expiresAt: now - 1, replies: 1 },
    }
    const changed = pruneExpired(access, now)
    expect(changed).toBe(true)
    expect(Object.keys(access.pending)).toEqual(['valid1'])
  })

  test('returns true when entries were removed', () => {
    const now = Date.now()
    const access = defaultAccess()
    access.pending = {
      expired: { senderId: '1', chatId: '1', createdAt: now - 7200000, expiresAt: now - 1, replies: 1 },
    }
    expect(pruneExpired(access, now)).toBe(true)
  })

  test('returns false when nothing was pruned', () => {
    const now = Date.now()
    const access = defaultAccess()
    access.pending = {
      valid: { senderId: '1', chatId: '1', createdAt: now - 1000, expiresAt: now + 3600000, replies: 1 },
    }
    expect(pruneExpired(access, now)).toBe(false)
  })

  test('returns false when pending is empty', () => {
    const access = defaultAccess()
    expect(pruneExpired(access, Date.now())).toBe(false)
  })

  test('uses provided `now` timestamp (deterministic)', () => {
    const access = defaultAccess()
    access.pending = {
      entry: { senderId: '1', chatId: '1', createdAt: 1000, expiresAt: 5000, replies: 1 },
    }
    // With now=4999, entry is still valid
    expect(pruneExpired(access, 4999)).toBe(false)
    expect(access.pending['entry']).toBeDefined()

    // With now=5001, entry is expired
    expect(pruneExpired(access, 5001)).toBe(true)
    expect(access.pending['entry']).toBeUndefined()
  })

  test('does not remove entries expiring exactly at now (expiresAt === now is not expired)', () => {
    const now = 10000
    const access = defaultAccess()
    // expiresAt < now is expired; expiresAt === now is still valid
    access.pending = {
      boundary: { senderId: '1', chatId: '1', createdAt: 0, expiresAt: now, replies: 1 },
    }
    // expiresAt (10000) is NOT < now (10000), so not pruned
    expect(pruneExpired(access, now)).toBe(false)
  })
})
