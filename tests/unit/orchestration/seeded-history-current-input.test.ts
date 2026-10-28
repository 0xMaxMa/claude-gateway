import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import { SessionProcess, INTERRUPTED_NO_REPLY_TEXT } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// A decision turn that cannot resume a CLI transcript (every new session's first turn)
// seeds the stored history. The current input is already persisted by then and the
// turn prompt delivers it again as "Current user message", so seeding it too made it
// a dangling user turn, answered by a fabricated "Session was interrupted" reply.
describe('seeded history of a decision turn', () => {
  it('leaves out the input the turn itself delivers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seeded-input-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
    mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
    const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
    const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig;
    const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
    await sessions.ensureApiSession('a', 'chat', sid);
    const seeded: Array<{ stored: string[]; historyPrompt: string | null }> = [];
    const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
      createAgentSession: async (_id, profile) => {
        const stored = (await sessions.loadSession('a', sid)).map(m => `${m.role}:${m.content}`);
        const { historyPrompt } = await (new SessionProcess(sid, 'api', agent, gateway, sessions, undefined, profile) as any).buildInitialPrompt();
        seeded.push({ stored, historyPrompt });
        return Object.assign(new EventEmitter(), {
          start: async () => {}, stop: async () => {},
          sendMessage: function (this: EventEmitter) { this.emit('output', JSON.stringify({ type: 'result', result: 'Done.' })); },
        }) as unknown as SessionProcess;
      }, releaseAgentSession: async () => {},
    });
    const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
    try {
      await runtime.send({ scope, text: 'What did you reply last time?' }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
      // The input is persisted before the turn starts; that is the condition being guarded.
      expect(seeded[0]!.stored).toEqual(['user:What did you reply last time?']);
      expect(seeded[0]!.historyPrompt).toBeNull();
    } finally {
      await runtime.close();
      (history as never as {db:{close():void}}).db.close(); HistoryDB.evict(root, 'a');
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still seeds earlier turns, and never fabricates an interrupted reply for them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seeded-input-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
    mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
    const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
    const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig;
    const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
    await sessions.ensureApiSession('a', 'chat', sid);
    const prompts: Array<string | null> = [];
    const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
      createAgentSession: async (_id, profile) => {
        prompts.push((await (new SessionProcess(sid, 'api', agent, gateway, sessions, undefined, profile) as any).buildInitialPrompt()).historyPrompt);
        return Object.assign(new EventEmitter(), {
          start: async () => {}, stop: async () => {},
          sendMessage: function (this: EventEmitter) { this.emit('output', JSON.stringify({ type: 'result', result: 'ok-one' })); },
        }) as unknown as SessionProcess;
      }, releaseAgentSession: async () => {},
    });
    const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
    try {
      await runtime.send({ scope, text: 'Reply with ok-one' }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
      // No transcript was written, so the second turn cannot resume and re-seeds.
      await runtime.send({ scope, text: 'What did you reply last time?' }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
      expect(prompts[1]).toContain('User: Reply with ok-one');
      expect(prompts[1]).toContain('Assistant: ok-one');
      expect(prompts[1]).not.toContain('What did you reply last time?');
      expect(prompts[1]).not.toContain(INTERRUPTED_NO_REPLY_TEXT);
    } finally {
      await runtime.close();
      (history as never as {db:{close():void}}).db.close(); HistoryDB.evict(root, 'a');
      rmSync(root, { recursive: true, force: true });
    }
  });
});
