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
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
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
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
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
  | { action: 'pair'; code: string; isResend: boolean }

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
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // pairing mode
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccessFn(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = generateCode()
    const ts = now ?? Date.now()
    access.pending[code] = {
      senderId,
      chatId: input.chatId ?? senderId,
      createdAt: ts,
      expiresAt: ts + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccessFn(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = input.chatId ?? ''
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (requireMention && !isMentionedPure(input, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

export { hasMarkdown, toMarkdownV2 } from '../../src/markdown'

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
