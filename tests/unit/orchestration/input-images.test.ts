import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadInputImages } from '../../../src/orchestration/input-images';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L9sAAAAASUVORK5CYII=', 'base64');
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'input-images-')); mkdirSync(join(root, 'a/media/c'), { recursive: true }); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
test('sniffs actual bytes, preserves order and originals, skips audio/documents', async () => {
  writeFileSync(join(root, 'a/media/c/photo.bin'), png);
  writeFileSync(join(root, 'a/media/c/doc.pdf'), '%PDF-1.7');
  writeFileSync(join(root, 'a/media/c/audio.mp3'), 'ID3');
  const result = await loadInputImages(root, 'a', ['media/c/doc.pdf', 'media/c/photo.bin', 'media/c/audio.mp3', 'media/c/photo.bin']);
  expect(result.refs).toEqual(['media/c/photo.bin']);
  expect(result.images).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }]);
  expect(result.unavailable).toEqual([]);
});
test('does not read outside scoped media, follow escaping symlinks or silently drop missing/unsupported images', async () => {
  writeFileSync(join(root, 'private.png'), png);
  symlinkSync(join(root, 'private.png'), join(root, 'a/media/c/link.png'));
  writeFileSync(join(root, 'a/media/c/fake.png'), '%PDF-1.7');
  const result = await loadInputImages(root, 'a', ['../../private.png', 'media/c/link.png', 'media/c/missing.png', 'media/c/fake.png']);
  expect(result.images).toEqual([]); expect(result.unavailable).toHaveLength(4);
});
test('bounds image bytes and image count with explicit unavailable notices', async () => {
  writeFileSync(join(root, 'a/media/c/huge.png'), png);
  truncateSync(join(root, 'a/media/c/huge.png'), 5 * 1024 * 1024 + 1);
  const refs = Array.from({ length: 21 }, (_, i) => `media/c/${i}.png`);
  for (const ref of refs) writeFileSync(join(root, 'a', ref), png);
  const result = await loadInputImages(root, 'a', ['media/c/huge.png', ...refs]);
  expect(result.images).toHaveLength(20); expect(result.unavailable).toHaveLength(2);
});

test.each([
  ['jpeg', Buffer.from([255, 216, 255, 224]), 'image/jpeg'],
  ['gif', Buffer.from('GIF89a'), 'image/gif'],
  ['webp', Buffer.from('RIFFxxxxWEBP'), 'image/webp'],
] as const)('accepts supported %s bytes without trusting extension', async (_format, bytes, mime) => {
  writeFileSync(join(root, 'a/media/c/upload'), bytes);
  const result = await loadInputImages(root, 'a', ['media/c/upload']);
  expect(result.images[0].source.media_type).toBe(mime);
});
test('enforces aggregate bytes before allocating another image', async () => {
  const refs = Array.from({ length: 5 }, (_, i) => `media/c/${i}.png`);
  for (const ref of refs) { writeFileSync(join(root, 'a', ref), png); truncateSync(join(root, 'a', ref), 5 * 1024 * 1024); }
  const result = await loadInputImages(root, 'a', refs);
  expect(result.images).toHaveLength(4); expect(result.unavailable.map(item => item.ref)).toEqual([refs[4]]);
});
