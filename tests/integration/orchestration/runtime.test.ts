import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentOrchestrationRuntime, AgentOrchestrationHost } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';
import { WorkerDriver } from '../../../src/orchestration/tasks/scheduler';
import { TaskResult } from '../../../src/orchestration/types';

test('E01/E02: agent answers another turn and dispatches B before worker A completes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-runtime-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const results: Array<(result: { type: 'completed'; result: TaskResult }) => void> = [];
  const worker: WorkerDriver = { start: async () => ({ accepted: Promise.resolve(), result: new Promise(resolve => results.push(resolve)), stop: async () => {} }) };
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a', 'workspace'), description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  let runtime: AgentOrchestrationRuntime;
  let turnCount = 0;
  const host: AgentOrchestrationHost = {
    createAgentSession: async sessionId => {
      const agentSession = new EventEmitter() as SessionProcess;
      agentSession.start = async () => {};
      agentSession.stop = async () => {};
      agentSession.sendMessage = () => {
        turnCount++;
        if (turnCount !== 2) {
          const d = runtime.store.get("SELECT * FROM conversation_decisions WHERE state='running'")!;
          const inputId = (JSON.parse(String(d.input_ids_json)) as string[])[0];
          runtime.tasks.spawn({ conversationId: String(d.conversation_id), principalId: 'p', inputId,
            decisionId: String(d.id), epoch: Number(d.epoch), actionId: `action:${d.id}`, execute: true, writeMemory: false },
          { title: `Task ${turnCount}`, instructions: 'Do the task', targetProfile: 'default-worker' });
        }
        agentSession.emit('output', JSON.stringify({ type: 'result', result: turnCount === 2 ? 'The task is still in progress.' : 'Task queued.' }));
      };
      expect(sessionId).toBe('original-session');
      return agentSession;
    },
    releaseAgentSession: async () => {},
  };
  runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, host, worker);
  const input = { scope: { agentId: 'a', agentSessionId: 'original-session', source: 'api' as const, accountId: 'key', chatId: 'c', threadKey: '', principalId: 'p' }, text: 'Do A' };
  try {
    expect(await runtime.send(input, { execute: true, writeMemory: false }, { timeoutMs: 1000 })).toBe('Task queued.');
    expect(await runtime.send({ ...input, text: 'Status?' }, { execute: true, writeMemory: false }, { timeoutMs: 1000 })).toBe('The task is still in progress.');
    expect(await runtime.send({ ...input, text: 'Do B' }, { execute: true, writeMemory: false }, { timeoutMs: 1000 })).toBe('Task queued.');
    expect(runtime.store.get('SELECT COUNT(*) AS n FROM tasks')!.n).toBe(2);
    expect(runtime.store.get("SELECT COUNT(*) AS n FROM tasks WHERE state='completed'")!.n).toBe(0);
    expect((await sessions.loadSession('a', 'original-session')).map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    await new Promise(resolve => setTimeout(resolve, 150));
    for (const complete of results) complete({ type: 'completed', result: { summary: 'done', artifactIds: [] } });
    await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    await runtime.close(); (history as unknown as { db: { close(): void } }).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});

test.each(['api', 'telegram', 'discord', 'line', 'slack'] as const)('%s Agent receives images before replying, including explicit skill input', async source => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-vision-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a/workspace'), description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L9sAAAAASUVORK5CYII=', 'base64');
  mkdirSync(join(root, 'a/media/c'), { recursive: true }); writeFileSync(join(root, 'a/media/c/image.png'), bytes);
  const received = jest.fn();
  const host: AgentOrchestrationHost = {
    createAgentSession: async (_id, profile) => {
      expect(profile.overlay).toContain('Inspect attached images yourself first');
      expect(profile.overlay.includes('Telegram response layout:')).toBe(source === 'telegram');
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {}; process.stop = async () => {};
      process.sendMessage = (text, images) => { received(text, images); process.emit('output', JSON.stringify({ type: 'result', result: 'Image understood.' })); };
      return process;
    }, releaseAgentSession: async () => {},
  };
  const worker: WorkerDriver = { start: jest.fn() };
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, host, worker);
  try {
    const input = { scope: { agentId: 'a', agentSessionId: 'vision', source, accountId: 'key', chatId: 'c', threadKey: '', principalId: 'p' }, text: 'What is in this image?', attachmentIds: ['media/c/image.png'] };
    await runtime.send(input, { execute: true, writeMemory: false }, { timeoutMs: 1000 });
    expect(received.mock.calls[0][1][0].source.data).toBe(bytes.toString('base64'));
    expect(runtime.store.get('SELECT COUNT(*) AS n FROM tasks')!.n).toBe(0);
    await runtime.send({ ...input, text: '/review this', skill: { name: 'review', args: 'this', content: 'Review', filePath: '/unused' } }, { execute: true, writeMemory: false }, { timeoutMs: 1000 });
    expect(received).toHaveBeenCalledTimes(2);
    expect(received.mock.calls[1][0]).toContain('Requested installed skill:');
    expect(received.mock.calls[1][1]).toHaveLength(1);
    expect(worker.start).not.toHaveBeenCalled();
  } finally { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
});
