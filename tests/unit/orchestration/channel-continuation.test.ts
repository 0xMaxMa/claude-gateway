import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentRunner } from '../../../src/agent/runner';
import { TurnStreamRegistry } from '../../../src/agent/turn-stream';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

test.each([[1, 0], [125, 0], [3, 150]])('web continuation forwards %i tool calls exactly once with %ims completion delay', async (count, delay) => {
  const root = mkdtempSync(join(tmpdir(), 'channel-continuation-'));
  const agent = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true, channels: ['telegram'] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  let failNext = false;
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, {
    createAgentSession: async () => {
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {}; process.stop = async () => {};
      process.sendMessage = () => {
        for (let i = 0; i < count; i++) {
          process.emit('output', JSON.stringify({type: 'assistant', message: {content: [{type: 'tool_use', id: `tool-${i}`, name: 'mcp__gateway__task_status', input: {}}]}}));
          process.emit('output', JSON.stringify({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: `tool-${i}`, content: 'done'}]}}));
        }
        const finish = () => process.emit('output', JSON.stringify({type: 'result', result: failNext ? 'Provider failed' : 'Continued.', is_error: failNext}));
        if (delay) setTimeout(finish, delay); else finish();
      };
      return process;
    }, releaseAgentSession: async () => {},
  });
  const legacy = jest.fn();
  const runner = Object.assign(Object.create(AgentRunner.prototype), { agentConfig: agent, sessionStore: sessions,
    orchestration: runtime, turnStreams: new TurnStreamRegistry(), getOrSpawnSession: legacy });
  try {
    await runtime.send({ scope: { agentId: 'a', agentSessionId: 's', source: 'telegram', accountId: 'bot', chatId: 'chat', threadKey: 'topic', principalId: 'human' }, text: 'First' }, { execute: true, writeMemory: true }, { timeoutMs: 2000 });
    await expect(runner.sendMessageToSession('chat', 'telegram', 's', 'No auth', undefined, {}, { timeoutMs: 2000 })).rejects.toThrow('Authenticated principal');
    await expect(runner.sendMessageToSession('wrong', 'telegram', 's', 'Wrong chat', undefined, {}, { timeoutMs: 2000, principalId: 'api:key' })).rejects.toThrow('mismatched');
    const chunks: any[] = [];
    const result = new Promise<string>((resolve, reject) => {
      void runner.sendMessageToSession('chat', 'telegram', 's', 'Continue', 'Web user', {
        onChunk: (event: any) => chunks.push(event), onDone: (text: string) => resolve(text), onError: reject,
      }, { timeoutMs: 2000, principalId: 'api:key', allowTools: false }).catch(reject);
    });
    await expect(result).resolves.toBe('Continued.');
    expect(chunks.filter(event => event.type === 'tool_use')).toHaveLength(count);
    expect(legacy).not.toHaveBeenCalled();
    const inputs = runtime.store.all('SELECT * FROM conversation_inputs ORDER BY input_seq');
    expect(inputs.map(row => row.principal_id)).toEqual(['human', 'api:key']);
    expect(inputs[1].conversation_id).toBe(inputs[0].conversation_id);
    expect(runtime.store.get('SELECT * FROM conversations WHERE id=?', inputs[1].conversation_id)).toMatchObject({ source: 'telegram', account_id: 'bot', thread_key: 'topic' });
    failNext = true;
    const failedChunks: any[] = [];
    const failed = new Promise((resolve, reject) => {
      void runner.sendMessageToSession('chat', 'telegram', 's', 'Fail after tools', 'Web user', {
        onChunk: (event: any) => failedChunks.push(event), onDone: resolve, onError: reject,
      }, {timeoutMs: 2000, principalId: 'api:key', allowTools: false}).catch(reject);
    });
    await expect(failed).rejects.toBeDefined();
    expect(failedChunks.filter(event => event.type === 'tool_use')).toHaveLength(count);

  } finally {
    await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});
