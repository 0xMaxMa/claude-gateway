/**
 * Discord channel module — implements ChannelModule interface.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { randomBytes } from 'crypto';
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
import { sendMessage } from './outbound';
import { loadAccess, saveAccess, gate } from './access';
import { maybeCreateThread } from './threading';
import { createMessageHandler } from './inbound';
import type { DiscordMessageContext } from './types';

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export class DiscordModule implements ChannelModule {
  id = 'discord' as ChannelId;
  toolVisibility: ToolVisibility = 'current-channel';
  skillsDir = path.join(__dirname, 'skills');

  capabilities: ChannelCapabilities = {
    typingIndicator: false,
    reactions: true,
    editMessage: true,
    fileAttachment: true,
    threadReply: true,
    maxMessageLength: 2000,
    markupFormat: 'markdown',
  };

  private client: any = null;
  private stateDir: string;
  private inboxDir: string;
  private running = false;
  private lastMessageAt?: number;
  private lastError?: string;

  constructor() {
    this.stateDir = process.env.DISCORD_STATE_DIR
      ?? path.join(os.homedir(), '.claude', 'channels', 'discord');
    this.inboxDir = path.join(this.stateDir, 'inbox');
  }

  isEnabled(): boolean {
    return Boolean(this.getToken());
  }

  private getToken(): string | undefined {
    if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
    const envFile = path.join(this.stateDir, '.env');
    try {
      for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^DISCORD_BOT_TOKEN=(.*)$/);
        if (m) return m[1];
      }
    } catch {}
    return undefined;
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'discord_reply',
        description:
          'Send a message to a Discord channel, thread, or DM. Pass channel_id from the inbound message. Optionally pass reply_to (message_id) and files (absolute paths).',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string' },
            text: { type: 'string' },
            reply_to: { type: 'string', description: 'Message ID to reply to.' },
            files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach.' },
            embed: { type: 'boolean', description: 'Use embed for long responses.' },
          },
          required: ['channel_id', 'text'],
        },
      },
      {
        name: 'discord_react',
        description: 'Add an emoji reaction to a Discord message.',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string' },
            message_id: { type: 'string' },
            emoji: { type: 'string' },
          },
          required: ['channel_id', 'message_id', 'emoji'],
        },
      },
      {
        name: 'discord_edit_message',
        description: "Edit a message the bot previously sent.",
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string' },
            message_id: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['channel_id', 'message_id', 'text'],
        },
      },
      {
        name: 'discord_download_attachment',
        description: 'Download a file from a Discord CDN URL to the local inbox.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'CDN URL from attachmentFileId.' },
            filename: { type: 'string', description: 'Optional filename override.' },
          },
          required: ['url'],
        },
      },
      {
        name: 'discord_create_thread',
        description: 'Create a public thread in a Discord channel.',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string' },
            name: { type: 'string', description: 'Thread name (max 100 chars).' },
            message_id: { type: 'string', description: 'Source message to start the thread from.' },
          },
          required: ['channel_id', 'name'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.client) {
      return { content: [{ type: 'text', text: 'Discord client not initialized' }], isError: true };
    }
    try {
      switch (name) {
        case 'discord_reply':    return await this.handleReply(args);
        case 'discord_react':    return await this.handleReact(args);
        case 'discord_edit_message': return await this.handleEditMessage(args);
        case 'discord_download_attachment': return await this.handleDownloadAttachment(args);
        case 'discord_create_thread': return await this.handleCreateThread(args);
        default:
          return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `${name} failed: ${msg}` }], isError: true };
    }
  }

  async initBot(): Promise<void> {
    const token = this.getToken();
    if (!token) throw new Error('DISCORD_BOT_TOKEN not configured');
    const { createDiscordClient } = await import('./client');
    this.client = await createDiscordClient(token);
    this.running = true;
  }

  async start(handler: InboundMessageHandler, signal: AbortSignal): Promise<void> {
    if (!this.client) {
      await this.initBot();
    }

    const autoThread = process.env.DISCORD_AUTO_THREAD === 'true';
    const autoArchive = parseInt(process.env.DISCORD_AUTO_THREAD_ARCHIVE ?? '60', 10);
    const useEmbeds = process.env.DISCORD_USE_EMBEDS === 'true';
    const agentId = process.env.GATEWAY_AGENT_ID ?? 'discord';

    const stateDir = this.stateDir;
    const loadAccessFn = () => loadAccess(stateDir);
    const saveAccessFn = (a: ReturnType<typeof loadAccess>) => saveAccess(stateDir, a);

    // Permissive config — gate() already handled access, inbound.ts skips re-check
    const permissiveConfig = {
      botToken: this.getToken()!,
      dmPolicy: 'open' as const,
      dmAllowlist: [] as string[],
      guildAllowlist: [] as string[],
      channelAllowlist: [] as string[],
      autoThread,
      autoThreadArchiveMinutes: autoArchive as 60 | 1440 | 4320 | 10080,
      maxMessageLength: 2000,
      useEmbeds,
    };

    const permissiveAccessConfig = {
      dmPolicy: 'open' as const,
      dmAllowlist: [] as string[],
      guildAllowlist: [] as string[],
      channelAllowlist: [] as string[],
      roleAllowlist: [] as string[],
    };

    const msgHandler = createMessageHandler(agentId, handler, permissiveConfig, permissiveAccessConfig);

    this.client.on('messageCreate', async (msg: any) => {
      if (msg.author?.bot) return;
      if (msg.system) return;

      this.lastMessageAt = Date.now();

      const isDM = !msg.guild;
      const isThread = msg.channel?.isThread?.() ?? false;

      const context: DiscordMessageContext = {
        guildId: msg.guildId ?? null,
        channelId: msg.channelId,
        threadId: isThread ? msg.channelId : null,
        userId: msg.author.id,
        username: msg.author.username,
        messageId: msg.id,
        isDM,
        isThread,
      };

      const access = loadAccessFn();
      const result = gate(access, context, saveAccessFn, () => randomBytes(3).toString('hex'));

      if (result.action === 'drop') return;

      if (result.action === 'pair') {
        try {
          await msg.channel.send(
            `Pairing required — run in Claude Code:\n\n/discord:access pair ${result.code}`,
          );
        } catch {}
        return;
      }

      // action === 'deliver'
      await msgHandler(msg);
      if (autoThread) {
        await maybeCreateThread(msg, autoThread, autoArchive).catch(() => {});
      }
    });

    const approvedDir = path.join(this.stateDir, 'approved');
    const approvedInterval = setInterval(() => { void this.checkApprovals(approvedDir); }, 5000);
    approvedInterval.unref();

    signal.addEventListener('abort', () => {
      this.running = false;
      clearInterval(approvedInterval);
      this.client?.destroy?.();
    });

    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
  }

  private async checkApprovals(approvedDir: string): Promise<void> {
    let files: string[];
    try { files = fs.readdirSync(approvedDir); } catch { return; }

    for (const userId of files) {
      const file = path.join(approvedDir, userId);
      let channelId: string;
      try { channelId = fs.readFileSync(file, 'utf8').trim(); } catch { continue; }

      try {
        const channel = await this.client.channels.fetch(channelId);
        await channel.send('Paired! Say hi to Claude.');
      } catch {}

      try { fs.unlinkSync(file); } catch {}
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

  private async handleReply(args: Record<string, unknown>): Promise<McpToolResult> {
    const channel = await this.client.channels.fetch(args.channel_id as string);
    const text = args.text as string;
    const replyTo = args.reply_to as string | undefined;
    const files = (args.files as string[] | undefined) ?? [];
    const useEmbed = Boolean(args.embed);

    for (const f of files) {
      const st = fs.statSync(f);
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`);
      }
    }

    const sent = await sendMessage(channel, text, { replyTo, files, useEmbed });
    const ids = sent.map(m => m.id).join(', ');
    return { content: [{ type: 'text', text: `sent (${sent.length === 1 ? `id: ${ids}` : `ids: ${ids}`})` }] };
  }

  private async handleReact(args: Record<string, unknown>): Promise<McpToolResult> {
    const channel = await this.client.channels.fetch(args.channel_id as string);
    const message = await channel.messages.fetch(args.message_id as string);
    await message.react(args.emoji as string);
    return { content: [{ type: 'text', text: 'reacted' }] };
  }

  private async handleEditMessage(args: Record<string, unknown>): Promise<McpToolResult> {
    const channel = await this.client.channels.fetch(args.channel_id as string);
    const message = await channel.messages.fetch(args.message_id as string);
    const edited = await message.edit(args.text as string);
    return { content: [{ type: 'text', text: `edited (id: ${edited.id})` }] };
  }

  private async handleDownloadAttachment(args: Record<string, unknown>): Promise<McpToolResult> {
    const url = args.url as string;
    const filename = (args.filename as string | undefined) ?? path.basename(url.split('?')[0]);
    const ext = path.extname(filename).replace(/[^a-zA-Z0-9.]/g, '') || '.bin';
    const dlPath = path.join(this.inboxDir, `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`);

    fs.mkdirSync(this.inboxDir, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      const proto = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(dlPath);
      proto.get(url, res => {
        if (res.statusCode && res.statusCode >= 400) {
          file.close();
          reject(new Error(`download failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', err => { file.close(); reject(err); });
    });

    return { content: [{ type: 'text', text: dlPath }] };
  }

  private async handleCreateThread(args: Record<string, unknown>): Promise<McpToolResult> {
    const channel = await this.client.channels.fetch(args.channel_id as string);
    const name = (args.name as string).slice(0, 100);
    let thread: any;
    if (args.message_id) {
      const message = await channel.messages.fetch(args.message_id as string);
      thread = await message.startThread({ name, autoArchiveDuration: 60 });
    } else {
      thread = await channel.threads.create({ name, autoArchiveDuration: 60 });
    }
    return { content: [{ type: 'text', text: `thread created (id: ${thread.id})` }] };
  }
}
