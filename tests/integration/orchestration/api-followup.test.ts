import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';

const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  throw Error('condition not reached');
};
test.each([false, true])('API worker completion persists result, tools and optional live voice summary (voice=%s)', async voice => {
  const root = mkdtempSync(join(tmpdir(), 'api-task-followup-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  let runtime: AgentOrchestrationRuntime, complete: ((value: any) => void) | undefined, followups = 0;
  runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, {
    createAgentSession: async (_id, profile) => {
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {}; process.stop = async () => {};
      process.sendMessage = prompt => {
        const d = runtime.store.get("SELECT * FROM conversation_decisions WHERE state='running'")!;
        if (prompt.startsWith('Report the persisted')) {
          followups++;
          expect(prompt).toContain('verified worker result');
          expect(Boolean(profile.responseSchema)).toBe(voice);
          process.emit('output', JSON.stringify({ type: 'result', result: voice ? JSON.stringify({ display_text: 'Finished: verified worker result.', spoken_text: 'Work finished.' }) : 'Finished: verified worker result.' }));
        } else {
          const task = runtime.tasks.spawn({ conversationId: String(d.conversation_id), principalId: 'p', inputId: JSON.parse(String(d.input_ids_json))[0], decisionId: String(d.id), epoch: Number(d.epoch), actionId: 'a', execute: true, writeMemory: false }, { title: 'Fixture', instructions: 'Do fixture', targetProfile: 'media-worker' });
          process.emit('output', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__gateway__task_spawn', input: { title: task.title, api_key: 'must-not-leak' } }] } }));
          process.emit('output', JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'private raw output' }] } }));
          process.emit('output', JSON.stringify({ type: 'result', result: 'Queued.' }));
        }
      };
      return process;
    }, releaseAgentSession: async () => {},
  }, { start: async () => ({ accepted: Promise.resolve(), result: new Promise(r => { complete = r; }), stop: async () => complete?.({ type: 'stopped' }) }) });
  try {
    const tools: unknown[] = [];
    await runtime.send({ scope: { agentId: 'a', agentSessionId: 's', source: 'api', accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'p' }, text: 'Run task' }, { execute: true, writeMemory: false }, { timeoutMs: 1000, onTool: e => tools.push(e) });
    await until(() => Boolean(complete));
    const received: unknown[] = [];
    const unsubscribe = voice ? runtime.subscribeVoiceResults('s', 'p', result => received.push(result)) : () => {};
    expect(() => runtime.subscribeVoiceResults('s', 'stranger', () => {})).toThrow('ACCESS_DENIED');
    const before = runtime.activity('s', 'p');
    expect(before.tasks[0].state).toBe('running');
    expect(before.tools).toHaveLength(2); expect(tools).toHaveLength(2);
    expect(JSON.stringify(before)).not.toContain('must-not-leak');
    expect(JSON.stringify(before)).not.toContain('private raw output');
    expect(() => runtime.activity('s', 'stranger')).toThrow('ACCESS_DENIED');
    complete!({ type: 'completed', result: { summary: 'verified worker result', artifactIds: [] } });
    await until(() => runtime.store.get("SELECT COUNT(*) n FROM notifications WHERE status='handled'")!.n === 1 && !runtime.isBusy('s'));
    expect(followups).toBe(1);
    expect(received).toEqual(voice ? [expect.objectContaining({ text: 'Finished: verified worker result.', spoken: 'Work finished.' })] : []);
    unsubscribe();
    const after = runtime.activity('s', 'p', before.cursor);
    expect(after.tasks[0].state).toBe('completed');
    expect(after.responses.map(r => r.text)).toEqual(['Queued.', 'Finished: verified worker result.']);
    expect(after.tools).toHaveLength(0);
    expect((await sessions.loadSession('a', 's')).map(m => m.role)).toEqual(['user', 'assistant', 'assistant']);
    await new Promise(r => setTimeout(r, 220)); expect(followups).toBe(1);
  } finally { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
});

test('a user message arriving during an automatic task report waits and runs once instead of returning conflict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'api-notification-overlap-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  let runtime: AgentOrchestrationRuntime, report: SessionProcess | undefined;
  const prompts: string[] = [];
  runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, {
    createAgentSession: async () => {
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {}; process.stop = async () => {};
      process.sendMessage = prompt => {
        prompts.push(prompt);
        if (prompt.startsWith('Report the persisted')) { report = process; return; }
        if (prompts.length === 1) {
          const d = runtime.store.get("SELECT * FROM conversation_decisions WHERE state='running'")!;
          runtime.tasks.spawn({ conversationId: String(d.conversation_id), principalId: 'p', inputId: JSON.parse(String(d.input_ids_json))[0], decisionId: String(d.id), epoch: Number(d.epoch), actionId: 'a', execute: true, writeMemory: false }, { title: 'Fixture', instructions: 'Do fixture', targetProfile: 'media-worker' });
        }
        process.emit('output', JSON.stringify({ type: 'result', result: prompts.length === 1 ? 'Queued.' : 'Your follow-up was received.' }));
      };
      return process;
    }, releaseAgentSession: async () => {},
  }, { start: async () => ({ accepted: Promise.resolve(), result: Promise.resolve({ type: 'completed', result: { summary: 'done', artifactIds: [] } }), stop: async () => {} }) });
  const input = { scope: { agentId: 'a', agentSessionId: 's', source: 'api' as const, accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'p' }, text: 'Run task' };
  try {
    await runtime.send(input, { execute: true, writeMemory: false }, { timeoutMs: 1000 }); await until(() => Boolean(report));
    const pending = runtime.send({ ...input, text: 'Follow up during report' }, { execute: true, writeMemory: false }, { timeoutMs: 1000 });
    expect(prompts).toHaveLength(2);
    report!.emit('output', JSON.stringify({ type: 'result', result: 'Task finished.' }));
    await expect(pending).resolves.toBe('Your follow-up was received.');
    expect(prompts.filter(p => p.startsWith('Follow up during report'))).toHaveLength(1);
  } finally { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
});

test('live task requires Agent contextual speech, flushes it before terminal response, and speaks final results separately', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-voice-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  let runtime: AgentOrchestrationRuntime, finishInitial: (() => void) | undefined, finishWorker: ((value: any) => void) | undefined;
  const speech = 'I will run Python to calculate the sum from 1 to 100.';
  runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, {
    createAgentSession: async (_id, profile) => {
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {}; process.stop = async () => {};
      process.sendMessage = prompt => {
        if (prompt.startsWith('Report the persisted')) { process.emit('output', JSON.stringify({ type: 'result', result: JSON.stringify({ display_text: 'Python returned 5050', spoken_text: 'The result is 5050.' }) })); return; }
        void (async () => {
          const config = JSON.parse(readFileSync(profile.mcpConfigPath!, 'utf8'));
          const ticket = JSON.parse(readFileSync(config.mcpServers.gateway.env.GATEWAY_ORCHESTRATION_TICKET_FILE, 'utf8'));
          const call = (args: object) => fetch(ticket.url, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'task_spawn', action_id: 'spawn-once', args }) });
          const args = { title: 'Python sum', instructions: 'Compute sum', target_profile: 'media-worker' };
          const denied = await call(args); expect(await denied.json()).toEqual({ error: 'VOICE_ACKNOWLEDGEMENT_REQUIRED' });
          expect(runtime.store.all('SELECT id FROM tasks')).toHaveLength(0);
          const queued = await call({ ...args, spoken_acknowledgement: speech }); expect(queued.status).toBe(200);
          // Retried tool calls cannot duplicate either the task or the spoken receipt.
          expect((await call({ ...args, spoken_acknowledgement: speech })).status).toBe(200);
          finishInitial = () => process.emit('output', JSON.stringify({ type: 'result', result: JSON.stringify({ display_text: 'I will calculate the sum using Python.', spoken_text: 'Do not speak this duplicate receipt.' }) }));
        })().catch(error => process.emit('output', JSON.stringify({ type: 'result', is_error: true, result: String(error) })));
      };
      return process;
    }, releaseAgentSession: async () => {},
  }, { start: async () => ({ accepted: Promise.resolve(), result: new Promise(r => { finishWorker = r; }), stop: async () => finishWorker?.({ type: 'stopped' }) }) });
  try {
    const accepted = runtime.submitInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'api', accountId: 'p', chatId: 'chat', threadKey: '', principalId: 'p' }, text: 'Run Python to sum 1 to 100', modality: 'live_voice' }, { execute: true, writeMemory: false });
    const notifications: Array<{ text: string; spoken: string }> = [];
    const unsubscribe = runtime.subscribeVoiceResults('s', 'p', r => notifications.push(r));
    const iterator = accepted.stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value.text).toBe(speech);
    expect((await iterator.next()).done).toBe(true); // TTS can flush while Agent is still running.
    await until(() => !!finishInitial && !!finishWorker);
    expect(runtime.isBusy('s')).toBe(true);
    expect(runtime.store.all('SELECT id FROM tasks')).toHaveLength(1);
    finishInitial!(); await expect(accepted.response).resolves.toBe('I will calculate the sum using Python.');
    expect(runtime.store.all('SELECT text FROM response_speech').map(r => r.text)).toEqual([speech]);
    finishWorker!({ type: 'completed', result: { summary: '5050', artifactIds: [] } });
    await until(() => notifications.length === 1);
    expect(notifications[0]).toMatchObject({ text: 'Python returned 5050', spoken: 'The result is 5050.' });
    unsubscribe();
  } finally { finishInitial?.(); await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
});
