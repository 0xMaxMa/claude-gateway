/**
 * Tests for executeApiCommand persistence + dispatch hardening (#157).
 *
 * Builtin slash commands sent from the web must (1) appear in chat history and
 * (2) always leave history ending with an assistant turn (so the web's typing
 * indicator never sticks). The fix persists commands to the history DB ONLY —
 * never the model's JSONL session context — validates before persisting, and
 * wraps dispatch in catch-and-persist so even failures end with an assistant row.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mock child_process (restartProcess on /clear & /compact spawns a child) ───

interface MockChildProcess extends EventEmitter {
  stdin: { writable: boolean; write: jest.Mock } | null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  killed: boolean;
  kill: jest.Mock;
  pid: number;
}

function makeMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdin = { writable: true, write: jest.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.pid = Math.floor(Math.random() * 90000) + 10000;
  proc.kill = jest.fn((signal?: string) => {
    proc.killed = true;
    process.nextTick(() => proc.emit('exit', 0, signal ?? 'SIGTERM'));
    return true;
  });
  return proc;
}

jest.mock('child_process', () => ({
  spawn: jest.fn(() => makeMockProcess()),
  // spawnSync is only reached by SessionCompactor on ≥5-message sessions, which
  // these tests never set up — but stub it so an accidental call can't shell out.
  spawnSync: jest.fn(() => ({ status: 0, stdout: '', stderr: '', error: undefined })),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig, GatewayConfig, Message } from '../../src/types';
import { SessionStore } from '../../src/session/store';
import { HistoryDB } from '../../src/history/db';

// ── Helpers ─────────────────────────────────────────────────────────────────────

function makeAgentConfig(workspace: string): AgentConfig {
  return {
    id: 'alfred',
    description: 'test agent',
    workspace,
    env: '',
    telegram: { botToken: 'test-token' },
    claude: { model: 'claude-opus-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
  };
}

function makeGatewayConfig(): GatewayConfig {
  return { gateway: { orchestration: false, logDir: '/tmp/test-cmd-persist-logs', timezone: 'UTC' }, agents: [] };
}

function getSessionStore(runner: AgentRunner): SessionStore {
  return (runner as unknown as { sessionStore: SessionStore }).sessionStore;
}

function makeMsg(role: 'user' | 'assistant', content: string): Message {
  return { role, content, ts: Date.now() };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeApiCommand persistence + dispatch (#157)', () => {
  let tmpDir: string;
  let runner: AgentRunner;
  const agentId = 'alfred';
  const chatId = 'web-1';
  const dbChatId = `api-${chatId}`;   // historyDb is keyed by the channel-prefixed chatId
  const sessionId = 'sess-1';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-persist-test-'));
    const workspaceDir = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({ agents: [{ id: 'alfred', claude: { model: 'claude-opus-4-6' } }] }, null, 2) + '\n',
    );
    runner = new AgentRunner(makeAgentConfig(workspaceDir), makeGatewayConfig());
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Newest-first history rows for the session (historyDb returns ts DESC).
  function historyRows(): Array<{ role: string; content: string }> {
    const db: HistoryDB = runner.getHistoryDb();
    return db.getMessages(dbChatId, { sessionId }).messages.map((m) => ({ role: m.role, content: m.content }));
  }

  it('U-P-01: a command persists user + assistant rows to historyDb', async () => {
    const { responseText } = await runner.executeApiCommand(sessionId, chatId, '/model');

    const rows = historyRows();
    expect(rows.filter((r) => r.role === 'user')).toHaveLength(1);
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1);
    expect(rows.find((r) => r.role === 'user')!.content).toBe('/model');
    expect(rows.find((r) => r.role === 'assistant')!.content).toBe(responseText);
  });

  it('U-P-02: commands are NOT written to the model JSONL session context', async () => {
    await runner.executeApiCommand(sessionId, chatId, '/model');

    // The flat sessions/{sessionId}.jsonl store is what spawn replays into the model.
    // Commands must stay out of it so /model replies aren't fed back to Claude.
    const context = await getSessionStore(runner).loadSession(agentId, sessionId);
    expect(context).toEqual([]);
  });

  it('U-P-03: dispatch resolves on the first token, persisting the full command text', async () => {
    // "/model sonnet" must resolve to /model, not fall through to unknown-command.
    const { result } = await runner.executeApiCommand(sessionId, chatId, '/model sonnet');
    expect(result.model).toBe('claude-opus-4-6');

    // The full original text is persisted as the user row.
    expect(historyRows().find((r) => r.role === 'user')!.content).toBe('/model sonnet');
  });

  it('U-P-04: an unknown command throws and persists nothing (no orphan user row)', async () => {
    await expect(
      runner.executeApiCommand(sessionId, chatId, '/bogus'),
    ).rejects.toThrow('Unknown command: /bogus');

    expect(historyRows()).toHaveLength(0);
  });

  it('U-P-05: /sessions is implemented (was previously persist-then-throw)', async () => {
    const { result, responseText } = await runner.executeApiCommand(sessionId, chatId, '/sessions');

    expect(Array.isArray(result.sessions)).toBe(true);
    const current = (result.sessions as Array<{ id: string; current: boolean }>).find((s) => s.id === sessionId);
    expect(current?.current).toBe(true);
    expect(responseText).toContain('(current)');
    // It ended with an assistant turn, not a thrown error.
    expect(historyRows().some((r) => r.role === 'assistant')).toBe(true);
  });

  it('U-P-06: a failing command still ends history with a "Command failed" assistant turn', async () => {
    // /compact on a fresh session has too few messages → throws inside dispatch.
    await expect(
      runner.executeApiCommand(sessionId, chatId, '/compact'),
    ).rejects.toThrow();

    const rows = historyRows();
    // Newest row (ts DESC → index 0) must be the assistant failure turn.
    expect(rows[0].role).toBe('assistant');
    expect(rows[0].content).toContain('Command failed:');
    // The user command row is still present too.
    expect(rows.some((r) => r.role === 'user' && r.content === '/compact')).toBe(true);
    // Nothing leaked into the model context.
    expect(await getSessionStore(runner).loadSession(agentId, sessionId)).toEqual([]);
  });

  it('U-P-07: skipPersist suppresses BOTH the user and assistant rows', async () => {
    await runner.executeApiCommand(sessionId, chatId, '/model', { skipPersist: true });
    expect(historyRows()).toHaveLength(0);
  });

  it('U-P-08: skipPersist also suppresses the failure-path assistant row', async () => {
    await expect(
      runner.executeApiCommand(sessionId, chatId, '/compact', { skipPersist: true }),
    ).rejects.toThrow();
    expect(historyRows()).toHaveLength(0);
  });

  it('U-P-09: /clear persists no user row and ends with a single assistant turn', async () => {
    // Seed some prior history so we can see /clear wipe it.
    runner.getHistoryDb().insertMessage({ chatId: dbChatId, sessionId, source: 'api', role: 'user', content: 'earlier', ts: Date.now() });

    const { responseText } = await runner.executeApiCommand(sessionId, chatId, '/clear');

    const rows = historyRows();
    // clearSession wiped the table; only the assistant confirmation survives.
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('assistant');
    expect(rows[0].content).toBe(responseText);
    expect(responseText).toBe('Session cleared.');
  });

  it('U-P-10: a successful command persists both a user row and an assistant row', async () => {
    await getSessionStore(runner).ensureApiSession(agentId, chatId, sessionId);
    await runner.executeApiCommand(sessionId, chatId, '/session');

    const rows = historyRows();
    // Role-based assertion — independent of ts ordering, which can be the same millisecond.
    expect(rows.filter((r) => r.role === 'user')).toHaveLength(1);
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1);
  });
});
