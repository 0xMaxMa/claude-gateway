import { CALL_END_GRACE_MS, VoiceCallPairings, voiceCallEndedText } from '../../../src/voice/call-pairing';
import { formatCallDuration } from '../../../src/ui/voice-call-client';

/** A claimed `/call` pairing whose latest ticket opened `voiceSessionId`. */
function call(voiceSessionId = 'voice-1') {
  const pairings = new VoiceCallPairings(), pairingId = pairings.create('agent', '42');
  pairings.claim(pairingId, '42');
  pairings.attach(pairingId, voiceSessionId);
  return { pairings, pairingId, ended: jest.fn() };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1_000_000); });
afterEach(() => { jest.useRealTimers(); });

test('a call with reconnects reports one length, from its first connect to the hang-up', () => {
  const { pairings, pairingId, ended } = call();
  pairings.connected('voice-1', ended, 1_000_000);
  pairings.disconnected('voice-1', false, 1_010_000);
  // The page rejoins with a fresh ticket, and its clock resumes from the server's start.
  pairings.attach(pairingId, 'voice-2');
  expect(pairings.elapsed(pairingId, 1_015_000)).toBe(15_000);
  pairings.connected('voice-2', ended, 1_015_000);
  jest.advanceTimersByTime(CALL_END_GRACE_MS * 2);
  expect(ended).not.toHaveBeenCalled();
  pairings.disconnected('voice-2', true, 1_222_000);
  expect(ended.mock.calls).toEqual([[222_000]]);
  pairings.disconnected('voice-2', true, 1_300_000);
  jest.advanceTimersByTime(CALL_END_GRACE_MS * 2);
  expect(ended).toHaveBeenCalledTimes(1);
});

test('a call nobody rejoins ends at its last disconnect once the grace period passes', () => {
  const { pairings, pairingId, ended } = call();
  pairings.connected('voice-1', ended, 1_000_000);
  pairings.disconnected('voice-1', false, 1_065_000);
  jest.advanceTimersByTime(CALL_END_GRACE_MS - 1);
  expect(ended).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(ended.mock.calls).toEqual([[65_000]]);
  // Rejoining after that is a new call with its own clock.
  expect(pairings.elapsed(pairingId)).toBeUndefined();
  pairings.connected('voice-1', ended, 2_000_000);
  expect(pairings.elapsed(pairingId, 2_005_000)).toBe(5_000);
});

test('a call that never connected reports nothing', () => {
  const { pairings, pairingId, ended } = call();
  pairings.disconnected('voice-1', true);
  pairings.disconnected('voice-1', false);
  jest.advanceTimersByTime(CALL_END_GRACE_MS * 2);
  expect(ended).not.toHaveBeenCalled();
  expect(pairings.elapsed(pairingId)).toBeUndefined();
  // A socket of another call does not touch this one.
  pairings.connected('unknown', ended);
  expect(pairings.elapsed(pairingId)).toBeUndefined();
});

test('the chat notice and the page clock format a length the same way', () => {
  expect(voiceCallEndedText(222_000)).toBe('📞 Call ended · 3:42');
  expect([0, 999, 5_000, 59_999, 60_000, 3_599_000, 3_600_000, 3_723_000].map(formatCallDuration))
    .toEqual(['0:00', '0:00', '0:05', '0:59', '1:00', '59:59', '1:00:00', '1:02:03']);
});
