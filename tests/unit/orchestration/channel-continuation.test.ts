import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
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

type ForwardEntry = { text: string; format: string; turnId: string | null };

// Mirror the receiver's typing-directory layout so these tests can read exactly
// what the REAL writeAutoForward() wrote to the channel's `.forward` queue —
// rather than stubbing writeAutoForward and merely asserting it was called
// (which cannot catch a dedup/format suppression on the real delivery path).
function typingDir(workspace: string, channel: string): string {
  return join(workspace, channel === 'discord' ? '.discord-state' : '.telegram-state', 'typing');
}
function forwardEntries(workspace: string, channel: string, chatId: string): ForwardEntry[] {
  const p = join(typingDir(workspace, channel), `${chatId}.forward`);
  if (!existsSync(p)) return [];
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as ForwardEntry | ForwardEntry[];
  return Array.isArray(parsed) ? parsed : [parsed];
}
// Faithful replica of the receiver's `isEntryAlreadyReplied()`: an entry is
// dropped only when its turnId is non-null AND equals the `.replied` marker's
// turnId — "never matches a null on either side" (writeAutoForward's dedup
// comment). Returns the entries that actually reach the user.
function delivered(entries: ForwardEntry[], repliedTurnId: string | null): ForwardEntry[] {
  return entries.filter(e => !(e.turnId !== null && repliedTurnId !== null && e.turnId === repliedTurnId));
}


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
  const legacy = jest.fn();
  // The REAL writeAutoForward runs (no stub): channelSourceMap routes the echo
  // to the telegram receiver's `.forward` queue, which we read back below.
  const runner = Object.assign(Object.create(AgentRunner.prototype), { agentConfig: agent, sessionStore: sessions,
    orchestration: runtime, turnStreams: new TurnStreamRegistry(), getOrSpawnSession: legacy,
    channelSourceMap: new Map() });
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
    // The web message actually reaches the Telegram `.forward` queue exactly
    // once, carrying the sender's name (finding 2), and force-delivered with a
    // null turnId so a stale same-turn dedup marker can't swallow it (finding 1).
    const echoes = forwardEntries(agent.workspace, 'telegram', 'chat');
    expect(echoes.filter(e => e.text === '📱 Web (Web user): Continue')).toHaveLength(1);
    expect(echoes.find(e => e.text === '📱 Web (Web user): Continue')!.turnId).toBeNull();
    // The two rejected continuations emit no echo: 'No auth' (chatId 'chat')
    // throws before the echo, so it never appears in chat's queue, and the
    // mismatched 'Wrong chat' (chatId 'wrong') never creates a queue at all.
    expect(echoes.some(e => e.text.includes('No auth'))).toBe(false);
    expect(forwardEntries(agent.workspace, 'telegram', 'wrong')).toHaveLength(0);
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
// sendOrchestratedChannel and this goes RED (no '📱 Web (Web user): Continue'
// forward reaches the discord queue).
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
  // The REAL writeAutoForward runs (no stub); channelSourceMap is set before the
  // echo so it routes to the discord receiver's `.forward` queue (channelFor
  // defaults to telegram otherwise), which we read back below.
  const runner = Object.assign(Object.create(AgentRunner.prototype), { agentConfig: agent, sessionStore: sessions,
    orchestration: runtime, turnStreams: new TurnStreamRegistry(), getOrSpawnSession: jest.fn(),
    channelSourceMap: new Map() });
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
    // Exactly one echo actually reaches the discord `.forward` queue, for the
    // accepted continuation only, attributed to the sender and force-delivered.
    const echoes = forwardEntries(agent.workspace, 'discord', 'chat');
    expect(echoes.filter(e => e.text === '📱 Web (Web user): Continue')).toHaveLength(1);
    expect(echoes.find(e => e.text === '📱 Web (Web user): Continue')!.turnId).toBeNull();
    // The mismatched 'Wrong chat' (chatId 'wrong') never creates a queue.
    expect(forwardEntries(agent.workspace, 'discord', 'wrong')).toHaveLength(0);
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
// rejected request writes a phantom '📱 Web (…):' forward before the throw.
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
  const runner = Object.assign(Object.create(AgentRunner.prototype), { agentConfig: agent, sessionStore: sessions,
    orchestration: runtime, turnStreams: new TurnStreamRegistry(), getOrSpawnSession: jest.fn(),
    channelSourceMap: new Map() });
  try {
    await runtime.send({ scope: { agentId: 'a', agentSessionId: 's', source: 'telegram', accountId: 'bot', chatId: 'chat', threadKey: 'topic', principalId: 'human' }, text: 'First' }, { execute: true, writeMemory: true }, { timeoutMs: 2000 });
    // Success path: a valid, admitted continuation echoes exactly once.
    const ok = new Promise<string>((resolve, reject) => {
      void runner.sendMessageToSession('chat', 'telegram', 's', 'Continue', 'Web user', {
        onChunk: () => {}, onDone: resolve, onError: reject,
      }, { timeoutMs: 2000, principalId: 'api:key', allowTools: false }).catch(reject);
    });
    await expect(ok).resolves.toBe('Continued.');
    expect(forwardEntries(agent.workspace, 'telegram', 'chat').filter(e => e.text === '📱 Web (Web user): Continue')).toHaveLength(1);
    // Rejection at admission: submitInput throws (QUEUE_FULL). The request
    // reached a valid session, so the pre-echo validation passes — the only
    // thing standing between it and a phantom echo is that the echo now runs
    // *after* submitInput. It must reach no `.forward` queue.
    const realSubmit = runtime.submitInput.bind(runtime);
    (runtime as unknown as { submitInput: () => never }).submitInput = () => { throw new OrchestrationError('QUEUE_FULL'); };
    await expect(runner.sendMessageToSession('chat', 'telegram', 's', 'Rejected at admission', 'Web user', {
      onChunk: () => {}, onDone: () => {}, onError: () => {},
    }, { timeoutMs: 2000, principalId: 'api:key', allowTools: false })).rejects.toThrow('QUEUE_FULL');
    (runtime as unknown as { submitInput: typeof realSubmit }).submitInput = realSubmit;
    const finalEchoes = forwardEntries(agent.workspace, 'telegram', 'chat');
    expect(finalEchoes.some(e => e.text.includes('Rejected at admission'))).toBe(false);
    // The successful continuation is still the only echo emitted.
    expect(finalEchoes.filter(e => e.text.startsWith('📱 Web'))).toEqual([finalEchoes.find(e => e.text === '📱 Web (Web user): Continue')]);
  } finally {
    await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});

// Finding 1 (forceDeliver). The web echo is standalone text no `.replied`
// marker covers, but it used to be stamped with readCurrentTurnId(). If an
// earlier reply in the same turn — or a concurrent channel turn — left a
// `.replied` marker carrying that same turn id, the receiver's dedup
// (isEntryAlreadyReplied) would swallow the echo, defeating the very
// one-sided-conversation fix this path exists for. forceDeliver=true writes a
// null turnId so the echo always survives. Revert gate: drop the `'text', true`
// args on the echo in sendOrchestratedChannel and this goes RED — the echo is
// stamped with the live turn id, matches the stale marker, and delivered()
// drops it (0 delivered, and turnId is no longer null).
test('web echo survives a stale same-turn-id .replied dedup marker (forceDeliver)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-continuation-force-'));
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
  // The REAL writeAutoForward runs (no stub) so the real turnId-stamping and
  // force-delivery logic is exercised end to end.
  const runner = Object.assign(Object.create(AgentRunner.prototype), { agentConfig: agent, sessionStore: sessions,
    orchestration: runtime, turnStreams: new TurnStreamRegistry(), getOrSpawnSession: jest.fn(),
    channelSourceMap: new Map() });
  try {
    await runtime.send({ scope: { agentId: 'a', agentSessionId: 's', source: 'telegram', accountId: 'bot', chatId: 'chat', threadKey: 'topic', principalId: 'human' }, text: 'First' }, { execute: true, writeMemory: true }, { timeoutMs: 2000 });
    // Route the chat to telegram so getTypingDir/readCurrentTurnId land in the
    // same dir the echo is written to, then plant the live turn id and a stale
    // `.replied` marker carrying it — exactly what an earlier reply this turn
    // would leave. Without forceDeliver, the echo would be stamped with this id.
    (runner.channelSourceMap as Map<string, string>).set('chat', 'telegram');
    const turnId = '1755000009999';
    const dir = typingDir(agent.workspace, 'telegram');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chat'), turnId);                                        // live typing signal
    writeFileSync(join(dir, 'chat.replied'), JSON.stringify({ text: 'earlier reply', turnId })); // stale marker
    const result = new Promise<string>((resolve, reject) => {
      void runner.sendMessageToSession('chat', 'telegram', 's', 'Continue', 'Web user', {
        onChunk: () => {}, onDone: resolve, onError: reject,
      }, { timeoutMs: 2000, principalId: 'api:key', allowTools: false }).catch(reject);
    });
    await expect(result).resolves.toBe('Continued.');
    const echoes = forwardEntries(agent.workspace, 'telegram', 'chat');
    const echo = echoes.find(e => e.text === '📱 Web (Web user): Continue');
    expect(echo).toBeDefined();
    // forceDeliver=true → null turnId (RED without the fix: it would be turnId).
    expect(echo!.turnId).toBeNull();
    // With the receiver's real dedup applied against the stale same-turn-id
    // marker, the echo still reaches the user exactly once (RED without the fix:
    // the same-id entry is dropped, delivered count 0).
    expect(delivered(echoes, turnId).filter(e => e.text === '📱 Web (Web user): Continue')).toHaveLength(1);
  } finally {
    await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});

