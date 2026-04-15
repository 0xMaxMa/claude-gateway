/**
 * Telegram channel module — implements ChannelModule interface.
 * Wraps the existing Telegram bot logic with prefixed tool names.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type {
  ChannelModule,
  ChannelCapabilities,
  ChannelAccountSnapshot,
  McpToolDefinition,
  McpToolResult,
  ToolVisibility,
  InboundMessageHandler,
  ChannelId,
} from '../../types';

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_CHUNK_LIMIT = 4096;

export class TelegramModule implements ChannelModule {
  id = 'telegram' as ChannelId;
  toolVisibility: ToolVisibility = 'current-channel';
  skillsDir = path.join(__dirname, 'skills');

  capabilities: ChannelCapabilities = {
    typingIndicator: true,
    reactions: true,
    editMessage: true,
    fileAttachment: true,
    threadReply: true,
    maxMessageLength: 4096,
    markupFormat: 'html',
  };

  private bot: any = null;
  private botUsername = '';
  private stateDir: string;
  private inboxDir: string;
  private typingDir: string;
  private running = false;
  private lastMessageAt?: number;
  private lastError?: string;
  private _hasMarkdown?: (text: string) => boolean;
  private _toTelegramHtml?: (text: string) => string;
  private _InputFile?: any;
  private _typingManager?: any;

  constructor() {
    this.stateDir = process.env.TELEGRAM_STATE_DIR
      ?? path.join(os.homedir(), '.claude', 'channels', 'telegram');
    this.inboxDir = path.join(this.stateDir, 'inbox');
    this.typingDir = path.join(this.stateDir, 'typing');
  }

  isEnabled(): boolean {
    return Boolean(this.getToken());
  }

  private getToken(): string | undefined {
    if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
    // Standalone fallback: read from .env file
    const envFile = path.join(this.stateDir, '.env');
    try {
      for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^TELEGRAM_BOT_TOKEN=(.*)$/);
        if (m) return m[1];
      }
    } catch {}
    return undefined;
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'telegram_reply',
        description:
          'Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            text: { type: 'string' },
            reply_to: {
              type: 'string',
              description: 'Message ID to thread under. Use message_id from the inbound <channel> block.',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each.',
            },
            format: {
              type: 'string',
              enum: ['text', 'html'],
              description: "Rendering mode. 'html' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per HTML rules (&amp; &lt; &gt;). Default: 'text' (plain, no escaping needed).",
            },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'telegram_react',
        description: 'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string' },
            emoji: { type: 'string' },
          },
          required: ['chat_id', 'message_id', 'emoji'],
        },
      },
      {
        name: 'telegram_download_attachment',
        description: 'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
          },
          required: ['file_id'],
        },
      },
      {
        name: 'telegram_edit_message',
        description: "Edit a message the bot previously sent. Useful for interim progress updates. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings.",
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string' },
            text: { type: 'string' },
            format: {
              type: 'string',
              enum: ['text', 'html'],
              description: "Rendering mode. 'html' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per HTML rules (&amp; &lt; &gt;). Default: 'text' (plain, no escaping needed).",
            },
          },
          required: ['chat_id', 'message_id', 'text'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.bot) {
      return { content: [{ type: 'text', text: 'Telegram bot not initialized' }], isError: true };
    }

    try {
      switch (name) {
        case 'telegram_reply':
          return await this.handleReply(args);
        case 'telegram_react':
          return await this.handleReact(args);
        case 'telegram_download_attachment':
          return await this.handleDownload(args);
        case 'telegram_edit_message':
          return await this.handleEditMessage(args);
        default:
          return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `${name} failed: ${msg}` }], isError: true };
    }
  }

  /**
   * Initialize bot and tool helpers. Called by server.ts before MCP connect
   * to ensure tools work immediately. Does NOT start polling or block.
   */
  async initBot(): Promise<void> {
    const token = this.getToken();
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');

    // Dynamic import grammy (only available in bun runtime)
    // @ts-ignore — grammy is installed in plugin's node_modules, not root
    const { Bot, InputFile } = await import('grammy');
    this.bot = new Bot(token, {
      client: { apiRoot: process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org' },
    });

    // Import pure functions and typing manager
    const { hasMarkdown, toTelegramHtml } = await import('./pure');
    const { createWorkingStateManager } = await import('./typing');

    const typingManager = createWorkingStateManager(
      this.typingDir,
      {
        sendChatAction: (chatId: string, action: string) => this.bot.api.sendChatAction(chatId, action),
        sendMessage: (chatId: string, text: string, opts?: any) => this.bot.api.sendMessage(chatId, text, opts),
        editMessageText: (chatId: string, msgId: number, text: string) => this.bot.api.editMessageText(chatId, msgId, text),
        deleteMessage: (chatId: string, msgId: number) => this.bot.api.deleteMessage(chatId, msgId),
        setMessageReaction: (chatId: string, msgId: number, emoji: string) =>
          this.bot.api.setMessageReaction(chatId, msgId, [
            { type: 'emoji', emoji },
          ]),
      },
      { ...fs },
    );

    this._hasMarkdown = hasMarkdown;
    this._toTelegramHtml = toTelegramHtml;
    this._InputFile = InputFile;
    this._typingManager = typingManager;

    this.running = true;
  }

  async start(handler: InboundMessageHandler, signal: AbortSignal): Promise<void> {
    if (!this.bot) {
      await this.initBot();
    }

    const SEND_ONLY = process.env.TELEGRAM_SEND_ONLY === 'true';

    // Handle abort signal
    signal.addEventListener('abort', () => {
      this.running = false;
      void Promise.resolve(this.bot.stop()).catch(() => {});
    });

    // @ts-ignore — GrammyError needed for polling
    const { GrammyError } = await import('grammy');

    if (SEND_ONLY) {
      // In SEND_ONLY mode, just keep alive — no polling
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve());
      });
    } else {
      await this.startPolling(GrammyError);
    }
  }

  getSnapshot(): ChannelAccountSnapshot {
    return {
      accountId: this.id,
      running: this.running,
      configured: this.isEnabled(),
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
    };
  }

  // --- Private helpers ---

  private readAccessFile(): any {
    const accessFile = path.join(this.stateDir, 'access.json');
    try {
      const raw = fs.readFileSync(accessFile, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        dmPolicy: parsed.dmPolicy ?? 'pairing',
        allowFrom: parsed.allowFrom ?? [],
        groups: parsed.groups ?? {},
        pending: parsed.pending ?? {},
        mentionPatterns: parsed.mentionPatterns,
        ackReaction: parsed.ackReaction,
        replyToMode: parsed.replyToMode,
        textChunkLimit: parsed.textChunkLimit,
        chunkMode: parsed.chunkMode,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} };
      }
      return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} };
    }
  }

  private assertAllowedChat(chat_id: string): void {
    const access = this.readAccessFile();
    if (access.allowFrom.includes(chat_id)) return;
    if (chat_id in access.groups) return;
    throw new Error(`chat ${chat_id} is not allowlisted`);
  }

  private assertSendable(f: string): void {
    let real: string, stateReal: string;
    try {
      real = fs.realpathSync(f);
      stateReal = fs.realpathSync(this.stateDir);
    } catch { return; }
    const inbox = path.join(stateReal, 'inbox');
    if (real.startsWith(stateReal + path.sep) && !real.startsWith(inbox + path.sep)) {
      throw new Error(`refusing to send channel state: ${f}`);
    }
  }

  private chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
    if (text.length <= limit) return [text];
    const out: string[] = [];
    let rest = text;
    while (rest.length > limit) {
      let cut = limit;
      if (mode === 'newline') {
        const para = rest.lastIndexOf('\n\n', limit);
        const line = rest.lastIndexOf('\n', limit);
        const space = rest.lastIndexOf(' ', limit);
        cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
      }
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n+/, '');
    }
    if (rest) out.push(rest);
    return out;
  }

  private async handleReply(args: Record<string, unknown>): Promise<McpToolResult> {
    const chat_id = args.chat_id as string;
    const text = args.text as string;
    const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined;
    const files = (args.files as string[] | undefined) ?? [];
    const explicitFormat = args.format as string | undefined;

    const hasMarkdown = this._hasMarkdown!;
    const toTelegramHtml = this._toTelegramHtml!;
    const InputFile = this._InputFile;

    const useHtml = explicitFormat === 'html' || (!explicitFormat && hasMarkdown(text));
    const sendText = useHtml && !explicitFormat ? toTelegramHtml(text) : text;
    const parseMode = useHtml ? 'HTML' as const : undefined;

    this.assertAllowedChat(chat_id);

    for (const f of files) {
      this.assertSendable(f);
      const st = fs.statSync(f);
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`);
      }
    }

    const access = this.readAccessFile();
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT));
    const mode = access.chunkMode ?? 'length';
    const replyMode = access.replyToMode ?? 'first';
    const chunks = this.chunk(sendText, limit, mode);
    const sentIds: number[] = [];

    try {
      for (let i = 0; i < chunks.length; i++) {
        const shouldReplyTo =
          reply_to != null &&
          replyMode !== 'off' &&
          (replyMode === 'all' || i === 0);
        const sent = await this.bot.api.sendMessage(chat_id, chunks[i], {
          ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
          ...(parseMode ? { parse_mode: parseMode } : {}),
        });
        sentIds.push(sent.message_id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`);
    }

    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      const input = new InputFile(f);
      const opts = reply_to != null && replyMode !== 'off'
        ? { reply_parameters: { message_id: reply_to } }
        : undefined;
      if (PHOTO_EXTS.has(ext)) {
        const sent = await this.bot.api.sendPhoto(chat_id, input, opts);
        sentIds.push(sent.message_id);
      } else {
        const sent = await this.bot.api.sendDocument(chat_id, input, opts);
        sentIds.push(sent.message_id);
      }
    }

    // Write .replied marker
    try {
      fs.mkdirSync(this.typingDir, { recursive: true });
      fs.writeFileSync(path.join(this.typingDir, `${chat_id}.replied`), sendText);
    } catch {}

    const result = sentIds.length === 1
      ? `sent (id: ${sentIds[0]})`
      : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`;

    return { content: [{ type: 'text', text: result }] };
  }

  private async handleReact(args: Record<string, unknown>): Promise<McpToolResult> {
    this.assertAllowedChat(args.chat_id as string);
    await this.bot.api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
      { type: 'emoji', emoji: args.emoji },
    ]);
    return { content: [{ type: 'text', text: 'reacted' }] };
  }

  private async handleDownload(args: Record<string, unknown>): Promise<McpToolResult> {
    const file_id = args.file_id as string;
    const token = this.getToken()!;
    const file = await this.bot.api.getFile(file_id);
    if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired');
    const apiRoot = process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org';
    const url = `${apiRoot}/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin';
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
    const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl';
    const dlPath = path.join(this.inboxDir, `${Date.now()}-${uniqueId}.${ext}`);
    fs.mkdirSync(this.inboxDir, { recursive: true });
    fs.writeFileSync(dlPath, buf);
    return { content: [{ type: 'text', text: dlPath }] };
  }

  private async handleEditMessage(args: Record<string, unknown>): Promise<McpToolResult> {
    this.assertAllowedChat(args.chat_id as string);
    const editFormat = (args.format as string | undefined) ?? 'text';
    const editParseMode = editFormat === 'html' ? 'HTML' as const : undefined;
    const edited = await this.bot.api.editMessageText(
      args.chat_id as string,
      Number(args.message_id),
      args.text as string,
      ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
    );
    const id = typeof edited === 'object' ? edited.message_id : args.message_id;
    return { content: [{ type: 'text', text: `edited (id: ${id})` }] };
  }

  private async startPolling(GrammyError: any): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.bot.start({
          onStart: (info: any) => {
            this.botUsername = info.username;
          },
        });
        return;
      } catch (err: any) {
        if (err instanceof GrammyError && err.error_code === 409) {
          const delay = Math.min(1000 * attempt, 15000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (err instanceof Error && err.message === 'Aborted delay') return;
        throw err;
      }
    }
  }
}
