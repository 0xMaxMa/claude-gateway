import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentRunner } from '../../../src/agent/runner';
import { TurnStreamRegistry } from '../../../src/agent/turn-stream';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { OrchestrationError } from '../../../src/orchestration/types';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

test.each([[1, 0], [125, 0], [3, 150]])('web continuation forwards %i tool calls exactly once with %ims completion delay', async (count, delay) => {
  const root = mkdtempSync(join(tmpdir(), 'channel-continuation-'));
  const agent = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true, channels: ['telegram'] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  let failNext = false, privateFailure = false;
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, {
    createAgentSession: async () => {
      if (privateFailure) throw new Error('Private prompt contents from an internal failure');
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
  const legacy = jest.fn(), echoed = jest.fn();
  // channelSourceMap + writeAutoForward back the web→channel echo that
  // sendOrchestratedChannel writes once the continuation passes validation.
  const runner = Object.assign(Object.create(AgentRunner.prototype), { agentConfig: agent, sessionStore: sessions,
    orchestration: runtime, turnStreams: new TurnStreamRegistry(), getOrSpawnSession: legacy,
    channelSourceMap: new Map(), writeAutoForward: echoed });
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
    // The web message is echoed to the Telegram chat exactly once on the orchestrated path.
    expect(echoed.mock.calls.filter(([id, text]) => id === 'chat' && text === '📱 Web: Continue')).toHaveLength(1);
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
    privateFailure = true;
    const internal = await new Promise<Error>((resolve,reject)=>{
      void runner.sendMessageToSession('chat','telegram','s','Fail internally','Web user',{
        onChunk:()=>{},onDone:()=>reject(new Error('unexpected success')),onError:resolve,
      },{timeoutMs:2000,principalId:'api:key',allowTools:false}).catch(reject);
    });
    expect(internal.message).toContain('GATEWAY_INTERNAL_ERROR');
    expect(internal.message).not.toContain('Private prompt');

  } finally {
    await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});

// The web→channel echo is not Telegram-only: the endpoint also serves discord,
// line, slack and whatsapp, and the one-sided-conversation problem hits all of
// them. This proves the echo fires on a non-telegram channel (discord). Revert
// gate: re-add a `channel === 'telegram'` guard around the echo in
// sendOrchestratedChannel and this goes RED (no '📱 Web: Continue' forward).
test('web continuation echoes the injected message on a non-telegram channel (discord)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-continuation-discord-'));
  const agent = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true, channels: ['discord'] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, {
    createAgentSession: async () => {
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {}; process.stop = async () => {};
      process.sendMessage = () => process.emit('output', JSON.stringify({ type: 'result', result: 'Continued.' }));
      return process;
    }, releaseAgentSession: async () => {},
  });
  const echoed = jest.fn();
  // channelSourceMap is set before writeAutoForward so the echo routes to the
  // discord receiver (channelFor defaults to telegram otherwise).
  const runner = Object.assign(Object.create(AgentRunner.prototype), { agentConfig: agent, sessionStore: sessions,
    orchestration: runtime, turnStreams: new TurnStreamRegistry(), getOrSpawnSession: jest.fn(),
    channelSourceMap: new Map(), writeAutoForward: echoed });
  try {
    await runtime.send({ scope: { agentId: 'a', agentSessionId: 's', source: 'discord', accountId: 'bot', chatId: 'chat', threadKey: 'topic', principalId: 'human' }, text: 'First' }, { execute: true, writeMemory: true }, { timeoutMs: 2000 });
    // A rejected continuation must send no phantom echo (finding 1).
    await expect(runner.sendMessageToSession('wrong', 'discord', 's', 'Wrong chat', undefined, {}, { timeoutMs: 2000, principalId: 'api:key' })).rejects.toThrow('mismatched');
    const result = new Promise<string>((resolve, reject) => {
      void runner.sendMessageToSession('chat', 'discord', 's', 'Continue', 'Web user', {
        onChunk: () => {}, onDone: resolve, onError: reject,
      }, { timeoutMs: 2000, principalId: 'api:key', allowTools: false }).catch(reject);
    });
    await expect(result).resolves.toBe('Continued.');
    // Exactly one echo, for the accepted continuation only, routed to discord.
    expect(echoed.mock.calls.filter(([id, text]) => text === '📱 Web: Continue')).toEqual([['chat', '📱 Web: Continue']]);
    expect(echoed.mock.calls.some(([, text]) => text === '📱 Web: Wrong chat')).toBe(false);
    expect((runner.channelSourceMap as Map<string, string>).get('chat')).toBe('discord');
    expect(runtime.store.get('SELECT * FROM conversations WHERE agent_session_id=?', 's')).toMatchObject({ source: 'discord' });
  } finally {
    await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});

// The orchestrated echo must fire only after submitInput has *accepted* the
// input into the store — not merely after the session-validation checks.
// submitInput calls store.acceptInput, which throws QUEUE_FULL (pending inputs
// at the per-conversation cap) or ORCHESTRATION_CLOSING (gateway shutting down)
// for a request that reached a valid session but is still refused at admission.
// Revert gate: move the two echo lines back above `runtime.submitInput(...)` in
// sendOrchestratedChannel and the QUEUE_FULL assertion below goes RED — the
// rejected request emits a phantom '📱 Web:' forward before the throw.
test('web continuation echoes only after submitInput accepts the input (no phantom echo on QUEUE_FULL)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-continuation-admission-'));
  const agent = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true, channels: ['telegram'] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, {
    createAgentSession: async () => {
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {}; process.stop = async () => {};
      process.sendMessage = () => process.emit('output', JSON.stringify({ type: 'result', result: 'Continued.' }));
      return process;
    }, releaseAgentSession: async () => {},
  });
  const echoed = jest.fn();
  const runner = Object.assign(Object.create(AgentRunner.prototype), { agentConfig: agent, sessionStore: sessions,
    orchestration: runtime, turnStreams: new TurnStreamRegistry(), getOrSpawnSession: jest.fn(),
    channelSourceMap: new Map(), writeAutoForward: echoed });
  try {
    await runtime.send({ scope: { agentId: 'a', agentSessionId: 's', source: 'telegram', accountId: 'bot', chatId: 'chat', threadKey: 'topic', principalId: 'human' }, text: 'First' }, { execute: true, writeMemory: true }, { timeoutMs: 2000 });
    // Success path: a valid, admitted continuation echoes exactly once.
    const ok = new Promise<string>((resolve, reject) => {
      void runner.sendMessageToSession('chat', 'telegram', 's', 'Continue', 'Web user', {
        onChunk: () => {}, onDone: resolve, onError: reject,
      }, { timeoutMs: 2000, principalId: 'api:key', allowTools: false }).catch(reject);
    });
    await expect(ok).resolves.toBe('Continued.');
    expect(echoed.mock.calls.filter(([id, text]) => text === '📱 Web: Continue')).toEqual([['chat', '📱 Web: Continue']]);
    // Rejection at admission: submitInput throws (QUEUE_FULL). The request
    // reached a valid session, so the pre-echo validation passes — the only
    // thing standing between it and a phantom echo is that the echo now runs
    // *after* submitInput. It must send no '📱 Web:' forward.
    const realSubmit = runtime.submitInput.bind(runtime);
    (runtime as unknown as { submitInput: () => never }).submitInput = () => { throw new OrchestrationError('QUEUE_FULL'); };
    await expect(runner.sendMessageToSession('chat', 'telegram', 's', 'Rejected at admission', 'Web user', {
      onChunk: () => {}, onDone: () => {}, onError: () => {},
    }, { timeoutMs: 2000, principalId: 'api:key', allowTools: false })).rejects.toThrow('QUEUE_FULL');
    (runtime as unknown as { submitInput: typeof realSubmit }).submitInput = realSubmit;
    expect(echoed.mock.calls.some(([, text]) => text === '📱 Web: Rejected at admission')).toBe(false);
    // The successful continuation is still the only echo emitted.
    expect(echoed.mock.calls.filter(([, text]) => String(text).startsWith('📱 Web:'))).toEqual([['chat', '📱 Web: Continue']]);
  } finally {
    await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});

