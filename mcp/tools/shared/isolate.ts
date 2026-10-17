/**
 * Isolate-mode policy for the gateway MCP server (#609). In isolate mode
 * (GATEWAY_ISOLATE_MEMORY non-empty) one agent serves many unrelated end users
 * and one conversation is (channel, chatId), so every tool must stay inside the
 * conversation that spawned this server. Outside isolate mode every helper here
 * is a no-op.
 *
 * Self-contained on purpose, like share-client.ts: mcp/** ships as source
 * without src/** (see tests/unit/mcp-no-src-imports.test.ts).
 */
import * as fs from 'fs';
import * as path from 'path';

/** Non-channel modules that are safe per conversation. Everything else is off.
 * `narrate` only speaks through the task bridge into the task's own conversation. */
export const ISOLATE_SAFE_MODULES: ReadonlySet<string> = new Set(['image', 'video', 'share-file', 'narrate']);

export function isolateMode(): boolean {
  return Boolean(process.env.GATEWAY_ISOLATE_MEMORY);
}

/**
 * Default-deny module allowlist. In isolate mode only the originating channel's
 * module (never every channel when the origin is unknown), plus the
 * per-conversation-safe modules above, may load.
 */
export function isolateAllowsModule(id: string): boolean {
  if (!isolateMode()) return true;
  const origin = process.env.GATEWAY_ORIGIN_CHANNEL ?? '';
  return (origin !== '' && id === origin) || ISOLATE_SAFE_MODULES.has(id);
}

/**
 * Origin-chat lock: in isolate mode a tool may only act on this conversation's
 * own chat. `parentId` lets a thread whose parent is the origin chat through
 * (Discord threads started from the conversation's channel).
 */
export function assertOriginChat(chatId: string, parentId?: string | null): void {
  if (!isolateMode()) return;
  const origin = process.env.GATEWAY_ORIGIN_CHAT_ID ?? '';
  if (!origin) throw new Error('isolate mode: the originating chat is unknown, so chat tools are disabled');
  if (chatId === origin || (parentId != null && parentId === origin)) return;
  throw new Error('isolate mode: this conversation can only reply to its own chat');
}

/** This session's own media dir; isolate mode fails closed without one. */
export function isolateMediaDir(): string {
  const dir = process.env.GATEWAY_SESSION_MEDIA_DIR ?? '';
  if (!dir) throw new Error('isolate mode: no session media directory, so file attachments are disabled');
  return dir;
}

/**
 * In isolate mode a local file a tool sends or shares must realpath-resolve
 * inside this session's media dir. A relative path is media-root relative
 * ("media/<chat>/x.png" or "<chat>/x.png"), the form the share route accepts;
 * the agent media root is the session media dir's parent.
 */
export function assertIsolateMediaPath(file: string): void {
  if (!isolateMode()) return;
  const dir = isolateMediaDir();
  const abs = path.isAbsolute(file)
    ? file
    : path.resolve(path.dirname(dir), file.startsWith('media/') ? file.slice('media/'.length) : file);
  let real: string;
  let dirReal: string;
  try {
    real = fs.realpathSync(abs);
    dirReal = fs.realpathSync(dir);
  } catch {
    throw new Error(`isolate mode: file not found in this conversation's media directory: ${file}`);
  }
  if (!real.startsWith(dirReal + path.sep)) {
    throw new Error(`isolate mode: file is outside this conversation's media directory: ${file}`);
  }
}
