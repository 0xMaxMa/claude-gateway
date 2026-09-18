import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { BrowserVoice } from '../../../src/orchestration/browser-voice';
import { VoiceSession } from '../../../src/voice/session';
import { FakeSttProvider } from '../../../src/voice/providers/fake';
import { PCM16, TtsProvider } from '../../../src/voice/types';
import { decodeVoiceFrame } from '../../../src/voice/protocol';

test('voice intent survives detach and catches up only unheard speech from its session', () => {
  const store = new OrchestrationStore(':memory:', 'agent');
  const voice = new BrowserVoice(store), decisions = new DecisionService(store);
  const answer = (session: string, principal = 'owner') => {
    const input = store.acceptInput({ scope: { agentId:'agent', agentSessionId:session, source:'api', accountId:principal, principalId:principal, chatId:'chat', threadKey:'' }, text:'hello' });
    const decision = decisions.begin(input.conversationId, principal, [input.inputId]);
    decisions.finish(decision, 'Full display response', 'completed', 'Approved spoken summary');
    return decision.responseId!;
  };
  try {
    const historical=answer('a');
    store.run('UPDATE assistant_responses SET created_at=1 WHERE id=?', historical);
    voice.set('a','owner',true);
    const missed=answer('a'), other=answer('b');
    expect(new BrowserVoice(store).pending('a','owner')).toEqual([{responseId:missed,text:'Full display response',spoken:'Approved spoken summary'}]);
    expect(voice.pending('a','stranger')).toEqual([]);
    expect(voice.pending('a','owner',[missed])).toEqual([]);
    const row=store.get('SELECT conversation_id FROM assistant_responses WHERE id=?',missed)!;
    const binding=store.get('SELECT id FROM conversation_bindings WHERE conversation_id=?', row.conversation_id)!;
    store.run('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?)', 'playback',missed,null,binding.id,'audio','detached',null,null,'{}',Date.now());
    expect(voice.pending('a','owner').map(r=>r.responseId)).toEqual([missed]);
    store.run("UPDATE deliveries SET state='played' WHERE id='playback'");
    expect(voice.pending('a','owner')).toEqual([]);
    voice.set('a','owner',false);
    answer('a');
    expect(voice.enabled('a','owner')).toBe(false);
    expect(voice.pending('a','owner')).toEqual([]);
    expect(voice.pending('b','owner')).toEqual([]);
    expect(other).not.toBe(missed);
  } finally { store.close(); }
});

test('catch-up and live results synthesize a response once; playback completion survives detach', async () => {
  const controls: Record<string, any>[] = [], audio: Buffer[] = [], receipts=jest.fn();
  const synthesize=jest.fn(async function* () { yield {bytes:Buffer.alloc(640),format:PCM16,chunkSeq:0}; });
  const tts: TtsProvider={id:'fixture',capabilities:{textStreaming:true,wordAlignment:false,outputFormats:[PCM16]},synthesize};
  const session=new VoiceSession(new FakeSttProvider(),tts,'voice',{control:v=>controls.push(v),audio:v=>audio.push(v),bufferedBytes:()=>0},jest.fn(),jest.fn(),undefined,receipts);
  const result={responseId:'response',text:'Display',spoken:'Speak'};
  try {
    session.notifyResult(result); session.notifyResult(result);
    for(let n=0;n<40;n++)await Promise.resolve();
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(audio).toHaveLength(1);
    const frame=decodeVoiceFrame(audio[0]);
    session.progress(frame.epoch,320);
    await new Promise(resolve => setTimeout(resolve,30));
    session.notifyResult(result);
    await new Promise(resolve => setTimeout(resolve,20));
    expect(synthesize).toHaveBeenCalledTimes(1);
    await session.close();
    expect(receipts).toHaveBeenLastCalledWith('response',expect.objectContaining({playedSamples:320,generatedSamples:320}),'played');
  } finally { await session.close(); }
});

test('barge-in releases a queued unheard reply for catch-up without replaying the interrupted reply', async () => {
  const controls: Record<string, any>[] = [], receipts = jest.fn();
  const synthesize = jest.fn(async function* () { yield {bytes: Buffer.alloc(640), format: PCM16, chunkSeq: 0}; });
  const tts: TtsProvider = {id:'fixture', capabilities:{textStreaming:true,wordAlignment:false,outputFormats:[PCM16]}, synthesize};
  const session = new VoiceSession(new FakeSttProvider(), tts, 'voice', {control:v=>controls.push(v), audio:()=>{}, bufferedBytes:()=>0}, jest.fn(), jest.fn(), undefined, receipts);
  const first = {responseId:'first',text:'First',spoken:'First'};
  const waiting = {responseId:'waiting',text:'Waiting',spoken:'Waiting'};
  const until = async (predicate:()=>boolean) => {
    const deadline=Date.now()+1000;
    while(!predicate() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,5));
    expect(predicate()).toBe(true);
  };
  try {
    session.notifyResult(first); session.notifyResult(waiting);
    await until(()=>controls.some(c=>c.type==='playback.end'));
    session.speechStarted(session.playback.epoch+1);
    await session.mute(true,'discard');
    await until(()=>!session.speechClaims().includes('waiting'));
    expect(receipts).toHaveBeenCalledWith('first',expect.anything(),'interrupted');
    expect(session.speechClaims()).toContain('first');
    session.notifyResult(waiting); session.notifyResult(waiting); session.notifyResult(first);
    await until(()=>controls.filter(c=>c.type==='playback.end').length===2);
    expect(controls.filter(c=>c.type==='playback.start').map(c=>c.response_id)).toEqual(['first','waiting']);
    expect(synthesize).toHaveBeenCalledTimes(2);
  } finally { await session.close(); }
});
