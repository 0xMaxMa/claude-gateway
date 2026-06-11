import { mkdirSync, openSync, closeSync, readdirSync, statSync, rmSync } from 'fs'
import { join } from 'path'

/** Marker files older than this are pruned on next cleanup pass. */
export const DEDUP_TTL_MS = 60_000 // 60 s — covers receiver restart overlap, avoids stale drops

/**
 * Ensure the dedup directory exists. Call once at startup rather than on
 * every message so hot paths don't pay the mkdirSync cost.
 */
export function initDedupDir(dedupDir: string): void {
  mkdirSync(dedupDir, { recursive: true })
}

/**
 * Atomic check-and-mark using O_EXCL (create-or-fail).
 * Returns true if this (chatId, msgId) was already claimed by any receiver instance.
 * Safe across multiple bun processes sharing the same filesystem.
 */
export function isDuplicate(dedupDir: string, chatId: string, msgId: number): boolean {
  const file = join(dedupDir, `${chatId}-${msgId}`)
  try {
    const fd = openSync(file, 'wx') // O_CREAT | O_EXCL — fails with EEXIST if file exists
    closeSync(fd)
    return false
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return true
    return false // unexpected I/O error — let it through rather than dropping messages
  }
}

/**
 * Remove marker files older than ttlMs. Safe to call concurrently from multiple
 * processes — rmSync({ force: true }) is idempotent.
 */
export function pruneDedup(dedupDir: string, ttlMs = DEDUP_TTL_MS): void {
  try {
    const now = Date.now()
    for (const f of readdirSync(dedupDir)) {
      try {
        const file = join(dedupDir, f)
        if (now - statSync(file).mtimeMs > ttlMs) rmSync(file, { force: true })
      } catch {}
    }
  } catch {}
}
