import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { DeliveryOutbox } from '../../../src/orchestration/delivery';
import { withLiveVoiceTranscript } from '../../../src/orchestration/live-voice-transcript';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

jest.mock('../../../src/voice/providers/voice-catalog', () => ({
  resolveVoiceId: async () => 'fixture', voiceChoices: async () => [{ id: 'fixture', name: 'Default' }],
}));

const voice = { enabled: true, stt: { provider: 'elevenlabs', model: 'scribe_v2_realtime' }, tts: { provider: 'elevenlabs', model: 'eleven_v3_conversational', voiceId: 'fixture' },
  notes: { enabled: true, provider: 'elevenlabs', model: 'scribe_v2', replyWithVoice: true } };

// A Telegram call turn shares the DM conversation, so its reply is delivered to
// that chat. With `/voice on` the chat's voice-reply rule would also send the
// reply as a voice message, while the caller already hears it in the call.
test('a reply to a Telegram call turn reaches the chat as text with the transcript, never as a duplicate voice message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'live-voice-channel-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] }, telegram: { botToken: 'fixture' },
    orchestration: { enabled: true, channels: ['telegram'] }, voice } as unknown as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    createAgentSession: async (_id, profile) => Object.assign(new EventEmitter(), {
      runtimeProfile: profile, start: async () => {}, stop: async () => {},
      sendMessage: function (this: EventEmitter) {
        this.emit('output', JSON.stringify({ type: 'system', subtype: 'init', tools: [] }));
        this.emit('output', JSON.stringify({ type: 'result', result: 'It is sunny.' }));
      },
    }) as unknown as SessionProcess, releaseAgentSession: async () => {},
  });
  const scope = { agentId: 'a', agentSessionId: sid, source: 'telegram' as const, accountId: 'a', chatId: '42', threadKey: '', principalId: 'telegram:42' };
  try {
    runtime.store.setTelegramVoiceMode('42', 'on');
    await runtime.send({ scope, text: 'what is the weather', modality: 'live_voice', trustedChannelMember: true }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
    const call = runtime.store.all("SELECT d.modality,d.delivered_text FROM deliveries d JOIN conversation_bindings b ON b.id=d.binding_id WHERE b.chat_id='42' ORDER BY d.rowid");
    expect(call.filter(row => row.modality === 'speech')).toEqual([]);
    expect(call.filter(row => row.modality === 'text').map(row => row.delivered_text)).toEqual(['🎙 what is the weather\n\nIt is sunny.']);
    // The chat rule still applies to a typed message in the same chat.
    await runtime.send({ scope, text: 'and tomorrow?', trustedChannelMember: true }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
    const typed = runtime.store.all("SELECT d.modality,d.delivered_text FROM deliveries d JOIN conversation_bindings b ON b.id=d.binding_id WHERE b.chat_id='42' ORDER BY d.rowid").slice(call.length);
    expect(typed.some(row => row.modality === 'speech')).toBe(true);
    expect(typed.find(row => row.modality === 'text')!.delivered_text).toBe('It is sunny.');
  } finally {
    await runtime.close(); fetchSpy.mockRestore(); warn.mockRestore(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});

test('the chat quotes every utterance since its last delivered reply, so a barged-in turn joins the next reply', () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const delivered: string[] = [];
  const outbox = new DeliveryOutbox(store, async () => ({ state: 'delivered' }));
  const decisions = new DecisionService(store, (response, binding, text) => {
    const quoted = withLiveVoiceTranscript(store, response, text); delivered.push(quoted); outbox.enqueue(response, binding, quoted);
  });
  const scope = { agentId: 'a', agentSessionId: 's', source: 'telegram' as const, accountId: 'a', chatId: '42', threadKey: '', principalId: 'telegram:42' };
  const say = (text: string, modality: 'live_voice' | 'text' = 'live_voice') => store.acceptInput({ scope, text, modality, trustedChannelMember: true });
  try {
    const first = say('book a table');
    const interrupted = decisions.begin(first.conversationId, scope.principalId, [first.inputId]);
    decisions.interrupt(interrupted);
    decisions.finish(interrupted, '', 'interrupted', undefined, false);
    const second = say('for two people');
    const answer = decisions.begin(second.conversationId, scope.principalId, [second.inputId]);
    // An acknowledgement carries the quote; the final reply to the same words does not repeat it.
    decisions.acknowledge(answer, 'On it.');
    decisions.finish(answer, 'Booked for two.');
    const typed = say('thanks', 'text');
    const reply = decisions.begin(typed.conversationId, scope.principalId, [typed.inputId]);
    decisions.finish(reply, 'You are welcome.');
    expect(delivered).toEqual(['🎙 book a table\n🎙 for two people\n\nOn it.', 'Booked for two.', 'You are welcome.']);
  } finally { store.close(); }
});
