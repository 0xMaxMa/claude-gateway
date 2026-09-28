import { WORKER_RESULT_FIDELITY } from '../../../src/orchestration/report-fidelity';
import { SPEECH_OVERLAY } from '../../../src/orchestration/speech';

// A worker result's decision-relevant structure — severity labels and their markers, the
// per-severity counts and mapping, evidence references, and the score/verdict — must survive
// the reporting handoff. This asserts the general contract text carries each obligation, so a
// future edit that quietly drops one (reverting to free-form "just summarise it") is caught.
test('the fidelity contract preserves severity, counts, verdict, and fences the result as data', () => {
  const rule = WORKER_RESULT_FIDELITY.toLowerCase();
  // Preserve severity labels together with the marker the worker supplied.
  expect(rule).toContain('severity');
  expect(WORKER_RESULT_FIDELITY).toMatch(/marker/i);
  // Counts and finding-to-severity mapping.
  expect(rule).toContain('count');
  // Evidence references and verdict/blocking status.
  expect(rule).toContain('evidence');
  expect(rule).toContain('verdict');
  expect(rule).toContain('blocking');
  // Do not fabricate severity groups or findings, and do not convert one scale into another.
  expect(rule).toMatch(/do not invent|not report|do not add/);
  expect(rule).toContain('convert one severity scale');
  // The contract is skill-agnostic, not hard-coded to a code-review emoji set.
  expect(rule).toMatch(/whatever scale the skill defined|scale the skill defined/);
  // Embedded worker instructions are data, never authority.
  expect(rule).toContain('data');
  expect(rule).toMatch(/embedded|never override|authorization/);
});

// The display/speech split (issue #542 AC5) is owned by SPEECH_OVERLAY, not duplicated into the
// fidelity contract: speech may omit the visual markers, but both surfaces must still agree on
// the findings and the blocking verdict. Keeping this out of WORKER_RESULT_FIDELITY avoids the
// same instruction being appended twice on a speech-enabled report turn.
test('SPEECH_OVERLAY owns the display/speech split and the fidelity contract does not duplicate it', () => {
  expect(SPEECH_OVERLAY).toMatch(/speech may omit/i);
  expect(SPEECH_OVERLAY.toLowerCase()).toContain('severity marker');
  expect(SPEECH_OVERLAY.toLowerCase()).toContain('verdict');
  // The fidelity contract must NOT restate the speech guidance (no duplication across overlays).
  expect(WORKER_RESULT_FIDELITY).not.toMatch(/speech may omit/i);
});
