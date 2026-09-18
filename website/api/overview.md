# Endpoints Overview {#endpoints-overview}

## System {#system}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Liveness only — returns `{"status":"ok"}` (no agent list) |
| `GET` | `/status` | Admin key or dashboard session¹ | Per-agent stats, legacy/managed sessions, worker pools + heartbeat history |
| `GET` | `/processes` | Admin key or dashboard session¹ | Host process tree for the dashboard |
| `GET` | `/knowledge/graph` | Admin key or dashboard session¹ | Memory-wiki as `{ nodes, edges, demo, scope }` for the dashboard **Knowledge base** tab. `?scope=shared` (default) = the cross-agent Shared KB; `?scope=agent:<id>` = that agent's Lane-2 memory (`workspace/memory/*.md`, id validated against the known-agents allowlist). Computed on-demand (independent of `gateway.knowledge.shared.graph` and the nightly reindex). Shared scope serves a labelled demo (`demo:true`) when empty; `?demo=off` returns the real model; `?demo=<N>` a synthetic N-node graph for scale testing |
| `GET` | `/knowledge/sources` | Admin key or dashboard session¹ | Graph sources for the KB tab's selector: `{ sources: [{ id, label, count }] }` — the Shared KB plus every agent with ≥1 Lane-2 memory note |
| `GET` | `/knowledge/note` | Admin key or dashboard session¹ | Full Markdown body of one note for the KB tab's detail section: `{ id, scope, path, updated, body }` (frontmatter stripped, ≤20 KB; `path` = gateway-root-relative location, `updated` = ISO last-modified). `?scope=shared\|agent:<id>` selects the vault (same allowlist guard as `/knowledge/graph`); `?id=<relPath>.md` must be a `.md` path that resolves **inside** that vault (no traversal) |
| `GET` | `/dashboard/memory-activity` | Admin key or dashboard session¹ | Unified memory-dream and native-compaction audit. Filters: `scope=24h/7d/30d/90d/all`, `agentId`, `kind=memory_dream/session_compaction/all`, `status`, zero-based `page`. Returns 25 run summaries per page, counts, schedules and source notices. Add `agentId` + `id` to read one run, including at most 1,000 session outcomes. Read-only, `no-store`, refreshed by the dashboard. |
| `GET` | `/knowledge/dreams` | Admin key or dashboard session¹ | Nightly-dreaming audit trail for the **Nightly dreaming** tab: `{ runs, agents }`, newest-first, parsed from each agent's `.dreaming/DREAMS.md` + `promotions.jsonl` (+ `accepted.jsonl`). Each proposal carries an `index` (accept target) and an `accepted` flag. Bounded (≤200 runs; proposal `content` truncated) |
| `POST` | `/knowledge/dreams/apply` | Admin key or dashboard session¹ | Manually accept `propose`-mode proposals: applies the selected ops to the agent's `MEMORY.md`/`USER.md` via the **same K4 safe applier** as auto mode (backup + bounded-loss + net-negative + CAS + never-empty; memory-only ⇒ no restart), records them to `.dreaming/accepted.jsonl` (idempotent), and promotes applied `add`s to the shared vault when it is `auto`. Body: `{ agentId, ts, indexes?[] }` (omit `indexes` ⇒ whole run). Returns `{ applied, skipped, alreadyAccepted, requested, backups }`. `404` unknown agent / no matching run, `400` bad `ts`/`indexes` |
| `GET` | `/dashboard` | Session cookie¹ | Web UI dashboard (Sessions + Knowledge base + Nightly dreaming tabs; serves the login page when unauthenticated) |
| `POST` | `/dashboard/login` | None (validates an admin key) | Exchange an **admin** API key for an `HttpOnly; SameSite=Lax` `dash_session` cookie (8h). Brute-force throttled per IP (`429` after 10 failed attempts / 5 min) |
| `POST` | `/dashboard/logout` | Session cookie | Revoke the dashboard session and clear the cookie |
| `GET` | `/api/v1/commands` | None | List slash commands available in the chat UI |
| `GET` | `/api/v1/_meta/routes` | API key | Route manifest (every `defineRoute`-registered endpoint, incl. its CLI noun/verb mapping) — source for the `claude-gateway` CLI's codegen and `doctor` cross-check |

¹ **Auth applies when `gateway.api.keys` is configured, and requires an _admin_ key**
(`admin: true`). The dashboard/monitoring surface grants cross-agent, host-wide power
(session list, process tree, and PTY keystroke injection into any session), so it
intentionally requires more than a scoped or write key. "Admin key or dashboard session"
accepts an admin API key (`X-Api-Key` / `Authorization: Bearer`) **or** the `dash_session`
cookie issued by `POST /dashboard/login` (which is itself only issued to an admin key). A
valid but non-admin key is rejected (`401`). With **no** keys configured the behavior
depends on the bind: on a **loopback** bind (`127.0.0.1`) they stay open (a keyless
local install has no credential to check); on a **non-loopback** bind (`0.0.0.0` or a
real IP) they **fail closed** — `/status`, `/processes`, and `/dashboard` return `503`
until `gateway.api.keys` is set, so the surface is never exposed unauthenticated to the
network. If keys are configured but **none is admin**, the dashboard is inaccessible
(login returns `401`) and a startup warning is emitted. `/health` stays public in all cases.

## Terminal viewer (`/cli`) {#terminal-viewer-cli}

See [Terminal viewer (`/cli`)](/api/terminal).

## Agent API {#agent-api}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents` | Key | List agents accessible by the provided key |
| `POST` | `/api/v1/agents` | Admin | Create a new agent |
| `PATCH` | `/api/v1/agents/:agentId` | Write | Update agent name, description, model, or allow_tools (`connectors` needs **Admin**) |
| `DELETE` | `/api/v1/agents/:agentId` | Admin | Delete an agent |
| `POST` | `/api/v1/agents/:agentId/messages` | Key | Send a message — sync JSON or SSE stream; supports slash commands |
| `POST` | `/api/v1/agents/:agentId/greeting` | Write | Stream a proactive welcome from `GREETING.md` into an existing session (SSE); returns 204 if file absent |
| `GET` | `/api/v1/models` | Key | List available models — live catalog when configured, `gateway.models` otherwise |
| `PUT` | `/api/v1/agents/:agentId/model` | Admin | Set the active model for an agent |

## Orchestration and voice {#orchestration-and-voice}

See [activity polling, scoped task dispatch, voice WebSocket protocol and dashboard fields](/api/orchestration#orchestration-and-live-voice).

## Session Management API {#session-management-api}

Session management operations require `chat_id` (query param for GET/DELETE, body for POST/PATCH). The resumable stream and orchestration activity/task routes instead use their documented session and principal checks.
Sessions are stored at `sessions/api-{chat_id}/` — symmetric with `telegram-{id}` and `discord-{id}`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/sessions` | Key | List API sessions for a `chat_id` |
| `POST` | `/api/v1/agents/:agentId/sessions` | Key | Create a new API session (auto-names from prompt) |
| `GET` | `/api/v1/agents/:agentId/sessions/:sessionId/info` | Key | Get session info (name, message count, context %) |
| `GET` | `/api/v1/agents/:agentId/sessions/:sessionId/stream` | Key | Re-attach to the session's in-flight turn (SSE, resumable from a `seq` cursor) |
| `PATCH` | `/api/v1/agents/:agentId/sessions/:sessionId` | Key | Rename a session |
| `DELETE` | `/api/v1/agents/:agentId/sessions/:sessionId` | Key | Delete a session |
| `POST` | `/api/v1/agents/:agentId/sessions/:sessionId/clear` | Key | Reset model context; preserve history |
| `POST` | `/api/v1/agents/:agentId/sessions/:sessionId/compact` | Key | Summarise old history, keep only recent messages |
| `POST` | `/api/v1/agents/:agentId/sessions/:sessionId/stop` | Key | Interrupt the in-flight turn |
| `POST` | `/api/v1/agents/:agentId/sessions/:sessionId/restart` | Key | Graceful session restart |
| `POST` | `/api/v1/agents/:agentId/sessions/:sessionId/attachments` | Key | Register file paths as attachments for the current turn (called internally by `api_reply` MCP tool) |

## Workspace File API {#workspace-file-api}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/files/:filename` | Key | Read a workspace file |
| `PUT` | `/api/v1/agents/:agentId/files/:filename` | Write | Write a workspace file |

## Telegram Channel API {#telegram-channel-api}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/telegram/pending` | Admin | List pending pairing requests (DM + group knocks) |
| `POST` | `/api/v1/agents/:agentId/telegram/approve` | Admin | Approve a pending pairing by code (kind-aware) |
| `POST` | `/api/v1/agents/:agentId/telegram/deny` | Admin | Deny a pending pairing by code |
| `PATCH` | `/api/v1/agents/:agentId/telegram/policy` | Admin | Update DM policy, pairing toggle, group policy and/or mention gate |
| `GET` | `/api/v1/agents/:agentId/telegram/allowlist` | Admin | List allowlisted users |
| `DELETE` | `/api/v1/agents/:agentId/telegram/allow/:userId` | Admin | Remove a user from the allowlist |
| `GET` | `/api/v1/agents/:agentId/telegram/group/allowlist` | Admin | List allowlisted group ids |
| `DELETE` | `/api/v1/agents/:agentId/telegram/group/allow/:groupId` | Admin | Remove a group from the group allowlist |

## Discord Channel API {#discord-channel-api}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/discord/pending` | Admin | List pending pairing requests (DM + guild knocks) |
| `POST` | `/api/v1/agents/:agentId/discord/approve` | Admin | Approve a pending pairing by code (kind-aware) |
| `POST` | `/api/v1/agents/:agentId/discord/deny` | Admin | Deny a pending pairing by code |
| `PATCH` | `/api/v1/agents/:agentId/discord/policy` | Admin | Update DM policy, pairing toggle, guild policy and/or mention gate |
| `GET` | `/api/v1/agents/:agentId/discord/allowlist` | Admin | List allowlisted users |
| `DELETE` | `/api/v1/agents/:agentId/discord/allow/:userId` | Admin | Remove a user from the allowlist |
| `GET` | `/api/v1/agents/:agentId/discord/guild/allowlist` | Admin | List allowlisted guild ids |
| `DELETE` | `/api/v1/agents/:agentId/discord/guild/allow/:guildId` | Admin | Remove a guild from the guild allowlist |

## Public Webhook Ingress {#public-webhook-ingress}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/webhooks/:app` | None (self-authenticating) | Provider URL-verification probe |
| `GET` | `/webhooks/:app/:agentId` | None (self-authenticating) | Provider URL-verification probe, agent-scoped |
| `POST` | `/webhooks/:app` | None (self-authenticating) | Inbound webhook delivery — first agent with `:app` configured |
| `POST` | `/webhooks/:app/:agentId` | None (self-authenticating) | Inbound webhook delivery — specific agent |

## Skill API {#skill-api}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/skills` | Key | List all skills (workspace + module + shared) |
| `GET` | `/api/v1/agents/:agentId/skills/:name` | Key | Get a single skill's content |
| `POST` | `/api/v1/agents/:agentId/skills` | Write | Create a new skill |
| `POST` | `/api/v1/agents/:agentId/skills/install` | Admin | Install a skill from a GitHub/raw URL |
| `DELETE` | `/api/v1/agents/:agentId/skills/:name` | Write | Delete a skill |
| `GET` | `/api/v1/agents/:agentId/skill-metrics` | Key | Skill self-improvement effectiveness rollup |
| `GET` | `/api/v1/agents/:agentId/memory-metrics` | Key | Two-lane memory metrics: budget hygiene, archive/shared coverage, dreaming ledger, session-drop invariant |

## App Store API {#app-store-api}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/apps/registry` | Key | Fetch community registry (5-min cached) |
| `GET` | `/api/v1/apps/registry/:name` | Key | Get versions of a registry app |
| `GET` | `/api/v1/apps` | Key | List installed apps |
| `POST` | `/api/v1/apps/install` | Admin | Start async install → `jobId` |
| `POST` | `/api/v1/apps/inspect` | Admin | Read-only preview of a source → required/generated secrets (no install) |
| `GET` | `/api/v1/apps/jobs/:jobId` | Key | Poll install/update job status + logs |
| `GET` | `/api/v1/apps/:name` | Key | Get installed app info |
| `DELETE` | `/api/v1/apps/:name` | Admin | Uninstall app |
| `POST` | `/api/v1/apps/:name/start` | Admin | Start stopped app |
| `POST` | `/api/v1/apps/:name/stop` | Admin | Stop running app |
| `POST` | `/api/v1/apps/:name/restart` | Admin | Restart app |
| `GET` | `/api/v1/apps/:name/version` | Key | Check installed vs latest version |
| `POST` | `/api/v1/apps/:name/update` | Admin | Start async update with rollback → `jobId` |
| `POST` | `/api/v1/apps/:name/reconfigure` | Admin | Start async env/host-port reconfigure (keeps volumes) → `jobId` |
| `POST` | `/api/v1/apps/housekeeping` | Admin | Docker build-cache & orphan reclaim report (`mode:"report"`) or safe prune (`mode:"prune"`) |
| `POST` | `/api/v1/apps/:name/backup` | Admin | Start async snapshot of volumes, bind-mount data dirs & config → `jobId` |
| `POST` | `/api/v1/apps/:name/restore` | Admin | Restore volumes, bind-mount data dirs & config from a backup → `jobId` |
| `GET` | `/api/v1/apps/:name/backups` | Key | List backups (newest first) |
| `DELETE` | `/api/v1/apps/:name/backups/:id` | Admin | Delete one backup |
| `GET` | `/app/:name/:portName/*` | None | Reverse proxy to installed app |

Backup retention (`gateway.appBackup`): backups are pruned by the **union** of a count cap and an age cap — a backup is removed when it exceeds `retention` (keep N newest per app, default **3**, `0` = unbounded) **or** is older than `maxAgeDays` (default **30**, `0` = disabled). Pruning runs after each successful backup and once per day via a scheduler at `cleanupHour` (0-23, default `0`) in `cleanupTimezone` (IANA, default `"UTC"`, falling back to `gateway.timezone` when unset or invalid).

Boot restore (`gateway.appRestore`): at startup every app stored as `running` is brought back up in the background. When an image the app needs is missing from the local daemon, the restore first runs `docker compose pull --ignore-buildable` and `docker compose build`, each under `buildTimeoutMs` (default **1800000**, 30 min); it then runs `docker compose up -d --wait` under `waitTimeoutMs` (default **180000**, 3 min). The two budgets are separate because a timeout SIGKILLs the compose CLI, and while that only abandons the *healthcheck wait* once images exist, it **cancels an in-progress build** — so a cold host with no image cache must not have its rebuild bounded by the short wait budget. When the images are already present both cold-start steps are skipped entirely, so a warm reboot is unaffected. Any non-numeric, non-finite or non-positive value falls back to the default. See `restoreError` under `GET /api/v1/apps`.

## Connectors API {#connectors-api}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/connectors` | Key | List every connector with its connected state |
| `GET` | `/api/v1/connectors/:id/status` | Key | Connected boolean for a single connector (for polling) |
| `POST` | `/api/v1/connectors/:id/connect` | Admin | Store a pasted token |
| `POST` | `/api/v1/connectors/:id/oauth/receive` | Admin | Accept an `access_token` + connector shape pushed by an external control plane |
| `DELETE` | `/api/v1/connectors/:id` | Admin | Disconnect — clears the credential; removes the whole entry for `none`/`external` connectors |
| `POST` | `/api/v1/connectors/custom` | Admin | Add a user-pasted connector |
| `POST` | `/api/v1/connectors/custom/:id/oauth/start` | Admin | Begin the gateway-owned OAuth 2.1 + PKCE sign-in → `authorizeUrl` |
| `GET` | `/oauth/mcp/callback` | None (single-use `state`) | OAuth redirect target — the provider sends the end user's own browser here |

## Cron API {#cron-api}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/crons` | Key | List jobs (filtered to key's accessible agents) |
| `GET` | `/api/v1/crons/status` | Key | Scheduler status (total, enabled, running) |
| `POST` | `/api/v1/crons` | Key | Create a new job |
| `GET` | `/api/v1/crons/:id` | Key | Get a single job |
| `PUT` | `/api/v1/crons/:id` | Key | Update a job |
| `DELETE` | `/api/v1/crons/:id` | Key | Delete a job |
| `POST` | `/api/v1/crons/:id/run` | Key | Trigger a job manually |
| `GET` | `/api/v1/crons/:id/runs` | Key | Get run history (last 20 by default) |

## Chat History API {#chat-history-api}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/sessions` | Admin | List all sessions across all agents (nested by agent) |
| `GET` | `/api/v1/agents/:agentId/chats` | Key | List all chats for an agent |
| `GET` | `/api/v1/agents/:agentId/chats/:chatId/sessions` | Key | List sessions for a specific chat |
| `GET` | `/api/v1/agents/:agentId/chats/:chatId/messages` | Key | Paginated message history (cursor-based) |
| `GET` | `/api/v1/agents/:agentId/chats/:chatId/messages/search` | Key | Full-text search across messages (SQLite FTS5) |
| `GET` | `/api/v1/agents/:agentId/chats/:chatId/messages/active-days` | Key | Distinct local calendar days with >= 1 message in a window (jump-to-date dots) |
| `POST` | `/api/v1/agents/:agentId/chats/:chatId/sessions/:sessionId/messages` | Key | Inject a message into an existing channel session (SSE stream) |

## Media API {#media-api}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/agents/:agentId/media` | Key | Upload a media file (image/* or PDF) — returns `mediaPath` |
| `GET` | `/api/v1/agents/:agentId/media/*` | Key | Serve a media file by path |

## File Share Bridge API {#file-share-bridge-api}

See [File Share Bridge API](/api/shares).

## PTY Shell API {#pty-shell-api}

See [PTY Shell API](/api/pty).
