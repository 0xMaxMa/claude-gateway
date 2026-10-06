import { splitNarration, isSpeakable } from '../../../src/voice/narrate-split';

const thai = 'สวัสดีครับวันนี้อากาศดีมากเราจะไปเดินเล่นที่สวนสาธารณะกันหลังเลิกงานแล้วค่อยหาอะไรกินด้วยกัน';
const check = (text: string, limit = 800) => {
  const pieces = splitNarration(text, limit);
  expect(pieces.map(p => p.text).join('')).toBe(text);
  for (const piece of pieces) expect(piece.text.length).toBeLessThanOrEqual(limit);
  pieces.forEach((piece, i) => {
    expect(text.slice(piece.start, piece.end)).toBe(piece.text);
    if (i) expect(piece.start).toBe(pieces[i - 1].end);
  });
  return pieces;
};

describe('splitNarration', () => {
  it('round-trips Thai text without spaces', () => {
    const text = thai.repeat(30);
    const pieces = check(text, 200);
    expect(pieces.length).toBeGreaterThan(5);
  });
  it('round-trips Thai mixed with English', () => {
    const text = `${thai} This is a plain English sentence. Another one follows! And a question?\n\n${thai}\n\nคำว่า API คือ interface. `.repeat(8);
    check(text, 300);
  });
  it('splits one very long sentence by words and then by length', () => {
    check(`${'word '.repeat(2000)}end.`, 800);
    check('x'.repeat(5000), 800);
  });
  it('keeps paragraphs together when they fit', () => {
    const pieces = check('First paragraph.\n\nSecond paragraph.\n\nThird.', 20);
    expect(pieces.map(p => p.text)).toEqual(['First paragraph.\n\n', 'Second paragraph.\n\n', 'Third.']);
  });
  it('never splits a surrogate pair or grapheme', () => {
    const text = '😀'.repeat(50);
    for (const piece of check(text, 7)) expect(piece.text).toBe([...piece.text].join(''));
  });
  it('returns nothing for empty input and flags symbol-only input as unspeakable', () => {
    expect(splitNarration('')).toEqual([]);
    expect(isSpeakable('--- *** ...')).toBe(false);
    expect(isSpeakable('ก')).toBe(true);
    expect(isSpeakable('7')).toBe(true);
    check('--- *** ...\n\n');
  });
});
