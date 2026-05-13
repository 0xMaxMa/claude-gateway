import * as fs from 'fs';
import * as path from 'path';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_MIME_PREFIXES = ['image/', 'application/pdf'];
/** Staging files older than this are eligible for cleanup */
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    // Resolve symlinks to prevent escaping the media root via symlink attacks.
    // Only do this if the path already exists (realpathSync throws if not found).
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(root + path.sep) && real !== root) {
        throw new Error('Path traversal detected');
      }
      return real;
    }
    return resolved;
  }

  /**
   * Delete files in the ui-upload staging area that are older than STAGING_MAX_AGE_MS.
   * Safe to call periodically (e.g. hourly) to prevent disk accumulation.
   */
  static cleanupStaging(agentsBaseDir: string): void {
    const agentsDir = agentsBaseDir;
    if (!fs.existsSync(agentsDir)) return;
    const now = Date.now();
    for (const agentId of fs.readdirSync(agentsDir)) {
      const stagingDir = path.join(agentsDir, agentId, 'media', 'ui-upload');
      if (!fs.existsSync(stagingDir)) continue;
      // Walk up to 2 levels: ui-upload/ and ui-upload/{subdir}/
      for (const entry of fs.readdirSync(stagingDir)) {
        const entryPath = path.join(stagingDir, entry);
        const stat = fs.statSync(entryPath);
        if (stat.isDirectory()) {
          for (const file of fs.readdirSync(entryPath)) {
            const filePath = path.join(entryPath, file);
            try {
              const fstat = fs.statSync(filePath);
              if (now - fstat.mtimeMs > STAGING_MAX_AGE_MS) fs.unlinkSync(filePath);
            } catch { /* skip */ }
          }
          // Remove empty subdir
          try {
            if (fs.readdirSync(entryPath).length === 0) fs.rmdirSync(entryPath);
          } catch { /* skip */ }
        } else if (stat.isFile() && now - stat.mtimeMs > STAGING_MAX_AGE_MS) {
          try { fs.unlinkSync(entryPath); } catch { /* skip */ }
        }
      }
    }
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

  static deleteMediaFiles(agentsBaseDir: string, agentId: string, relativePaths: string[]): void {
    for (const rel of relativePaths) {
      try {
        const abs = MediaStore.resolvePath(agentsBaseDir, agentId, rel);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch { /* skip — path traversal or missing file */ }
    }
  }

  static isAllowedMime(mime: string): boolean {
    return ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p));
  }

  static get maxUploadBytes(): number {
    return MAX_UPLOAD_BYTES;
  }
}
