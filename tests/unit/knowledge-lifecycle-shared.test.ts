import { wholeNoteEntryBlock, entryHash } from '../../src/agent/knowledge/lifecycle';

describe('wholeNoteEntryBlock (issue #392 part D)', () => {
  test('a plain note becomes one whole-file block', () => {
    const content = 'The prod cluster runs on kubernetes in region eu-west.';
    const blocks = wholeNoteEntryBlock(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(content);
    expect(blocks[0].entryHash).toBe(entryHash(content));
    expect(blocks[0].startLine).toBe(1);
  });

  test('empty content yields no blocks', () => {
    expect(wholeNoteEntryBlock('')).toEqual([]);
    expect(wholeNoteEntryBlock('   \n  \n')).toEqual([]);
  });

  test('a leading HTML comment is skipped from the hashed block (move-stability)', () => {
    const body = 'Escalate paging incidents to the platform team first.';
    const withoutComment = wholeNoteEntryBlock(body)[0];
    const withComment = wholeNoteEntryBlock(`<!-- staled 2026-08-25 (aged out) -->\n${body}`)[0];
    // Same hash whether or not a staleness-GC marker line precedes the content —
    // this is what lets a note's entry_hash (and thus promote-back) survive a move.
    expect(withComment.entryHash).toBe(withoutComment.entryHash);
    expect(withComment.text).toBe(body);
  });

  test('a leading comment plus blank lines only (no real content) yields no blocks', () => {
    expect(wholeNoteEntryBlock('<!-- staled 2026-08-25 -->\n\n  \n')).toEqual([]);
  });

  test('a genuine content change yields a different hash', () => {
    const a = wholeNoteEntryBlock('Escalate paging incidents to the platform team first.')[0];
    const b = wholeNoteEntryBlock('Escalate paging incidents to the SRE team first.')[0];
    expect(a.entryHash).not.toBe(b.entryHash);
  });

  test('cosmetic whitespace changes keep the same hash (normalizeEntryText)', () => {
    const a = wholeNoteEntryBlock('line one\nline two')[0];
    const b = wholeNoteEntryBlock('line one\n\nline two  ')[0];
    expect(a.entryHash).toBe(b.entryHash);
  });
});
