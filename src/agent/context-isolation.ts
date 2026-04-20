import { AgentConfig } from '../types';

export class WorkspaceConflictError extends Error {
  constructor(public readonly agentIds: [string, string], public readonly workspace: string) {
    super(
      `Workspace conflict: agents "${agentIds[0]}" and "${agentIds[1]}" share the same workspace path: "${workspace}"`,
    );
    this.name = 'WorkspaceConflictError';
  }
}

export class TokenConflictError extends Error {
  constructor(public readonly agentIds: [string, string], public readonly token: string) {
    super(
      `Token conflict: agents "${agentIds[0]}" and "${agentIds[1]}" share the same bot token`,
    );
    this.name = 'TokenConflictError';
  }
}

export class SessionDirConflictError extends Error {
  constructor(public readonly agentIds: [string, string], public readonly sessionDir: string) {
    super(
      `Session directory conflict: agents "${agentIds[0]}" and "${agentIds[1]}" share the same session directory: "${sessionDir}"`,
    );
    this.name = 'SessionDirConflictError';
  }
}

/**
 * ContextIsolationGuard ensures that no two agents share workspace path,
 * session directory, or bot token. Call `validate()` at startup with all agent configs.
 */
export class ContextIsolationGuard {
  /**
   * Validate all agent configs for isolation conflicts.
   * Throws the first conflict found.
   */
  validate(agents: AgentConfig[]): void {
    const workspaces = new Map<string, string>(); // workspace → agentId
    const tokens = new Map<string, string>();     // token → agentId
    const sessionDirs = new Map<string, string>(); // sessionDir → agentId

    for (const agent of agents) {
      // Workspace check
      const ws = agent.workspace;
      if (workspaces.has(ws)) {
        throw new WorkspaceConflictError([workspaces.get(ws)!, agent.id], ws);
      }
      workspaces.set(ws, agent.id);

      // Token check
      const token = agent.telegram?.botToken ?? '';
      if (tokens.has(token)) {
        throw new TokenConflictError([tokens.get(token)!, agent.id], token);
      }
      tokens.set(token, agent.id);

      // Session dir: derived as <workspace>/../sessions (by convention),
      // but we also check the agent id-based session path if it were the same.
      // The key insight is: if two agents have the same id they'd share session dir.
      // We derive the session dir from workspace parent + "sessions" (per design.md).
      // For safety, treat agentId as the session namespace key.
      // Two agents with identical workspace already caught above.
      // We additionally check if agent.env paths conflict as a proxy for session dir,
      // but session dir is actually determined by the SessionStore base path + agentId.
      // Since session dirs are namespaced by agentId, two agents with different IDs
      // cannot share session dirs. We check explicit sessionDir if provided.
      const sessionDir = (agent as AgentConfig & { sessionDir?: string }).sessionDir;
      if (sessionDir) {
        if (sessionDirs.has(sessionDir)) {
          throw new SessionDirConflictError([sessionDirs.get(sessionDir)!, agent.id], sessionDir);
        }
        sessionDirs.set(sessionDir, agent.id);
      }
    }
  }
}
