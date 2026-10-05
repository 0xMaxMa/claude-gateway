/**
 * Deterministic text splitter for long-form narration.
 *
 * Lossless by construction: `pieces.join('') === text` for every input, so
 * nothing is rewritten, dropped or reordered. Boundaries are chosen in this
 * order: paragraphs, sentences, word segmentation, hard length cut. Thai has no
 * spaces between words, so the word pass relies on ICU (`Intl.Segmenter('th')`).
 */

export interface NarrationPiece { text: string; start: number; end: number; }

const SPEAKABLE = /[\p{L}\p{N}]/u;
const SENTENCE_END = /(?<=[.!?。។…])/u;
const hasThai = (value: string) => /[฀-๿]/.test(value);

/** True when a piece contains something a TTS engine can actually pronounce. */
export function isSpeakable(text: string): boolean { return SPEAKABLE.test(text); }

function segments(text: string, granularity: 'sentence' | 'word' | 'grapheme', locale: string): string[] {
  return Array.from(new Intl.Segmenter(locale, { granularity }).segment(text), part => part.segment);
}

/** Paragraph break = blank line; the separator stays attached to the preceding paragraph. */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const match of text.matchAll(/\n[ \t\r]*\n[\s]*/g)) {
    out.push(text.slice(last, match.index! + match[0].length));
    last = match.index! + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function sentences(text: string): string[] {
  const native = segments(text, 'sentence', hasThai(text) ? 'th' : 'en');
  if (native.length > 1) return native;
  // ICU found no boundary: fall back to explicit terminators and line breaks.
  return text.split(SENTENCE_END).flatMap(part => part.split(/(?<=\n)/)).filter(part => part.length > 0);
}

function pack(units: string[], limit: number): string[] {
  const out: string[] = [];
  for (const unit of units) {
    if (out.length && out[out.length - 1].length + unit.length <= limit) out[out.length - 1] += unit;
    else out.push(unit);
  }
  return out;
}

/** Break one unit that is longer than `limit` into units that each fit. */
function shrink(unit: string, limit: number, level: 0 | 1 | 2 | 3): string[] {
  if (unit.length <= limit) return [unit];
  if (level === 0) {
    const parts = sentences(unit);
    if (parts.length > 1) return pack(parts.flatMap(part => shrink(part, limit, 1)), limit);
  }
  if (level <= 1) {
    const words = segments(unit, 'word', hasThai(unit) ? 'th' : 'en');
    if (words.length > 1) return pack(words.flatMap(word => shrink(word, limit, 2)), limit);
  }
  // A single unbreakable run: cut on grapheme boundaries so no character is split.
  return pack(segments(unit, 'grapheme', 'en'), limit);
}

export function splitNarration(text: string, limit = 800): NarrationPiece[] {
  const target = Math.max(1, Math.floor(limit));
  const pieces = pack(paragraphs(text).flatMap(paragraph => shrink(paragraph, target, 0)), target);
  let offset = 0;
  return pieces.map(piece => {
    const start = offset;
    offset += piece.length;
    return { text: piece, start, end: offset };
  });
}
