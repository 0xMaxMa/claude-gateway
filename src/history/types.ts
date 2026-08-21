/**
 * Canonical channel list — the SINGLE source of truth for the
 * 'telegram' | 'discord' | 'line' | 'slack' union that used to be
 * hand-copied into ~10 files (session/process.ts, agent/runner.ts,
 * api/router.ts, session/compactor.ts, agent/builtin-commands.ts,
 * cli-viewer/pairing-store.ts, ui/cli-viewer-ui.ts, ...).
 *
 * That duplication is exactly what caused three real bugs when Slack was
 * added: a channelSource ternary with no 'slack' branch (every Slack
 * session silently became 'telegram'), a replyToolName ternary with the
 * same gap, and an isCliChannel() runtime guard whose type was widened to
 * include 'slack' but whose implementation wasn't. Deriving both the type
 * AND a runtime guard from one array makes that specific failure mode
 * (type says X is valid, some hand-copied runtime check disagrees)
 * impossible to reintroduce for this union — adding a channel here updates
 * every consumer's type AND its guard in one place.
 */
export const CHAT_CHANNELS = ['telegram', 'discord', 'line', 'slack'] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];
export function isChatChannel(value: unknown): value is ChatChannel {
  return typeof value === 'string' && (CHAT_CHANNELS as readonly string[]).includes(value);
}

/** ChatChannel plus 'api' — a session spawned via direct API access, not a channel. */
export type ChatChannelOrApi = ChatChannel | 'api';
export type HistorySource = ChatChannelOrApi | 'ui';

/**
 * Normalize a ChatChannelOrApi down to a live ChatChannel — 'api' (not a real
 * channel) falls back to 'telegram', matching this codebase's long-standing
 * default for channel-scoped state paths (session/process.ts's stateSubDir).
 */
export function toChatChannel(source: ChatChannelOrApi): ChatChannel {
  return isChatChannel(source) ? source : 'telegram';
}
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
  /** Catalog refs (`artifact:<id>` or media-root-relative path) this user turn
   *  explicitly referenced via image_params.image_refs (#74). Display-only:
   *  the UI joins them against the session image catalog to show which earlier
   *  images the message pointed at. Never used for generation replay. */
  imageRefs?: string[];
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
