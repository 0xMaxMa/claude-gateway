export type { CustomConnectorEntry } from './connectors/types';
import type { CustomConnectorEntry } from './connectors/types';

export interface SessionConfig {
  idleTimeoutMinutes?: number; // default 30
  maxConcurrent?: number; // default 20
}

export interface HistoryConfig {
  retentionDays?: number; // 0 = keep forever (disabled), default 60
  // Max history messages re-injected into a session at spawn. Lower values
  // shrink the context loaded at session start. Default is MAX_HISTORY_MESSAGES
  // (50). 0 = inject no history. Per-agent overrides global.
  maxHistoryMessages?: number;
}

export interface AgentConfig {
  id: string;
  description: string;
  /** Editable display name shown in the UI instead of `id`. null/absent falls back to `id`. */
  name?: string | null;
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
  slack?: {
    /** Bot User OAuth Token (xoxb-...) — used for chat.postMessage / reactions.add / auth.test. */
    botToken: string;
    /** Signing Secret — verifies X-Slack-Signature (HMAC-SHA256 of "v0:{timestamp}:{rawBody}"). */
    signingSecret: string;
    /**
     * DM access policy (mirrors `line.dmPolicy` exactly — same 3 states, same
     * closed-by-default posture). Gates Slack user ids (1:1 `im` conversations).
     */
    dmPolicy?: 'open' | 'allowlist' | 'disabled';
    /** Allowed Slack user ids (stable "U"+ids — never names; Slack UI display names are not usable here). */
    dmAllowlist?: string[];
    /**
     * Channel access policy — named `groupPolicy` (not `channelPolicy`) to
     * match `line.groupPolicy` field-for-field, even though Slack's own term
     * for this tier is "channel". Gates the channels the bot is a member of.
     */
    groupPolicy?: 'open' | 'allowlist' | 'disabled';
    /** Allowed Slack channel ids (stable "C"+ids — never names, same footgun LINE's groupAllowlist avoids). */
    groupAllowlist?: string[];
    /**
     * In channels, only respond when the bot is @mentioned (mirrors
     * `line.requireMention`). Default true (absent ⇒ true). No effect on DMs.
     * Enforced for free at the Slack API level: channel messages only reach
     * this gateway via the `app_mention` event subscription.
     */
    requireMention?: boolean;
    /**
     * Pairing aid for the allowlist (mirrors `line.pairing` exactly — same
     * orthogonal-boolean shape, not a named policy value). When on, an
     * un-allowlisted sender gets a one-time visual-match pairing code posted
     * back to them, and the same code shows in the UI "pending" row so an
     * admin can visually match it before clicking "+ Add". Default true
     * (absent ⇒ on). Only has an effect under `allowlist` (closed-default).
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
  /** Per-agent skill-learning override (wins over the global gateway default). */
  skillLearning?: GatewayConfig['gateway']['skillLearning'];
  /** Per-agent memory-budget override (field-level over the global gateway default). */
  memory?: GatewayConfig['gateway']['memory'];
  /** Per-agent dreaming override (field-level over the global gateway default). */
  dreaming?: GatewayConfig['gateway']['dreaming'];
  /** Per-agent knowledge-archive override (field-level over the global gateway default). */
  knowledge?: GatewayConfig['gateway']['knowledge'];
  /** Avatar filename relative to agent dir, e.g. "avatar.png". null = no avatar. */
  avatar?: string;
  /** Per-agent connector enablement, keyed by connector id (e.g. "github"). */
  connectors?: Record<string, { enabled: boolean }>;
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

/**
 * Log verbosity, rotation and retention (issue #435). Every field is optional
 * and falls back to `LOGS_DEFAULTS` in src/logger.ts, so a config with no
 * `gateway.logs` block keeps working.
 *
 * Named to match the history-retention settings above (`retentionDays`, with
 * 0 = keep forever) rather than inventing a second vocabulary for the same idea.
 */
export interface LogsConfig {
  /** Minimum level written to file and stdout. Default "info" — see LOGS_DEFAULTS. */
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Rotate a log once an append would carry it past this size. Default 16 MiB. */
  maxFileBytes?: number;
  /** Rotated generations kept per stream (`<name>.log.1` …). 0 = keep none. Default 3. */
  maxFiles?: number;
  /** Delete logs older than this at boot and daily. 0 = keep forever. Default 14. */
  retentionDays?: number;
}

export interface GatewayConfig {
  gateway: {
    logDir: string;
    /** Log verbosity, rotation and retention. Absent = LOGS_DEFAULTS. */
    logs?: LogsConfig;
    timezone: string;
    /**
     * Network interface the HTTP/WebSocket server binds to. Defaults to
     * "127.0.0.1" (localhost-only) so the dashboard and API are not exposed to
     * the local network out of the box. Set to "0.0.0.0" to expose all
     * interfaces (e.g. behind a trusted reverse proxy). The `GATEWAY_BIND` env
     * var, when set, takes precedence over this field.
     */
    bind?: string;
    /**
     * Absolute, externally-reachable base URL of this gateway, including any
     * reverse-proxy path prefix (e.g. "https://gateway.example.com" or
     * "https://vm.example.com/gateway"). Two consumers: phone-openable links
     * such as the `/cli` webview terminal viewer, and the image-share bridge —
     * its presence is the sole enable switch and source for minting public
     * shared-image URLs. The process cannot infer its own public URL (it binds
     * localhost by default and sits behind a reverse proxy), so the operator
     * sets it explicitly. Unset = features that need a public link are
     * disabled. A trailing slash is trimmed when building links.
     */
    publicUrl?: string;
    /**
     * Optional "come back here after signing in" URL for the generic MCP
     * OAuth callback (oauth-connectors-router.ts) — e.g. a downstream
     * product's own connectors page. This gateway is product-agnostic, so
     * it never hardcodes one; unset = the callback just shows a plain
     * "Connected, close this tab" page instead of auto-redirecting anywhere.
     */
    oauthReturnUrl?: string;
    models?: ModelConfig[];
    api?: {
      keys: ApiKey[];
    };
    /**
     * true (default) = headless backend (claude --print + stream-json).
     * false = interactive backend: claude TUI under the claude-pty-shell PTY wrapper.
     */
    headless?: boolean;
    /**
     * Self-healing recovery (Epic #195, Phase 3). When `autoRecover` is true the
     * turn-trace watchdog may auto-execute a whitelisted recovery action
     * (keystroke, session/receiver restart, safe-mode fallback, guarded resend)
     * for a stalled turn. Default false — detection, incident logging, and
     * notification still run when disabled; only live action execution is gated,
     * so the feature ships dark and the operator opts in when ready. Safe-mode
     * auto-fallback on hard PTY failure is independent of this flag (it is always
     * reversible and never presses keys).
     */
    selfHealing?: {
      autoRecover?: boolean;
    };
    /** Global history retention/cleanup defaults */
    history?: HistoryConfig & {
      cleanupHour?: number;      // 0-23, default 0
      cleanupTimezone?: string;  // IANA timezone, default "UTC"
    };
    /**
     * App-store Docker housekeeping (issue #302). Best-effort reclaim of the
     * build cache and dangling `<none>` images left behind by every app
     * install/update. Each toggle defaults on with a conservative time window;
     * set all toggles off to make the feature issue zero prune calls. There is
     * deliberately NO volume auto-delete toggle — orphaned volumes can hold real
     * app data and are report-only. The safety floor is fixed regardless of
     * config: never `system prune`, never `image/builder prune -a`, never an
     * automatic volume prune.
     */
    appHousekeeping?: {
      /** Prune build cache older than the window after a successful build. Default true. */
      buildCachePrune?: boolean;
      /** Age window (hours) for the build-cache prune — only frees cache older than this, so a concurrent build's fresh layers survive. Default 168 (7d). */
      buildCacheMaxAgeHours?: number;
      /** Prune dangling `<none>` images with no container (safe subset — never `-a`). Default true. */
      danglingImagePrune?: boolean;
    };
    /**
     * Per-app backup/restore policy. A backup is a permission-safe snapshot of
     * an app's Docker named volumes + config (`.env`/`app.yaml`) into a single
     * archive; restore returns exact inner ownership via helper-container tar.
     * Absent = defaults below (feature on with a 3-backup ceiling, a 30-day age
     * cap, and safety hooks enabled). Set the flags to false to opt out of the
     * auto-hooks.
     */
    appBackup?: {
      retention?: number;                 // keep N most recent per app, default 3 (0 = unbounded)
      maxAgeDays?: number;                // prune backups older than N days, default 30 (0 = disabled)
      cleanupHour?: number;               // 0-23 daily prune hour, default 0
      cleanupTimezone?: string;           // IANA timezone for cleanupHour, default "UTC"
      autoBackupBeforeUninstall?: boolean; // default true
      autoBackupBeforeUpdate?: boolean;    // default true
    };
    /**
     * Boot-time app-restore budgets (issue #425). `restoreRunningApps()` brings
     * every app stored as `running` back up after a gateway/host restart. On a
     * warm reboot the images already exist and the wait is short; on a cold host
     * (data dir restored elsewhere, migrated machine, pruned Docker) the app has
     * to be rebuilt from source first — and a build killed by an expired budget
     * is *cancelled*, not merely un-awaited. Hence two budgets: raise
     * `buildTimeoutMs` for slow hosts or heavy images.
     */
    appRestore?: {
      /** Ceiling for the restore's `docker compose build`, ms. Default 1800000 (30 min). */
      buildTimeoutMs?: number;
      /** Ceiling for the restore's `docker compose up -d --wait`, ms. Default 180000 (3 min). */
      waitTimeoutMs?: number;
    };
    /**
     * Skill self-improvement (skill-learning). A closed Do → Learn → Improve
     * loop: after a qualifying session goes idle, a print-only reviewer distils
     * how the task was solved into a reusable workspace SKILL.md (provenance
     * `origin:auto`), a curator prunes stale auto-skills, and effectiveness is
     * captured in per-turn telemetry. Ships on by default via config migration;
     * set `enabled:false` to keep only baseline telemetry capture. Per-agent
     * overrides are honored over this global default (like history retention).
     */
    skillLearning?: {
      enabled?: boolean;         // default true — reviewer + writer + curator active
      mode?: 'propose' | 'auto'; // propose = review queue, auto = live write. default "auto"
      minToolCalls?: number;     // gating threshold, default 5
      reviewModel?: string;      // cheap model for the reviewer, default haiku
      maxAutoSkills?: number;    // curator cap per agent, default 50 (0 = unbounded)
      maxAgeDays?: number;       // prune auto-skills unused this long, default 30 (0 = disabled)
      minUsesToKeep?: number;    // an auto-skill must load >= N times or it's pruned, default 2
      maxReviewsPerDay?: number; // reviewer spawns per agent per day (cost cap), default 20 (0 = disabled)
      pruneHour?: number;        // 0-23 daily curator hour, default 3
      pruneTimezone?: string;    // IANA timezone for pruneHour, default "UTC"
      notify?: boolean;          // Telegram push when a skill is auto-written, default true (diary always on)
    };
    /**
     * Memory budget discipline (issue #323). Self-authored memory files
     * (MEMORY.md/USER.md) that exceed their SOFT char budget get a loud
     * over-budget banner at compose time instead of a silent truncation, so the
     * agent consolidates on its next spawn (frozen-at-spawn — no restart). Soft
     * budgets sit well under the hard per-file limit; the banner is the primary
     * signal for memory files.
     */
    memory?: {
      memoryBudgetChars?: number;    // soft budget for MEMORY.md, default 8000 (0 = disabled)
      userBudgetChars?: number;      // soft budget for USER.md, default 3000 (0 = disabled)
      overBudget?: 'warn' | 'error'; // compose banner severity, default "warn"
      // planning-65 write routing: inject the two-tier contract into the Memory
      // Rule (MEMORY.md = durable facts; task-log → memory/<topic>.md) and let the
      // dreaming reviewer route episodic ops out. Default true; false = kill-switch.
      writeRouting?: boolean;
      episodicArchiveDir?: string;   // where episodic notes land (rel to workspace), default "memory"
    };
    /**
     * Nightly memory "dreaming" (issue #325). A print-only reviewer reads a
     * lookback window of the agent's own session transcripts and proposes memory
     * consolidation ops. In `propose` mode (the shipped default) proposals are
     * written only to a `DREAMS.md` diary + JSONL audit under `<workspace>/.dreaming/`
     * — no memory file is mutated (the `auto` applier is a follow-up). Runs on a
     * nightly scheduler; `enabled:false` or `maxChangesPerRun:0` ⇒ no-op.
     */
    dreaming?: {
      enabled?: boolean;            // default true
      mode?: 'propose' | 'auto';    // default "auto" (apply via safe applier); "propose" = diary-only dry-run
      dreamHour?: number;           // 0-23 nightly hour, default 3
      dreamMinute?: number;         // 0-59 minute-of-hour, default 0 (pairs with dreamHour)
      dreamTimezone?: string;       // IANA tz, default "UTC"
      quietMinutes?: number;        // skip if a session was active within this window, default 30
      lookbackDays?: number;        // how far back to scan sessions, default 3
      maxChangesPerRun?: number;    // cap on proposed ops, default 3 (0 = disabled)
      reviewModel?: string;         // cheap model for the reviewer, default haiku
      promotionThreshold?: number;  // min candidate score to promote, default 0.6
      minRecallCount?: number;      // a fact must recur >= N times to promote, default 2
      // planning-67: auto-drain an over-budget MEMORY.md by routing episodic
      // task-log to memory/<topic>.md during the nightly dream (archive-safe),
      // instead of a manual per-agent `dreaming:migrate`. Default true; kill-switch.
      autoRouteOut?: boolean;
      // planning-68: spread agents' nightly runs across a window (deterministic
      // per-agent jitter added to the delay) to avoid a dreamHour thundering-herd.
      // Default 30 min; clamped [0,55]; 0 = disabled (all fire at dreamHour:00).
      staggerWindowMinutes?: number;
      /**
       * Archive staleness GC (planning-66). Nightly, deterministic pass (next to the
       * compactor, auto mode) that keeps `memory_search` surfacing CURRENT truth: it
       * soft-invalidates superseded / aged-out / low-recall archive entries by moving
       * them to `memory/archive/stale.md` + stamping `invalid_at` — NEVER deletes, so
       * every entry stays searchable — and promotes an invalidated entry back if it is
       * retrieved again. A search-quality fix, not a prompt-budget one (planning-65
       * already moved task-log off the prompt). Touches only the `memory/*.md` archive
       * tier — never evergreen Lane-1 (MEMORY.md/USER.md) or pinned files.
       */
      staleness?: {
        enabled?: boolean;         // default true; false ⇒ GC no-ops (archive grows as before)
        staleTtlDays?: number;     // idle-since-last-retrieval before an unmarked entry ages out, default 90
        keepImportance?: number;   // importance >= this is never GC'd, default 7
        minRetrievalKeep?: number; // retrieved >= this in the window ⇒ keep regardless of age, default 1
        supersession?: boolean;    // deterministic same-#id invalidation (no TTL), default true
        recordRetrievals?: boolean; // read-path append to kb_retrieval_log (feeds LRU + feedback), default true
      };
    };
    /**
     * Two-lane memory: per-agent searchable knowledge archive (planning-64 K0).
     * A SQLite/FTS5 index over the agent's `memory/*.md` notes (+ evergreen
     * MEMORY.md/USER.md), so later phases can retrieve on demand instead of
     * injecting the whole file. K0 is dormant infrastructure — building the
     * index changes nothing about the prompt and adds no tools yet.
     * `archive.enabled:false` ⇒ complete no-op (no DB created).
     */
    knowledge?: {
      archive?: {
        enabled?: boolean;     // default true
        tokenizer?: string;    // FTS5 tokenizer, default "unicode61" ("trigram" for CJK/Thai)
        chunkTokens?: number;  // target chunk size in ~tokens, default 400
        chunkOverlap?: number; // overlap between chunks in ~tokens, default 80
      };
      /**
       * Shared, cross-agent knowledge base (planning-64 K3). A shared SQLite/FTS5
       * vault OUTSIDE any single agent's workspace so agents can build a common KB.
       * The gateway has no built-in project concept, so sharing is keyed by an
       * explicit `project` value: agents with the same `project` share one vault.
       * `project` defaults to "global" ⇒ shared-by-default across all agents.
       */
      shared?: {
        enabled?: boolean;  // default true
        project?: string;   // sharing partition key, default "global"
        root?: string;      // vault root dir, default ~/.claude-gateway/shared/kb
        mode?: 'propose' | 'auto'; // per-agent→shared promotion mode (K4), default "auto"
        graph?: boolean;    // K5: compile memory-wiki graph/dashboards, default false
        /** issue #392 part D: shared-KB staleness GC (same shape as dreaming.staleness above). */
        staleness?: {
          enabled?: boolean;
          staleTtlDays?: number;
          keepImportance?: number;
          minRetrievalKeep?: number;
          supersession?: boolean;
          recordRetrievals?: boolean;
        };
      };
      /**
       * Weekly, KB-level shared reflection pass (issue #392 part C). Runs once
       * per distinct shared-vault root (not per agent), skips entirely when the
       * vault hasn't changed since the last run, and clusters related notes
       * (connected components over the wikilink graph) before proposing at most
       * `maxClustersPerRun` bounded merges.
       */
      reflection?: {
        enabled?: boolean;         // default true
        dayOfWeek?: number;        // 0=Sunday..6=Saturday, default 0
        hour?: number;             // default 4
        minute?: number;           // default 0
        timezone?: string;         // default "UTC"
        maxClustersPerRun?: number; // default 5
        reviewModel?: string;      // default matches the dreaming reviewer's default
      };
    };
    /**
     * Every connector the gateway knows about, keyed by slugified id — user-pasted
     * (not code-reviewed) configs, plus the entries an external control plane
     * pushes in (`credentialOwner: 'external'`). See connectors/types.ts's
     * CustomConnectorEntry doc for the security tradeoff.
     *
     * Whether a connector is CONNECTED is not stored here — mcp-token.env alone
     * answers that. Per-AGENT enablement lives on AgentConfig.connectors, which is
     * a different thing again.
     */
    customConnectors?: Record<string, CustomConnectorEntry>;
    /**
     * Whether a connected connector is available to an agent that has no explicit
     * entry in `AgentConfig.connectors`. Default `true` (opt-out): connecting a
     * connector makes it available everywhere, and an agent only misses it if
     * explicitly disabled.
     *
     * Set `false` on a gateway that hosts agents for more than one person. There,
     * the default hands a credential connected by one operator to every agent on
     * the box, including agents whose chat users are not that operator; opt-in
     * per agent is the safer posture.
     *
     * A switch rather than a safer default, because the common deployment is one
     * operator's own VM running their own agents — there, opt-in would mean
     * connecting a connector and then enabling it again on every agent before it
     * did anything, and the second step is easy to forget and hard to diagnose
     * ("it says Connected, why has the agent no tools?"). Nothing about upgrades
     * is at stake either way: connectors ship for the first time in this change,
     * so there is no install that already has one (see connectors/types.ts's note
     * on `credentialOwner` for the same reasoning applied to on-disk shape).
     */
    connectorsDefaultEnabled?: boolean;
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
  loadedAtSpawn?: number;   // messages loaded into context at last spawn (≤ the resolved max history messages, default MAX_HISTORY_MESSAGES)
  archivedCount?: number;   // messages not loaded into context (older than loaded window)
  messageCountAtSpawn?: number; // total messageCount at spawn time, used to derive in-context count
  /** Last composer image options sent for this session (D9). Persisted so the web
   *  can restore the composer selection on reload; the agent's own context is the
   *  functional source of truth. Updated whenever a send carries image_params. */
  imageConfig?: ImageParams;
  /** Real model from Claude stream, updated per turn (e.g. "claude-opus-4-8"). */
  model?: string;
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

/**
 * Image-generation options selected in the web composer (per-session, D9/D25).
 * Passed through the chat send body as `image_params` and surfaced to the agent
 * so it calls the `generate_image` MCP tool with these values (contract E5).
 */
export type ImageParams = {
  model?: string;
  quality?: string;
  size?: string;
  aspect_ratio?: string;
  image_ref?: string;
  /**
   * Reference images explicitly selected in the composer, in the order the user
   * picked them. Each entry is a `ref` value from GET /api/v1/image-catalog —
   * either an `artifact:<id>` ref or a media-relative path (the same forms the
   * generate_image `image`/`images` arguments accept). Per-turn only: unlike the
   * rest of ImageParams these are NOT persisted as durable session image config.
   */
  image_refs?: string[];
  n?: number;
};

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; name: string; id: string; input?: Record<string, unknown> }
  | { type: 'thinking'; text: string }
  | { type: 'result'; text: string; attachments?: ApiAttachment[] }
  // The soft response budget elapsed, but the turn is still running (#421).
  // Non-terminal on purpose: the stream stays open and the turn stays resumable
  // via GET …/sessions/:sessionId/stream. `error` remains reserved for genuine
  // failures, including the hard-cap expiry.
  | { type: 'timeout'; message: string; resumable: true }
  // `code` carries the originating Error's `code`. Without it the only way to
  // tell one failure from another was to match `message` — and the two timeouts
  // differ by a tense and a full stop ('Agent response timeout' vs 'Agent
  // response timed out.'). Optional: not every failure carries one.
  //
  // Timeout vocabulary — the distinction is whether the TURN is over, not
  // whether the caller gave up:
  //   'TIMEOUT'        the hard cap fired; the turn was interrupted and is dead.
  //   'TIMEOUT_SOFT'   the caller's budget elapsed; the turn is STILL RUNNING and
  //                    its result will land in history. Emitted by the paths that
  //                    cannot keep streaming it — the cross-channel live view
  //                    (no hard cap, no resume endpoint) and the synchronous API.
  //   'PROCESS_EXITED' the subprocess crashed mid-turn.
  // The streaming API path emits no soft-timeout error at all: there the budget
  // elapsing is the non-terminal `timeout` event above, because the turn stays
  // reachable through GET …/sessions/:sessionId/stream.
  | { type: 'error'; message: string; code?: string };

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
  timezone?: string;                // IANA zone (kind=cron) the schedule fires in; default 'UTC'
  // Payload fields
  type?: CronJobType;               // default: 'command'
  command?: string;                 // shell command (type=command)
  prompt?: string;                  // agent prompt (type=agent)
  telegram?: string;                // chat_id to deliver response (agent-type) or failure notices (any type)
  discord?: string;                 // discord channel/user id to deliver response (agent-type) or failure notices (any type)
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
  timezone?: string;
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
  timezone?: string;
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
