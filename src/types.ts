export interface SessionConfig {
  idleTimeoutMinutes?: number; // default 30
  maxConcurrent?: number; // default 20
}

export interface AgentConfig {
  id: string;
  description: string;
  workspace: string;
  env: string;
  telegram: {
    botToken: string;
    allowedUsers: number[];
    dmPolicy: 'allowlist' | 'open';
  };
  claude: {
    model: string;
    dangerouslySkipPermissions: boolean;
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
}

export interface ApiKey {
  key: string;
  description?: string;
  agents: string[] | '*'; // agent IDs this key can access, or '*' for all
}

export interface GatewayConfig {
  gateway: {
    logDir: string;
    timezone: string;
    api?: {
      keys: ApiKey[];
    };
  };
  agents: AgentConfig[];
}

export interface WorkspaceFiles {
  agentMd: string;
  soulMd: string;
  toolsMd: string;
  userMd: string;
  heartbeatMd: string;
  memoryMd: string;
  bootstrapMd: string | null; // null if not present
  isFirstRun: boolean;
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
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; name: string; id: string }
  | { type: 'thinking'; text: string }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string };

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

// ─── Cron Manager Types ───────────────────────────────────────────────────────

export type CronScheduleKind = 'cron' | 'at' | 'every';
export type CronPayloadKind = 'command' | 'agentTurn';

export interface CronJobState {
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  consecutiveErrors: number;
  runCount: number;
  lastAlertAt?: number | null;
}

export interface CronJobNotify {
  telegram?: string; // chat_id
  webhook?: string;  // URL
  onSuccess?: boolean; // default true
  onError?: boolean;   // default true
}

export interface CronJobFailureAlert {
  after: number;       // trigger after N consecutive errors
  telegram?: string;   // chat_id
  webhook?: string;    // URL
  cooldownMs?: number; // default 3600000 (1h)
}

export interface CronJob {
  id: string;
  agentId: string;
  name: string;
  // Schedule fields
  scheduleKind?: CronScheduleKind;  // default: 'cron'
  schedule?: string;                // cron expression (kind=cron)
  scheduleAt?: string;              // ISO-8601 timestamp (kind=at)
  everyMs?: number;                 // interval in ms (kind=every)
  anchorMs?: number;                // optional anchor timestamp (kind=every)
  // Payload fields
  payloadKind?: CronPayloadKind;    // default: 'command'
  command?: string;                 // shell command (payloadKind=command)
  agentTurnMessage?: string;        // prompt for agent (payloadKind=agentTurn)
  agentTurnSessionId?: string;      // session id (auto-generated if omitted)
  agentTurnTimeoutMs?: number;      // default 120000
  // Lifecycle
  deleteAfterRun?: boolean;         // auto-delete after first successful run
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  notify?: CronJobNotify;
  failureAlert?: CronJobFailureAlert;
  state: CronJobState;
}

export interface CronJobCreate {
  agentId: string;
  name: string;
  // Schedule
  scheduleKind?: CronScheduleKind;
  schedule?: string;
  scheduleAt?: string;
  everyMs?: number;
  anchorMs?: number;
  // Payload
  payloadKind?: CronPayloadKind;
  command?: string;
  agentTurnMessage?: string;
  agentTurnSessionId?: string;
  agentTurnTimeoutMs?: number;
  // Lifecycle
  deleteAfterRun?: boolean;
  enabled?: boolean;
  notify?: CronJobNotify;
  failureAlert?: CronJobFailureAlert;
}

export interface CronJobUpdate {
  name?: string;
  scheduleKind?: CronScheduleKind;
  schedule?: string;
  scheduleAt?: string;
  everyMs?: number;
  anchorMs?: number;
  payloadKind?: CronPayloadKind;
  command?: string;
  agentTurnMessage?: string;
  agentTurnSessionId?: string;
  agentTurnTimeoutMs?: number;
  deleteAfterRun?: boolean;
  enabled?: boolean;
  notify?: CronJobNotify;
  failureAlert?: CronJobFailureAlert;
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
