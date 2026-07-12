/**
 * Discord-specific types. No discord.js imports — pure TypeScript.
 */

export interface DiscordPending {
  senderId: string;
  channelId: string;
  createdAt: number;
  expiresAt: number;
  replies: number;
  // Absent ⇒ 'dm'. A 'guild' entry is a guild knock: guildId holds the server
  // id and approval pushes it into guildAllowlist (mirrors LINE group pairing).
  kind?: 'dm' | 'guild';
  guildId?: string;
}

export interface DiscordAccess {
  dmPolicy: 'open' | 'allowlist' | 'disabled';
  // Orthogonal to dmPolicy (mirrors Telegram): when the base policy is
  // 'allowlist', `pairing: true` means an unknown sender gets a one-time code
  // and lands in pending for the admin to approve; `pairing: false` means
  // they're silently dropped (pure allowlist). Ignored when dmPolicy is
  // 'open'/'disabled'.
  pairing: boolean;
  allowFrom: string[];
  // Guild access tier (mirrors LINE): base policy for guilds + a single
  // requireMention gate. `guildAllowlist` IS the group allowlist. `pairing`
  // governs guild code-minting too. channelAllowlist/roleAllowlist stay
  // backend-only filters.
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  requireMention: boolean;
  guildAllowlist: string[];
  channelAllowlist: string[];
  roleAllowlist: string[];
  pending: Record<string, DiscordPending>;
}

export type DiscordGateResult =
  | { action: 'deliver' }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean; isGuild?: boolean };

export type DiscordConfig = {
  botToken: string;
  guildAllowlist?: string[];
  channelAllowlist?: string[];
  dmPolicy: 'open' | 'allowlist' | 'disabled';
  dmAllowlist?: string[];
  autoThread: boolean;
  autoThreadArchiveMinutes: 60 | 1440 | 4320 | 10080;
  maxMessageLength: number;
  useEmbeds: boolean;
};

export type DiscordMessageContext = {
  guildId: string | null;
  channelId: string;
  threadId: string | null;
  userId: string;
  username: string;
  messageId: string;
  isDM: boolean;
  isThread: boolean;
  // Whether the bot was @mentioned / replied-to. Computed in module.ts so gate()
  // stays discord.js-free. Absent ⇒ treated as not mentioned.
  mentionsBot?: boolean;
};

export type DiscordAccessConfig = {
  dmPolicy: 'open' | 'allowlist' | 'disabled';
  dmAllowlist: string[];
  guildAllowlist: string[];
  channelAllowlist: string[];
  roleAllowlist: string[];
};

/** Minimal interface for a Discord text-based channel send operation. */
export interface SendableChannel {
  send(options: SendOptions): Promise<SentMessage>;
}

export type SendOptions = {
  content?: string;
  embeds?: EmbedData[];
  files?: FileAttachment[];
  reply?: { messageReference: string };
  /** Raw Discord message components (action rows of buttons), passed through to channel.send. */
  components?: unknown[];
};

export type SentMessage = { id: string };

export type EmbedData = { description: string };

export type FileAttachment = { attachment: string; name?: string };

/** Minimal interface for a Discord message (for inbound handler). */
export interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string; bot: boolean };
  system: boolean;
  guild: { id: string } | null;
  guildId: string | null;
  channelId: string;
  channel: {
    isThread(): boolean;
    parentId?: string | null;
  };
  createdTimestamp: number;
  attachments: { first(): { url: string } | undefined };
  client: { user: { id: string } | null };
  startThread(options: { name: string; autoArchiveDuration: number }): Promise<{ id: string }>;
}

export type SlashCommandDef = {
  name: string;
  description: string;
  options?: SlashCommandOption[];
};

export type SlashCommandOption = {
  name: string;
  description: string;
  required: boolean;
  type: 'STRING';
};
