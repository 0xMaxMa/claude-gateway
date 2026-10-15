import type { Response } from 'express';
import type { AgentRunner } from '../agent/runner';
import type { ApiKey } from '../types';
import { SESSION_ID_RE } from '../session/store';
import { isAdmin, PROJECTS_ADMIN_REQUIRED } from './auth';


/**
 * Only an admin key may reveal or control a project-bound session. True when `apiKey` is not admin and the session
 * is bound, its binding cannot be read, or the id is malformed (a path, a dot segment, an encoded separator).
 * An empty id names nothing and is left to the handler's own 400.
 */
export async function refusesProjectChat(runner: AgentRunner, apiKey: ApiKey, sessionId: string): Promise<boolean> {
  if (isAdmin(apiKey) || sessionId === '') return false;
  if (!SESSION_ID_RE.test(sessionId)) return true;
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
