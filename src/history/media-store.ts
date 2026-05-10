import * as fs from 'fs';
import * as path from 'path';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_MIME_PREFIXES = ['image/', 'application/pdf'];

export class MediaStore {
  static mediaDir(agentsBaseDir: string, agentId: string, chatId: string): string {
    return path.join(agentsBaseDir, agentId, 'media', chatId);
  }

  static agentMediaRoot(agentsBaseDir: string, agentId: string): string {
    return path.join(agentsBaseDir, agentId, 'media');
  }

  /**
   * Copy a file from srcPath into the permanent media directory for chatId.
   * Returns the relative path stored in HistoryMessage.mediaFiles[].
   */
  static copyToMedia(
    agentsBaseDir: string,
    agentId: string,
    chatId: string,
    srcPath: string,
  ): string {
    const dir = MediaStore.mediaDir(agentsBaseDir, agentId, chatId);
    fs.mkdirSync(dir, { recursive: true });
    const basename = `${Date.now()}-${path.basename(srcPath)}`;
    const destName = basename.length > 128 ? basename.slice(0, 128) : basename;
    const destPath = path.join(dir, destName);
    fs.copyFileSync(srcPath, destPath);
    return path.join('media', chatId, destName);
  }

  /**
   * Resolve a relative media path to an absolute filesystem path.
   * Throws if the resolved path escapes the agent's media root (path traversal guard).
   */
  static resolvePath(agentsBaseDir: string, agentId: string, relativePath: string): string {
    const root = MediaStore.agentMediaRoot(agentsBaseDir, agentId);
    // Strip leading "media/" prefix if present (callers may or may not include it)
    const withoutPrefix = relativePath.startsWith('media/')
      ? relativePath.slice(6)
      : relativePath;
    const resolved = path.resolve(root, withoutPrefix);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }

  /**
   * Delete all media files for a chatId (called by /clear).
   */
  static clearChatMedia(agentsBaseDir: string, agentId: string, chatId: string): void {
    const dir = MediaStore.mediaDir(agentsBaseDir, agentId, chatId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  static isAllowedMime(mime: string): boolean {
    return ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p));
  }

  static get maxUploadBytes(): number {
    return MAX_UPLOAD_BYTES;
  }
}
