import fs from 'fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, truncateSync, statSync, symlinkSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { prepareSharePath } from '../../../src/orchestration/share-path';
import { ingestOrchestrationMedia } from '../../../src/orchestration/media';

let root: string, media: string, source: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'share-path-'));
  media = join(root, 'agent', 'media', 'api-session');
  mkdirSync(media, { recursive: true });
  source = join(root, 'disk.iso'); writeFileSync(source, 'fixture');
});
afterEach(() => { jest.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

test('large workspace files are linked without reading/copying and attachment limits remain enforced', async () => {
  truncateSync(source, 1_970_044_928);
  const prepared = await prepareSharePath(source, media);
  expect(statSync(prepared).ino).toBe(statSync(source).ino);
  expect(statSync(prepared).size).toBe(1_970_044_928);
  expect(await prepareSharePath(source, media)).toBe(prepared);
  expect(readdirSync(media)).toHaveLength(1);
  expect(() => ingestOrchestrationMedia(root, 'agent', 'api-session', source)).toThrow('ATTACHMENT_TOO_LARGE');
});
test('existing session paths are reused directly', async () => {
  const local = join(media, 'existing.iso'); writeFileSync(local, 'fixture');
  expect(await prepareSharePath(local, media)).toBe(local);
  expect(readdirSync(media)).toEqual(['existing.iso']);
});
test('cross-device files use a bounded-memory stream', async () => {
  jest.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('different device'), { code: 'EXDEV' }));
  const prepared = await prepareSharePath(source, media);
  expect(await fs.readFile(prepared, 'utf8')).toBe('fixture');
});
test('readable files denied a hard link by protected_hardlinks use a bounded-memory stream', async () => {
  jest.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('protected hardlink'), { code: 'EPERM' }));
  const prepared = await prepareSharePath(source, media);
  expect(await fs.readFile(prepared, 'utf8')).toBe('fixture');
});
test('an unreadable source is rejected even if hard-linking would be possible', async () => {
  jest.spyOn(fs, 'open').mockRejectedValueOnce(Object.assign(new Error('unreadable'), { code: 'EACCES' }));
  await expect(prepareSharePath(source, media)).rejects.toThrow('SHARE_SOURCE_UNREADABLE');
  expect(readdirSync(media)).toEqual([]);
});
test('session preparation failures have a specific error instead of INVALID_REQUEST', async () => {
  jest.spyOn(fs, 'mkdir').mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
  await expect(prepareSharePath(source, media)).rejects.toThrow('SHARE_PREPARATION_FAILED');
});
test.each(['link', 'cross-device'])('rejects a source swapped to a symlink during %s preparation', async mode => {
  const ref = join(root, 'swapped.iso'); symlinkSync(source, ref);
  if (mode === 'cross-device') jest.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('different device'), { code: 'EXDEV' }));
  await expect(prepareSharePath(ref, media)).rejects.toThrow();
  expect(readdirSync(media)).toEqual([]);
});
test.each(['session', 'media'])('rejects redirected %s directory', async kind => {
  const target = kind === 'session' ? media : join(media, '..');
  rmSync(target, { recursive: true });
  const external = join(root, 'external'); mkdirSync(external); symlinkSync(external, target);
  await expect(prepareSharePath(source, media)).rejects.toThrow('ARTIFACT_PATH_DENIED');
  expect(readdirSync(external).filter(name => name.startsWith('share-'))).toEqual([]);
});

test('valid multibyte filenames remain shareable with their extension', async () => {
  const named = join(root, `${'ก'.repeat(70)}.pdf`); writeFileSync(named, '%PDF-1.4 fixture');
  const prepared = await prepareSharePath(named, media);
  expect(prepared.endsWith('.pdf')).toBe(true);
  expect(await fs.readFile(prepared, 'utf8')).toBe('%PDF-1.4 fixture');
});
