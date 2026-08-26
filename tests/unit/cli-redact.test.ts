import { redactLine } from '../../src/cli/redact';
import { selectDiagnosticLines } from '../../src/cli/commands/debug-bundle';

describe('cli redact redactLine', () => {
  it('masks a bearer token', () => {
    const out = redactLine('headers Authorization: Bearer abc123def456ghi.jkl-mno');
    expect(out).toContain('«redacted»');
    expect(out).not.toContain('abc123def456ghi');
  });

  it('masks api-key/secret/password assignments', () => {
    expect(redactLine('api_key="supersecretvalue123"')).not.toContain('supersecretvalue123');
    expect(redactLine('password=hunter2hunter2')).not.toContain('hunter2hunter2');
    expect(redactLine('token: myopaquetoken98765')).not.toContain('myopaquetoken98765');
  });

  it('masks provider-style keys and long opaque tokens', () => {
    expect(redactLine('using sk-abcdefgh12345678')).not.toContain('sk-abcdefgh12345678');
    const longTok = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
    expect(redactLine(`ticket ${longTok}`)).not.toContain(longTok);
  });

  it('leaves ordinary text untouched', () => {
    expect(redactLine('session went idle after end_turn')).toBe('session went idle after end_turn');
  });
});

describe('cli debug-bundle selectDiagnosticLines', () => {
  const sample = [
    '2026-08-24 INFO normal chatter that should be dropped',
    '2026-08-24 WARN [pty-shell] submit-diag {"event":"giveup","likelyCause":"cause1-swallowed"}',
    '2026-08-24 ERROR something failed with token abcdefghijklmnopqrstuvwxyz012345',
    '2026-08-24 DEBUG verbose trace dropped',
    'plain submit-diag line kept too',
  ].join('\n');

  it('keeps only warn/error/submit-diag lines', () => {
    const lines = selectDiagnosticLines(sample);
    expect(lines.some((l) => l.includes('submit-diag'))).toBe(true);
    expect(lines.some((l) => l.includes('ERROR'))).toBe(true);
    expect(lines.some((l) => l.includes('normal chatter'))).toBe(false);
    expect(lines.some((l) => l.includes('verbose trace'))).toBe(false);
  });

  it('redacts secrets in the kept lines', () => {
    const lines = selectDiagnosticLines(sample);
    expect(lines.join('\n')).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('caps the number of lines to the tail', () => {
    const many = Array.from({ length: 100 }, (_, i) => `WARN line ${i}`).join('\n');
    const lines = selectDiagnosticLines(many, 10);
    expect(lines).toHaveLength(10);
    expect(lines[lines.length - 1]).toBe('WARN line 99');
  });

  it('caps an individual line length, marking how much was truncated', () => {
    const huge = `WARN ${'lorem ipsum dolor sit amet '.repeat(200)}`; // spaced words, nothing token-like to redact
    const lines = selectDiagnosticLines(huge, 4000, 200);
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThan(300);
    expect(lines[0]).toMatch(/…\[truncated, \d+ more chars\]$/);
  });

  it('leaves lines under the length cap untouched', () => {
    const lines = selectDiagnosticLines('WARN short line', 4000, 200);
    expect(lines).toEqual(['WARN short line']);
  });
});
