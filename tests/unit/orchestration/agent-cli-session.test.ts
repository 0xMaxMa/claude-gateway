import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { AgentCliSessions, resumeRejected } from '../../../src/orchestration/agent-cli-session';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { transcriptPath } from '../../../src/config/claude-settings';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { RuntimeProfile } from '../../../src/session/runtime-profile';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

/** Stand in for the transcript Claude Code writes, which is what `--resume` reads. */
function writeTranscript(cwd: string, cliSessionId: string): string {
  const file = transcriptPath(cwd, cliSessionId);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'seeded' } }) + '\n');
  return file;
}

describe('AgentCliSessions', () => {
  let store: OrchestrationStore, cwd: string, written: string[];
  beforeEach(() => {
    store = new OrchestrationStore(':memory:', 'agent');
    cwd = mkdtempSync(join(tmpdir(), 'cli-session-'));
    written = [];
  });
  afterEach(() => {
    for (const file of written) { try { unlinkSync(file); } catch { /* already gone */ } }
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('starts a session, resumes the same id once its transcript exists, and keeps it stable', () => {
    const sessions = new AgentCliSessions(store);
    const first = sessions.resolve('session-a', cwd);
    expect(first).toMatchObject({ resume: false });
    expect(first.fallback).toBeUndefined(); // an ordinary cold start is not a fallback
    written.push(writeTranscript(cwd, first.id));
    expect(sessions.resolve('session-a', cwd)).toEqual({ id: first.id, resume: true });
    expect(sessions.resolve('session-a', cwd)).toEqual({ id: first.id, resume: true });
  });

  it('reports a fallback and mints a new id when the transcript is gone', () => {
    const sessions = new AgentCliSessions(store);
    const first = sessions.resolve('session-a', cwd);
    const file = writeTranscript(cwd, first.id);
    expect(sessions.resolve('session-a', cwd).resume).toBe(true);
    unlinkSync(file);
    const recovered = sessions.resolve('session-a', cwd);
    expect(recovered).toMatchObject({ resume: false, fallback: 'TRANSCRIPT_UNAVAILABLE' });
    expect(recovered.id).not.toBe(first.id);
  });

  it('treats an empty transcript as unresumable rather than resuming a truncated file', () => {
    const sessions = new AgentCliSessions(store);
    const first = sessions.resolve('session-a', cwd);
    const file = transcriptPath(cwd, first.id);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '');
    written.push(file);
    expect(sessions.resolve('session-a', cwd)).toMatchObject({ resume: false, fallback: 'TRANSCRIPT_UNAVAILABLE' });
  });

  it('never resumes a transcript recorded under a different working directory', () => {
    const sessions = new AgentCliSessions(store);
    const first = sessions.resolve('session-a', cwd);
    written.push(writeTranscript(cwd, first.id));
    const moved = mkdtempSync(join(tmpdir(), 'cli-session-moved-'));
    try {
      expect(sessions.resolve('session-a', moved)).toMatchObject({ resume: false, fallback: 'WORKSPACE_CHANGED' });
    } finally { rmSync(moved, { recursive: true, force: true }); }
  });

  it('keeps separate agent sessions on separate CLI sessions', () => {
    const sessions = new AgentCliSessions(store);
    expect(sessions.resolve('session-a', cwd).id).not.toBe(sessions.resolve('session-b', cwd).id);
  });

  it('survives a gateway restart: a new instance over the same store still resumes', () => {
    const before = new AgentCliSessions(store);
    const first = before.resolve('session-a', cwd);
    written.push(writeTranscript(cwd, first.id));
    // The table lives in the orchestration database, so a fresh process reads the same row.
    const after = new AgentCliSessions(store);
    expect(after.resolve('session-a', cwd)).toEqual({ id: first.id, resume: true });
  });

  it('forgets a session so the next turn starts fresh', () => {
    const sessions = new AgentCliSessions(store);
    const first = sessions.resolve('session-a', cwd);
    written.push(writeTranscript(cwd, first.id));
    expect(sessions.resolve('session-a', cwd).resume).toBe(true);
    sessions.forget('session-a');
    const restarted = sessions.resolve('session-a', cwd);
    expect(restarted.resume).toBe(false);
    // Forgetting is a deliberate reset, so the restart is a cold start, not a reported fallback.
    expect(restarted.fallback).toBeUndefined();
  });

  it('recognises only Claude Code\'s own refusal to resume', () => {
    expect(resumeRejected('No conversation found with session ID: 123')).toBe(true);
    expect(resumeRejected('Error: Session ID 123 is already in use.')).toBe(false);
    expect(resumeRejected(null)).toBe(false);
    expect(resumeRejected(undefined)).toBe(false);
  });
});

describe('agent decision turns over one CLI session', () => {
  it('resumes the same CLI session on the next turn and records an explicit fallback when the transcript vanishes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-turn-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
    mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
    const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
    const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
    const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
    await sessions.ensureApiSession('a', 'chat', sid);
    const observed: Array<RuntimeProfile['cliSession']> = [];
    const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
      createAgentSession: async (_id, profile) => {
        observed.push(profile.cliSession);
        return Object.assign(new EventEmitter(), {
          start: async () => {}, stop: async () => {},
          sendMessage: function (this: EventEmitter) { this.emit('output', JSON.stringify({ type: 'result', result: 'Done.' })); },
        }) as unknown as SessionProcess;
      }, releaseAgentSession: async () => {},
    });
    const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
    const send = () => runtime.send({ scope, text: 'do the work' }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
    const transcripts: string[] = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await send();
      expect(observed[0]).toMatchObject({ resume: false });
      const cliSessionId = observed[0]!.id;
      // Claude Code writes the transcript during the turn; stand in for it here.
      transcripts.push(writeTranscript(workspace, cliSessionId));

      await send();
      // Same id, now resumed: that is what lets the second turn reuse the first turn's prefix.
      expect(observed[1]).toEqual({ id: cliSessionId, resume: true });
      expect(runtime.store.all("SELECT type FROM conversation_events WHERE type='session.transcript_unavailable'")).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();

      unlinkSync(transcripts.pop()!);
      await send();
      expect(observed[2]).toMatchObject({ resume: false });
      expect(observed[2]!.id).not.toBe(cliSessionId);
      const events = runtime.store.all("SELECT payload_json FROM conversation_events WHERE type='session.transcript_unavailable'");
      expect(events).toHaveLength(1);
      expect(JSON.parse(String(events[0].payload_json)).payload).toMatchObject({ sessionId: sid, reason: 'TRANSCRIPT_UNAVAILABLE' });
      // Fail loud, not silent: the fallback is logged as well as recorded.
      const logged = warn.mock.calls.map(call => String(call[0])).find(line => line.includes('could not be resumed'));
      expect(logged).toBeDefined();
      expect(JSON.parse(logged!)).toMatchObject({ level: 'warn', sessionId: sid, reason: 'TRANSCRIPT_UNAVAILABLE' });
    } finally {
      warn.mockRestore();
      for (const file of transcripts) { try { unlinkSync(file); } catch { /* already gone */ } }
      for (const id of observed) { if (id) { try { unlinkSync(transcriptPath(workspace, id.id)); } catch { /* not written */ } } }
      await runtime.close(); (history as never as {db:{close():void}}).db.close(); HistoryDB.evict(root, 'a');
      rmSync(root, { recursive: true, force: true });
    }
  });
});
