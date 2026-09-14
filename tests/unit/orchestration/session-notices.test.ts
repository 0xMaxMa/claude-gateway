import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { DecisionService } from '../../../src/orchestration/decisions';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';

test('system notices persist and stream only to their origin without invoking inference or consuming work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-notice-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const createAgentSession = jest.fn();
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, { createAgentSession, releaseAgentSession: async () => {} });
  try {
    const web = randomUUID(), other = randomUUID(), telegram = randomUUID();
    await sessions.ensureApiSession('a', 'chat', web); await sessions.ensureApiSession('a', 'chat', other);
    const inputs = [web, other, telegram].map((id, i) => runtime.store.acceptInput({ scope: {
      agentId: 'a', agentSessionId: id, source: i === 2 ? 'telegram' : 'api', accountId: 'owner', chatId: i === 2 ? 'tg' : 'chat', threadKey: i === 2 ? '123' : '', principalId: 'owner',
    }, text: 'existing work' }, 20));
    const received = jest.fn(), foreign = jest.fn();
    runtime.subscribeText(web, 'owner', received); runtime.subscribeText(other, 'owner', foreign);
    const decisions = new DecisionService(runtime.store);
    const active = decisions.begin(inputs[0].conversationId, 'owner', [inputs[0].inputId]);
    await runtime.notifySession(web, '🧠 Skill created (auto): test');
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ text: '🧠 Skill created (auto): test', final: true }));
    expect(foreign).not.toHaveBeenCalled(); expect(createAgentSession).not.toHaveBeenCalled();
    expect(runtime.store.all('SELECT * FROM deliveries')).toHaveLength(0);
    expect(runtime.store.get('SELECT state FROM conversation_decisions WHERE id=?', active.decisionId)?.state).toBe('running');
    expect(runtime.store.get('SELECT epoch FROM conversations WHERE id=?', inputs[0].conversationId)?.epoch).toBe(active.epoch);
    expect(history.getMessages('api-chat', { sessionId: web }).messages.some(m => m.content.includes('Skill created'))).toBe(true);
    expect(history.getMessages('api-chat', { sessionId: other }).messages).toHaveLength(0);
    await runtime.notifySession(telegram, 'Own Telegram notice');
    const deliveries = runtime.store.all('SELECT d.*,b.chat_id,b.thread_key FROM deliveries d JOIN conversation_bindings b ON b.id=d.binding_id');
    expect(deliveries).toHaveLength(1); expect(deliveries[0]).toMatchObject({ chat_id: 'tg', thread_key: '123', delivered_text: 'Own Telegram notice' });
    await runtime.notifySession(telegram, 'Archived session notice', false);
    await runtime.notifySession('unknown-session', 'Must not broadcast');
    expect(runtime.store.all('SELECT * FROM deliveries')).toHaveLength(1);
    expect(runtime.store.all("SELECT * FROM assistant_responses WHERE generated_text='Must not broadcast'")).toHaveLength(0);
  } finally {
    await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});
