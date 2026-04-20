/**
 * Discord-specific types. No discord.js imports — pure TypeScript.
 */

export interface DiscordPending {
  senderId: string;
  channelId: string;
  createdAt: number;
  expiresAt: number;
  replies: number;
}

export interface DiscordAccess {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled';
  allowFrom: string[];
  guildAllowlist: string[];
  channelAllowlist: string[];
  roleAllowlist: string[];
  pending: Record<string, DiscordPending>;
}

export type DiscordGateResult =
  | { action: 'deliver' }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean };

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
