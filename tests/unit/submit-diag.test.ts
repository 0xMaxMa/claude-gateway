import { shortHash, buildSubmitDiag, SubmitDiagInputs } from '../../src/shell/submit-diag';

// Diagnostics for the swallowed-Enter submit-retry path (#370). These are pure
// helpers, so the tests mirror the menu-probe/decideMenuCancel style: no
// node-pty/screen imports, just field- and redaction-level assertions.

const baseInputs = (over: Partial<SubmitDiagInputs> = {}): SubmitDiagInputs => ({
  event: 'giveup',
  enterRetries: 2,
  sawBusy: false,
  sawBusyMarker: false,
  sawAssistant: false,
  recordsDelta: 0,
  draft: '',
  quietMs: 2000,
  msSinceSubmit: 4200,
  msSinceStart: 8600,
  msSinceFirstRecord: null,
  hasPrompt: true,
  dialog: null,
  fromMenuSelection: false,
  probeRounds: null,
  ...over,
});

describe('submit-diag shortHash (draft redaction primitive)', () => {
  it('is deterministic — same input yields the same hash', () => {
    expect(shortHash('deploy the staging build now')).toBe(shortHash('deploy the staging build now'));
  });

  it('differs for different inputs (so a changed draft is detectable across retries)', () => {
    expect(shortHash('draft A')).not.toBe(shortHash('draft B'));
  });

  it('returns a fixed-width 8-char hex string', () => {
    expect(shortHash('x')).toMatch(/^[0-9a-f]{8}$/);
    expect(shortHash('a much longer draft with spaces and symbols !@#')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('never contains the raw input text', () => {
    const secret = 'sk-super-secret-token-value';
    expect(shortHash(secret)).not.toContain('secret');
    expect(shortHash(secret)).not.toContain(secret);
  });
});

describe('submit-diag buildSubmitDiag (structured snapshot)', () => {
  it('redacts the draft to length + hash — the raw text never appears in the snapshot', () => {
    const draft = 'please retry the failed deployment';
    const snap = buildSubmitDiag(baseInputs({ draft }));
    expect(snap.draftLen).toBe(draft.length);
    expect(snap.draftHash).toBe(shortHash(draft));
    // Acceptance criterion: no raw user text, tokens, or secrets in the snapshot.
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(draft);
    expect(serialized).not.toContain('please retry');
    expect(Object.prototype.hasOwnProperty.call(snap, 'draft')).toBe(false);
  });

  it('reports an empty draft as length 0 with a null hash (the cause-2 tell)', () => {
    const snap = buildSubmitDiag(baseInputs({ draft: '' }));
    expect(snap.draftLen).toBe(0);
    expect(snap.draftHash).toBeNull();
  });

  it('carries the give-up decision inputs verbatim (cause-1 snapshot: draft still on screen)', () => {
    const snap = buildSubmitDiag(baseInputs({
      event: 'giveup',
      draft: 'unsent text',
      sawBusy: false,
      sawBusyMarker: false,
      sawAssistant: false,
      recordsDelta: 0,
      quietMs: 1800,
      hasPrompt: true,
    }));
    expect(snap.event).toBe('giveup');
    expect(snap.draftLen).toBe('unsent text'.length);
    expect(snap.recordsDelta).toBe(0);
    expect(snap.sawBusyMarker).toBe(false);
    expect(snap.hasPrompt).toBe(true);
  });

  it('distinguishes a recovered turn (cause-2: records arrived, no marker) from a give-up', () => {
    const snap = buildSubmitDiag(baseInputs({
      event: 'recovered',
      draft: '',
      enterRetries: 1,
      sawBusy: true,        // flipped from an assistant record, not the marker
      sawBusyMarker: false, // the literal "esc to interrupt" was never seen
      sawAssistant: true,
      recordsDelta: 3,      // Claude did produce output — the Enter was NOT swallowed
      msSinceFirstRecord: 900,
    }));
    expect(snap.event).toBe('recovered');
    expect(snap.sawBusyMarker).toBe(false);
    expect(snap.sawAssistant).toBe(true);
    expect(snap.recordsDelta).toBe(3);
    expect(snap.msSinceFirstRecord).toBe(900);
  });

  it('passes through the record-timing / probe / dialog discriminators', () => {
    const snap = buildSubmitDiag(baseInputs({
      event: 'retry',
      fromMenuSelection: true,
      probeRounds: 2,
      dialog: 'bypass-permissions',
      msSinceFirstRecord: 1200,
      msSinceSubmit: 4100,
      msSinceStart: 9000,
    }));
    expect(snap.event).toBe('retry');
    expect(snap.fromMenuSelection).toBe(true);
    expect(snap.probeRounds).toBe(2);
    expect(snap.dialog).toBe('bypass-permissions');
    expect(snap.msSinceFirstRecord).toBe(1200);
    expect(snap.msSinceSubmit).toBe(4100);
    expect(snap.msSinceStart).toBe(9000);
  });

  it('preserves null timing fields (submit/first-record not yet observed)', () => {
    const snap = buildSubmitDiag(baseInputs({ msSinceSubmit: null, msSinceFirstRecord: null }));
    expect(snap.msSinceSubmit).toBeNull();
    expect(snap.msSinceFirstRecord).toBeNull();
  });

  it('emits exactly the documented field set (no accidental raw-state leak)', () => {
    const snap = buildSubmitDiag(baseInputs({ draft: 'x' }));
    expect(Object.keys(snap).sort()).toEqual([
      'dialog',
      'draftHash',
      'draftLen',
      'enterRetries',
      'event',
      'fromMenuSelection',
      'hasPrompt',
      'msSinceFirstRecord',
      'msSinceStart',
      'msSinceSubmit',
      'probeRounds',
      'quietMs',
      'recordsDelta',
      'sawAssistant',
      'sawBusy',
      'sawBusyMarker',
    ]);
  });
});
