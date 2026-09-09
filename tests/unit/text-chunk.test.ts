/**
 * Unit tests for the shared text chunker (src/shared/text-chunk.ts), Phase 2
 * of the WhatsApp feature-parity plan.
 *
 * Both WhatsApp channels send long replies through this: WhatsApp Cloud caps a
 * text message at 4096 chars and Baileys is given a conservative 4000, and a
 * reply over the cap used to be rejected by the platform (Cloud) rather than
 * split. The invariants that matter: nothing is ever dropped, and no chunk
 * exceeds the budget.
 */
import { chunkText } from '../../src/shared/text-chunk';

/** Rejoining with a single space undoes exactly the whitespace the cuts ate. */
function rejoin(chunks: string[]): string {
  return chunks.join(' ');
}

describe('chunkText()', () => {
  describe('inputs that must not be split', () => {
    test('empty string → no chunks at all (caller decides what an empty send means)', () => {
      expect(chunkText('', 100)).toEqual([]);
    });

    test('text shorter than the budget → returned verbatim as a single chunk', () => {
      expect(chunkText('hello world', 100)).toEqual(['hello world']);
    });

    test('text exactly at the budget → still a single chunk (the cap is inclusive)', () => {
      const text = 'x'.repeat(50);
      expect(chunkText(text, 50)).toEqual([text]);
    });

    test('a non-positive/NaN budget → single chunk rather than an infinite loop', () => {
      expect(chunkText('abc', 0)).toEqual(['abc']);
      expect(chunkText('abc', -10)).toEqual(['abc']);
      expect(chunkText('abc', Number.NaN)).toEqual(['abc']);
    });
  });

  describe("mode 'length' — hard cuts", () => {
    test('splits at exactly maxChars, losing nothing', () => {
      const text = 'abcdefghij';
      expect(chunkText(text, 4, 'length')).toEqual(['abcd', 'efgh', 'ij']);
      expect(chunkText(text, 4, 'length').join('')).toBe(text);
    });

    test('does NOT trim whitespace at the cut (a strict char budget keeps every char)', () => {
      expect(chunkText('ab  cd', 3, 'length')).toEqual(['ab ', ' cd']);
    });

    test('every chunk respects the budget for a long body', () => {
      const chunks = chunkText('y'.repeat(9001), 4096, 'length');
      expect(chunks).toHaveLength(3);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
      expect(chunks.join('')).toHaveLength(9001);
    });
  });

  describe("mode 'newline' (default) — boundary-preferring cuts", () => {
    test('prefers a paragraph break over a plain newline or a space', () => {
      const first = 'a'.repeat(30);
      const second = 'b'.repeat(30);
      // Both a \n\n (at 30) and later single \n / spaces exist inside the
      // budget; the paragraph break wins.
      const text = `${first}\n\n${second}\nc d e`;
      const chunks = chunkText(text, 40);
      expect(chunks[0]).toBe(first);
      expect(chunks[1]).toBe(`${second}\nc d e`);
    });

    test('falls back to the last newline when no paragraph break is late enough', () => {
      const line1 = 'a'.repeat(25);
      const line2 = 'b'.repeat(25);
      const chunks = chunkText(`${line1}\n${line2}`, 30);
      expect(chunks).toEqual([line1, line2]);
    });

    test('falls back to the last space when there is no newline at all', () => {
      const chunks = chunkText('aaaaaaaaaa bbbbbbbbbb cccccccccc', 25);
      expect(chunks).toEqual(['aaaaaaaaaa bbbbbbbbbb', 'cccccccccc']);
    });

    test('hard-cuts an unbroken run (one long token has no boundary to find)', () => {
      const chunks = chunkText('z'.repeat(25), 10);
      expect(chunks).toEqual(['z'.repeat(10), 'z'.repeat(10), 'z'.repeat(5)]);
    });

    test('the "later half" preference picks between boundary KINDS, not against a lone space', () => {
      // Inherited verbatim from splitForLine: the half-budget test only decides
      // whether to fall through from paragraph → newline → space. Once the
      // space is the last candidate it is used wherever it sits, so a leading
      // short token does become its own chunk. Documented rather than
      // "fixed" — the two splitters must keep behaving identically.
      const text = `ab ${'c'.repeat(40)}`;
      const chunks = chunkText(text, 20);
      // 'ab' first, then the unbroken run of c's hard-cut at the budget.
      expect(chunks).toEqual(['ab', 'c'.repeat(20), 'c'.repeat(20)]);
    });

    test('is lossless apart from whitespace collapsed exactly at the cut points', () => {
      const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
      const text = words.join(' ');
      const chunks = chunkText(text, 100);
      expect(chunks.length).toBeGreaterThan(1);
      expect(rejoin(chunks)).toBe(text);
    });

    test('no chunk ever exceeds the budget, and none is empty or whitespace-only', () => {
      const text = `${'para one. '.repeat(500)}\n\n\n\n${'para two. '.repeat(500)}`;
      const chunks = chunkText(text, 4000);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(4000);
        expect(c.trim()).not.toBe('');
      }
    });

    test('a long run of whitespace between two blocks never produces a blank message', () => {
      const chunks = chunkText(`${'a'.repeat(10)}${' '.repeat(30)}${'b'.repeat(10)}`, 12);
      expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
      expect(chunks[0]).toBe('a'.repeat(10));
      expect(chunks[chunks.length - 1]).toBe('b'.repeat(10));
    });
  });

  describe('surrogate pairs (astral characters, e.g. most emoji) are never split', () => {
    // U+1F600 😀 — outside the BMP, so it's TWO UTF-16 code units (a high +
    // low surrogate). A hard cut landing between them produces an unpaired
    // surrogate in each half, which is mojibake on the receiving side.
    const EMOJI = '\u{1F600}';

    /** True if `s` ends in a high surrogate with no following low surrogate. */
    function endsWithUnpairedHighSurrogate(s: string): boolean {
      if (!s) return false;
      const code = s.charCodeAt(s.length - 1);
      return code >= 0xd800 && code <= 0xdbff;
    }

    /** True if `s` starts with a low surrogate with no preceding high surrogate. */
    function startsWithUnpairedLowSurrogate(s: string): boolean {
      if (!s) return false;
      const code = s.charCodeAt(0);
      return code >= 0xdc00 && code <= 0xdfff;
    }

    test("mode 'length': a hard cut never separates a surrogate pair", () => {
      const text = `aaa${EMOJI}bbb${EMOJI}ccc${EMOJI}ddd`;
      const chunks = chunkText(text, 4, 'length');
      expect(chunks.join('')).toBe(text);
      for (const c of chunks) {
        expect(endsWithUnpairedHighSurrogate(c)).toBe(false);
        expect(startsWithUnpairedLowSurrogate(c)).toBe(false);
      }
    });

    test("mode 'newline' hard-cut fallback never separates a surrogate pair", () => {
      // No paragraph/newline/space boundary anywhere, so this exercises the
      // hard-cut fallback directly, same as the "unbroken run" test above. An
      // ODD maxChars against an all-2-unit-wide alphabet guarantees a naive
      // cut would misalign with pair boundaries on the very first chunk.
      const text = EMOJI.repeat(20);
      const chunks = chunkText(text, 9);
      expect(chunks.join('')).toBe(text);
      for (const c of chunks) {
        expect(endsWithUnpairedHighSurrogate(c)).toBe(false);
        expect(startsWithUnpairedLowSurrogate(c)).toBe(false);
      }
    });
  });
});
