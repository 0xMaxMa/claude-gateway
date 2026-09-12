import * as catalog from '../../../src/voice/providers/voice-catalog';
import { sendTelegramSpeech } from '../../../src/orchestration/telegram-speech';
import { OrchestrationStore, Row } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { DeliveryOutbox } from '../../../src/orchestration/delivery';
import type { AgentConfig } from '../../../src/types';
import type { TtsProvider } from '../../../src/voice/types';

const speech = { text: 'こんにちは。お手伝いします。', provider: 'elevenlabs', model: 'fixture', voiceId: 'chosen-voice' };
const agent = { telegram: { botToken: 'fixture' } } as AgentConfig;
const binding = { channel: 'telegram', chat_id: '123', thread_key: '456' };
const synthesizeFile = jest.fn(async () => ({ bytes: Buffer.from('fixture-mp3'), mime: 'audio/mpeg' as const, name: 'reply.mp3' }));
const provider = () => ({ synthesizeFile } as unknown as TtsProvider);
beforeEach(() => synthesizeFile.mockClear());

test('Telegram voice preserves approved language, selected voice and bound destination/thread', async () => {
  const request = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 91 } })));
  await expect(sendTelegramSpeech(agent, binding, speech, request, provider)).resolves.toEqual({ state: 'delivered', providerId: '91' });
  expect(synthesizeFile).toHaveBeenCalledWith(expect.objectContaining({ text: speech.text, voiceId: 'chosen-voice' }));
  const [url, init] = request.mock.calls[0];
  expect(String(url).endsWith('/sendVoice')).toBe(true);
  const form = init!.body as FormData;
  expect(form.get('chat_id')).toBe('123'); expect(form.get('message_thread_id')).toBe('456');
  expect((form.get('voice') as Blob).type).toBe('audio/mpeg');
  expect(await (form.get('voice') as Blob).text()).toBe('fixture-mp3');
});

test('synthesis failure does not send an empty voice or leak provider errors', async () => {
  synthesizeFile.mockRejectedValueOnce(new Error('private credentials'));
  const request = jest.fn();
  await expect(sendTelegramSpeech(agent, binding, speech, request, provider)).resolves.toEqual({ state: 'failed', code: 'TTS_SYNTHESIS_FAILED', speechSynthesisFailed: true });
  expect(request).not.toHaveBeenCalled();
});

test('ambiguous Telegram send remains unknown', async () => {
  await expect(sendTelegramSpeech(agent, binding, speech, async () => { throw new Error('timeout'); }, provider))
    .resolves.toEqual({ state: 'unknown', code: 'PROVIDER_RECEIPT_UNKNOWN' });
});

test.each(['failed', 'unknown'] as const)('speech and text commit durably; %s acknowledgement does not block final text or retry', async state => {
  const store = new OrchestrationStore(':memory:', 'a');
  const sender = jest.fn(async (_binding: Row, _text: string, _id: string, _file?: unknown, audio?: unknown) => audio
    ? { state, code: 'TTS_SYNTHESIS_FAILED' } : { state: 'delivered' as const, providerId: '92' });
  const outbox = new DeliveryOutbox(store, sender);
  const decisions = new DecisionService(store, (r, b, text) => {
    outbox.enqueue(r, b, text);
    const row = store.get('SELECT text FROM response_speech WHERE response_id=?', r);
    if (row) outbox.enqueueSpeech(r, b, { ...speech, text: String(row.text) });
  });
  try {
    const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source: 'telegram', accountId: 'bot', chatId: '123', threadKey: '', principalId: 'u' }, text: 'hello' });
    const receipt = decisions.begin(input.conversationId, 'u', [input.inputId]);
    store.transaction(() => outbox.enqueueSpeech(receipt.responseId!, input.bindingId, speech));
    decisions.finish(receipt, 'Result text', 'completed', speech.text);
    expect(store.all("SELECT * FROM deliveries WHERE modality='speech'")).toHaveLength(1);
    await outbox.tick(); await outbox.tick();
    expect(sender).toHaveBeenCalledTimes(2);
    expect(store.all('SELECT modality,state FROM deliveries ORDER BY rowid')).toEqual([
      { modality: 'speech', state }, { modality: 'text', state: 'delivered' },
    ]);
    expect(store.get('SELECT text FROM response_speech WHERE response_id=?', receipt.responseId!)?.text).toBe(speech.text);
  } finally { store.close(); }
});

test('default off and chat-scoped settings survive restart', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-preference-'));
  const file = path.join(root, 'state.db');
  let store = new OrchestrationStore(file, 'a');
  try {
    expect(store.telegramVoice('123')).toBe(false);
    store.setTelegramVoice('123', true);
    expect(store.telegramVoice('456')).toBe(false);
    store.close(); store = new OrchestrationStore(file, 'a');
    expect(store.telegramVoice('123')).toBe(true);
    store.setTelegramVoice('123', false);
    expect(store.telegramVoice('123')).toBe(false);
  } finally { store.close(); fs.rmSync(root, {recursive:true,force:true}); }
});

test('turning voice off prevents paid synthesis; switching off during synthesis prevents sending', async () => {
  const request = jest.fn();
  await expect(sendTelegramSpeech(agent, binding, speech, request, provider, () => false)).resolves.toMatchObject({ code:'VOICE_REPLY_DISABLED' });
  expect(synthesizeFile).not.toHaveBeenCalled();
  let enabled = true;
  const pendingProvider = () => ({ synthesizeFile: async () => {
    enabled = false;
    return { bytes: Buffer.from('audio'), mime:'audio/mpeg',name:'reply.mp3' };
  } } as unknown as TtsProvider);
  await expect(sendTelegramSpeech(agent,binding,speech,request,pendingProvider,()=>enabled)).resolves.toMatchObject({code:'VOICE_REPLY_DISABLED'});
  expect(request).not.toHaveBeenCalled();
});

test('Auto resolves a voice for channel delivery and catalog failure never submits audio', async () => {
 const resolve=jest.spyOn(catalog,'resolveVoiceId').mockResolvedValue('auto-voice');
 const request=jest.fn(async()=>new Response(JSON.stringify({ok:true,result:{message_id:92}})));
 try {
  expect((await sendTelegramSpeech(agent,binding,{...speech,voiceId:''},request,provider)).state).toBe('delivered');
  expect(synthesizeFile).toHaveBeenCalledWith(expect.objectContaining({voiceId:'auto-voice'}));
  request.mockClear();synthesizeFile.mockClear();resolve.mockRejectedValue(Error('offline'));
  expect(await sendTelegramSpeech(agent,binding,{...speech,voiceId:''},request,provider)).toEqual({state:'failed',code:'TTS_SYNTHESIS_FAILED',speechSynthesisFailed:true});
  expect(request).not.toHaveBeenCalled();expect(synthesizeFile).not.toHaveBeenCalled();
 } finally {resolve.mockRestore();}
});

test.each(['delivered','unknown'] as const)('early Telegram audio waits for text receipt (%s), including after a restart',async textState=>{
 const store=new OrchestrationStore(':memory:','a');
 const sent:string[]=[];
 const sender=jest.fn(async(_b:Row,text:string,_id:string,_f?:unknown,audio?:unknown)=>{
  sent.push(audio?'speech':'text');return audio||textState==='delivered'?{state:'delivered' as const}:{state:'unknown' as const,code:'UNCERTAIN'};
 });
 let outbox=new DeliveryOutbox(store,sender);const decisions=new DecisionService(store,(r,b,t)=>outbox.enqueue(r,b,t));
 try{
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'telegram',accountId:'b',chatId:'123',threadKey:'',principalId:'u'},text:'hello'});
  const decision=decisions.begin(input.conversationId,'u',[input.inputId]);
  store.transaction(()=>outbox.enqueueSpeech(decision.responseId!,input.bindingId,speech));
  await outbox.tick();expect(sent).toEqual([]);
  decisions.finish(decision,'Final text');
  outbox=new DeliveryOutbox(store,sender);
  await outbox.tick();await outbox.tick();
  expect(sent).toEqual(textState==='delivered'?['text','speech']:['text']);
 }finally{store.close();}
});
