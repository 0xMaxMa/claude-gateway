import { VoiceTurnManager } from '../../../src/voice/turn-manager';
import { FakeSttSession, FakeSttProvider, FakeTtsProvider } from '../../../src/voice/providers/fake';
import { VoicePlayback } from '../../../src/voice/playback';
import { PCM16 } from '../../../src/voice/types';
import { BoundedQueue } from '../../../src/voice/queue';
import { encodeVoiceFrame, decodeVoiceFrame } from '../../../src/voice/protocol';
import { randomUUID } from 'crypto';

test('V03/V09: partial and final segments wait for the matching commit barrier', async () => {
  const stt = new FakeSttSession(), turn = new VoiceTurnManager(stt, 16000);
  await turn.pushAudio(1, new Uint8Array(640));
  turn.event({ type: 'partial', segmentId: 'a', text: 'unfinished' });
  const commit = turn.commit(1); let accepted = false; void commit.then(() => { accepted = true; });
  await Promise.resolve(); await Promise.resolve();
  turn.event({ type: 'segment_final', segmentId: 'a', text: 'แก้ login' });
  turn.event({ type: 'segment_final', segmentId: 'a', text: 'แก้ login' });
  turn.event({ type: 'segment_final', segmentId: 'b', text: 'แล้วรัน tests' });
  turn.event({ type: 'commit_done', commitId: 'stale' });
  await Promise.resolve(); expect(accepted).toBe(false);
  turn.event({ type: 'commit_done', commitId: stt.commitId! });
  await expect(commit).resolves.toBe('แก้ login แล้วรัน tests');
  await expect(turn.commit(1)).resolves.toBe('แก้ login แล้วรัน tests');
  await turn.close();
});

test('V09: finalization timeout does not dispatch partial text', async () => {
  jest.useFakeTimers();
  try {
    const stt = new FakeSttSession(), turn = new VoiceTurnManager(stt, 16000, 100);
    await turn.pushAudio(1, new Uint8Array(640));
    turn.event({ type: 'partial', segmentId: 'a', text: 'delete' });
    const commit = turn.commit(1), rejected = expect(commit).rejects.toThrow('TRANSCRIPTION_INCOMPLETE');
    jest.advanceTimersByTime(101); await rejected;
    await turn.close();
  } finally { jest.useRealTimers(); }
});

test('V01/V02/V10: barge-in invalidates audio and concurrent clears are monotonic', () => {
  const playback = new VoicePlayback(), oldSignal = playback.signal;
  expect(playback.accept(0, { bytes: new Uint8Array(640), format: PCM16, chunkSeq: 0 })).toBe(true);
  expect(playback.clear(2)).toBe(2); expect(oldSignal.aborted).toBe(true);
  expect(playback.clear(1)).toBe(2); expect(playback.clear(2)).toBe(2);
  expect(playback.accept(0, { bytes: new Uint8Array(640), format: PCM16, chunkSeq: 1 })).toBe(false);
  expect(playback.accept(2, { bytes: new Uint8Array(640), format: PCM16, chunkSeq: 0 })).toBe(true);
  playback.progress(2, 100);
  expect(playback.snapshot().playedSamples).toBe(100);
  expect(playback.snapshot().generatedSamples).toBe(320);
  expect(() => playback.progress(2, 321)).toThrow('INVALID_PLAYBACK_PROGRESS');
  playback.close();
});

test('audio frames round trip IDs, ordering and samples without relabeling or base64', () => {
  const frame = { generation: randomUUID(), segmentId: randomUUID(), epoch: 3, sequence: 1, audio: Buffer.from([1, 2, 3, 4]) };
  expect(decodeVoiceFrame(encodeVoiceFrame(frame))).toEqual(frame);
  expect(() => decodeVoiceFrame(Buffer.alloc(10))).toThrow();
});

test('slow consumer is bounded without blocking an independent subscriber', async () => {
  const slow = new BoundedQueue<string>(3, value => value.length), fast = new BoundedQueue<string>(3, value => value.length);
  slow.push('abc'); fast.push('abc');
  expect(() => slow.push('x')).toThrow('CONSUMER_TOO_SLOW');
  expect(await fast[Symbol.asyncIterator]().next()).toEqual({ value: 'abc', done: false });
  slow.close(); fast.close();
});
