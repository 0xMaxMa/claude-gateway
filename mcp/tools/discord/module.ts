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
  InboundMessage,
  ChannelId,
} from '../../types';
import { sendMessage, buildChoiceComponents } from './outbound';
import { loadAccess, saveAccess, gate } from './access';
import { maybeCreateThread } from './threading';
import { createMessageHandler } from './inbound';
// Cross-process message dedup (shared with Telegram): when more than one
// receiver instance is connected on the same bot token — Discord's gateway
// delivers every event to all sessions, unlike Telegram's single-consumer
// getUpdates — the first instance to claim (channelId, messageId) processes it;
// the others see the O_EXCL marker and drop, so a stranger's DM is handled once.
import { initDedupDir, isDuplicate, pruneDedup } from '../telegram/dedup';
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
  // Files already delivered this session. Small models sometimes retry
  // discord_reply after a transient send hiccup even though the upload
  // succeeded, which spams duplicate images. We never re-send the same file.
  private readonly sentFiles = new Set<string>();

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

    // Dedup dir shared by every receiver instance on this bot token (same
    // DISCORD_STATE_DIR). Init once here, prune stale markers on a timer —
    // mirrors the Telegram receiver's setup.
    const dedupDir = path.join(stateDir, 'dedup');
    initDedupDir(dedupDir);
    pruneDedup(dedupDir);
    setInterval(() => pruneDedup(dedupDir), 60_000).unref();

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

    const handleDiscordMessage = async (msg: any): Promise<void> => {
      if (msg.author?.bot) return;
      if (msg.system) return;

      // Drop if another receiver instance already claimed this message. Must run
      // before gate() so a duplicate never mints a pairing code or replies twice.
      if (isDuplicate(dedupDir, msg.channelId, msg.id)) return;

      this.lastMessageAt = Date.now();

      const isDM = !msg.guild;
      const isThread = msg.channel?.isThread?.() ?? false;
      // Did this message @mention the bot (or reply to one of its messages)?
      // Computed here so gate() stays discord.js-free. Works regardless of the
      // MessageContent intent — mention entities are always delivered.
      const botUser = this.client.user;
      const mentionsBot = Boolean(botUser && msg.mentions?.has?.(botUser))
        || (!!botUser && msg.mentions?.repliedUser?.id === botUser.id);

      const context: DiscordMessageContext = {
        guildId: msg.guildId ?? null,
        channelId: msg.channelId,
        threadId: isThread ? msg.channelId : null,
        userId: msg.author.id,
        username: msg.author.username,
        messageId: msg.id,
        isDM,
        isThread,
        mentionsBot,
      };

      const access = loadAccessFn();
      const result = gate(access, context, saveAccessFn, () => randomBytes(3).toString('hex'));

      if (result.action === 'drop') return;

      if (result.action === 'pair') {
        try {
          if (result.isGuild) {
            // LINE-style guild knock: post the code in the channel so a member
            // can relay it to the admin, who approves it from the web UI. The
            // user runs no command — a guild has no single owner to run one.
            await msg.channel.send(
              `This bot is private in this server.\n\nPairing code: ${result.code}\n\nShare this code with an admin to enable me here.`,
            );
          } else {
            await msg.channel.send(
              `Pairing required — run in Claude Code:\n\n/discord:access pair ${result.code}`,
            );
          }
        } catch {}
        return;
      }

      // action === 'deliver'
      // Start typing indicator before handing off to runner
      const channelId = context.channelId;
      const typingFileDir = path.join(this.stateDir, 'typing');
      try {
        fs.mkdirSync(typingFileDir, { recursive: true });
        fs.writeFileSync(path.join(typingFileDir, channelId), '');
        await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
          method: 'POST',
          headers: { Authorization: `Bot ${this.getToken()!}`, 'Content-Length': '0' },
        });
      } catch {}

      await msgHandler(msg);
      if (autoThread) {
        await maybeCreateThread(msg, autoThread, autoArchive).catch(() => {});
      }
    };

    this.client.on('messageCreate', handleDiscordMessage);

    // discord.js's own MESSAGE_CREATE handling resolves msg.channel from its
    // in-memory cache; DM channels are never included in the initial
    // GUILD_CREATE/READY payload, so the *first* DM after every process
    // restart hits an uncached channel. MessageCreateAction's partial-channel
    // fallback constructs the stub without a `type` field (it only forwards
    // {id, author, guild_id}), so ChannelManager#_add can't pick a Channel
    // subclass, logs "Failed to find guild, or unknown type for channel ...
    // undefined", and silently drops the event — messageCreate never fires,
    // no error, no pairing code. Every subsequent DM in that channel fails
    // the same way since the failed resolution never populates the cache.
    // Work around it: on the raw MESSAGE_CREATE dispatch, if it's a DM whose
    // channel isn't cached yet, fetch the channel (and the message) via REST
    // — a real API response includes `type`, so this caches it properly —
    // then hand the fully-formed Message object to the same handler used by
    // the normal path. isDuplicate() above ensures no double-processing if
    // discord.js's own path ever does resolve it first.
    this.client.on('raw', async (packet: { t?: string; d?: any }) => {
      if (packet.t !== 'MESSAGE_CREATE') return;
      const d = packet.d;
      if (!d || d.guild_id || d.author?.bot) return;
      if (this.client.channels.cache.has(d.channel_id)) return;
      try {
        const channel = await this.client.channels.fetch(d.channel_id);
        if (!channel) return;
        const msg = await channel.messages.fetch(d.id);
        await handleDiscordMessage(msg);
      } catch (err) {
        process.stderr.write(`discord: raw DM fallback failed: ${err}\n`);
      }
    });

    // Interactive-menu button clicks: custom_id `choice:N`. A click is routed
    // exactly like the user typing "N" (same InboundMessage → handler), so the
    // session's pending-menu handler injects the selection into the PTY.
    // Security mirrors the message path: the access gate must return 'deliver'.
    // discord.js client is typed as `any` (dynamic import) so we narrow locally.
    interface ButtonInteraction {
      isButton?: () => boolean;
      customId?: string;
      guildId?: string | null;
      channelId: string;
      channel?: { isThread?: () => boolean };
      user: { id: string; username: string };
      message?: { id: string };
      client: { user?: { id: string } };
      reply(opts: { content: string; ephemeral: boolean }): Promise<unknown>;
      update(opts: { components: unknown[] }): Promise<unknown>;
    }
    this.client.on('interactionCreate', async (interaction: ButtonInteraction) => {
      try {
        if (!interaction.isButton?.()) return;

        // Cancel button: send ESC sentinel to dismiss the pending menu cleanly.
        if ((interaction.customId ?? '') === 'menu:cancel') {
          const isDM = !interaction.guildId;
          const isThread = interaction.channel?.isThread?.() ?? false;
          const context: DiscordMessageContext = {
            guildId: interaction.guildId ?? null,
            channelId: interaction.channelId,
            threadId: isThread ? interaction.channelId : null,
            userId: interaction.user.id,
            username: interaction.user.username,
            messageId: interaction.message?.id ?? '',
            isDM,
            isThread,
            // A button click is an explicit interaction — never mention-gated.
            mentionsBot: true,
          };
          const access = loadAccessFn();
          const result = gate(access, context, saveAccessFn, () => randomBytes(3).toString('hex'));
          if (result.action !== 'deliver') {
            await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {});
            return;
          }
          await interaction.update({ components: [] }).catch(() => {});
          const inbound: InboundMessage = {
            channel: 'discord',
            accountId: interaction.client.user?.id ?? 'discord',
            senderId: interaction.user.id,
            chatId: interaction.channelId,
            chatType: isDM ? 'direct' : 'group',
            text: '__MENU_CANCEL__',
            messageId: interaction.message?.id ?? '',
            ts: Date.now(),
          };
          await handler(inbound);
          return;
        }

        const m = /^choice:(\d+)$/.exec(interaction.customId ?? '');
        if (!m) return;

        const isDM = !interaction.guildId;
        const isThread = interaction.channel?.isThread?.() ?? false;
        const context: DiscordMessageContext = {
          guildId: interaction.guildId ?? null,
          channelId: interaction.channelId,
          threadId: isThread ? interaction.channelId : null,
          userId: interaction.user.id,
          username: interaction.user.username,
          messageId: interaction.message?.id ?? '',
          isDM,
          isThread,
          // A button click is an explicit interaction — never mention-gated.
          mentionsBot: true,
        };
        const access = loadAccessFn();
        const result = gate(access, context, saveAccessFn, () => randomBytes(3).toString('hex'));
        if (result.action !== 'deliver') {
          await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {});
          return;
        }

        // Disable the buttons (acknowledges the click + prevents double-selection).
        await interaction.update({ components: [] }).catch(() => {});

        const channelId = interaction.channelId;
        const typingFileDir = path.join(this.stateDir, 'typing');
        try {
          fs.mkdirSync(typingFileDir, { recursive: true });
          fs.writeFileSync(path.join(typingFileDir, channelId), '');
        } catch {}

        const inbound: InboundMessage = {
          channel: 'discord',
          accountId: interaction.client.user?.id ?? 'discord',
          senderId: interaction.user.id,
          chatId: channelId,
          chatType: isDM ? 'direct' : 'group',
          text: m[1],
          messageId: interaction.message?.id ?? '',
          ts: Date.now(),
        };
        await handler(inbound);
      } catch (err) {
        process.stderr.write(`discord: interaction handler error: ${err}\n`);
      }
    });

    const approvedDir = path.join(this.stateDir, 'approved');
    const approvedInterval = setInterval(() => { void this.checkApprovals(approvedDir); }, 5000);
    approvedInterval.unref();

    const typingDir = path.join(this.stateDir, 'typing');
    const forwardInterval = setInterval(() => { void this.processForwardFiles(typingDir); }, 1000);
    forwardInterval.unref();

    // Send typing indicator every 8s for all active channels (Discord typing lasts ~10s)
    const typingInterval = setInterval(() => { void this.processTypingSignals(typingDir, this.getToken()!); }, 8000);
    typingInterval.unref();

    signal.addEventListener('abort', () => {
      this.running = false;
      clearInterval(approvedInterval);
      clearInterval(forwardInterval);
      clearInterval(typingInterval);
      this.client?.destroy?.();
    });

    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
  }

  private async processForwardFiles(typingDir: string): Promise<void> {
    let files: string[];
    try { files = fs.readdirSync(typingDir); } catch { return; }

    for (const file of files) {
      // Interactive menu: render the question with Secondary buttons. Each click
      // routes back as a normal "N" message (see the interactionCreate handler).
      if (file.endsWith('.menu')) {
        const filePath = path.join(typingDir, file);
        const channelId = file.slice(0, -'.menu'.length);
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').trim()) as {
            text: string;
            options: Array<{ label: string }>;
          };
          fs.rmSync(filePath, { force: true });
          if (parsed.text && Array.isArray(parsed.options) && parsed.options.length) {
            const channel = await this.client.channels.fetch(channelId);
            await sendMessage(channel, parsed.text, { components: buildChoiceComponents(parsed.options) });
          }
        } catch { /* non-fatal — result text carries the numbered list as fallback */ }
        continue;
      }
      if (!file.endsWith('.forward')) continue;
      const filePath = path.join(typingDir, file);
      const channelId = file.slice(0, -'.forward'.length);
      let text: string;
      let parseMode: undefined | 'html';
      try {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        try {
          const parsed = JSON.parse(raw) as { text: string; format: string };
          text = parsed.text;
          parseMode = parsed.format === 'html' ? 'html' : undefined;
        } catch {
          text = raw;
        }
        fs.rmSync(filePath, { force: true });
      } catch { continue; }

      if (!text) continue;
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (parseMode === 'html') {
          // Discord doesn't support HTML — strip tags and send plain text
          text = text.replace(/<[^>]*>/g, '');
        }
        await sendMessage(channel, text, {});
      } catch { /* non-fatal */ }
    }
  }

  private async processTypingSignals(typingDir: string, token: string): Promise<void> {
    let files: string[];
    try { files = fs.readdirSync(typingDir); } catch { return; }

    for (const file of files) {
      // Only act on plain files (no extension) — these are active typing channels
      if (file.includes('.')) continue;
      const channelId = file;
      const errorFile = path.join(typingDir, `${channelId}.error`);
      if (fs.existsSync(errorFile)) {
        // Error signalled by runner — clean up both files and stop typing
        try { fs.rmSync(path.join(typingDir, channelId), { force: true }); } catch {}
        try { fs.rmSync(errorFile, { force: true }); } catch {}
        continue;
      }
      try {
        await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
          method: 'POST',
          headers: { Authorization: `Bot ${this.getToken()!}`, 'Content-Length': '0' },
        });
      } catch {}
    }
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
        await channel.send("You're connected! Send me a message to get started.");
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
    const requested = (args.files as string[] | undefined) ?? [];
    const useEmbed = Boolean(args.embed);

    // Drop files already delivered successfully this session (retry-dedup): a small
    // model sometimes retries discord_reply after a transient hiccup even though the
    // upload landed, which would spam duplicate images.
    const files = requested.filter((f) => typeof f === 'string' && !this.sentFiles.has(f));

    // Nothing new to say or send — the whole reply is a duplicate. No-op success
    // so the agent treats it as delivered and stops retrying.
    if (!text && files.length === 0 && requested.length > 0) {
      return { content: [{ type: 'text', text: 'already sent (duplicate suppressed)' }] };
    }

    for (const f of files) {
      const st = fs.statSync(f);
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`);
      }
    }

    const sent = await sendMessage(channel, text, { replyTo, files, useEmbed });
    // Mark as sent only AFTER the send succeeds — if sendMessage throws, the files
    // stay un-marked so a genuine retry re-delivers them (never silently dropped).
    for (const f of files) this.sentFiles.add(f);
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
