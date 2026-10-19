import { speechCoverageGap } from '../../../src/orchestration/speech';

// Issue #624: a language-agnostic, model-free signal that speech skipped what the chat answered.
test('a Latin word in a Thai question that the chat answers but the speech omits is reported', () => {
  const display = 'จะแก้ทั้ง 4 ข้อค่ะ\n- npm: แสดงเป็น package ใหม่';
  expect(speechCoverageGap('แล้วส่วนของ npm จะขึ้นยังไง', display, 'ได้ค่ะ จะแก้ทั้ง 4 ข้อ')).toEqual(['npm']);
  expect(speechCoverageGap('แล้วส่วนของ npm จะขึ้นยังไง', display, 'ส่วน NPM จะขึ้นเป็น package ใหม่ค่ะ')).toEqual([]);
});

test('a Thai-only or a Latin-only message never reports a gap', () => {
  expect(speechCoverageGap('แก้ทั้งหมดเลย แล้วอยากรู้ว่าจะขึ้นยังไง', 'ขึ้นเป็นแพ็กเกจใหม่ npm', 'ได้ค่ะ')).toEqual([]);
  // Ordinary words, hyphenated words and identifiers in an English message are not distinctive.
  expect(speechCoverageGap('can you do the follow-up on the e-mail and package.json?', 'Sure, the follow-up e-mail is sent and package.json updated.', 'Done, I sent it.')).toEqual([]);
});

test('identifiers are not expected in speech, and only whole words match', () => {
  // The overlay forbids reading code aloud, so a file name the speech paraphrases is not a gap.
  expect(speechCoverageGap('release อ่าน package.json ยังไง', 'release อ่าน version จาก package.json', 'release อ่านเวอร์ชันจากไฟล์แพ็กเกจค่ะ')).toEqual([]);
  // A term the chat does not answer is not a speech omission, and a longer word is not a match.
  expect(speechCoverageGap('ตั้งค่า npm ยังไง', 'ใช้ไฟล์ npmrc ได้', 'ได้ค่ะ')).toEqual([]);
});
