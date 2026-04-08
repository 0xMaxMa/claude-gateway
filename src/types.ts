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
