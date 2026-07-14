/**
 * Incident store (Epic #195, Phase 2).
 *
 * Persists turn-trace stall incidents as on-disk bundles under
 * `<dir>/<id>/`, deduplicates repeats by fingerprint within a rolling window,
 * escalates according to the pure rules in incident.ts, and prunes old bundles.
 *
 * All IO is funnelled through an injected `fs` and `now()` so the store is
 * fully unit-testable against an in-memory filesystem (no real disk, no real
 * clock). The pure decision logic (fingerprint, escalation, scrub, digest)
 * lives in incident.ts; this file only orchestrates it and touches disk.
 *
 * A bundle is captured BEFORE any recovery mutates state (Phase 3 recovery runs
 * after record() returns), so evidence reflects the wedged turn, not its
 * aftermath. Every text artifact is scrubbed on the way in.
 */

import type { TurnIncident, TurnIncidentEvidence } from './turn-trace'
import {
  computeFingerprint,
  fingerprintHash,
  decideEscalation,
  maxEscalationLevel,
  scrubText,
  summarizeIncidents,
  DEFAULT_ESCALATION,
  type EscalationConfig,
  type EscalationDecision,
  type EscalationLevel,
  type IncidentManifest,
  type IncidentSample,
  type DigestSummary,
  type RecoveryOutcome,
} from './incident'

/** Minimal filesystem surface the store needs. Node's `fs` satisfies it. */
export interface IncidentFsApi {
  mkdirSync(path: string, opts: { recursive: boolean }): void
  writeFileSync(path: string, data: string): void
  readFileSync(path: string, enc: 'utf8'): string
  existsSync(path: string): boolean
  readdirSync(path: string): string[]
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void
}

export interface IncidentStoreDeps {
  /** Base directory for incident bundles (e.g. ~/.claude-gateway/incidents). */
  dir: string
  fs: IncidentFsApi
  /** Clock injection — epoch ms. */
  now: () => number
  /** Transport name recorded on each incident ('telegram' | 'discord' | ...). */
  channel: string
  /** Gateway version, recorded for context (not part of the fingerprint). */
  gatewayVersion: string
  /** Lazily resolves the Claude CLI version (part of the fingerprint). */
  getCliVersion: () => string
  /** Retention: bundles whose lastAt is older than this are pruned (ms). */
  retentionMs?: number
  /** Retention: hard cap on bundle count (oldest pruned first). */
  maxIncidents?: number
  /** Escalation thresholds. */
  escalation?: EscalationConfig
  /** Max occurrence samples retained per incident. */
  maxSamples?: number
}

/** Outcome of recording one stall occurrence. */
export interface RecordResult {
  id: string
  fingerprint: string
  occurrences: number
  escalation: EscalationDecision
  /** True when this created a fresh bundle (vs. folding into an existing one). */
  isNew: boolean
  manifest: IncidentManifest
}

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const DEFAULT_MAX_INCIDENTS = 500
const DEFAULT_MAX_SAMPLES = 20
const MANIFEST = 'manifest.json'

export interface IncidentStore {
  record(incident: TurnIncident, evidence?: TurnIncidentEvidence): RecordResult
  /** Load a manifest by id, or null if absent/corrupt. */
  get(id: string): IncidentManifest | null
  /** Record that the user was notified at a level (dedupes re-notifying). */
  markNotified(id: string, level: EscalationLevel, at?: number): void
  /**
   * Append a recovery outcome to an incident bundle (Phase 3b). The runner
   * executes recovery and returns the outcome; the receiver persists it here so
   * the bundle records what was attempted and whether it worked. Capped like
   * samples so a flapping stall cannot grow the manifest unbounded.
   */
  appendRecovery(id: string, outcome: RecoveryOutcome): void
  /** Link a filed GitHub issue to an incident fingerprint. */
  linkIssue(id: string, issueNumber: number): void
  /** Mark an incident resolved (stops it folding new occurrences). */
  resolve(id: string): void
  /** Prune bundles past retention / over the count cap. Returns pruned ids. */
  prune(): string[]
  /** Digest summary over the last `sinceMs`. */
  digest(sinceMs: number): DigestSummary
  /** All manifests currently on disk (unsorted). */
  list(): IncidentManifest[]
}

export function createIncidentStore(deps: IncidentStoreDeps): IncidentStore {
  const {
    dir,
    fs,
    now,
    channel,
    gatewayVersion,
    getCliVersion,
    retentionMs = DEFAULT_RETENTION_MS,
    maxIncidents = DEFAULT_MAX_INCIDENTS,
    escalation = DEFAULT_ESCALATION,
    maxSamples = DEFAULT_MAX_SAMPLES,
  } = deps

  // In-memory index of currently-open incidents by fingerprint, so dedup does
  // not rescan every bundle on each stall. Rebuilt from disk on construction so
  // dedup survives a process restart.
  const openByFingerprint = new Map<string, string>() // fingerprint → id

  function bundleDir(id: string): string {
    return join(dir, id)
  }
  function manifestPath(id: string): string {
    return join(bundleDir(id), MANIFEST)
  }

  function ensureBaseDir(): void {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      // Best-effort; a subsequent write will surface a real failure.
    }
  }

  function readManifest(id: string): IncidentManifest | null {
    try {
      const raw = fs.readFileSync(manifestPath(id), 'utf8')
      const m = JSON.parse(raw) as IncidentManifest
      // Defensive: a manifest missing its id is treated as corrupt.
      if (!m || typeof m.id !== 'string' || typeof m.fingerprint !== 'string') {
        return null
      }
      return m
    } catch {
      return null
    }
  }

  function writeManifest(m: IncidentManifest): void {
    fs.mkdirSync(bundleDir(m.id), { recursive: true })
    fs.writeFileSync(manifestPath(m.id), JSON.stringify(m, null, 2))
  }

  function listIds(): string[] {
    try {
      return fs.readdirSync(dir).filter((name) => {
        // Only directories that contain a manifest count as bundles.
        return fs.existsSync(manifestPath(name))
      })
    } catch {
      return []
    }
  }

  // ── Rebuild the open-fingerprint index from disk on construction. ──────────
  ensureBaseDir()
  for (const id of listIds()) {
    const m = readManifest(id)
    if (m && m.status === 'open') {
      // If two open bundles share a fingerprint (shouldn't happen), keep the
      // most recent so folding continues on the freshest episode.
      const existing = openByFingerprint.get(m.fingerprint)
      if (!existing) {
        openByFingerprint.set(m.fingerprint, m.id)
      } else {
        const prev = readManifest(existing)
        if (!prev || m.lastAt >= prev.lastAt) {
          openByFingerprint.set(m.fingerprint, m.id)
        }
      }
    }
  }

  function scrubEvidence(
    evidence: TurnIncidentEvidence | undefined,
    redactions: string[],
  ): Record<string, string> {
    const files: Record<string, string> = {}
    if (!evidence) return files
    if (evidence.artifacts && evidence.artifacts.length > 0) {
      files['typing-artifacts.txt'] = scrubText(
        evidence.artifacts.join('\n'),
        redactions,
      )
    }
    if (evidence.statusText) {
      files['status.txt'] = scrubText(evidence.statusText, redactions)
    }
    if (evidence.errorText) {
      files['error.txt'] = scrubText(evidence.errorText, redactions)
    }
    return files
  }

  function record(
    incident: TurnIncident,
    evidence?: TurnIncidentEvidence,
  ): RecordResult {
    const at = incident.at || now()
    const cliVersion = safe(getCliVersion) || 'unknown'
    const fingerprint = computeFingerprint({
      stage: incident.stage,
      failureClass: incident.failureClass,
      cliVersion,
    })

    const sample: IncidentSample = {
      at,
      sinceMs: incident.sinceMs,
      budgetMs: incident.budgetMs,
      midTurn: incident.midTurn,
    }

    // Try to fold into an existing open incident within the dedup window.
    const existingId = openByFingerprint.get(fingerprint)
    if (existingId) {
      const existing = readManifest(existingId)
      if (
        existing &&
        existing.status === 'open' &&
        at - existing.lastAt <= escalation.windowMs
      ) {
        existing.occurrences += 1
        existing.lastAt = at
        existing.samples = pushCapped(existing.samples, sample, maxSamples)
        const escalated = decideEscalation(
          existing.occurrences,
          existing.notifiedLevel === 'investigate',
          escalation,
        )
        existing.escalationLevel = maxEscalationLevel(
          existing.escalationLevel,
          escalated.level,
        )
        writeManifest(existing)
        return {
          id: existing.id,
          fingerprint,
          occurrences: existing.occurrences,
          escalation: escalated,
          isNew: false,
          manifest: existing,
        }
      }
      // Stale or resolved → drop the stale index entry and fall through to new.
      openByFingerprint.delete(fingerprint)
    }

    // Fresh incident bundle.
    const id = `${fingerprintHash(fingerprint)}-${at}`
    const escalated = decideEscalation(1, false, escalation)
    const manifest: IncidentManifest = {
      id,
      fingerprint,
      stage: incident.stage,
      failureClass: incident.failureClass,
      cliVersion,
      gatewayVersion,
      channel,
      firstAt: at,
      lastAt: at,
      occurrences: 1,
      escalationLevel: escalated.level,
      status: 'open',
      notifiedAt: null,
      notifiedLevel: null,
      githubIssue: null,
      recovery: [],
      samples: [sample],
    }

    // Redact the chat id and any known handle from all exported text.
    const redactions = [incident.chatId]
    writeManifest(manifest)
    const files = scrubEvidence(evidence, redactions)
    for (const [name, content] of Object.entries(files)) {
      try {
        fs.writeFileSync(join(bundleDir(id), name), content)
      } catch {
        // A failed artifact write must not lose the incident itself.
      }
    }

    openByFingerprint.set(fingerprint, id)
    // Enforce the count cap opportunistically on creation.
    prune()
    return { id, fingerprint, occurrences: 1, escalation: escalated, isNew: true, manifest }
  }

  function get(id: string): IncidentManifest | null {
    return readManifest(id)
  }

  function markNotified(id: string, level: EscalationLevel, atArg?: number): void {
    const m = readManifest(id)
    if (!m) return
    m.notifiedAt = atArg ?? now()
    m.notifiedLevel = m.notifiedLevel
      ? maxEscalationLevel(m.notifiedLevel, level)
      : level
    writeManifest(m)
  }

  function appendRecovery(id: string, outcome: RecoveryOutcome): void {
    const m = readManifest(id)
    if (!m) return
    m.recovery = pushCapped(m.recovery ?? [], outcome, maxSamples)
    writeManifest(m)
  }

  function linkIssue(id: string, issueNumber: number): void {
    const m = readManifest(id)
    if (!m) return
    m.githubIssue = issueNumber
    writeManifest(m)
  }

  function resolve(id: string): void {
    const m = readManifest(id)
    if (!m) return
    m.status = 'resolved'
    writeManifest(m)
    if (openByFingerprint.get(m.fingerprint) === id) {
      openByFingerprint.delete(m.fingerprint)
    }
  }

  function list(): IncidentManifest[] {
    const out: IncidentManifest[] = []
    for (const id of listIds()) {
      const m = readManifest(id)
      if (m) out.push(m)
    }
    return out
  }

  function prune(): string[] {
    const manifests = list()
    const cutoff = now() - retentionMs
    const pruned: string[] = []

    // Age-based prune.
    const survivors: IncidentManifest[] = []
    for (const m of manifests) {
      if (m.lastAt < cutoff) {
        removeBundle(m.id)
        pruned.push(m.id)
      } else {
        survivors.push(m)
      }
    }

    // Count-cap prune: drop oldest (by lastAt) beyond the cap.
    if (survivors.length > maxIncidents) {
      survivors.sort((a, b) => a.lastAt - b.lastAt) // oldest first
      const overflow = survivors.length - maxIncidents
      for (let i = 0; i < overflow; i++) {
        removeBundle(survivors[i].id)
        pruned.push(survivors[i].id)
      }
    }

    // Keep the open-fingerprint index consistent with what remains.
    for (const id of pruned) {
      for (const [fp, mapped] of openByFingerprint) {
        if (mapped === id) openByFingerprint.delete(fp)
      }
    }
    return pruned
  }

  function removeBundle(id: string): void {
    try {
      fs.rmSync(bundleDir(id), { recursive: true, force: true })
    } catch {
      // Best-effort.
    }
  }

  function digest(sinceMs: number): DigestSummary {
    return summarizeIncidents(list(), sinceMs, now())
  }

  return { record, get, markNotified, appendRecovery, linkIssue, resolve, prune, digest, list }
}

/** Path join without importing `path` (keeps the module dependency-light). */
function join(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p.length > 0)
    .join('/')
}

/** Push onto a capped ring, dropping the oldest when full. */
function pushCapped<T>(arr: T[], item: T, cap: number): T[] {
  const next = [...arr, item]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/** Call a provider defensively; any throw collapses to ''. */
function safe(fn: () => string): string {
  try {
    return fn()
  } catch {
    return ''
  }
}
