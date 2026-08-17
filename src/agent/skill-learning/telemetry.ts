/**
 * Telemetry helpers — pure functions for building the per-turn record.
 *
 * The durable storage lives in HistoryDB (turn_metrics / skill_stats /
 * skill_review_runs). This module only owns the cheap derivations: the
 * intent-cluster signature and session-signal aggregation.
 */

import type { TurnMetricRow } from '../../history/db';
import type { SessionSignals } from './types';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'this', 'that', 'it',
  'you', 'i', 'me', 'my', 'we', 'please', 'can', 'could', 'would', 'should',
]);

/**
 * A cheap, deterministic task-cluster key for the first user message of a turn.
 * v1 = keyword/command signature (no embedding dependency, D2):
 *   - `/deploy foo`        → `cmd:deploy`
 *   - `fix the login bug`  → `kw:fix-login-bug`
 * Empty/whitespace input → `misc`.
 */
export function intentHash(firstUserMessage: string): string {
  const text = (firstUserMessage ?? '').trim();
  if (!text) return 'misc';

  // Slash-command: cluster by the command token.
  const cmd = text.match(/^\/([a-z0-9][a-z0-9:_-]*)/i);
  if (cmd) return `cmd:${cmd[1].toLowerCase()}`;

  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .slice(0, 5);

  return tokens.length ? `kw:${tokens.join('-')}` : 'misc';
}

/** Fold a session's turn rows into the aggregate signals the trigger gate reads. */
export function signalsFromTurns(rows: TurnMetricRow[]): SessionSignals {
  let toolCalls = 0;
  let recoveryFired = false;
  for (const r of rows) {
    if (r.toolCalls > toolCalls) toolCalls = r.toolCalls;
    if (r.recoveryFired) recoveryFired = true;
  }
  return { toolCalls, recoveryFired, userCorrection: false };
}

/** Signed offset (ms) of `timezone` relative to UTC at instant `now`. +ve = ahead of UTC. */
function tzOffsetMs(now: number, timezone: string): number {
  const d = new Date(now);
  // Parsing each localized wall-clock string back through `new Date` adds the
  // server's own offset to both sides equally, so the difference is exactly the
  // target tz's offset from UTC. Standard, dependency-free technique.
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  const local = new Date(d.toLocaleString('en-US', { timeZone: timezone })).getTime();
  return local - utc;
}

/** Midnight-of-today epoch ms in a timezone (for daily budget windows). Falls back to UTC math. */
export function startOfDayMs(now: number, timezone: string): number {
  try {
    const d = new Date(now);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    if (y && m && day) {
      // `Date.UTC(...)` is midnight of the tz-local date expressed as if it were
      // UTC; subtract the tz offset to get the epoch ms of true LOCAL midnight.
      // (e.g. UTC+7: local midnight is 07:00 earlier than the UTC-labelled one.)
      const utcLabelledMidnight = Date.UTC(Number(y), Number(m) - 1, Number(day));
      return utcLabelledMidnight - tzOffsetMs(now, timezone);
    }
  } catch {
    /* fall through to UTC */
  }
  // UTC fallback: truncate to day.
  return now - (now % (24 * 60 * 60 * 1000));
}
