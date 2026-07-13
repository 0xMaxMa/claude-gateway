/**
 * Unit tests for readAccessFile(), saveAccess(), pruneExpired() pure functions
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { readAccessFile, saveAccess, pruneExpired, defaultAccess, migrateAccess, deriveLegacyGroupAllowFrom, Access } from '../../../mcp/tools/telegram/pure'

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
      pairing: false,
      allowFrom: ['123', '456'],
      groupPolicy: 'allowlist',
      groupAllowlist: ['-100123'],
      requireMention: true,
      pending: {},
      ackReaction: '👍',
    }
    fs.writeFileSync(accessFile, JSON.stringify(data, null, 2))
    const result = readAccessFile(accessFile)
    expect(result.dmPolicy).toBe('allowlist')
    expect(result.allowFrom).toEqual(['123', '456'])
    expect(result.groupAllowlist).toEqual(['-100123'])
    expect(result.groupPolicy).toBe('allowlist')
    expect(result.requireMention).toBe(true)
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
    expect(result.groupAllowlist).toEqual([])
    expect(result.groupPolicy).toBe('allowlist')
    expect(result.requireMention).toBe(true)
    expect(result.pending).toEqual({})
  })
})

describe('migrateAccess() — legacy 4-value dmPolicy → split model', () => {
  test("legacy 'pairing' → allowlist + pairing:true (mint codes preserved)", () => {
    const result = migrateAccess({ dmPolicy: 'pairing', allowFrom: ['1'] })
    expect(result.dmPolicy).toBe('allowlist')
    expect(result.pairing).toBe(true)
    expect(result.allowFrom).toEqual(['1'])
  })

  test("SECURITY: legacy 'allowlist' with no pairing field → pairing:false (stays locked down)", () => {
    const result = migrateAccess({ dmPolicy: 'allowlist', allowFrom: ['1'] })
    expect(result.dmPolicy).toBe('allowlist')
    expect(result.pairing).toBe(false)
  })

  test("legacy 'open' → open + pairing:false (pairing ignored for open)", () => {
    expect(migrateAccess({ dmPolicy: 'open' })).toMatchObject({ dmPolicy: 'open', pairing: false })
  })

  test("legacy 'disabled' → disabled + pairing:false", () => {
    expect(migrateAccess({ dmPolicy: 'disabled' })).toMatchObject({ dmPolicy: 'disabled', pairing: false })
  })

  test('new-format file (explicit pairing) is preserved as-is', () => {
    expect(migrateAccess({ dmPolicy: 'allowlist', pairing: true })).toMatchObject({ dmPolicy: 'allowlist', pairing: true })
    expect(migrateAccess({ dmPolicy: 'allowlist', pairing: false })).toMatchObject({ dmPolicy: 'allowlist', pairing: false })
  })

  test('empty object → allowlist + pairing:false (locked, no accidental minting)', () => {
    expect(migrateAccess({})).toMatchObject({ dmPolicy: 'allowlist', pairing: false })
  })

  test('brand-new agent (ENOENT default) → allowlist + pairing:true (capture owner id)', () => {
    // defaultAccess is the ENOENT/new-agent path, distinct from migrating an
    // existing file — it opts pairing ON so onboarding works.
    expect(defaultAccess()).toMatchObject({ dmPolicy: 'allowlist', pairing: true })
  })

  test('group tier: legacy `groups` map flattens to groupAllowlist, non-empty allowFrom preserved as legacyGroupAllowFrom', () => {
    const result = migrateAccess({
      dmPolicy: 'allowlist',
      groups: { '-100123': { requireMention: true, allowFrom: [] }, '-100456': { requireMention: false, allowFrom: ['9'] } },
    })
    expect(result.groupAllowlist.sort()).toEqual(['-100123', '-100456'])
    expect(result.groupPolicy).toBe('allowlist')
    expect(result.requireMention).toBe(true)
    // Only the group with a non-empty allowFrom carries a restriction forward —
    // an empty allowFrom meant "unrestricted" under the old schema too.
    expect(result.legacyGroupAllowFrom).toEqual({ '-100456': ['9'] })
  })

  test('group tier: legacy `groups` with no non-empty allowFrom → legacyGroupAllowFrom stays undefined', () => {
    const result = migrateAccess({
      dmPolicy: 'allowlist',
      groups: { '-100123': { requireMention: true, allowFrom: [] } },
    })
    expect(result.legacyGroupAllowFrom).toBeUndefined()
  })

  test('group tier: explicit legacyGroupAllowFrom is passed through unchanged (idempotent re-migration)', () => {
    const result = migrateAccess({
      dmPolicy: 'allowlist',
      groupAllowlist: ['-100456'],
      legacyGroupAllowFrom: { '-100456': ['9'] },
      groups: { '-100456': { allowFrom: ['should-be-ignored'] } },
    })
    expect(result.legacyGroupAllowFrom).toEqual({ '-100456': ['9'] })
  })

  test('deriveLegacyGroupAllowFrom(): undefined groups → undefined; empty allowFrom excluded; non-empty preserved', () => {
    expect(deriveLegacyGroupAllowFrom(undefined)).toBeUndefined()
    expect(deriveLegacyGroupAllowFrom({})).toBeUndefined()
    expect(deriveLegacyGroupAllowFrom({ '-1': { allowFrom: [] } })).toBeUndefined()
    expect(deriveLegacyGroupAllowFrom({ '-1': { allowFrom: ['9'] }, '-2': { allowFrom: [] } })).toEqual({ '-1': ['9'] })
  })

  test('group tier: absent group fields → allowlist + requireMention:true (secure default)', () => {
    const result = migrateAccess({ dmPolicy: 'allowlist' })
    expect(result.groupAllowlist).toEqual([])
    expect(result.groupPolicy).toBe('allowlist')
    expect(result.requireMention).toBe(true)
  })

  test('group tier: explicit new fields are preserved over legacy `groups`', () => {
    const result = migrateAccess({
      dmPolicy: 'allowlist',
      groups: { '-1': { requireMention: true, allowFrom: [] } },
      groupPolicy: 'open',
      groupAllowlist: ['-999'],
      requireMention: false,
    })
    expect(result.groupPolicy).toBe('open')
    expect(result.groupAllowlist).toEqual(['-999'])
    expect(result.requireMention).toBe(false)
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
      dmPolicy: 'allowlist',
      pairing: true,
      allowFrom: ['111'],
      groupPolicy: 'allowlist',
      groupAllowlist: [],
      requireMention: true,
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
    expect(parsed.dmPolicy).toBe('allowlist')
    expect(parsed.pairing).toBe(true)
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
