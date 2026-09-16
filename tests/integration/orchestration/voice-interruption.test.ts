import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentOrchestrationRuntime, AgentOrchestrationHost } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';

test.each([
  { reason: 'barge-in', phase: 'starting', partial: '' },
  { reason: 'barge-in', phase: 'starting-error', partial: '' },
  { reason: 'barge-in', phase: 'running', partial: '' },
  { reason: 'barge-in', phase: 'running', partial: 'Here is the first part.' },
  { reason: 'barge-in', phase: 'error', partial: '' },
  { reason: 'barge-in', phase: 'error', partial: 'Here is the first part.' },
  { reason: 'user', phase: 'starting', partial: '' },
  { reason: 'user', phase: 'running', partial: '' },
] as const)('$reason during $phase preserves visible text ($partial)', async ({ reason, phase, partial }) => {
  const root = mkdtempSync(join(tmpdir(), 'voice-interruption-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a/workspace'), description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  let runtime: AgentOrchestrationRuntime;
  let first = true;
  const host: AgentOrchestrationHost = {
    createAgentSession: async () => {
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {};
      process.interrupt = () => true;
      process.stop = async () => {
        if (phase === 'error') process.emit('output', JSON.stringify({ type: 'result', is_error: true, result: 'Interrupted process' }));
        else process.emit('exit', 0);
      };
      process.sendMessage = () => {
        if (!first) {
          process.emit('output', JSON.stringify({ type: 'result', result: JSON.stringify({ display_text: 'New answer.', spoken_text: 'New answer.' }) }));
          return;
        }
        if (partial) process.emit('output', JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '{"display_text":' + JSON.stringify(partial) } } }));
        runtime.stopResponse('voice-session', reason);
      };
      if (first && phase.startsWith('starting')) {
        runtime.stopResponse('voice-session', reason);
        if (phase === 'starting-error') throw new Error('Startup interrupted');
      }
      return process;
    },
    releaseAgentSession: async () => {},
  };
  runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, host, { start: jest.fn() });
  const onText = jest.fn();
  const input = { scope: { agentId: 'a', agentSessionId: 'voice-session', source: 'api' as const, accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'p' }, text: 'First question', modality: 'live_voice' as const };
  try {
    // Stop after startProcessTurn returns its handle, not synchronously in sendMessage.
    const originalStop = runtime.stopResponse.bind(runtime);
    if (!phase.startsWith('starting')) jest.spyOn(runtime, 'stopResponse').mockImplementation((id, why) => { queueMicrotask(() => originalStop(id, why)); return true; });
    const pending = runtime.send(input, { execute: true, writeMemory: false }, { timeoutMs: 1000, onText });
    if (phase === 'error' || phase === 'starting-error') await expect(pending).rejects.toThrow();
    else expect(await pending).toBe(reason === 'user' ? 'Response stopped.' : partial);
    const response = runtime.store.get('SELECT state,generated_text FROM assistant_responses')!;
    expect(response.state).toBe('interrupted');
    expect(response.generated_text).toBe(reason === 'user' ? 'Response stopped.' : partial);
    const messages = await sessions.loadSession('a', 'voice-session');
    expect(messages.filter(m => m.role === 'assistant').map(m => m.content)).toEqual(reason === 'user' ? ['Response stopped.'] : partial ? [partial] : []);
    if (reason === 'barge-in') expect(onText.mock.calls.flat().join('')).not.toContain('Response stopped.');
    first = false;
    expect(await runtime.send({ ...input, text: 'Follow-up question' }, { execute: true, writeMemory: false }, { timeoutMs: 1000 })).toBe('New answer.');
  } finally {
    await runtime.close();
    (history as unknown as { db: { close(): void } }).db.close();
    HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});
