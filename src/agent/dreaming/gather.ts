/**
 * Gather the lookback transcript slice for a dream run from the agent's own
 * HistoryDB. Read-only; bounded in size. Best-effort — DB errors degrade to an
 * empty slice rather than throwing (the daemon must never wedge on a dream).
 */

import type { ResolvedDreamingCfg } from './types';

/** The subset of HistoryDB the dreamer reads (injectable for tests). */
export interface DreamHistoryDb {
  listSessions(chatId?: string): Array<{ sessionId: string; lastActivity: number }>;
  getSessionTranscript(sessionId: string, limit?: number): Array<{ role: string; content: string; ts: number }>;
}

export interface GatherResult {
  transcript: string;
  sessionCount: number;
  /** Most recent activity across ALL sessions (ms), 0 if none. For the quiet-window check. */
  lastActivityMs: number;
}

const PER_SESSION_LIMIT = 200;
const MAX_TRANSCRIPT_CHARS = 40_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Build the transcript slice for sessions active within the lookback window.
 * Sessions are ordered oldest→newest; if the concatenation exceeds the char
 * cap, the most-recent tail is kept.
 */
export function gatherTranscript(db: DreamHistoryDb, cfg: ResolvedDreamingCfg, now: number): GatherResult {
  const cutoff = now - cfg.lookbackDays * MS_PER_DAY;
  let sessions: Array<{ sessionId: string; lastActivity: number }>;
  try {
    sessions = db.listSessions();
  } catch {
    return { transcript: '', sessionCount: 0, lastActivityMs: 0 };
  }

  const lastActivityMs = sessions.reduce((max, s) => Math.max(max, s.lastActivity ?? 0), 0);
  const recent = sessions
    .filter((s) => (s.lastActivity ?? 0) >= cutoff)
    .sort((a, b) => (a.lastActivity ?? 0) - (b.lastActivity ?? 0));

  if (recent.length === 0) {
    return { transcript: '', sessionCount: 0, lastActivityMs };
  }

  const blocks: string[] = [];
  for (const s of recent) {
    let rows: Array<{ role: string; content: string; ts: number }>;
    try {
      rows = db.getSessionTranscript(s.sessionId, PER_SESSION_LIMIT);
    } catch {
      rows = [];
    }
    const text = rows
      .map((r) => `${r.role}: ${r.content}`)
      .join('\n')
      .trim();
    if (text) blocks.push(`<session id="${s.sessionId}">\n${text}\n</session>`);
  }

  let transcript = blocks.join('\n\n');
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS);
  }
  return { transcript, sessionCount: blocks.length, lastActivityMs };
}
