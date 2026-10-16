import { SpokenTextStream, spokenPieces } from '../../../src/orchestration/spoken-stream';

test('Thai without full stops splits at the space between Thai phrases, never inside a sentence with Latin text or numbers', () => {
  const thai = 'ได้ค่ะ ตอนนี้ราคา Bitcoin อยู่ที่ประมาณ 67,240 ดอลลาร์ ขึ้นมาราวสองเปอร์เซ็นต์จากเมื่อวาน ตลาดยังรอตัวเลขเงินเฟ้อคืนนี้อยู่ค่ะ';
  const { pieces } = spokenPieces(thai, true);
  expect(pieces.join(' ')).toBe(thai);
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces) expect(piece).not.toMatch(/^(Bitcoin|\d)/);
  expect(pieces[0]).toBe('ได้ค่ะ ตอนนี้ราคา Bitcoin อยู่ที่ประมาณ 67,240 ดอลลาร์');
});

test('English splits at sentence ends once a piece is long enough; an unfinished sentence waits for more text', () => {
  expect(spokenPieces('Sure. Bitcoin is at about 67 thousand dollars. It rose two perc', false))
    .toEqual({ pieces: ['Sure. Bitcoin is at about 67 thousand dollars.'], consumed: 'Sure. Bitcoin is at about 67 thousand dollars. '.length });
  expect(spokenPieces('The price is 67.24 thousand', false).pieces).toEqual([]);
  expect(spokenPieces('The price is 67.24 thousand', true).pieces).toEqual(['The price is 67.24 thousand']);
});

test('a long run without any boundary is cut at its last space, or at the limit, so it cannot hold the voice back', () => {
  const run = 'ก'.repeat(100) + ' ' + 'ข'.repeat(100);
  expect(spokenPieces(run, false).pieces).toEqual(['ก'.repeat(100)]);
  expect(spokenPieces('ค'.repeat(400), false).pieces).toEqual(['ค'.repeat(160), 'ค'.repeat(160)]);
});

test('the stream speaks each piece once as the field grows, and the final spoken_text only adds what is left', () => {
  const said: string[] = [];
  const stream = new SpokenTextStream(text => said.push(text));
  const spoken = 'Bitcoin is at about 67 thousand dollars today. It rose about two percent since yesterday. Watch tonight\'s inflation data.';
  for (let i = 1; i <= spoken.length; i++) stream.update(spoken.slice(0, i), false);
  expect(said).toEqual(['Bitcoin is at about 67 thousand dollars today.', 'It rose about two percent since yesterday.']);
  expect(stream.finish(spoken)).toBe('Watch tonight\'s inflation data.');
  expect([...said, stream.finish(spoken)].join(' ')).toBe(spoken);
});

test('speech the final check would reject stops streaming, and a diverging final text is never spoken on top', () => {
  const said: string[] = [];
  const stream = new SpokenTextStream(text => said.push(text));
  stream.update('This is a perfectly normal first sentence. Then ```code', false);
  expect(said).toEqual([]);
  stream.update('This is a perfectly normal first sentence. Then ```code``` and more. ', true);
  expect(said).toEqual([]);
  const other = new SpokenTextStream(text => said.push(text));
  other.update('A first sentence long enough to speak. ', false);
  expect(said).toEqual(['A first sentence long enough to speak.']);
  expect(other.finish('Something else entirely.')).toBe('');
  expect(new SpokenTextStream(() => {}).finish('Nothing streamed yet.')).toBe('Nothing streamed yet.');
});
