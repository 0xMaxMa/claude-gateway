import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveOrchestrationConfig, OrchestrationConfig } from '../../../src/orchestration/config';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { OrchestrationHistoryWriter } from '../../../src/orchestration/history';

test('legacy config defaults off; invalid nested limits and unknown keys are rejected', () => {
  expect(resolveOrchestrationConfig().enabled).toBe(false);
  for (const config of [
    { tasks: { maxConcurrentPerAgent: 0 } }, { tasks: { maxConcurrentPerAgent: NaN } },
    { tasks: { maxConcurrentPerAgent: 1 } }, { tasks: { maxQueuedPerConversation: 101 } },
    { conversation: { maxPendingInputs: -1 } }, { channels: ['unknown'] },
    { voice: { enabled: true, stt: { provider: '' } } }, { voice: { apiKey: 'secret' } }, { enabled: 'true' },
    { voice: { playback: { bargeIn: false } } }, { tasks: { projectRoot: 'relative/project' } },
  ]) expect(() => resolveOrchestrationConfig(config as OrchestrationConfig)).toThrow();
});

test('history append interrupted before sidecar receipt reconciles without duplicate canonical messages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-history-'));
  const orchestration = new OrchestrationStore(join(root, 'orchestration.db'), 'a');
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  try {
    const scope = { agentId: 'a', agentSessionId: 's', source: 'api' as const, accountId: 'key', chatId: 'c', threadKey: '', principalId: 'p' };
    const input = orchestration.acceptInput({ scope, text: 'private input', storeUserMessage: false });
    const decisions = new DecisionService(orchestration);
    const decision = decisions.begin(input.conversationId, 'p', [input.inputId]);
    const response = decisions.finish(decision, 'answer');
    const writer = new OrchestrationHistoryWriter(orchestration, sessions, history);
    await writer.write(`input:${input.inputId}`);
    expect(await sessions.loadSession('a', 's')).toHaveLength(0);
    const original = orchestration.run.bind(orchestration);
    const spy = jest.spyOn(orchestration, 'run').mockImplementation((sql, ...values) => {
      if (sql.startsWith('UPDATE history_operations')) throw new Error('crash after append');
      return original(sql, ...values);
    });
    await expect(writer.write(`response:${response}`)).rejects.toThrow('crash after append');
    spy.mockRestore();
    await writer.write(`response:${response}`);
    await writer.write(`response:${response}`);
    expect(await sessions.loadSession('a', 's')).toHaveLength(1);
    expect(history.getMessages('api-c', { sessionId: 's' }).messages).toHaveLength(1);
    await expect(sessions.appendMessage('a', 's', { role: 'assistant', content: 'changed', ts: 1, operationId: `response:${response}` })).rejects.toThrow('conflict');
  } finally { orchestration.close(); (history as unknown as { db: { close(): void } }).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
});

test('voice and channel replies accept an automatic voice', () => {
 expect(resolveOrchestrationConfig({voice:{enabled:true,notes:{enabled:true,replyWithVoice:true}}}).voice.tts.voiceId).toBe('');
});

test('voice notes default on but explicit opt-out and legacy mode remain respected',()=>{
 expect(resolveOrchestrationConfig({enabled:true}).voice.notes.enabled).toBe(true);
 expect(resolveOrchestrationConfig({enabled:true}).voice.notes.replyWithVoice).toBe(true);
 expect(resolveOrchestrationConfig({voice:{notes:{enabled:false}}}).voice.notes.enabled).toBe(false);
 expect(resolveOrchestrationConfig().enabled).toBe(false);
});

test('accepted voice input is visible in history before the decision finishes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'voice-admission-'));
 const store=new OrchestrationStore(':memory:','a'),sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
 try{
  const receipt=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'key',chatId:'getpod',threadKey:'',principalId:'p'},text:'สร้างรูปหมามีปีก',modality:'live_voice'});
  const writer=new OrchestrationHistoryWriter(store,sessions,history);
  await writer.write(`input:${receipt.inputId}`);
  expect(history.getMessages('api-getpod',{sessionId:'s'}).messages.map(m=>m.content)).toEqual(['สร้างรูปหมามีปีก']);
  const decisions=new DecisionService(store),d=decisions.begin(receipt.conversationId,'p',[receipt.inputId]);
  decisions.finish(d,'Done');await writer.write(`input:${receipt.inputId}`);await writer.write(`response:${d.responseId}`);
  const rows=history.getMessages('api-getpod',{sessionId:'s'}).messages;
  expect(rows).toHaveLength(2);expect(rows.find(m=>m.role==='assistant')?.responseId).toBe(d.responseId);
 }finally{store.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});
