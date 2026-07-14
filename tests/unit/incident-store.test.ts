/**
 * Unit tests for src/agent/incident-store.ts — persistence, fingerprint dedup,
 * escalation, retention pruning, and scrubbed evidence export. Uses an in-memory
 * filesystem and an injected clock: no real disk, no real Date.now().
 */

import { createIncidentStore, type IncidentFsApi } from '../../src/agent/incident-store'
import type { TurnIncident, TurnIncidentEvidence } from '../../src/agent/turn-trace'
import { REDACTION } from '../../src/agent/incident'

const T0 = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** Minimal in-memory fs implementing the IncidentFsApi surface. */
function memFs(): IncidentFsApi & { dump(): Record<string, string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()

  const parent = (p: string): string => {
    const i = p.lastIndexOf('/')
    return i <= 0 ? '' : p.slice(0, i)
  }
  const base = (p: string): string => {
    const i = p.lastIndexOf('/')
    return i < 0 ? p : p.slice(i + 1)
  }
  const addDir = (p: string): void => {
    let cur = p
    while (cur && !dirs.has(cur)) {
      dirs.add(cur)
      cur = parent(cur)
    }
  }

  return {
    mkdirSync(path: string): void {
      addDir(path)
    },
    writeFileSync(path: string, data: string): void {
      addDir(parent(path))
      files.set(path, data)
    },
    readFileSync(path: string): string {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`)
      return files.get(path) as string
    },
    existsSync(path: string): boolean {
      return files.has(path) || dirs.has(path)
    },
    readdirSync(path: string): string[] {
      const out = new Set<string>()
      for (const f of files.keys()) if (parent(f) === path) out.add(base(f))
      for (const d of dirs) if (parent(d) === path) out.add(base(d))
      if (!dirs.has(path)) {
        // Node throws on a missing dir; the store guards readdir with try/catch.
        if (out.size === 0) throw new Error(`ENOENT: ${path}`)
      }
      return [...out]
    },
    rmSync(path: string): void {
      for (const f of [...files.keys()]) {
        if (f === path || f.startsWith(path + '/')) files.delete(f)
      }
      for (const d of [...dirs]) {
        if (d === path || d.startsWith(path + '/')) dirs.delete(d)
      }
    },
    dump(): Record<string, string> {
      return Object.fromEntries(files)
    },
  }
}

function incident(overrides: Partial<TurnIncident> = {}): TurnIncident {
  return {
    chatId: '997170033',
    stage: 'progress',
    failureClass: 'claude-cli',
    sinceMs: 320_000,
    budgetMs: 300_000,
    midTurn: false,
    at: T0,
    ...overrides,
  }
}

function makeStore(now: () => number, opts: Partial<Parameters<typeof createIncidentStore>[0]> = {}) {
  return createIncidentStore({
    dir: '/incidents',
    fs: memFs(),
    now,
    channel: 'telegram',
    gatewayVersion: '1.3.25',
    getCliVersion: () => '2.1.0',
    ...opts,
  })
}

describe('createIncidentStore.record', () => {
  test('U-IS-01: first stall persists a bundle with manifest', () => {
    let clock = T0
    const store = makeStore(() => clock)
    const r = store.record(incident())
    expect(r.isNew).toBe(true)
    expect(r.occurrences).toBe(1)
    expect(r.escalation).toEqual({ level: 'quiet', notify: true })
    const m = store.get(r.id)
    expect(m).not.toBeNull()
    expect(m!.fingerprint).toBe('progress:claude-cli:2.1.0')
    expect(m!.cliVersion).toBe('2.1.0')
    expect(m!.channel).toBe('telegram')
    expect(m!.status).toBe('open')
  })

  test('U-IS-02: same fingerprint within window folds (dedup, no re-notify)', () => {
    let clock = T0
    const store = makeStore(() => clock)
    const r1 = store.record(incident({ at: clock }))
    clock = T0 + 1000
    const r2 = store.record(incident({ at: clock }))
    expect(r2.isNew).toBe(false)
    expect(r2.id).toBe(r1.id)
    expect(r2.occurrences).toBe(2)
    expect(r2.escalation.notify).toBe(false) // silent increment
    expect(store.list().length).toBe(1)
  })

  test('U-IS-03: third occurrence within window escalates to investigate', () => {
    let clock = T0
    const store = makeStore(() => clock)
    store.record(incident({ at: clock }))
    clock += 1000
    store.record(incident({ at: clock }))
    clock += 1000
    const r3 = store.record(incident({ at: clock }))
    expect(r3.occurrences).toBe(3)
    expect(r3.escalation).toEqual({ level: 'investigate', notify: true })
    expect(store.get(r3.id)!.escalationLevel).toBe('investigate')
  })

  test('U-IS-04: same fingerprint outside window opens a new bundle', () => {
    let clock = T0
    const store = makeStore(() => clock)
    const r1 = store.record(incident({ at: clock }))
    clock = T0 + 2 * DAY // well past the 24h window
    const r2 = store.record(incident({ at: clock }))
    expect(r2.isNew).toBe(true)
    expect(r2.id).not.toBe(r1.id)
    expect(store.list().length).toBe(2)
  })

  test('U-IS-05: different failure class is a distinct fingerprint', () => {
    const clock = T0
    const store = makeStore(() => clock)
    store.record(incident({ stage: 'dispatch', failureClass: 'receiver-out' }))
    store.record(incident({ stage: 'progress', failureClass: 'claude-cli' }))
    expect(store.list().length).toBe(2)
  })

  test('U-IS-06: evidence is scrubbed before it is written to disk', () => {
    const fs = memFs()
    const store = createIncidentStore({
      dir: '/incidents',
      fs,
      now: () => T0,
      channel: 'telegram',
      gatewayVersion: '1.3.25',
      getCliVersion: () => '2.1.0',
    })
    const evidence: TurnIncidentEvidence = {
      artifacts: ['signal', 'status=thinking'],
      statusText: 'chat 997170033 waiting',
      errorText: 'token 123456789:AAHfiqABCDEFGHIJKLMNOPQRSTUVWXYZ0123456 failed',
    }
    store.record(incident({ chatId: '997170033' }), evidence)
    const dump = fs.dump()
    const allContent = Object.values(dump).join('\n')
    expect(allContent).not.toContain('997170033')
    expect(allContent).not.toContain('123456789:AAHfiqABCDEFGHIJKLMNOPQRSTUVWXYZ0123456')
    // The status artifact exists and is redacted.
    const statusFile = Object.entries(dump).find(([k]) => k.endsWith('status.txt'))
    expect(statusFile).toBeDefined()
    expect(statusFile![1]).toContain(REDACTION)
  })

  test('U-IS-07: chat id never appears in the persisted manifest', () => {
    const fs = memFs()
    const store = createIncidentStore({
      dir: '/incidents',
      fs,
      now: () => T0,
      channel: 'telegram',
      gatewayVersion: '1.3.25',
      getCliVersion: () => '2.1.0',
    })
    store.record(incident({ chatId: '997170033' }))
    const manifestEntry = Object.entries(fs.dump()).find(([k]) => k.endsWith('manifest.json'))
    expect(manifestEntry).toBeDefined()
    expect(manifestEntry![1]).not.toContain('997170033')
  })
})

describe('createIncidentStore dedup survives a restart (rebuild index from disk)', () => {
  test('U-IS-08: a second store over the same fs folds into the open bundle', () => {
    const fs = memFs()
    const deps = {
      dir: '/incidents',
      fs,
      now: () => T0 + 1000,
      channel: 'telegram',
      gatewayVersion: '1.3.25',
      getCliVersion: () => '2.1.0',
    }
    const store1 = createIncidentStore({ ...deps, now: () => T0 })
    const r1 = store1.record(incident({ at: T0 }))
    // New store instance (simulated restart) sees the open bundle on disk.
    const store2 = createIncidentStore(deps)
    const r2 = store2.record(incident({ at: T0 + 1000 }))
    expect(r2.id).toBe(r1.id)
    expect(r2.occurrences).toBe(2)
  })
})

describe('createIncidentStore.prune', () => {
  test('U-IS-09: bundles older than retention are pruned by lastAt', () => {
    let clock = T0
    const store = makeStore(() => clock, { retentionMs: DAY })
    const r = store.record(incident({ at: clock }))
    clock = T0 + 2 * DAY
    const pruned = store.prune()
    expect(pruned).toContain(r.id)
    expect(store.get(r.id)).toBeNull()
    expect(store.list().length).toBe(0)
  })

  test('U-IS-10: count cap drops the oldest bundles first', () => {
    let clock = T0
    const store = makeStore(() => clock, { maxIncidents: 2 })
    // Three distinct fingerprints (different stages) at increasing times.
    const a = store.record(incident({ at: (clock = T0), stage: 'inject', failureClass: 'runner' }))
    const b = store.record(incident({ at: (clock = T0 + 1000), stage: 'startup', failureClass: 'session-process' }))
    store.record(incident({ at: (clock = T0 + 2000), stage: 'dispatch', failureClass: 'receiver-out' }))
    // Creation triggers an opportunistic prune → oldest (a) evicted.
    expect(store.get(a.id)).toBeNull()
    expect(store.get(b.id)).not.toBeNull()
    expect(store.list().length).toBe(2)
  })
})

describe('createIncidentStore mutators + digest', () => {
  test('U-IS-11: markNotified records level; resolve stops folding', () => {
    let clock = T0
    const store = makeStore(() => clock)
    const r = store.record(incident({ at: clock }))
    store.markNotified(r.id, 'quiet')
    expect(store.get(r.id)!.notifiedLevel).toBe('quiet')
    store.resolve(r.id)
    expect(store.get(r.id)!.status).toBe('resolved')
    // A later stall with the same fingerprint opens a fresh bundle.
    clock = T0 + 1000
    const r2 = store.record(incident({ at: clock }))
    expect(r2.id).not.toBe(r.id)
    expect(r2.isNew).toBe(true)
  })

  test('U-IS-12: linkIssue attaches a GitHub issue number', () => {
    const store = makeStore(() => T0)
    const r = store.record(incident())
    store.linkIssue(r.id, 195)
    expect(store.get(r.id)!.githubIssue).toBe(195)
  })

  test('U-IS-12b: appendRecovery records outcomes (Phase 3b), capped like samples', () => {
    const store = makeStore(() => T0, { maxSamples: 2 })
    const r = store.record(incident())
    expect(store.get(r.id)!.recovery).toEqual([])
    store.appendRecovery(r.id, { action: 'esc-esc', at: T0, ok: true, detail: 'first' })
    store.appendRecovery(r.id, { action: 'restart-session', at: T0 + 1, ok: false, detail: 'second' })
    store.appendRecovery(r.id, { action: 'select-option:2', at: T0 + 2, ok: true, detail: 'third' })
    const rec = store.get(r.id)!.recovery
    // Capped at maxSamples (2), keeping the most recent.
    expect(rec.length).toBe(2)
    expect(rec[rec.length - 1].action).toBe('select-option:2')
  })

  test('U-IS-12c: appendRecovery on an unknown id is a no-op (no throw)', () => {
    const store = makeStore(() => T0)
    expect(() => store.appendRecovery('nope', { action: 'esc', at: T0, ok: true })).not.toThrow()
  })

  test('U-IS-13: digest summarises incidents in the window', () => {
    let clock = T0
    const store = makeStore(() => clock)
    store.record(incident({ at: clock, stage: 'progress', failureClass: 'claude-cli' }))
    store.record(incident({ at: clock, stage: 'dispatch', failureClass: 'receiver-out' }))
    clock = T0 + 60_000
    const d = store.digest(DAY)
    expect(d.total).toBe(2)
    expect(d.byStage['progress']).toBe(1)
    expect(d.byStage['dispatch']).toBe(1)
  })

  test('U-IS-14: getCliVersion that throws collapses to "unknown"', () => {
    const store = makeStore(() => T0, {
      getCliVersion: () => {
        throw new Error('claude not found')
      },
    })
    const r = store.record(incident())
    expect(store.get(r.id)!.cliVersion).toBe('unknown')
    expect(r.fingerprint.endsWith(':unknown')).toBe(true)
  })
})
