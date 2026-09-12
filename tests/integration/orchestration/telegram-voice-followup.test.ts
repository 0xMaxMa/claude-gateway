import { ORCHESTRATION_DEFAULTS } from '../../../src/orchestration/config';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
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
const cases = (['telegram','discord','line','slack'] as const).flatMap(source => (['on','auto'] as const).flatMap(mode => (['voice_note','text'] as const).map(modality => ({source,mode,modality}))));
test.each(cases)('$source $mode $modality queues TTS only when policy allows the task origin', async ({source,mode,modality}) => {
  const expectsSpeech = mode === 'on' || modality === 'voice_note';
  const root = mkdtempSync(join(tmpdir(), 'telegram-voice-followup-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  // No Telegram credentials: deliveries remain inspectable without external sends.
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true, channels: [source] }, voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: true, tts: { ...ORCHESTRATION_DEFAULTS.voice.tts, voiceId: 'chosen' } } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  let runtime: AgentOrchestrationRuntime, complete: ((result: any) => void) | undefined, followups = 0;
  runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, {
    transcribeNote: async () => '調べてください',
    createAgentSession: async (sessionId, profile) => {
      expect(sessionId).toBe('s');
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {}; process.stop = async () => {};
      process.sendMessage = prompt => {
        if (expectsSpeech) expect(profile.overlay).toContain('spoken_text');
        if (prompt.startsWith('Report the persisted')) {
          followups++;
          expect(prompt).toContain('verified result');
          process.emit('output', JSON.stringify({ type: 'result', result: expectsSpeech ? JSON.stringify({ display_text: '調査が完了しました。', spoken_text: '調査が完了しました。' }) : '調査が完了しました。' }));
        } else {
          const d = runtime.store.get("SELECT * FROM conversation_decisions WHERE state='running'")!;
          runtime.tasks.spawn({ conversationId: String(d.conversation_id), principalId: 'p', inputId: JSON.parse(String(d.input_ids_json))[0], decisionId: String(d.id), epoch: Number(d.epoch), actionId: 'a', execute: true, writeMemory: false }, { title: 'Fixture', instructions: 'Do fixture', targetProfile: 'default-worker' });
          process.emit('output', JSON.stringify({ type: 'result', result: expectsSpeech ? JSON.stringify({ display_text: '調べます。', spoken_text: '調べます。' }) : '調べます。' }));
        }
      };
      return process;
    }, releaseAgentSession: async () => {},
  }, { start: async () => ({ accepted: Promise.resolve(), result: new Promise(r => { complete = r; }), stop: async () => complete?.({ type: 'stopped' }) }) });
  runtime.store.setChannelVoiceMode(source,'chat','topic',mode);
  try {
    await runtime.send({ scope: { agentId: 'a', agentSessionId: 's', source, accountId: 'bot', chatId: 'chat', threadKey: 'topic', principalId: 'p' }, text: '[Voice note]', modality, attachmentIds: ['media/chat/note.ogg'] }, { execute: true, writeMemory: false }, { timeoutMs: 1000 });
    await until(() => Boolean(complete));
    complete!({ type: 'completed', result: { summary: 'verified result', artifactIds: [] } });
    await until(() => runtime.store.get("SELECT COUNT(*) n FROM notifications WHERE status='handled'")!.n === 1 && !runtime.isBusy('s'));
    expect(followups).toBe(1);
    const speech = runtime.store.all("SELECT d.delivered_text,b.chat_id,b.thread_key FROM deliveries d JOIN conversation_bindings b ON b.id=d.binding_id WHERE d.modality='speech' ORDER BY d.rowid");
    expect(speech).toHaveLength(expectsSpeech ? 2 : 0);
    expect(speech.map(r => JSON.parse(String(r.delivered_text)).text)).toEqual(expectsSpeech ? ['調べます。', '調査が完了しました。'] : []);
    expect(speech.every(r => r.chat_id === 'chat' && r.thread_key === 'topic')).toBe(true);
  } finally { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
});
