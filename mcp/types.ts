/**
 * Shared types for the gateway multi-channel architecture.
 * Adopts openclaw patterns: ChannelModule interface, ToolVisibility, Route Resolution.
 */

export type ChannelId = string;

export type InboundMessage = {
  channel: ChannelId;
  accountId: string;
  senderId: string;
  chatId: string;
  chatType: 'direct' | 'group' | 'channel';
  text: string;
  messageId: string;
  replyToMessageId?: string;
  threadId?: string;
  attachmentFileId?: string;
  attachmentSize?: number;
  ts: number;
};

export type OutboundMessage = {
  channel: ChannelId;
  accountId: string;
  chatId: string;
  text: string;
  replyToMessageId?: string;
  files?: string[];
  format?: 'text' | 'html' | 'markdown';
};

export type ChannelCapabilities = {
  typingIndicator: boolean;
  reactions: boolean;
  editMessage: boolean;
  fileAttachment: boolean;
  threadReply: boolean;
  maxMessageLength: number;
  markupFormat: 'html' | 'markdown' | 'none';
};

export type ChannelAccountSnapshot = {
  accountId: string;
  running: boolean;
  configured: boolean;
  lastMessageAt?: number;
  lastError?: string;
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: object;
};

export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * ToolVisibility: openclaw pattern
 * "current-channel" — expose tools only when this channel is the origin
 * "all-configured"  — expose tools always (cross-channel sends, cron)
 */
export type ToolVisibility = 'current-channel' | 'all-configured';

/** Chat channel module — receives and sends messages */
export interface ChannelModule {
  id: ChannelId;
  capabilities: ChannelCapabilities;
  toolVisibility: ToolVisibility;

  /** Check whether this module is configured and enabled */
  isEnabled(): boolean;

  /** MCP tools exposed by this module */
  getTools(): McpToolDefinition[];

  /** Execute a tool call */
  handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;

  /** Initialize bot client for tool calls (non-blocking) */
  initBot?(): Promise<void>;

  /** Start listening for inbound messages */
  start(handler: InboundMessageHandler, signal: AbortSignal): Promise<void>;

  /** Runtime status snapshot */
  getSnapshot(): ChannelAccountSnapshot;

  /** Skills directory path */
  skillsDir?: string;
}

/** Tool-only module — no inbound messages (e.g. cron) */
export interface ToolModule {
  id: string;
  toolVisibility: ToolVisibility;
  isEnabled(): boolean;
  getTools(): McpToolDefinition[];
  handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  skillsDir?: string;
}

export type InboundMessageHandler = (msg: InboundMessage) => Promise<void>;

/** Route resolution result — openclaw ResolvedAgentRoute */
export type ResolvedRoute = {
  agentId: string;
  channel: ChannelId;
  accountId: string;
  sessionKey: string;
  chatId: string;
  chatType: 'direct' | 'group' | 'channel';
  senderId: string;
};

/** Channel context injected into agent system prompt */
export type ChannelContext = {
  origin: {
    channel: ChannelId;
    chatId: string;
    senderId: string;
    chatType: 'direct' | 'group' | 'channel';
  };
  configuredChannels: ChannelId[];
};
