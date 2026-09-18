import { existsSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { OrchestrationStore } from './store';
import { transcriptPath } from '../config/claude-settings';

/** Why a decision turn could not continue the previous CLI session. Absent on the
 * first turn of a session, which is an ordinary cold start rather than a fallback. */
export type CliSessionFallback = 'TRANSCRIPT_UNAVAILABLE' | 'WORKSPACE_CHANGED';

export interface CliSessionDecision {
  /** Session id handed to `--resume` or `--session-id`. */
  id: string;
  /** True to pass `--resume`; the transcript already carries the conversation. */
  resume: boolean;
  /** Set only when a session we had previously started could not be continued. */
  fallback?: CliSessionFallback;
}

/** Durable CLI session for an agent's decision turns.
 *
 * Decision turns keep the per-turn spawn/kill lifecycle, so without a stable id every
 * turn got a fresh random session from the CLI, re-sent a flattened copy of the recent
 * history, and paid a full cache write. Reusing one id lets each turn resume the
 * transcript Claude Code already persisted on disk, which the cache matches as a prefix.
 *
 * The transcript file is the authority, not this table: `--resume` and `--session-id` are
 * mutually exclusive (the CLI rejects a missing transcript and rejects reusing a live id),
 * so the decision is re-derived from disk on every turn. This table only records which id
 * belongs to which session, which is what makes a vanished transcript distinguishable from
 * an ordinary first turn.
 */
export class AgentCliSessions {
  constructor(private readonly store: OrchestrationStore) {
    store.run(`CREATE TABLE IF NOT EXISTS agent_cli_sessions (
      session_id TEXT PRIMARY KEY, cli_session_id TEXT NOT NULL, cwd TEXT NOT NULL,
      updated_at INTEGER NOT NULL)`);
  }

  /** Decide the CLI session for the next decision turn of `sessionId`, running in `cwd`. */
  resolve(sessionId: string, cwd: string): CliSessionDecision {
    const row = this.store.get('SELECT cli_session_id,cwd FROM agent_cli_sessions WHERE session_id=?', sessionId);
    if (row) {
      const previous = String(row.cli_session_id);
      // A different working directory means a different project slug, so the stored id
      // names a transcript this process would not be resuming into.
      if (String(row.cwd) !== cwd) return this.start(sessionId, cwd, 'WORKSPACE_CHANGED');
      if (this.transcriptReadable(cwd, previous)) return { id: previous, resume: true };
      return this.start(sessionId, cwd, 'TRANSCRIPT_UNAVAILABLE');
    }
    return this.start(sessionId, cwd);
  }

  /** A turn observed the CLI refusing the stored id; the next turn must start fresh. */
  forget(sessionId: string): void {
    this.store.run('DELETE FROM agent_cli_sessions WHERE session_id=?', sessionId);
  }

  private start(sessionId: string, cwd: string, fallback?: CliSessionFallback): CliSessionDecision {
    const id = randomUUID();
    this.store.run(`INSERT INTO agent_cli_sessions(session_id,cli_session_id,cwd,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET cli_session_id=excluded.cli_session_id,cwd=excluded.cwd,updated_at=excluded.updated_at`,
      sessionId, id, cwd, Date.now());
    return { id, resume: false, ...(fallback ? { fallback } : {}) };
  }

  /** An empty file is as unresumable as a missing one and reads as a truncated transcript. */
  private transcriptReadable(cwd: string, cliSessionId: string): boolean {
    const file = transcriptPath(cwd, cliSessionId);
    try { return existsSync(file) && statSync(file).size > 0; } catch { return false; }
  }
}

/** The CLI prints this and exits non-zero when `--resume` names a transcript it cannot read. */
export function resumeRejected(stderr: string | null | undefined): boolean {
  return typeof stderr === 'string' && /No conversation found with session ID/i.test(stderr);
}
