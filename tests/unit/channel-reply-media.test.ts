import { toRelMediaFiles } from '../../src/agent/runner';

describe('toRelMediaFiles', () => {
  // POSIX-style media root (as built via path.join + path.sep on unix)
  const mediaRoot = '/agents/test-agent/media/';
  const always = () => true;

  it('maps an abs path under the media root to a relative media/<rel> path', () => {
    const abs = '/agents/test-agent/media/session-abc/image_1.png';
    expect(toRelMediaFiles([abs], mediaRoot, always)).toEqual([
      'media/session-abc/image_1.png',
    ]);
  });

  it('drops a path OUTSIDE the media root', () => {
    const inside = '/agents/test-agent/media/session-abc/ok.png';
    const outside = '/etc/passwd';
    const otherAgent = '/agents/other/media/session-abc/nope.png';
    expect(toRelMediaFiles([inside, outside, otherAgent], mediaRoot, always)).toEqual([
      'media/session-abc/ok.png',
    ]);
  });

  it('drops a non-existent file (injected exists predicate)', () => {
    const present = '/agents/test-agent/media/session-abc/present.png';
    const missing = '/agents/test-agent/media/session-abc/missing.png';
    const exists = (p: string) => p === present;
    expect(toRelMediaFiles([present, missing], mediaRoot, exists)).toEqual([
      'media/session-abc/present.png',
    ]);
  });

  it('normalises Windows-style backslashes in the relative part to forward slashes', () => {
    const winRoot = 'C:\\agents\\test-agent\\media\\';
    const abs = 'C:\\agents\\test-agent\\media\\session-abc\\image_1.png';
    expect(toRelMediaFiles([abs], winRoot, always)).toEqual([
      'media/session-abc/image_1.png',
    ]);
  });

  it('ignores non-string entries', () => {
    const abs = '/agents/test-agent/media/session-abc/ok.png';
    expect(
      toRelMediaFiles([abs, 123, null, undefined, {}], mediaRoot, always),
    ).toEqual(['media/session-abc/ok.png']);
  });

  it('returns an empty array when nothing qualifies', () => {
    expect(toRelMediaFiles([], mediaRoot, always)).toEqual([]);
  });
});
