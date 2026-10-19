import { speechCoverageGap } from '../../../src/orchestration/speech';

// Issue #624: a language-agnostic, model-free signal that speech skipped what the chat answered.
test('a Latin term in a Thai question that the chat answers but the speech omits is reported', () => {
  const display = 'จะแก้ทั้ง 4 ข้อค่ะ\n- npm: แสดงเป็น package ใหม่';
  expect(speechCoverageGap('แล้วส่วนของ npm จะขึ้นยังไง', display, 'ได้ค่ะ จะแก้ทั้ง 4 ข้อ')).toEqual(['npm']);
  expect(speechCoverageGap('แล้วส่วนของ npm จะขึ้นยังไง', display, 'ส่วน NPM จะขึ้นเป็น package ใหม่ค่ะ')).toEqual([]);
});

test('a Thai-only message never reports a gap, whatever the replies contain', () => {
  expect(speechCoverageGap('แก้ทั้งหมดเลย แล้วอยากรู้ว่าจะขึ้นยังไง', 'ขึ้นเป็นแพ็กเกจใหม่ npm', 'ได้ค่ะ')).toEqual([]);
});

test('in a Latin-script message only identifier-shaped tokens count, matched as whole tokens', () => {
  const display = 'The version in package.json is read by the release script, and the node_modules folder is ignored.';
  expect(speechCoverageGap('how does the release read package.json and node_modules', display, 'The release script reads the version.')).toEqual(['package.json', 'node_modules']);
  // Ordinary words are not distinctive in an English message.
  expect(speechCoverageGap('how does the release work', display, 'It reads a file.')).toEqual([]);
  // A term the chat does not answer is not a speech omission, and a substring is not a match.
  expect(speechCoverageGap('ตั้งค่า npm กับ v2', 'ใช้ npmrc ได้', 'ได้ค่ะ')).toEqual([]);
});

test('camelCase and versioned identifiers in an English message count', () => {
  expect(speechCoverageGap('what does mergeWindowMs do in v2', 'mergeWindowMs waits for a continuation; v2 keeps it.', 'It waits for more speech.')).toEqual(['mergewindowms', 'v2']);
});
