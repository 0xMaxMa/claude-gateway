import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { latestAgentContextWindow } from '../../../src/orchestration/token-ledger';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// #687: Claude Code reports a [1m] run under its base id. The ledger keeps the model the
// turn was started with, so the context window is sized for that model, not the agent default.
test.each([
  ['a per-turn model', 'claude-opus-5-5[1m]', 'claude-opus-5-5[1m]'],
  ['the agent default', undefined, 'claude-sonnet-5-5'],
])('an agent turn records %s as its configured model', async (_label, model, expected) => {
  const root = mkdtempSync(join(tmpdir(), 'turn-model-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Fixture identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'claude-sonnet-5-5', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    releaseAgentSession: async () => {},
    createAgentSession: async (_session, profile) => Object.assign(new EventEmitter(), { runtimeProfile: profile,
      start: async () => {}, stop: async () => {}, interrupt: () => {},
      sendMessage: function (this: EventEmitter) {
        this.emit('output', JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done' }],
          usage: { input_tokens: 10, cache_read_input_tokens: 500000, cache_creation_input_tokens: 0, output_tokens: 5 } } }));
        this.emit('output', JSON.stringify({ type: 'result', result: 'Done' }));
      } }) as unknown as SessionProcess,
  });
  try {
    const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
    await expect(runtime.send({ scope, text: 'Hello' }, { execute: false, writeMemory: false }, { timeoutMs: 1000, ...(model ? { model } : {}) })).resolves.toBe('Done');
    const row = runtime.store.get("SELECT payload_json FROM token_turns WHERE session_id=? AND role='agent'", sid);
    expect(JSON.parse(String(row!.payload_json)).configuredModel).toBe(expected);
    expect(latestAgentContextWindow(runtime.store, sid)).toMatchObject({ configuredModel: expected });
  } finally {
    await runtime.close().catch(() => {}); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});
