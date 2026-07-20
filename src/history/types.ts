export type HistorySource = 'telegram' | 'discord' | 'line' | 'api' | 'ui';
export type MessageRole = 'user' | 'assistant' | 'system';

export interface HistoryMessage {
  id?: number;
  chatId: string;
  sessionId: string;
  source: HistorySource;
  role: MessageRole;
  content: string;
  senderName?: string;
  senderId?: string;
  platformMessageId?: string;
  mediaFiles?: string[];
  ts: number;
}

export interface MessagePage {
  messages: HistoryMessage[];
  hasMore: boolean;
  nextCursor: number | null;
  // Row id of the boundary message, paired with nextCursor (ts). Pass both back as
  // before_id/after_id to page across a run of equal-ts messages without skipping the
  // tied remainder. null whenever nextCursor is null. See PaginationOpts.beforeId.
  nextCursorId: number | null;
}

export interface SearchResult extends HistoryMessage {
  snippet: string;
}

export interface SearchPage {
  results: SearchResult[];
  total: number;
  hasMore: boolean;
}

export interface ChatSummary {
  chatId: string;
  source: HistorySource;
  displayName: string | null;
  messageCount: number;
  lastActive: number;
  lastMessagePreview: string | null;
}

export interface PaginationOpts {
  limit?: number;
  before?: number;
  after?: number;
  // Optional id component of the cursor, paired with before/after (ts). When supplied,
  // the boundary is matched as a composite (ts, id) tuple so a page edge landing between
  // messages that share a ts no longer skips the tied remainder. Ignored unless its
  // matching before/after is also set. Omitting it preserves the legacy ts-only behavior.
  beforeId?: number;
  afterId?: number;
  sessionId?: string;
  order?: 'asc' | 'desc'; // default 'desc' (reverse-chronological)
}

export interface SearchOpts {
  limit?: number;
  offset?: number;
}

export interface ActiveDaysOpts {
  from: number; // UTC ms, inclusive (ts >= from)
  to: number; // UTC ms, exclusive (ts < to)
  tzOffset?: number; // minutes EAST of UTC (local = UTC + offset); Bangkok = +420; default 0 (UTC)
  sessionId?: string;
}

export interface SessionSummary {
  chatId: string | null;
  sessionId: string;
  source: HistorySource;
  messageCount: number;
  createdAt: number;
  lastActivity: number;
  lastMessage: string | null;
  lastMessageRole: MessageRole | null;
  sessionName: string | null;
}

export interface AgentSessionSummary {
  agentId: string;
  description: string;
  sessions: SessionSummary[];
}
