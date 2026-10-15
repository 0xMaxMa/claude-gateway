import * as fs from 'fs';
import * as path from 'path';
import type { Request, Response } from 'express';
import type { AgentRunner } from '../agent/runner';
import type { ApiKey } from '../types';
import { SESSION_ID_RE } from '../session/store';
import { MediaStore } from '../history/media-store';
import { AGENT_SESSION_TOKEN_HEADER, isAgentSessionToken } from './agent-credential';
import { isAdmin, PROJECTS_ADMIN_REQUIRED } from './auth';


/** What a non-admin read gets when the binding files cannot be listed: the gateway cannot tell which sessions to hide. */
export const BINDINGS_UNREADABLE = {
  error: 'Project bindings cannot be read on this gateway, so history and sessions are unavailable to this key. An operator should check the gateway log.',
  code: 'project_bindings_unreadable',
} as const;

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
 * The sessions a history read of one chat must leave out for `apiKey`. Asking for a bound session by name is
 * answered 403 here, and a binding list that cannot be read 503; both return `null`.
 */
export async function historyExclusions(runner: AgentRunner, apiKey: ApiKey, requestedSession: unknown, res: Response): Promise<string[] | null> {
  if (requestedSession !== undefined && typeof requestedSession !== 'string') {
    res.status(400).json({ error: 'session_id must be a single string', code: 'INVALID_INPUT' });
    return null;
  }
  const hidden = await hiddenSessions(runner, apiKey);
  if (!hidden) {
    res.status(503).json(BINDINGS_UNREADABLE);
    return null;
  }
  if (typeof requestedSession === 'string' && hidden.includes(requestedSession)) {
    res.status(403).json(PROJECTS_ADMIN_REQUIRED);
    return null;
  }
  return hidden;
}

/** The session token the caller presented, if any. */
export function presentedSessionToken(req: Request): string | undefined {
  const v = req.headers[AGENT_SESSION_TOKEN_HEADER];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Like `refusesProjectChat`, for routes the agent's own tools call (attachments, shares, image artifacts and
 * catalogs). The agent running session `sessionId` proves itself with the token it was spawned with, so a project
 * chat can still attach media and mint shares for itself while no outside non-admin key can.
 */
export async function refusesProjectSession(runner: AgentRunner, agentId: string, apiKey: ApiKey, sessionId: string, token?: string): Promise<boolean> {
  if (isAgentSessionToken(token, agentId, sessionId)) return false;
  return refusesProjectChat(runner, apiKey, sessionId);
}

/** The session a media path (relative to the agent's media folder, or prefixed `media/`) belongs to, after resolving dot segments and links. */
function mediaPathSession(runner: AgentRunner, agentId: string, relativePath: string): string | undefined {
  const base = runner.getAgentsBaseDir();
  let abs: string;
  try {
    abs = MediaStore.resolvePath(base, agentId, relativePath);
  } catch {
    return undefined;
  }
  let root = MediaStore.agentMediaRoot(base, agentId);
  try { root = fs.realpathSync(root); } catch { /* no media folder yet */ }
  const first = path.relative(root, abs).split(path.sep)[0] ?? '';
  return /^api-/i.test(first) ? first.slice(4) : undefined;
}

/** True when `relativePath` names a file of a project-bound session that `apiKey` (or the token's agent) may not reach. */
export async function refusesProjectMedia(runner: AgentRunner, agentId: string, apiKey: ApiKey, relativePath: string, token?: string): Promise<boolean> {
  const session = mediaPathSession(runner, agentId, relativePath);
  return session !== undefined && await refusesProjectSession(runner, agentId, apiKey, session, token);
}

/** What the share router asks, without holding the runners. */
export interface ProjectGate {
  refusesSession(apiKey: ApiKey, agentId: string, sessionId: string, token?: string): Promise<boolean>;
  refusesMedia(apiKey: ApiKey, agentId: string, relativePath: string, token?: string): Promise<boolean>;
}

export function projectGateFor(runners: ReadonlyMap<string, AgentRunner>): ProjectGate {
  return {
    async refusesSession(apiKey, agentId, sessionId, token) {
      const runner = runners.get(agentId);
      return runner ? refusesProjectSession(runner, agentId, apiKey, sessionId, token) : false;
    },
    async refusesMedia(apiKey, agentId, relativePath, token) {
      const runner = runners.get(agentId);
      return runner ? refusesProjectMedia(runner, agentId, apiKey, relativePath, token) : false;
    },
  };
}
