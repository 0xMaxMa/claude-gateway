import { VoiceReplays } from '../../../src/voice/replay';
import { FakeTtsProvider } from '../../../src/voice/providers/fake';
import { PCM16 } from '../../../src/voice/types';

test('concurrent replay requests share synthesis and shutdown aborts pending generation', async () => {
 const replay=new VoiceReplays(),provider=new FakeTtsProvider();
 let release!:()=>void;
 const synth=jest.spyOn(provider,'synthesize').mockImplementation(async function* ({signal}) {
  await new Promise<void>(resolve=>{release=resolve;});
  if(!signal.aborted)yield {bytes:Buffer.alloc(640),format:PCM16,chunkSeq:0};
 });
 const first=replay.generate('same',provider,'voice','hello');
 const second=replay.generate('same',provider,'voice','hello');
 expect(first).toBe(second);expect(synth).toHaveBeenCalledTimes(1);
 release();expect((await first).subarray(0,4).toString()).toBe('RIFF');
 const pending=replay.generate('later',provider,'voice','hello');
 const rejected=expect(pending).rejects.toThrow('TTS_UNAVAILABLE');
 replay.close();await rejected;release();
});

test('replay limits concurrency and times out a stalled provider', async () => {
 jest.useFakeTimers();
 const replay=new VoiceReplays(),provider=new FakeTtsProvider();
 jest.spyOn(provider,'synthesize').mockImplementation(async function* () { await new Promise(()=>{}); });
 try {
  const pending=Array.from({length:4},(_,i)=>expect(replay.generate(String(i),provider,'voice','hello')).rejects.toThrow('TTS_UNAVAILABLE'));
  await expect(replay.generate('overflow',provider,'voice','hello')).rejects.toThrow('VOICE_REPLAY_BUSY');
  await jest.advanceTimersByTimeAsync(60000);await Promise.all(pending);
 } finally {replay.close();jest.useRealTimers();}
});
