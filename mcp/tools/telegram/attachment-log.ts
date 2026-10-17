/**
 * Per-chat record of the attachment file_ids the receiver delivered (#609). A
 * Telegram file_id carries no chat, so isolate mode downloads only a file_id
 * this log shows arrived in the conversation's own chat. The receiver writes,
 * the session MCP server reads; both share TELEGRAM_STATE_DIR.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Newest file_ids kept per chat. */
export const MAX_LOGGED_ATTACHMENTS = 200;

function logFile(stateDir: string, chatId: string): string {
  return path.join(stateDir, 'attachments', `${chatId.replace(/[^0-9A-Za-z_-]/g, '_')}.json`);
}

function readLog(file: string): string[] {
  try {
    const ids = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function recordChatAttachments(stateDir: string, chatId: string, fileIds: string[]): void {
  if (fileIds.length === 0) return;
  const file = logFile(stateDir, chatId);
  const ids = [...readLog(file).filter((id) => !fileIds.includes(id)), ...fileIds].slice(-MAX_LOGGED_ATTACHMENTS);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Written whole and renamed, so the session never reads half a log.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ids), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function chatHasAttachment(stateDir: string, chatId: string, fileId: string): boolean {
  return readLog(logFile(stateDir, chatId)).includes(fileId);
}
