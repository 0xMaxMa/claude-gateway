import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { isDuplicate, pruneDedup, initDedupDir, DEDUP_TTL_MS } from '../../mcp/tools/telegram/dedup'

describe('telegram dedup', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('initDedupDir', () => {
    it('creates the directory if it does not exist', () => {
      const newDir = path.join(dir, 'nested', 'dedup')
      initDedupDir(newDir)
      expect(fs.existsSync(newDir)).toBe(true)
    })

    it('does not throw if directory already exists', () => {
      initDedupDir(dir) // already exists from beforeEach
      expect(fs.existsSync(dir)).toBe(true)
    })
  })

  describe('isDuplicate', () => {
    it('returns false on first call for a new message', () => {
      expect(isDuplicate(dir, '123', 456)).toBe(false)
    })

    it('returns true on second call for the same message', () => {
      isDuplicate(dir, '123', 456)
      expect(isDuplicate(dir, '123', 456)).toBe(true)
    })

    it('treats different chatId+msgId combos as independent', () => {
      expect(isDuplicate(dir, '111', 1)).toBe(false)
      expect(isDuplicate(dir, '222', 1)).toBe(false)
      expect(isDuplicate(dir, '111', 2)).toBe(false)
      expect(isDuplicate(dir, '111', 1)).toBe(true) // only this one is dup
    })

    it('creates a marker file named <chatId>-<msgId>', () => {
      isDuplicate(dir, '997', 42)
      expect(fs.existsSync(path.join(dir, '997-42'))).toBe(true)
    })
  })

  describe('pruneDedup', () => {
    it('removes files older than ttlMs', () => {
      const file = path.join(dir, '100-1')
      fs.writeFileSync(file, '')
      // backdate mtime to 2× TTL ago
      const old = new Date(Date.now() - DEDUP_TTL_MS * 2)
      fs.utimesSync(file, old, old)

      pruneDedup(dir)
      expect(fs.existsSync(file)).toBe(false)
    })

    it('keeps files newer than ttlMs', () => {
      const file = path.join(dir, '100-2')
      fs.writeFileSync(file, '')

      pruneDedup(dir)
      expect(fs.existsSync(file)).toBe(true)
    })

    it('does not throw on empty or missing directory', () => {
      expect(() => pruneDedup('/tmp/nonexistent-dedup-xyz-987')).not.toThrow()
    })

    it('is idempotent when called concurrently (double-prune)', () => {
      const file = path.join(dir, '200-1')
      fs.writeFileSync(file, '')
      const old = new Date(Date.now() - DEDUP_TTL_MS * 2)
      fs.utimesSync(file, old, old)

      pruneDedup(dir)
      expect(() => pruneDedup(dir)).not.toThrow() // second call on already-deleted file
    })
  })
})
