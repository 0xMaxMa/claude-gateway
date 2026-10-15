import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ORCHESTRATION_DEFAULTS } from '../../../src/orchestration/config';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { VoiceError } from '../../../src/voice/types';
import { recoverOrchestration } from '../../../src/orchestration/recovery';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// meguri, input 16e7b607: one failed wallet check ended the voice note for good. The recording
// was kept, but the failed row meant nothing could ever transcribe it again.
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  throw Error('condition not reached');
};

async function fixture(failures: string[], chatId = '42') {
  const root = mkdtempSync(join(tmpdir(), 'voice-retry-'));
  mkdirSync(join(root, 'a', 'media', 'chat'), { recursive: true });
  writeFileSync(join(root, 'a', 'media', 'chat', 'note.ogg'), Buffer.from('OggSfixture'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'fixture', extraFlags: [] },
    orchestration: { enabled: true, channels: ['telegram'] }, voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: true, notes: { ...ORCHESTRATION_DEFAULTS.voice.notes, replyWithVoice: false } } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  const transcribed: string[] = [], prompts: string[] = [];
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, {
    transcribeNote: async (path, options) => {
      transcribed.push(path);
      const failure = failures.shift();
      if (failure) {
        options.onDiagnostic?.({ stage: 'transcription', outcome: 'failed', code: failure, attempt: 3, elapsedMs: 4100, httpStatus: 503 });
        throw new VoiceError(failure);
      }
      return 'ช่วยสรุปงานวันนี้ให้หน่อย';
    },
    createAgentSession: async () => {
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {}; process.stop = async () => {};
      process.sendMessage = prompt => { prompts.push(prompt); process.emit('output', JSON.stringify({ type: 'result', result: 'สรุปให้แล้วครับ' })); };
      return process;
    }, releaseAgentSession: async () => {},
  });
  const scope = { agentId: 'a', agentSessionId: 's', source: 'telegram' as const, accountId: 'bot', chatId, threadKey: '', principalId: 'telegram:42' };
  const send = () => runtime.send({ scope, text: '(voice message)', modality: 'voice_note', attachmentIds: ['media/chat/note.ogg'], ingressKey: 'tg-message-1' }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
  const controls = () => runtime.store.all("SELECT payload_json FROM outbox WHERE kind='delivery'").map(row => JSON.parse(String(row.payload_json)).controls).filter(Boolean);
  return { root, runtime, transcribed, prompts, send, controls, close: async () => { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); } };
}

test('a retryable failure gets a 🔁 Retry button that re-transcribes the kept recording once, for its sender only', async () => {
  const f = await fixture(['STT_PROVIDER_ERROR_HTTP_503']);
  try {
    const reply = await f.send();
    const inputId = String(f.runtime.store.get("SELECT input_id FROM voice_note_transcripts")!.input_id);
    expect(reply).toContain(`Reference: ${inputId}`);
    expect(f.controls()).toEqual([[{ label: '🔁 Retry', data: `orch:vr:${inputId}` }]]);
    expect(Buffer.byteLength(`orch:vr:${inputId}`)).toBeLessThanOrEqual(64);
    // The cause, attempts and elapsed time are in the agent's own log, under the reference ID.
    const log = readFileSync(join(f.root, 'logs', 'a.log'), 'utf8');
    expect(log).toContain('Voice note transcription failed');
    expect(log).toContain(inputId);
    expect(log).toContain('"elapsedMs":4100');
    // Only the sender, in the same chat.
    expect(() => f.runtime.retryVoiceNote('telegram', '42', 'telegram:99', inputId)).toThrow('ACCESS_DENIED');
    expect(() => f.runtime.retryVoiceNote('telegram', '99', 'telegram:42', inputId)).toThrow('ACCESS_DENIED');
    expect(() => f.runtime.retryVoiceNote('discord', '42', 'telegram:42', inputId)).toThrow('ACCESS_DENIED');
    expect(f.runtime.retryVoiceNote('telegram', '42', 'telegram:42', inputId)).toEqual({ text: '🔁 Retrying the voice note…', retried: true });
    // A double tap queues nothing more.
    expect(f.runtime.retryVoiceNote('telegram', '42', 'telegram:42', inputId)).toMatchObject({ retried: false });
    await until(() => f.prompts.length === 1 && !f.runtime.isBusy('s'));
    // The same stored recording was transcribed again and the note was answered as usual.
    expect(f.transcribed).toHaveLength(2);
    expect(f.transcribed[1]).toBe(f.transcribed[0]);
    expect(f.prompts[0]).toContain('ช่วยสรุปงานวันนี้ให้หน่อย');
    const rows = f.runtime.store.all("SELECT input_id,state FROM voice_note_transcripts ORDER BY rowid");
    expect(rows.map(row => row.state)).toEqual(['retried', 'completed']);
    expect(f.runtime.store.get("SELECT COUNT(*) n FROM conversation_inputs WHERE modality='voice_note'")!.n).toBe(2);
    // A transcribed note is never processed again.
    expect(f.runtime.retryVoiceNote('telegram', '42', 'telegram:42', String(rows[1].input_id))).toMatchObject({ retried: false, text: 'This voice note was already transcribed.' });
    expect(f.prompts).toHaveLength(1);
  } finally { await f.close(); }
});

test('a final failure has no Retry button and cannot be retried', async () => {
  const f = await fixture(['VOICE_NOTE_NO_TRANSCRIPT']);
  try {
    await f.send();
    const inputId = String(f.runtime.store.get("SELECT input_id FROM voice_note_transcripts")!.input_id);
    expect(f.controls()).toEqual([]);
    expect(f.runtime.retryVoiceNote('telegram', '42', 'telegram:42', inputId)).toMatchObject({ retried: false });
    expect(f.transcribed).toHaveLength(1);
  } finally { await f.close(); }
});

test('a rerun of an input whose earlier failure was retryable transcribes it again', async () => {
  const f = await fixture(['PROVIDER_TIMEOUT']);
  try {
    await f.send();
    // The same channel message delivered again (for example after a restart) resolves to the
    // same input; its retryable failure is no longer final.
    const input = String(f.runtime.store.get('SELECT input_id FROM voice_note_transcripts')!.input_id);
    f.runtime.store.run("UPDATE conversation_inputs SET status='accepted' WHERE id=?", input);
    (f.runtime as any).pumpMailbox();
    await until(() => f.prompts.length === 1 && !f.runtime.isBusy('s'));
    expect(f.transcribed).toHaveLength(2);
    expect(f.runtime.store.get('SELECT state FROM voice_note_transcripts WHERE input_id=?', input)!.state).toBe('completed');
  } finally { await f.close(); }
});

test('a retry inherits the conversation model instead of re-stamping the original note model as explicit', async () => {
  const f = await fixture(['STT_PROVIDER_ERROR_HTTP_503']);
  try {
    await f.send();
    const inputId = String(f.runtime.store.get('SELECT input_id FROM voice_note_transcripts')!.input_id);
    // The original note only inherited a model that was in effect at the time.
    const ingress = JSON.parse(String(f.runtime.store.get('SELECT ingress_json FROM conversation_inputs WHERE id=?', inputId)!.ingress_json));
    f.runtime.store.run('UPDATE conversation_inputs SET ingress_json=? WHERE id=?', JSON.stringify({ ...ingress, model: 'stale-model', modelSelection: 'inherited' }), inputId);
    expect(f.runtime.retryVoiceNote('telegram', '42', 'telegram:42', inputId)).toMatchObject({ retried: true });
    const retried = f.runtime.store.get("SELECT json_extract(ingress_json,'$.model') model,json_extract(ingress_json,'$.modelSelection') selection FROM conversation_inputs WHERE id<>? AND modality='voice_note'", inputId)!;
    expect(retried.selection).not.toBe('explicit');
    expect(retried.model).toBeNull();
    await until(() => f.prompts.length === 1 && !f.runtime.isBusy('s'));
  } finally { await f.close(); }
});

test('a transcription cut off by a restart is a retryable interruption, not a stuck note', async () => {
  const f = await fixture(['STT_PROVIDER_ERROR_HTTP_503']);
  try {
    await f.send();
    const inputId = String(f.runtime.store.get('SELECT input_id FROM voice_note_transcripts')!.input_id);
    // The process stopped while the provider call was still in flight.
    f.runtime.store.run("UPDATE voice_note_transcripts SET state='processing',error_code=NULL WHERE input_id=?", inputId);
    recoverOrchestration(f.runtime.store);
    expect(f.runtime.store.get('SELECT state,error_code FROM voice_note_transcripts WHERE input_id=?', inputId)).toEqual({ state: 'failed', error_code: 'VOICE_NOTE_INTERRUPTED' });
    expect(f.runtime.retryVoiceNote('telegram', '42', 'telegram:42', inputId)).toMatchObject({ retried: true });
    await until(() => f.prompts.length === 1 && !f.runtime.isBusy('s'));
  } finally { await f.close(); }
});

test('a group chat failure has no Retry button, since only a private chat can use it', async () => {
  const f = await fixture(['STT_PROVIDER_ERROR_HTTP_503'], '-1001234567890');
  try {
    await f.send();
    expect(f.controls()).toEqual([]);
  } finally { await f.close(); }
});
