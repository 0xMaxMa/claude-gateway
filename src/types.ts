export interface SessionConfig {
  idleTimeoutMinutes?: number; // default 30
  maxConcurrent?: number; // default 20
}

export interface HistoryConfig {
  retentionDays?: number; // 0 = keep forever (disabled), default 60
}

export interface AgentConfig {
  id: string;
  description: string;
  workspace: string;
  env: string;
  /** 'app-agent' = docker-exec based agent installed from an app store app */
  type?: 'app-agent';
  /** Docker container name — required when type === 'app-agent' */
  container?: string;
  /** Absolute path to the claude binary mounted inside the container */
  claudeBin?: string;
  telegram?: {
    botToken: string;
  };
  discord?: {
    botToken: string;
    guildAllowlist?: string[];
    channelAllowlist?: string[];
    dmPolicy?: 'open' | 'allowlist' | 'disabled';
    dmAllowlist?: string[];
    autoThread?: boolean;
  };
  line?: {
    channelAccessToken: string;
    channelSecret: string;
    /**
     * Slow-LLM postback button (ported from hermes-agent). Seconds to wait for
     * the agent's answer before burning the reply token to send a tappable
     * "Get answer" button; tapping yields a fresh (free) reply token. Default
     * 45 (leaves margin under LINE's ~60s token TTL). Set 0 to disable — the
     * agent then uses the plain reply-token-first → push-fallback path.
     */
    slowResponseThreshold?: number;
    /** Button label (default "Get answer", max 20 chars on LINE). */
    slowButtonLabel?: string;
    /** Bubble text shown with the button (default a "still thinking" notice). */
    slowPendingText?: string;
    /**
     * DM access policy (mirrors `discord.dmPolicy`). Closed by default: when
     * absent, only senders in `dmAllowlist` may reach the agent (same posture as
     * hermes/openclaw). 'open' replies to any 1:1 sender; 'allowlist' replies
     * only to `dmAllowlist`; 'disabled' ignores all DMs.
     */
    dmPolicy?: 'open' | 'allowlist' | 'disabled';
    /** LINE userIds allowed under allowlist / closed-default (case-sensitive "U"+32hex). */
    dmAllowlist?: string[];
    /**
     * Group/room access policy (the group analogue of `dmPolicy`). Closed by
     * default: when absent, only conversations whose groupId/roomId is in
     * `groupAllowlist` are answered. 'open' answers in any group/room the bot is
     * invited to; 'allowlist' answers only listed ones; 'disabled' ignores all
     * group/room traffic. Applies to both `group` and `room` sources.
     */
    groupPolicy?: 'open' | 'allowlist' | 'disabled';
    /**
     * Allowed conversation ids for groups and rooms — groupIds ("C"+32hex) and
     * roomIds ("R"+32hex) share one list (the webhook tells us which). Used under
     * allowlist / closed-default.
     */
    groupAllowlist?: string[];
    /**
     * In groups/rooms, only respond when the bot is @mentioned (native LINE
     * mention or its name). Default true (absent ⇒ true). No effect on DMs.
     * Set false to make the bot answer every allowed group message.
     */
    requireMention?: boolean;
    /**
     * Pairing aid for the allowlist (orthogonal to dm/groupPolicy — not a policy
     * value). When on, an un-allowlisted sender (DM or group/room) gets a one-time
     * pairing code replied to them via the free reply token, and the same code
     * shows in the UI "pending" row so an admin can visually match it
     * before clicking "+ Add". Default true (absent ⇒ on). Only has an effect
     * under `allowlist` (closed-default) — `open` never denies and `disabled`
     * is hard-off, so neither sends a code. Set false to restore the silent
     * closed-allowlist behavior.
     */
    pairing?: boolean;
  };
  claude: {
    model: string;
    /** @deprecated --dangerously-skip-permissions is always passed now; this field is ignored. */
    dangerouslySkipPermissions?: boolean;
    extraFlags: string[];
  };
  /** Heartbeat / cron settings */
  heartbeat?: {
    rateLimitMinutes?: number; // default 30
  };
  /** Session pool settings */
  session?: SessionConfig;
  /** Agent's signature emoji (used in greetings/sign-offs) */
  signatureEmoji?: string;
  /** Allow tool calls when agent is accessed via API channel. Falls back to ApiKey.allow_tools if not set. */
  allow_tools?: boolean;
  /** Per-agent history retention override */
  history?: HistoryConfig;
  /** Avatar filename relative to agent dir, e.g. "avatar.png". null = no avatar. */
  avatar?: string;
}

export interface AgentStats {
  id: string;
  isRunning: boolean;
  messagesReceived: number;
  messagesSent: number;
  lastActivityAt: string | null; // ISO timestamp
}

export interface WatchHandle {
  close(): void;
  ready: Promise<void>;
}

export interface ApiKey {
  key: string;
  description?: string;
  agents: string[] | '*'; // agent IDs this key can access, or '*' for all
  allow_tools?: boolean;  // permit tool-enabled (allow_tools) requests for this key
  write?: boolean;        // allow write ops for scoped agents (files, skills, PATCH agent)
  admin?: boolean;        // bypass scope + destructive ops (agent CRUD, shared skills, install)
}

export interface ModelConfig {
  id: string;
  label: string;
  alias: string;
  contextWindow: number;
  multiplier?: number;
}

export interface GatewayConfig {
  gateway: {
    logDir: string;
    timezone: string;
    models?: ModelConfig[];
    api?: {
      keys: ApiKey[];
    };
    /**
     * true (default) = headless backend (claude --print + stream-json).
     * false = interactive backend: claude TUI under the claude-pty-shell PTY wrapper.
     */
    headless?: boolean;
    /** Global history retention/cleanup defaults */
    history?: HistoryConfig & {
      cleanupHour?: number;      // 0-23, default 0
      cleanupTimezone?: string;  // IANA timezone, default "UTC"
    };
  };
  agents: AgentConfig[];
}

export interface WorkspaceFiles {
  agentMd: string;
  identityMd: string;
  soulMd: string;
  userMd: string;
  heartbeatMd: string;
  memoryMd: string;

}

export interface HeartbeatTask {
  name: string;
  cron: string; // always stored as 5-field cron after parsing interval
  prompt: string;
}

export interface HeartbeatResult {
  taskName: string;
  sessionId: string;
  suppressed: boolean;
  rateLimited: boolean;
  response: string;
  durationMs: number;
  ts: string; // ISO timestamp
}

export interface LoadedWorkspace {
  systemPrompt: string;
  files: WorkspaceFiles;
  truncated: boolean;
  skillRegistry?: import('./skills').SkillRegistry;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
}

export interface SessionMeta {
  id: string;          // UUID
  name: string;        // user-set or auto-generated ("Session N")
  createdAt: number;
  lastActive: number;
  messageCount: number;
  totalTokensUsed: number;
  lastInputTokens?: number;
  loadedAtSpawn?: number;   // messages loaded into context at last spawn (≤ MAX_HISTORY_MESSAGES)
  archivedCount?: number;   // messages not loaded into context (older than loaded window)
  messageCountAtSpawn?: number; // total messageCount at spawn time, used to derive in-context count
}

export interface SessionIndex {
  activeSessionId: string;
  sessions: SessionMeta[];
}

export type ApiAttachment = {
  type: 'image';
  url: string;
  relPath: string;
};

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; name: string; id: string; input?: Record<string, unknown> }
  | { type: 'thinking'; text: string }
  | { type: 'result'; text: string; attachments?: ApiAttachment[] }
  | { type: 'error'; message: string };

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

// ─── Cron Manager Types ───────────────────────────────────────────────────────

export type CronScheduleKind = 'cron' | 'at';
export type CronJobType = 'command' | 'agent';

export interface CronJobState {
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  consecutiveErrors: number;
  runCount: number;
}

export interface CronJob {
  id: string;
  agentId: string;
  name: string;
  // Schedule fields
  scheduleKind?: CronScheduleKind;  // default: 'cron'
  schedule?: string;                // cron expression (kind=cron)
  scheduleAt?: string;              // ISO-8601 timestamp (kind=at)
  // Payload fields
  type?: CronJobType;               // default: 'command'
  command?: string;                 // shell command (type=command)
  prompt?: string;                  // agent prompt (type=agent)
  telegram?: string;                // chat_id to deliver agent response (type=agent, required)
  discord?: string;                 // discord channel/user id to deliver agent response (type=agent)
  timeoutMs?: number;               // execution timeout ms (default 120000)
  // Lifecycle
  deleteAfterRun?: boolean;         // auto-delete after first successful run
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  state: CronJobState;
}

export interface CronJobCreate {
  agentId: string;
  name: string;
  // Schedule
  scheduleKind?: CronScheduleKind;
  schedule?: string;
  scheduleAt?: string;
  // Payload
  type?: CronJobType;
  command?: string;
  prompt?: string;
  telegram?: string;
  discord?: string;
  timeoutMs?: number;
  // Lifecycle
  deleteAfterRun?: boolean;
  enabled?: boolean;
}

export interface CronJobUpdate {
  name?: string;
  scheduleKind?: CronScheduleKind;
  schedule?: string;
  scheduleAt?: string;
  type?: CronJobType;
  command?: string;
  prompt?: string;
  telegram?: string;
  discord?: string;
  timeoutMs?: number;
  deleteAfterRun?: boolean;
  enabled?: boolean;
}

export interface CronRunLog {
  jobId: string;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  output: string;
  error: string | null;
}

export interface CronManagerConfig {
  storePath?: string;
  runsDir?: string;
}
