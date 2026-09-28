import { WORKER_RESULT_FIDELITY } from '../../../src/orchestration/report-fidelity';
import { SPEECH_OVERLAY } from '../../../src/orchestration/speech';
import { PROGRESS_REVIEW_OVERLAY } from '../../../src/orchestration/progress-review';

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

// (F4) The always-on fidelity contract governs user-facing reports of a COMPLETED worker/skill
// result. The internal progress-review turn supervises a still-running task and is not such a
// report, so it must scope the contract out — cleanly, without gating the always-on contract off
// the invariant system prefix (which would reintroduce F1's cache-lineage divergence). That
// scope-out is owned by PROGRESS_REVIEW_OVERLAY, present only on the review turn. Removing the
// scope-out clause (reverting F4) turns this red; WORKER_RESULT_FIDELITY itself stays untouched.
test('PROGRESS_REVIEW_OVERLAY scopes the worker-result fidelity contract out of the internal review turn', () => {
  const overlay = PROGRESS_REVIEW_OVERLAY.toLowerCase();
  expect(overlay).toContain('worker-result fidelity contract does not govern this turn');
  // The reason it does not apply: a running task has no final result to preserve.
  expect(overlay).toMatch(/still-running task|no final findings/);
  // The scope-out must not weaken the review turn's own "only new progress" discipline.
  expect(overlay).toContain('only genuinely new progress');
  // F4's fix must NOT be to move the contract into the per-turn overlay (that reintroduces F1):
  // the fidelity contract text stays out of the per-turn review overlay entirely.
  expect(PROGRESS_REVIEW_OVERLAY).not.toContain(WORKER_RESULT_FIDELITY);
});
