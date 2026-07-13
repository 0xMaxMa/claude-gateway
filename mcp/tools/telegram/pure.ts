/**
 * Pure functions extracted from server.ts for unit testing.
 * These functions have no Grammy/MCP dependencies.
 */

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
  // Absent ⇒ 'dm'. A 'group' entry is a group knock: chatId holds the group id
  // and approval pushes that id into groupAllowlist (mirrors LINE).
  kind?: 'dm' | 'group'
}

export type Access = {
  dmPolicy: 'open' | 'allowlist' | 'disabled'
  // Orthogonal to dmPolicy (mirrors LINE): when the base policy is 'allowlist',
  // `pairing: true` means an unknown sender gets a one-time code and lands in
  // pending for the admin to approve; `pairing: false` means they're silently
  // dropped (pure allowlist). Ignored when dmPolicy is 'open'/'disabled'.
  pairing: boolean
  allowFrom: string[]
  // Group access tier (mirrors LINE): base policy for groups, the allowlisted
  // group ids, and a single requireMention gate. `pairing` (above) governs
  // group code-minting too, exactly like DMs.
  groupPolicy: 'open' | 'allowlist' | 'disabled'
  groupAllowlist: string[]
  requireMention: boolean
  // Migration-only artifact: a pre-split file's per-group `allowFrom` (the old
  // schema could restrict a group to specific senders). The new model has no
  // per-user group tier, so this is preserved but never written by any current
  // API/CLI — enforced in gateLogic() as an extra filter so migrating doesn't
  // silently widen a previously-restricted group to every member.
  legacyGroupAllowFrom?: Record<string, string[]>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

// Default for a brand-new agent (no access.json yet): closed base + pairing on,
// so the owner can DM the bot and capture their own id via a code. This matches
// the pre-split behavior where a missing file defaulted to dmPolicy:'pairing'.
export function defaultAccess(): Access {
  return {
    dmPolicy: 'allowlist',
    pairing: true,
    allowFrom: [],
    groupPolicy: 'allowlist',
    groupAllowlist: [],
    requireMention: true,
    pending: {},
  }
}

/**
 * Normalize a parsed access.json into the current shape, migrating the legacy
 * 4-value dmPolicy (which folded pairing in) to the split model.
 *
 * SECURITY: a legacy `allowlist` file was deliberately locked down — it must
 * migrate to `pairing:false`, NOT true, or it would start minting codes for
 * strangers. `pairing ?? true` is only correct for the brand-new/ENOENT path
 * (see defaultAccess). Here an absent `pairing` on an existing file means a
 * pre-split file → pairing off.
 */
/**
 * Extract per-group sender restrictions from a legacy `groups` map. Only a
 * non-empty `allowFrom` counts as a restriction — an empty array meant
 * "unrestricted" under the old schema, same as it does now.
 */
export function deriveLegacyGroupAllowFrom(
  groups?: Record<string, { requireMention?: boolean; allowFrom?: string[] }>,
): Record<string, string[]> | undefined {
  if (!groups) return undefined
  const out: Record<string, string[]> = {}
  for (const [groupId, g] of Object.entries(groups)) {
    if (g.allowFrom && g.allowFrom.length > 0) out[groupId] = [...g.allowFrom]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function migrateAccess(parsed: {
  dmPolicy?: string
  pairing?: boolean
  allowFrom?: string[]
  groups?: Record<string, { requireMention?: boolean; allowFrom?: string[] }>
  groupPolicy?: string
  groupAllowlist?: string[]
  requireMention?: boolean
  legacyGroupAllowFrom?: Record<string, string[]>
  pending?: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}): Access {
  const legacy = parsed.dmPolicy
  let dmPolicy: Access['dmPolicy']
  let pairing: boolean
  if (legacy === 'pairing') {
    dmPolicy = 'allowlist'
    pairing = true
  } else {
    dmPolicy = (legacy as Access['dmPolicy']) ?? 'allowlist'
    pairing = parsed.pairing ?? false
  }
  // Group tier: flatten legacy per-group `groups` map to a flat allowlist
  // (mirrors LINE). Legacy groups were closed-by-default → migrate to
  // 'allowlist' + requireMention:true, behavior-preserving. A group's
  // per-user `allowFrom` override has no equivalent in the new flat model,
  // but it's still a real restriction — preserve it in legacyGroupAllowFrom
  // and enforce it in gateLogic() rather than silently dropping it (that
  // would widen a restricted group to every member).
  const groupAllowlist = parsed.groupAllowlist ?? Object.keys(parsed.groups ?? {})
  const groupPolicy = (parsed.groupPolicy as Access['groupPolicy']) ?? 'allowlist'
  const requireMention = parsed.requireMention ?? true
  const legacyGroupAllowFrom = parsed.legacyGroupAllowFrom ?? deriveLegacyGroupAllowFrom(parsed.groups)
  return {
    dmPolicy,
    pairing,
    allowFrom: parsed.allowFrom ?? [],
    groupPolicy,
    groupAllowlist,
    requireMention,
    legacyGroupAllowFrom,
    pending: parsed.pending ?? {},
    mentionPatterns: parsed.mentionPatterns,
    ackReaction: parsed.ackReaction,
    replyToMode: parsed.replyToMode,
    textChunkLimit: parsed.textChunkLimit,
    chunkMode: parsed.chunkMode,
  }
}

export const MAX_CHUNK_LIMIT = 4096

export function pruneExpired(a: Access, now?: number): boolean {
  const ts = now ?? Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < ts) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from 'fs'
import { join } from 'path'

export function readAccessFile(accessFile: string): Access {
  try {
    const raw = readFileSync(accessFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access> & { dmPolicy?: string }
    return migrateAccess(parsed)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(accessFile, `${accessFile}.corrupt-${Date.now()}`)
    } catch {}
    return defaultAccess()
  }
}

export function saveAccess(stateDir: string, a: Access): void {
  const accessFile = join(stateDir, 'access.json')
  mkdirSync(stateDir, { recursive: true })
  const tmp = accessFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, accessFile)
}

export type GateInput = {
  fromId?: string
  chatType?: string
  chatId?: string
  botUsername?: string
  replyToUsername?: string
  messageText?: string
  messageEntities?: Array<{ type: string; offset: number; length: number; user?: { is_bot: boolean; username?: string } }>
  captionEntities?: Array<{ type: string; offset: number; length: number; user?: { is_bot: boolean; username?: string } }>
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean; isGroup?: boolean }

/**
 * Pure gate logic (for testing without Grammy Context).
 * Caller must provide readAccess and saveAccess functions,
 * plus a code generator.
 */
export function gateLogic(
  input: GateInput,
  loadAccess: () => Access,
  saveAccessFn: (a: Access) => void,
  generateCode: () => string,
  now?: number,
): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access, now)
  if (pruned) saveAccessFn(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  if (!input.fromId) return { action: 'drop' }
  const senderId = input.fromId
  const chatType = input.chatType

  if (chatType === 'private') {
    if (access.dmPolicy === 'open') {
      if (!access.allowFrom.includes(senderId)) {
        access.allowFrom.push(senderId)
        saveAccessFn(access)
      }
      return { action: 'deliver', access }
    }
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    // Base policy is 'allowlist' ('disabled' already dropped above). Pairing is
    // the orthogonal toggle: off ⇒ pure allowlist (drop strangers, no code).
    if (!access.pairing) return { action: 'drop' }

    // pairing mode
    for (const [code, p] of Object.entries(access.pending)) {
      if ((p.kind ?? 'dm') === 'dm' && p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccessFn(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    // Cap pending per-kind so group knocks and DM knocks don't starve each other.
    if (countPending(access, 'dm') >= 5) return { action: 'drop' }

    const code = generateCode()
    const ts = now ?? Date.now()
    access.pending[code] = {
      senderId,
      chatId: input.chatId ?? senderId,
      createdAt: ts,
      expiresAt: ts + 60 * 60 * 1000,
      replies: 1,
      kind: 'dm',
    }
    saveAccessFn(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = input.chatId ?? ''
    if (access.groupPolicy === 'disabled') return { action: 'drop' }

    if (access.groupPolicy === 'allowlist' && !access.groupAllowlist.includes(groupId)) {
      // Unknown group. Pairing off ⇒ silent drop (pure allowlist). On ⇒ mint a
      // code keyed on the group id; a member relays it to the admin (mirrors LINE).
      if (!access.pairing) return { action: 'drop' }
      for (const [code, p] of Object.entries(access.pending)) {
        if (p.kind === 'group' && p.chatId === groupId) {
          if ((p.replies ?? 1) >= 2) return { action: 'drop' }
          p.replies = (p.replies ?? 1) + 1
          saveAccessFn(access)
          return { action: 'pair', code, isResend: true, isGroup: true }
        }
      }
      if (countPending(access, 'group') >= 5) return { action: 'drop' }
      const code = generateCode()
      const ts = now ?? Date.now()
      access.pending[code] = {
        senderId,
        chatId: groupId,
        createdAt: ts,
        expiresAt: ts + 60 * 60 * 1000,
        replies: 1,
        kind: 'group',
      }
      saveAccessFn(access)
      return { action: 'pair', code, isResend: false, isGroup: true }
    }

    // Allowlisted (or open policy) → enforce any legacy per-sender restriction
    // that survived migration, then the single mention gate.
    const legacyAllowed = access.legacyGroupAllowFrom?.[groupId]
    if (legacyAllowed && legacyAllowed.length > 0 && !legacyAllowed.includes(senderId)) {
      return { action: 'drop' }
    }
    if (access.requireMention !== false && !isMentionedPure(input, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

/** Count pending entries of a given kind (absent kind ⇒ 'dm'). */
function countPending(access: Access, kind: 'dm' | 'group'): number {
  let n = 0
  for (const p of Object.values(access.pending)) {
    if ((p.kind ?? 'dm') === kind) n++
  }
  return n
}

export { hasMarkdown, toTelegramHtml } from './lib/markdown'

export function isMentionedPure(input: GateInput, extraPatterns?: string[]): boolean {
  const entities = input.messageEntities ?? input.captionEntities ?? []
  const text = input.messageText ?? ''
  const botUsername = input.botUsername ?? ''

  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) {
      return true
    }
  }

  if (input.replyToUsername === botUsername) return true

  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {
      // Invalid regex — skip
    }
  }
  return false
}
