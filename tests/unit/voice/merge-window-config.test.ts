import { ORCHESTRATION_DEFAULTS, resolveOrchestrationConfig } from '../../../src/orchestration/config';

const voice = (turns: Record<string, unknown>) => ({ ...ORCHESTRATION_DEFAULTS.voice, turns: { ...ORCHESTRATION_DEFAULTS.voice.turns, ...turns } });

test('voice.turns.mergeWindowMs defaults to 2000 ms so a short hesitation stays one turn (issue #624), accepts 0 and rejects invalid values', () => {
  expect(resolveOrchestrationConfig(undefined, { ...ORCHESTRATION_DEFAULTS.voice, turns: { silenceCommitMs: 650 } }).voice.turns.mergeWindowMs).toBe(2000);
  expect(resolveOrchestrationConfig(undefined, voice({ mergeWindowMs: 400 })).voice.turns.mergeWindowMs).toBe(400);
  expect(resolveOrchestrationConfig(undefined, voice({ mergeWindowMs: 0 })).voice.turns.mergeWindowMs).toBe(0);
  expect(() => resolveOrchestrationConfig(undefined, voice({ mergeWindowMs: -1 }))).toThrow('voice.turns.mergeWindowMs');
  expect(() => resolveOrchestrationConfig(undefined, voice({ mergeWindowMs: 1.5 }))).toThrow('voice.turns.mergeWindowMs');
  // Other timings stay strictly positive.
  expect(() => resolveOrchestrationConfig(undefined, voice({ finalizationTimeoutMs: 0 }))).toThrow('voice.turns.finalizationTimeoutMs');
});

test('voice.turns.silenceCommitMs keeps its 650 ms default and accepts 0, which commits as soon as speech.ended arrives', () => {
  expect(resolveOrchestrationConfig(undefined, voice({})).voice.turns.silenceCommitMs).toBe(650);
  expect(resolveOrchestrationConfig(undefined, voice({ silenceCommitMs: 0 })).voice.turns.silenceCommitMs).toBe(0);
  expect(() => resolveOrchestrationConfig(undefined, voice({ silenceCommitMs: -1 }))).toThrow('voice.turns.silenceCommitMs');
});
