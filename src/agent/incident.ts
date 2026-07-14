/**
 * Incident core (Epic #195, Phase 2).
 *
 * Pure decision logic for the incident-reporting layer that sits on top of the
 * turn-trace watchdog (Phase 1). Given a stall incident, this module decides:
 *   - its fingerprint (what makes two stalls "the same problem"),
 *   - whether/how to escalate a repeat (quiet → repeat → recommend-investigate),
 *   - how to scrub evidence before any of it can leave the machine,
 *   - how to summarise a set of incidents into a digest line/report.
 *
 * Like turn-trace.ts and orphan-wake.ts, this file performs NO IO and imports
 * no runtime code (only types, which are erased), so every rule here is
 * unit-testable without a filesystem, a clock, or a live session. The store
 * (incident-store.ts) owns persistence and calls into these functions.
 */

import type { TurnStage, TurnFailureClass } from './turn-trace'

/** Placeholder substituted for any redacted span in a scrubbed export. */
export const REDACTION = '‹redacted›'

/** Escalation level reached for an incident fingerprint. */
export type EscalationLevel = 'quiet' | 'repeat' | 'investigate'

/** Lifecycle status of a persisted incident. */
export type IncidentStatus = 'open' | 'resolved'

/**
 * A single occurrence of a stall, captured each time the watchdog re-raises the
 * same fingerprint. Kept small — the store retains only a capped tail of these.
 */
export interface IncidentSample {
  /** When this occurrence was raised (epoch ms). */
  at: number
  /** How long the turn had sat in the stalled stage (ms). */
  sinceMs: number
  /** The stage's timeout budget at the time (ms). */
  budgetMs: number
  /** Whether a fresh `.processing` sentinel showed the turn was mid-work. */
  midTurn: boolean
}

/**
 * The persisted record for one incident fingerprint. Written to
 * `<dir>/<id>/manifest.json`. Fields are deliberately free of chat content;
 * `channel` is the transport name only (never a chat id), and evidence with
 * potentially sensitive text lives in scrubbed sibling artifact files.
 */
export interface IncidentManifest {
  /** Filesystem-safe unique id: `<fingerprintHash>-<firstAt>`. */
  id: string
  /** Stable dedup key: stage + failure class + CLI version. */
  fingerprint: string
  stage: TurnStage
  failureClass: TurnFailureClass | null
  /** Claude CLI version at capture time, or 'unknown'. Part of the fingerprint. */
  cliVersion: string
  /** Gateway version at capture time, or 'unknown'. Context only. */
  gatewayVersion: string
  /** Transport name only: 'telegram' | 'discord' | 'line' | 'api'. */
  channel: string
  /** First and most-recent occurrence (epoch ms). */
  firstAt: number
  lastAt: number
  /** Total occurrences folded into this incident. */
  occurrences: number
  /** Highest escalation level reached. */
  escalationLevel: EscalationLevel
  status: IncidentStatus
  /** Last time the user was notified, and at what level (dedupes re-notifying). */
  notifiedAt: number | null
  notifiedLevel: EscalationLevel | null
  /** Linked GitHub issue number, if one was filed for this fingerprint. */
  githubIssue: number | null
  /** Recovery actions + outcomes — populated in Phase 3; [] in Phase 2. */
  recovery: RecoveryOutcome[]
  /** Capped tail of recent occurrences. */
  samples: IncidentSample[]
}

/** A recovery action and its result (Phase 3 fills these; typed here for the schema). */
export interface RecoveryOutcome {
  action: string
  at: number
  ok: boolean
  detail?: string
}

/**
 * Compute the dedup fingerprint. Two stalls are "the same problem" when they
 * hit the same pipeline stage with the same failure attribution on the same CLI
 * version — a new CLI version is treated as a distinct problem so a regression
 * introduced by an upgrade does not silently fold into an old fingerprint.
 */
export function computeFingerprint(input: {
  stage: TurnStage
  failureClass: TurnFailureClass | null
  cliVersion: string | null | undefined
}): string {
  const cls = input.failureClass ?? 'none'
  const ver = normalizeVersion(input.cliVersion)
  return `${input.stage}:${cls}:${ver}`
}

/** Normalise a version string to a fingerprint-safe token; empty → 'unknown'. */
function normalizeVersion(v: string | null | undefined): string {
  const t = (v ?? '').trim()
  return t.length > 0 ? t : 'unknown'
}

/**
 * Deterministic, dependency-free hash (FNV-1a → base36). Used to derive a short
 * filesystem-safe prefix for an incident id from its fingerprint. Not used for
 * anything security-sensitive — only stable naming/dedup.
 */
export function fingerprintHash(fingerprint: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < fingerprint.length; i++) {
    h ^= fingerprint.charCodeAt(i)
    // FNV prime multiply, kept in 32-bit range via Math.imul.
    h = Math.imul(h, 0x01000193)
  }
  // >>> 0 to interpret as unsigned before stringifying.
  return (h >>> 0).toString(36)
}

/** Configurable thresholds for escalation. */
export interface EscalationConfig {
  /** Dedup window — repeats within this of the last occurrence fold in (ms). */
  windowMs: number
  /** Occurrence count at/after which we recommend investigation. */
  investigateThreshold: number
}

export const DEFAULT_ESCALATION: EscalationConfig = {
  windowMs: 24 * 60 * 60 * 1000, // 24 h
  investigateThreshold: 3,
}

/** The escalation verdict for a single (folded) occurrence. */
export interface EscalationDecision {
  level: EscalationLevel
  /** Whether the user should be notified for this occurrence. */
  notify: boolean
}

/**
 * Decide how to escalate given the running occurrence count for a fingerprint
 * and whether the user was already notified at 'investigate' level.
 *
 *   - 1st occurrence            → quiet notify (one short heads-up)
 *   - repeats below threshold   → silent increment (no re-notify)
 *   - Nth (N ≥ threshold), once → recommend investigation (louder notify)
 *   - after that                → silent (already recommended)
 *
 * Pure: the caller supplies the count and prior-notify state.
 */
export function decideEscalation(
  occurrences: number,
  alreadyInvestigateNotified: boolean,
  cfg: EscalationConfig = DEFAULT_ESCALATION,
): EscalationDecision {
  if (occurrences <= 1) {
    return { level: 'quiet', notify: true }
  }
  if (occurrences >= cfg.investigateThreshold && !alreadyInvestigateNotified) {
    return { level: 'investigate', notify: true }
  }
  return { level: 'repeat', notify: false }
}

/** The maximum of two escalation levels (for tracking the highest reached). */
export function maxEscalationLevel(
  a: EscalationLevel,
  b: EscalationLevel,
): EscalationLevel {
  const rank: Record<EscalationLevel, number> = { quiet: 0, repeat: 1, investigate: 2 }
  return rank[a] >= rank[b] ? a : b
}

// ─── Scrubbing ──────────────────────────────────────────────────────────────

/**
 * Patterns for content that must never leave the machine, independent of any
 * caller-supplied literals. Conservative by design: each pattern targets a
 * recognisable secret/PII shape, not free text, to avoid mangling useful
 * diagnostic content. Order matters — more specific patterns run first.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Telegram bot token: <digits>:<35+ token chars>
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
  // Anthropic / OpenAI style keys: sk-... (and sk-ant-...)
  /\bsk-[A-Za-z0-9-]{16,}\b/g,
  // Slack tokens: xox[baprs]-...
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 36 chars
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // Bearer tokens in headers
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
  // Email addresses
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
]

/**
 * Scrub text destined for an exported/persisted artifact. Removes:
 *   1. every caller-supplied literal (chat ids, usernames) — matched verbatim,
 *   2. recognisable secret/PII shapes (tokens, keys, emails).
 *
 * Literals are escaped before use so a value like `a.b` cannot act as a regex.
 * Pure and idempotent enough for repeated application (placeholder is inert).
 */
export function scrubText(text: string, redactions: string[] = []): string {
  if (!text) return text
  let out = text
  // Caller literals first (longest first so a longer id containing a shorter
  // one is fully removed rather than partially).
  const literals = [...new Set(redactions.filter((r) => r && r.length >= 2))].sort(
    (a, b) => b.length - a.length,
  )
  for (const lit of literals) {
    out = out.split(lit).join(REDACTION)
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, REDACTION)
  }
  return out
}

// ─── Digest ───────────────────────────────────────────────────────────────

/** A roll-up of incidents over a period, for the digest line / trend report. */
export interface DigestSummary {
  /** Incidents (folded fingerprints) whose lastAt falls in the window. */
  total: number
  /** Sum of occurrences across those incidents. */
  occurrences: number
  openCount: number
  byStage: Record<string, number>
  byFailureClass: Record<string, number>
  byCliVersion: Record<string, number>
}

/**
 * Summarise the incidents whose most-recent occurrence lands in
 * `[now - sinceMs, now]`. Pure — the store supplies the manifests it read.
 */
export function summarizeIncidents(
  manifests: IncidentManifest[],
  sinceMs: number,
  now: number,
): DigestSummary {
  const cutoff = now - sinceMs
  const summary: DigestSummary = {
    total: 0,
    occurrences: 0,
    openCount: 0,
    byStage: {},
    byFailureClass: {},
    byCliVersion: {},
  }
  for (const m of manifests) {
    if (m.lastAt < cutoff) continue
    summary.total++
    summary.occurrences += m.occurrences
    if (m.status === 'open') summary.openCount++
    bump(summary.byStage, m.stage)
    bump(summary.byFailureClass, m.failureClass ?? 'none')
    bump(summary.byCliVersion, m.cliVersion || 'unknown')
  }
  return summary
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1
}

/**
 * One-line, human-friendly digest. Zero-incident periods produce a short "all
 * clear" line rather than nothing, so the digest itself is a liveness signal.
 */
export function formatDigestLine(summary: DigestSummary, label = 'daily'): string {
  if (summary.total === 0) {
    return `🩺 ${label} digest: no turn-trace incidents`
  }
  const stages = Object.entries(summary.byStage)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s}×${n}`)
    .join(', ')
  return (
    `🩺 ${label} digest: ${summary.total} incident(s), ` +
    `${summary.occurrences} occurrence(s), ${summary.openCount} open — ${stages}`
  )
}
