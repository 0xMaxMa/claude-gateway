/**
 * Unit tests for ContextIsolationGuard
 */

import {
  ContextIsolationGuard,
  WorkspaceConflictError,
  TokenConflictError,
  SessionDirConflictError,
} from '../../src/agent/context-isolation';
import { AgentConfig } from '../../src/types';

function makeAgent(id: string, botToken: string, workspace: string): AgentConfig {
  return {
    id,
    description: `Agent ${id}`,
    workspace,
    env: '',
    telegram: { botToken },
    claude: { model: 'claude-test', dangerouslySkipPermissions: false, extraFlags: [] },
  };
}

describe('ContextIsolationGuard', () => {
  let guard: ContextIsolationGuard;

  beforeEach(() => {
    guard = new ContextIsolationGuard();
  });

  it('passes with no agents', () => {
    expect(() => guard.validate([])).not.toThrow();
  });

  it('passes with one agent', () => {
    const agent = makeAgent('alpha', 'token-alpha', '/workspaces/alpha');
    expect(() => guard.validate([agent])).not.toThrow();
  });

  it('passes with two agents having distinct workspace, token', () => {
    const a = makeAgent('alpha', 'token-a', '/workspaces/alpha');
    const b = makeAgent('beta', 'token-b', '/workspaces/beta');
    expect(() => guard.validate([a, b])).not.toThrow();
  });

  it('passes with three agents all distinct', () => {
    const a = makeAgent('alpha', 'token-a', '/workspaces/alpha');
    const b = makeAgent('beta', 'token-b', '/workspaces/beta');
    const c = makeAgent('gamma', 'token-c', '/workspaces/gamma');
    expect(() => guard.validate([a, b, c])).not.toThrow();
  });

  describe('WorkspaceConflictError', () => {
    it('throws WorkspaceConflictError when two agents share a workspace', () => {
      const a = makeAgent('alpha', 'token-a', '/shared/ws');
      const b = makeAgent('beta', 'token-b', '/shared/ws');

      expect(() => guard.validate([a, b])).toThrow(WorkspaceConflictError);
    });

    it('WorkspaceConflictError message contains both agent ids', () => {
      const a = makeAgent('alpha', 'token-a', '/shared/ws');
      const b = makeAgent('beta', 'token-b', '/shared/ws');

      let caught: Error | undefined;
      try {
        guard.validate([a, b]);
      } catch (e) {
        caught = e as Error;
      }

      expect(caught).toBeInstanceOf(WorkspaceConflictError);
      expect(caught!.message).toContain('alpha');
      expect(caught!.message).toContain('beta');
      expect(caught!.message).toContain('/shared/ws');
    });

    it('WorkspaceConflictError has correct agentIds and workspace properties', () => {
      const a = makeAgent('alpha', 'token-a', '/conflict/path');
      const b = makeAgent('beta', 'token-b', '/conflict/path');

      let caught: WorkspaceConflictError | undefined;
      try {
        guard.validate([a, b]);
      } catch (e) {
        caught = e as WorkspaceConflictError;
      }

      expect(caught!.agentIds).toContain('alpha');
      expect(caught!.agentIds).toContain('beta');
      expect(caught!.workspace).toBe('/conflict/path');
    });

    it('does not throw when workspace paths are distinct but share prefix', () => {
      const a = makeAgent('alpha', 'token-a', '/workspaces/alfred');
      const b = makeAgent('beta', 'token-b', '/workspaces/alfred-extra');
      expect(() => guard.validate([a, b])).not.toThrow();
    });
  });

  describe('TokenConflictError', () => {
    it('throws TokenConflictError when two agents share a bot token', () => {
      const a = makeAgent('alpha', 'same-token-xyz', '/workspaces/alpha');
      const b = makeAgent('beta', 'same-token-xyz', '/workspaces/beta');

      expect(() => guard.validate([a, b])).toThrow(TokenConflictError);
    });

    it('TokenConflictError message contains both agent ids', () => {
      const a = makeAgent('alpha', 'dup-token', '/workspaces/alpha');
      const b = makeAgent('beta', 'dup-token', '/workspaces/beta');

      let caught: Error | undefined;
      try {
        guard.validate([a, b]);
      } catch (e) {
        caught = e as Error;
      }

      expect(caught).toBeInstanceOf(TokenConflictError);
      expect(caught!.message).toContain('alpha');
      expect(caught!.message).toContain('beta');
    });

    it('TokenConflictError has correct agentIds and token properties', () => {
      const a = makeAgent('agent1', 'shared-bot-token', '/workspaces/agent1');
      const b = makeAgent('agent2', 'shared-bot-token', '/workspaces/agent2');

      let caught: TokenConflictError | undefined;
      try {
        guard.validate([a, b]);
      } catch (e) {
        caught = e as TokenConflictError;
      }

      expect(caught!.agentIds).toContain('agent1');
      expect(caught!.agentIds).toContain('agent2');
      expect(caught!.token).toBe('shared-bot-token');
    });
  });

  describe('SessionDirConflictError', () => {
    it('throws SessionDirConflictError when two agents have same explicit sessionDir', () => {
      const a = makeAgent('alpha', 'token-a', '/workspaces/alpha') as AgentConfig & { sessionDir: string };
      const b = makeAgent('beta', 'token-b', '/workspaces/beta') as AgentConfig & { sessionDir: string };
      (a as unknown as Record<string, string>).sessionDir = '/shared/sessions';
      (b as unknown as Record<string, string>).sessionDir = '/shared/sessions';

      expect(() => guard.validate([a, b])).toThrow(SessionDirConflictError);
    });

    it('does not throw for different sessionDirs', () => {
      const a = makeAgent('alpha', 'token-a', '/workspaces/alpha') as AgentConfig & { sessionDir: string };
      const b = makeAgent('beta', 'token-b', '/workspaces/beta') as AgentConfig & { sessionDir: string };
      (a as unknown as Record<string, string>).sessionDir = '/sessions/alpha';
      (b as unknown as Record<string, string>).sessionDir = '/sessions/beta';

      expect(() => guard.validate([a, b])).not.toThrow();
    });
  });

  it('workspace conflict detected before token conflict when both present', () => {
    // Both conflicts exist — workspace check happens first (alphabetical by field)
    const a = makeAgent('alpha', 'dup-token', '/shared/ws');
    const b = makeAgent('beta', 'dup-token', '/shared/ws');

    let caught: Error | undefined;
    try {
      guard.validate([a, b]);
    } catch (e) {
      caught = e as Error;
    }

    // Should throw WorkspaceConflictError (first check done)
    expect(caught).toBeInstanceOf(WorkspaceConflictError);
  });

  it('error names are correct', () => {
    expect(new WorkspaceConflictError(['a', 'b'], '/ws').name).toBe('WorkspaceConflictError');
    expect(new TokenConflictError(['a', 'b'], 'tok').name).toBe('TokenConflictError');
    expect(new SessionDirConflictError(['a', 'b'], '/dir').name).toBe('SessionDirConflictError');
  });
});
