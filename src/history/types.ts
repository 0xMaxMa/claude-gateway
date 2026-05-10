export type HistorySource = 'telegram' | 'discord' | 'api' | 'ui';
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
  sessionId?: string;
}

export interface SearchOpts {
  limit?: number;
  offset?: number;
}
