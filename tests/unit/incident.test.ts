/**
 * Unit tests for src/agent/incident.ts — the pure incident decision core.
 * No filesystem, no clock: fingerprinting, escalation, scrubbing, and digest
 * summarisation are all exercised as pure functions.
 */

import {
  computeFingerprint,
  fingerprintHash,
  decideEscalation,
  maxEscalationLevel,
  scrubText,
  summarizeIncidents,
  formatDigestLine,
  REDACTION,
  DEFAULT_ESCALATION,
  type IncidentManifest,
} from '../../src/agent/incident'

const T0 = 1_000_000_000_000

function manifest(overrides: Partial<IncidentManifest> = {}): IncidentManifest {
  return {
    id: 'abc-1',
    fingerprint: 'progress:claude-cli:2.1.0',
    stage: 'progress',
    failureClass: 'claude-cli',
    cliVersion: '2.1.0',
    gatewayVersion: '1.3.25',
    channel: 'telegram',
    firstAt: T0,
    lastAt: T0,
    occurrences: 1,
    escalationLevel: 'quiet',
    status: 'open',
    notifiedAt: null,
    notifiedLevel: null,
    githubIssue: null,
    recovery: [],
    samples: [],
    ...overrides,
  }
}

describe('computeFingerprint', () => {
  test('U-INC-01: stable string of stage:class:version', () => {
    expect(
      computeFingerprint({ stage: 'dispatch', failureClass: 'receiver-out', cliVersion: '2.1.0' }),
    ).toBe('dispatch:receiver-out:2.1.0')
  })

  test('U-INC-02: null failure class → "none"; empty version → "unknown"', () => {
    expect(
      computeFingerprint({ stage: 'idle', failureClass: null, cliVersion: '' }),
    ).toBe('idle:none:unknown')
    expect(
      computeFingerprint({ stage: 'idle', failureClass: null, cliVersion: undefined }),
    ).toBe('idle:none:unknown')
  })

  test('U-INC-03: a different CLI version is a different fingerprint', () => {
    const a = computeFingerprint({ stage: 'progress', failureClass: 'tui-overlay', cliVersion: '2.1.0' })
    const b = computeFingerprint({ stage: 'progress', failureClass: 'tui-overlay', cliVersion: '2.2.0' })
    expect(a).not.toBe(b)
  })
})

describe('fingerprintHash', () => {
  test('U-INC-04: deterministic and filesystem-safe (base36)', () => {
    const h1 = fingerprintHash('progress:claude-cli:2.1.0')
    const h2 = fingerprintHash('progress:claude-cli:2.1.0')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-z]+$/)
  })

  test('U-INC-05: distinct inputs → distinct hashes (no trivial collision)', () => {
    expect(fingerprintHash('a:b:c')).not.toBe(fingerprintHash('a:b:d'))
  })
})

describe('decideEscalation', () => {
  test('U-INC-06: first occurrence → quiet notify', () => {
    expect(decideEscalation(1, false)).toEqual({ level: 'quiet', notify: true })
  })

  test('U-INC-07: repeats below threshold → silent increment', () => {
    expect(decideEscalation(2, false)).toEqual({ level: 'repeat', notify: false })
  })

  test('U-INC-08: threshold reached (3rd) → investigate notify once', () => {
    expect(decideEscalation(3, false)).toEqual({ level: 'investigate', notify: true })
  })

  test('U-INC-09: already investigate-notified → silent afterwards', () => {
    expect(decideEscalation(4, true)).toEqual({ level: 'repeat', notify: false })
  })

  test('U-INC-10: threshold is configurable', () => {
    const cfg = { ...DEFAULT_ESCALATION, investigateThreshold: 2 }
    expect(decideEscalation(2, false, cfg)).toEqual({ level: 'investigate', notify: true })
  })
})

describe('maxEscalationLevel', () => {
  test('U-INC-11: picks the higher-ranked level regardless of order', () => {
    expect(maxEscalationLevel('quiet', 'investigate')).toBe('investigate')
    expect(maxEscalationLevel('investigate', 'repeat')).toBe('investigate')
    expect(maxEscalationLevel('quiet', 'repeat')).toBe('repeat')
    expect(maxEscalationLevel('quiet', 'quiet')).toBe('quiet')
  })
})

describe('scrubText', () => {
  test('U-INC-12: redacts caller literals (chat id / username)', () => {
    const out = scrubText('user 997170033 (maxma015) stalled', ['997170033', 'maxma015'])
    expect(out).not.toContain('997170033')
    expect(out).not.toContain('maxma015')
    expect(out).toContain(REDACTION)
  })

  test('U-INC-13: redacts a Telegram bot token', () => {
    const token = '123456789:AAHfiqABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'
    expect(scrubText(`token=${token}`)).not.toContain(token)
  })

  test('U-INC-14: redacts sk- keys and emails', () => {
    const out = scrubText('key sk-ant-abcdef0123456789ABCDEF mail a.b@example.com')
    expect(out).not.toContain('sk-ant-abcdef0123456789ABCDEF')
    expect(out).not.toContain('a.b@example.com')
  })

  test('U-INC-15: literal with regex metachars is matched verbatim, not as a pattern', () => {
    // "a.b" must not also remove "aXb"; only the literal "a.b" is redacted.
    const out = scrubText('a.b and aXb', ['a.b'])
    expect(out).toContain('aXb')
    expect(out).not.toContain('a.b')
  })

  test('U-INC-16: idempotent — re-scrubbing changes nothing further', () => {
    const once = scrubText('id 997170033', ['997170033'])
    expect(scrubText(once, ['997170033'])).toBe(once)
  })

  test('U-INC-17: empty input returns empty', () => {
    expect(scrubText('')).toBe('')
  })
})

describe('summarizeIncidents / formatDigestLine', () => {
  test('U-INC-18: counts only incidents whose lastAt is within the window', () => {
    const manifests = [
      manifest({ id: 'a', lastAt: T0 - 1000, occurrences: 2 }),
      manifest({ id: 'b', lastAt: T0 - 2 * 60 * 60 * 1000, stage: 'dispatch', occurrences: 1 }),
      manifest({ id: 'c', lastAt: T0 - 48 * 60 * 60 * 1000 }), // outside 24h
    ]
    const s = summarizeIncidents(manifests, 24 * 60 * 60 * 1000, T0)
    expect(s.total).toBe(2)
    expect(s.occurrences).toBe(3)
    expect(s.byStage['progress']).toBe(1)
    expect(s.byStage['dispatch']).toBe(1)
    expect(s.openCount).toBe(2)
  })

  test('U-INC-19: zero-incident window → "all clear" digest line', () => {
    const s = summarizeIncidents([], 24 * 60 * 60 * 1000, T0)
    expect(s.total).toBe(0)
    expect(formatDigestLine(s)).toContain('no turn-trace incidents')
  })

  test('U-INC-20: non-empty digest line reports counts and stage histogram', () => {
    const s = summarizeIncidents(
      [manifest({ id: 'a', lastAt: T0, occurrences: 3 })],
      24 * 60 * 60 * 1000,
      T0,
    )
    const line = formatDigestLine(s, 'weekly')
    expect(line).toContain('weekly')
    expect(line).toContain('1 incident')
    expect(line).toContain('progress×1')
  })
})
