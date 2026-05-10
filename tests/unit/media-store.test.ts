import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MediaStore } from '../../src/history/media-store';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-store-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('MediaStore.copyToMedia', () => {
  it('copies file and returns relative path', () => {
    const srcFile = path.join(tmpDir, 'photo.jpg');
    fs.writeFileSync(srcFile, 'fake-image-bytes');

    const rel = MediaStore.copyToMedia(tmpDir, 'agent1', 'telegram-123', srcFile);

    expect(rel).toMatch(/^media\/telegram-123\//);
    const absPath = path.join(tmpDir, 'agent1', rel);
    expect(fs.existsSync(absPath)).toBe(true);
    expect(fs.readFileSync(absPath, 'utf-8')).toBe('fake-image-bytes');
  });

  it('creates directories as needed', () => {
    const srcFile = path.join(tmpDir, 'doc.pdf');
    fs.writeFileSync(srcFile, 'pdf-content');

    const rel = MediaStore.copyToMedia(tmpDir, 'agent-new', 'telegram-456', srcFile);
    expect(rel).toMatch(/^media\/telegram-456\//);
  });
});

describe('MediaStore.resolvePath', () => {
  it('resolves a valid relative path', () => {
    const rel = 'telegram-123/photo.jpg';
    const resolved = MediaStore.resolvePath(tmpDir, 'agent1', rel);
    expect(resolved).toBe(path.join(tmpDir, 'agent1', 'media', 'telegram-123', 'photo.jpg'));
  });

  it('strips media/ prefix if present', () => {
    const rel = 'media/telegram-123/photo.jpg';
    const resolved = MediaStore.resolvePath(tmpDir, 'agent1', rel);
    expect(resolved).toBe(path.join(tmpDir, 'agent1', 'media', 'telegram-123', 'photo.jpg'));
  });

  it('throws on path traversal', () => {
    expect(() =>
      MediaStore.resolvePath(tmpDir, 'agent1', '../../../etc/passwd'),
    ).toThrow('Path traversal detected');
  });

  it('throws on absolute path injection', () => {
    expect(() =>
      MediaStore.resolvePath(tmpDir, 'agent1', '/etc/passwd'),
    ).toThrow('Path traversal detected');
  });
});

describe('MediaStore.clearChatMedia', () => {
  it('removes directory for chatId', () => {
    const dir = path.join(tmpDir, 'agent1', 'media', 'telegram-123');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'photo.jpg'), 'data');

    MediaStore.clearChatMedia(tmpDir, 'agent1', 'telegram-123');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('does not error if directory does not exist', () => {
    expect(() => MediaStore.clearChatMedia(tmpDir, 'agent1', 'nonexistent-chat')).not.toThrow();
  });

  it('does not remove other chats', () => {
    const dir1 = path.join(tmpDir, 'agent1', 'media', 'telegram-111');
    const dir2 = path.join(tmpDir, 'agent1', 'media', 'telegram-222');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    MediaStore.clearChatMedia(tmpDir, 'agent1', 'telegram-111');
    expect(fs.existsSync(dir1)).toBe(false);
    expect(fs.existsSync(dir2)).toBe(true);
  });
});

describe('MediaStore.isAllowedMime', () => {
  it('allows image types', () => {
    expect(MediaStore.isAllowedMime('image/jpeg')).toBe(true);
    expect(MediaStore.isAllowedMime('image/png')).toBe(true);
    expect(MediaStore.isAllowedMime('image/gif')).toBe(true);
    expect(MediaStore.isAllowedMime('image/webp')).toBe(true);
  });

  it('allows PDF', () => {
    expect(MediaStore.isAllowedMime('application/pdf')).toBe(true);
  });

  it('rejects other types', () => {
    expect(MediaStore.isAllowedMime('application/javascript')).toBe(false);
    expect(MediaStore.isAllowedMime('text/plain')).toBe(false);
    expect(MediaStore.isAllowedMime('application/octet-stream')).toBe(false);
    expect(MediaStore.isAllowedMime('video/mp4')).toBe(false);
  });
});
