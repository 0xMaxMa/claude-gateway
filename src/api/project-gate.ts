import type { Response } from 'express';
import type { AgentRunner } from '../agent/runner';
import type { ApiKey } from '../types';
import { isAdmin, PROJECTS_ADMIN_REQUIRED } from './auth';

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Only an admin key may reveal or control a project-bound session. True when `apiKey` is not admin and the session
 * is bound, or its binding cannot be read. A malformed id names no session, so it is not refused here.
 */
export async function refusesProjectChat(runner: AgentRunner, apiKey: ApiKey, sessionId: string): Promise<boolean> {
  if (isAdmin(apiKey) || !SESSION_ID_RE.test(sessionId)) return false;
  return (await runner.apiSessionBinding(sessionId)).kind !== 'unbound';
}

/**
 * The project-bound sessions `apiKey` must not see: none for an admin key. `null` when the binding files cannot be
 * listed, which the caller answers as a refusal.
 */
export async function hiddenSessions(runner: AgentRunner, apiKey: ApiKey): Promise<string[] | null> {
  if (isAdmin(apiKey)) return [];
  try {
    return [...(await runner.boundSessionIds())];
  } catch {
    return null;
  }
}

/**
 * The sessions a history read of one chat must leave out for `apiKey`. Asking for a bound session by name, or a
 * binding list that cannot be read, is answered 403 here and returns `null`.
 */
export async function historyExclusions(runner: AgentRunner, apiKey: ApiKey, requestedSession: unknown, res: Response): Promise<string[] | null> {
  if (requestedSession !== undefined && typeof requestedSession !== 'string') {
    res.status(400).json({ error: 'session_id must be a single string', code: 'INVALID_INPUT' });
    return null;
  }
  const hidden = await hiddenSessions(runner, apiKey);
  if (!hidden || (typeof requestedSession === 'string' && hidden.includes(requestedSession))) {
    res.status(403).json(PROJECTS_ADMIN_REQUIRED);
    return null;
  }
  return hidden;
}
