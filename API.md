# Claude Gateway — API Reference

All API endpoints require an API key configured in `config.json`. Pass it via:
- `X-Api-Key: <key>` header
- `Authorization: Bearer <key>` header

---

## Endpoints Overview

### System

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Liveness only — returns `{"status":"ok"}` (no agent list) |
| `GET` | `/status` | Admin key or dashboard session¹ | Per-agent stats + heartbeat history |
| `GET` | `/processes` | Admin key or dashboard session¹ | Host process tree for the dashboard |
| `GET` | `/knowledge/graph` | Admin key or dashboard session¹ | Memory-wiki as `{ nodes, edges, demo, scope }` for the dashboard **Knowledge base** tab. `?scope=shared` (default) = the cross-agent Shared KB; `?scope=agent:<id>` = that agent's Lane-2 memory (`workspace/memory/*.md`, id validated against the known-agents allowlist). Computed on-demand (independent of `gateway.knowledge.shared.graph` and the nightly reindex). Shared scope serves a labelled demo (`demo:true`) when empty; `?demo=off` returns the real model; `?demo=<N>` a synthetic N-node graph for scale testing |
| `GET` | `/knowledge/sources` | Admin key or dashboard session¹ | Graph sources for the KB tab's selector: `{ sources: [{ id, label, count }] }` — the Shared KB plus every agent with ≥1 Lane-2 memory note |
| `GET` | `/knowledge/note` | Admin key or dashboard session¹ | Full Markdown body of one note for the KB tab's detail section: `{ id, scope, path, updated, body }` (frontmatter stripped, ≤20 KB; `path` = gateway-root-relative location, `updated` = ISO last-modified). `?scope=shared\|agent:<id>` selects the vault (same allowlist guard as `/knowledge/graph`); `?id=<relPath>.md` must be a `.md` path that resolves **inside** that vault (no traversal) |
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

### Terminal viewer (`/cli`)

The `/cli` chat command opens a live, **agent-scoped** webview terminal for an agent
running with `gateway.headless: false`. Unlike `/dashboard` (admin, host-wide), a `/cli`
session can only ever reach the single agent that the pairing was created for — it never
issues or accepts the admin `dash_session` cookie. Requires `gateway.publicUrl` to be set
(the absolute, externally-reachable origin used to build the link); when unset, `/cli`
replies that the viewer is not configured.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/cli/:pairingId` | Pairing (binds the browser) | Device page — "waiting for approval" (Discord/LINE) or Telegram Mini App initData submit |
| `GET` | `/cli/:pairingId/status` | `cli_pair` cookie | Poll; issues the agent-scoped `cli_session` cookie once approved |
| `POST` | `/cli/:pairingId/tg-init` | Telegram initData | Verify the signed initData (HMAC with the agent's bot token) and unlock |
| `GET` | `/cli/:pairingId/view` | `cli_session` cookie | The xterm.js viewer, scoped to the pairing's agent (read-only by default) |
| `GET` | `/cli/:pairingId/sessions` | `cli_session` cookie | The agent's live `pty-shell` sessions to attach to |
| `POST` | `/cli/:pairingId/pty-ticket` | `cli_session` cookie | One-time PTY ticket, validated to belong to the pairing's agent |

**Authorization model.** The link is not a credential. Unlocking requires proof bound to
an allowlist-gated chat action: **Telegram** submits a signed Mini App `initData` (verified
against the agent's bot token; the `initData` user must match the pairing's user), while
**Discord** and **LINE** require the operator to tap **Approve** in the chat. The first
browser to open a link owns it (a link opened in a second browser is rejected), and the
`cli_pair` / `cli_session` cookies are `HttpOnly` and scoped to the pairing's path only.

### Agent API

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

### Session Management API

All session endpoints require `chat_id` (query param for GET/DELETE, body for POST/PATCH).
Sessions are stored at `sessions/api-{chat_id}/` — symmetric with `telegram-{id}` and `discord-{id}`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/sessions` | Key | List API sessions for a `chat_id` |
| `POST` | `/api/v1/agents/:agentId/sessions` | Key | Create a new API session (auto-names from prompt) |
| `GET` | `/api/v1/agents/:agentId/sessions/:sessionId/info` | Key | Get session info (name, message count, context %) |
| `GET` | `/api/v1/agents/:agentId/sessions/:sessionId/stream` | Key | Re-attach to the session's in-flight turn (SSE, resumable from a `seq` cursor) |
| `PATCH` | `/api/v1/agents/:agentId/sessions/:sessionId` | Key | Rename a session |
| `DELETE` | `/api/v1/agents/:agentId/sessions/:sessionId` | Key | Delete a session |
| `POST` | `/api/v1/agents/:agentId/sessions/:sessionId/clear` | Key | Clear session history |
| `POST` | `/api/v1/agents/:agentId/sessions/:sessionId/compact` | Key | Summarise old history, keep only recent messages |
| `POST` | `/api/v1/agents/:agentId/sessions/:sessionId/stop` | Key | Interrupt the in-flight turn |
| `POST` | `/api/v1/agents/:agentId/sessions/:sessionId/restart` | Key | Graceful session restart |
| `POST` | `/api/v1/agents/:agentId/sessions/:sessionId/attachments` | Key | Register file paths as attachments for the current turn (called internally by `api_reply` MCP tool) |

### Workspace File API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/files/:filename` | Key | Read a workspace file |
| `PUT` | `/api/v1/agents/:agentId/files/:filename` | Write | Write a workspace file |

### Telegram Channel API

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

### Discord Channel API

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

### Public Webhook Ingress

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/webhooks/:app` | None (self-authenticating) | Provider URL-verification probe |
| `GET` | `/webhooks/:app/:agentId` | None (self-authenticating) | Provider URL-verification probe, agent-scoped |
| `POST` | `/webhooks/:app` | None (self-authenticating) | Inbound webhook delivery — first agent with `:app` configured |
| `POST` | `/webhooks/:app/:agentId` | None (self-authenticating) | Inbound webhook delivery — specific agent |

### Skill API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/skills` | Key | List all skills (workspace + module + shared) |
| `GET` | `/api/v1/agents/:agentId/skills/:name` | Key | Get a single skill's content |
| `POST` | `/api/v1/agents/:agentId/skills` | Write | Create a new skill |
| `POST` | `/api/v1/agents/:agentId/skills/install` | Admin | Install a skill from a GitHub/raw URL |
| `DELETE` | `/api/v1/agents/:agentId/skills/:name` | Write | Delete a skill |
| `GET` | `/api/v1/agents/:agentId/skill-metrics` | Key | Skill self-improvement effectiveness rollup |
| `GET` | `/api/v1/agents/:agentId/memory-metrics` | Key | Two-lane memory metrics: budget hygiene, archive/shared coverage, dreaming ledger, session-drop invariant |

### App Store API

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

Backup retention (`gateway.appBackup`): backups are pruned by the **union** of a count cap and an age cap — a backup is removed when it exceeds `retention` (keep N newest per app, default **3**, `0` = unbounded) **or** is older than `maxAgeDays` (default **30**, `0` = disabled). Pruning runs after each successful backup and once per day via a scheduler at `cleanupHour` (0-23, default `0`) in `cleanupTimezone` (IANA, default `"UTC"`).

Boot restore (`gateway.appRestore`): at startup every app stored as `running` is brought back up in the background. When an image the app needs is missing from the local daemon, the restore first runs `docker compose pull --ignore-buildable` and `docker compose build`, each under `buildTimeoutMs` (default **1800000**, 30 min); it then runs `docker compose up -d --wait` under `waitTimeoutMs` (default **180000**, 3 min). The two budgets are separate because a timeout SIGKILLs the compose CLI, and while that only abandons the *healthcheck wait* once images exist, it **cancels an in-progress build** — so a cold host with no image cache must not have its rebuild bounded by the short wait budget. When the images are already present both cold-start steps are skipped entirely, so a warm reboot is unaffected. Any non-numeric, non-finite or non-positive value falls back to the default. See `restoreError` under `GET /api/v1/apps`.

### Connectors API

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

### Cron API

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

### Chat History API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/sessions` | Admin | List all sessions across all agents (nested by agent) |
| `GET` | `/api/v1/agents/:agentId/chats` | Key | List all chats for an agent |
| `GET` | `/api/v1/agents/:agentId/chats/:chatId/sessions` | Key | List sessions for a specific chat |
| `GET` | `/api/v1/agents/:agentId/chats/:chatId/messages` | Key | Paginated message history (cursor-based) |
| `GET` | `/api/v1/agents/:agentId/chats/:chatId/messages/search` | Key | Full-text search across messages (SQLite FTS5) |
| `GET` | `/api/v1/agents/:agentId/chats/:chatId/messages/active-days` | Key | Distinct local calendar days with >= 1 message in a window (jump-to-date dots) |
| `POST` | `/api/v1/agents/:agentId/chats/:chatId/sessions/:sessionId/messages` | Key | Inject a message into an existing channel session (SSE stream) |

### Media API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/agents/:agentId/media` | Key | Upload a media file (image/* or PDF) — returns `mediaPath` |
| `GET` | `/api/v1/agents/:agentId/media/*` | Key | Serve a media file by path |

### File Share Bridge API

Short-lived public file shares + private image artifacts (enabled only when
`gateway.publicUrl` is set). A token IS the capability — only its SHA-256 hash is
stored, and shares are unenumerable (there is no list endpoint by design).
**The default allowlist is raster images only (PNG / JPEG / WebP);** any other
type is rejected with `415 unsupported_file_type` at both mint and fetch time.
A mint may pass `allow_documents: true` to widen the allowlist to PDF for that
request; the allow-kind is then recorded **per share, narrowed to what the ref
actually validated as** — a PNG in an `allow_documents` batch is still stored as
image-only — and the file is **re-sniffed on every fetch**, so replacing the file
behind a live share never widens what it serves. `agent_id` and `session_id`
must be valid identifiers (same charset as elsewhere) or the request is `400`
before any path resolution.

> **Upgrade / rollback note (#444).** The share table was renamed
> `image_shares` → `file_shares`. Upgrading renames in place, so shares minted
> before the upgrade keep resolving. **Rolling back across #444 does not:** the
> older build recreates an empty `image_shares` and every still-live share URL
> returns `404` until it expires (bounded by the 24 h max TTL — nothing durable
> is lost, since shares are ephemeral by design). Rolling forward again folds
> any rows the older build minted back into `file_shares` and drops the orphan
> table, logging `[share] migrated legacy image_shares:` with the row counts.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/shares` | Key (agent-scoped) | Mint one or more shares for artifact refs / media paths → `{ items: [{ share_id, token, url?, expires_at, task_id?, provider?, prior_prompt? }] }` (order preserved; TTL 10s–24h, default 30 min; idempotent within a 60s window, keyed by allow-kind as well as ref). Optional `allow_documents: true` widens this request's allowlist to PDF; anything non-boolean is `400`. `token` is a host-agnostic capability and is always present; `url` is a convenience built from `gateway.publicUrl` and is omitted when that is unset — callers with their own public base (e.g. LINE) build `<base>/shared/<token>` themselves. `task_id`/`provider`/`prior_prompt` are echoed **only for artifact refs** (never path refs) and only when the artifact's generation recorded them — `task_id`/`provider` are the provider-side handle a resume-capable backend needs (absent when the generating provider has no resume concept), and `prior_prompt` is the prompt that produced the artifact; `generate_image`'s `continue_from` consumes these to resume or hand off an edit session |
| `DELETE` | `/api/v1/shares/:shareId` | Key (owner/admin) | Revoke a share (uniform `404` when the key can't access the owner) |
| `POST` | `/api/v1/image-artifacts` | Key (agent-scoped) | Register generated images as private artifacts (registration never makes a file public) |
| `GET` | `/api/v1/image-catalog?agent_id=&session_id=` | Key (agent-scoped) | Deterministic per-session image list (oldest first); mints nothing, returns no token |
| `GET`/`HEAD` | `/shared/:token` | None (token IS the capability) | Stream the shared file — images `inline`, documents as an `attachment` whose filename is sanitised (RFC 8187) and whose **extension is forced to match the sniffed type**, not the agent-chosen basename (so `%PDF-` bytes named `invoice.html` download as `invoice.pdf`); always `X-Content-Type-Options: nosniff`; uniform `404` for unknown/expired/revoked/traversal/type-mismatch; per-IP rate limited. This is the single public share primitive — the gateway, MCP subprocesses, and LINE image delivery all mint through `/api/v1/shares` and serve here |

**Renamed in #444** (the bridge is no longer image-only):

| Kind | Was | Now |
|------|-----|-----|
| Error code | `image_ref_not_found` | `share_ref_not_found` |
| Error code | `image_too_large` | `file_too_large` |
| Error code | `unsupported_image_type` | `unsupported_file_type` |
| MCP tool | `share_image` | `share_file` (old name kept as a deprecated alias, still image-only — only `share_file` opts into documents) |
| Env vars | `IMAGE_SHARE_*` | `SHARE_*` (legacy names still read as a fallback) |
| SQLite table | `image_shares` | `file_shares` (renamed in place on first open) |

The error codes are the only breaking part: `code` values in `4xx` bodies changed.
HTTP statuses, request/response shapes and the token format are unchanged.

### PTY Shell API

Available only for agents running in wrap-shell (PTY) mode (`gateway.headless: false`).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/sessions/:sessionId/screen` | Key | Read the current visible screen as plain text — ANSI stripped, trailing blanks removed |

**Response:**

```json
{
  "text": "plain text content of the screen\ncursor is here",
  "cursorRow": 12,
  "cursorCol": 4,
  "cols": 200,
  "rows": 50
}
```

- `text` — visible screen rows joined by `\n`, trailing blank lines stripped. Suitable for agent consumption (detect menus, prompts, hang states).
- `cursorRow` / `cursorCol` — zero-based cursor position in the terminal grid.
- `cols` / `rows` — terminal dimensions (matches server PTY size).

Returns `404` if the session does not exist or is not running in wrap-shell mode.

**Example:**

```bash
curl -s http://localhost:10850/api/v1/sessions/<sessionId>/screen \
  -H "X-Api-Key: <key>"
```

The `sessionId` is the gateway session UUID. Find it from the process list:

```bash
# /processes requires an admin API key when gateway.api.keys is configured
curl -s -H "X-Api-Key: $KEY" http://localhost:10850/processes | grep -o 'sessions/[^/]*' | head -1
```

#### Live screen stream (WebSocket)

For a real-time mirror of the PTY (instead of a one-shot snapshot), connect to the
PTY stream WebSocket. Streams are **per session**, so a `session` is always required —
each session of an agent is an isolated stream.

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST` | `/api/v1/pty-stream-ticket` | Admin key *or* dashboard session | Exchange an **admin** API key **or** the `dash_session` cookie for a one-time, 30s-TTL ticket bound to a specific `{ agentId, sessionId }` |
| `WS` | `/api/v1/agents/:agentId/pty-stream` | Ticket *or* Key | Subscribe to the live PTY stream for one session |

> The browser dashboard authenticates with the `HttpOnly; SameSite=Lax` `dash_session`
> cookie (from `POST /dashboard/login`), which is sent automatically — it no longer embeds
> any token in the page. `POST /api/v1/pty-stream-ticket` accepts that cookie, so
> the ticket flow works without a token in the HTML or the WS URL.

**Auth path 1 — ephemeral ticket (used by the browser viewer):**

```bash
# 1. Mint a ticket (the ticket is bound to this sessionId)
curl -s -X POST http://localhost:10850/api/v1/pty-stream-ticket \
  -H "X-Api-Key: <key>" -H "Content-Type: application/json" \
  -d '{"agentId":"<agentId>","sessionId":"<sessionId>"}'
# → { "ticket": "<hex>", "expiresAt": "..." }

# 2. Connect (no API key on the URL — the ticket carries the session binding)
#    ws://localhost:10850/api/v1/agents/<agentId>/pty-stream?ticket=<hex>
```

**Auth path 2 — header auth (programmatic clients):** pass the API key as a header
(`X-Api-Key` or `Authorization: Bearer`) **and** the session as a query param:

```
ws://localhost:10850/api/v1/agents/<agentId>/pty-stream?session=<sessionId>
```

> **Required:** the header-auth path returns `400 Bad Request` if `?session=` is
> omitted (streams are per session — there is no agent-wide stream). The ticket path
> does not need `?session=` because the ticket is already bound to one session.

Closes with code `4404` if the session is not running in PTY mode.

**Direction:** the stream is server → client (live PTY output) by default, and the socket is bidirectional: inbound **text** frames carry raw keystroke bytes that are written into the live PTY (interactive terminal mode), bounded per frame and dropped for headless sessions. A dashboard viewer only sends these frames while its mode toggle is in input mode (a client-side choice); binary and oversized/empty frames are always dropped. Access is protected by the socket's auth (ticket/API key) and the localhost-default [`gateway.bind`](README.md#gatewaybind) — see the [Terminal Viewer](README.md#terminal-viewer--interactive-terminal-mode) docs.

**Auth levels:** `Key` = any valid API key, `Write` = key with write access to the agent, `Admin` = key with `agents: "*"`.

---

## System Endpoints

### GET /health

Liveness check. No auth required. Intentionally minimal — it returns **only**
liveness so it is safe to expose to external probes even when the gateway is bound
to a non-loopback interface. Agent ids moved to `/status` (authenticated).

```bash
curl http://localhost:10850/health
```

```json
{ "status": "ok" }
```

---

### GET /status

Per-agent stats and heartbeat history. **Requires an _admin_ API key or a dashboard
session cookie when `gateway.api.keys` is configured** (open otherwise). Returns 401
when keys are set and no valid admin credential is supplied (a valid non-admin key is
also rejected).

```bash
# API key
curl -H "X-Api-Key: $KEY" http://localhost:10850/status | jq
```

```json
{
  "agents": [
    {
      "id": "alfred",
      "isRunning": true,
      "messagesReceived": 12,
      "messagesSent": 48,
      "lastActivityAt": "2026-05-10T02:00:00.000Z",
      "heartbeat": {
        "tasks": ["morning-check"],
        "lastResults": [
          { "taskName": "morning-check", "suppressed": false, "rateLimited": false, "durationMs": 1200, "ts": 1746835200000 }
        ]
      },
      "sessions": [
        { "chatId": "<CHAT_ID>", "messageCount": 5, "lastActivity": "2026-05-10T01:50:00.000Z" }
      ]
    }
  ],
  "uptime": 3600,
  "startedAt": "2026-05-10T01:00:00.000Z"
}
```

---

### GET /ui

Serves the web UI dashboard. No auth required.

---

### GET /api/v1/commands

List the slash commands available in the chat UI. No auth required.

```bash
curl http://localhost:10850/api/v1/commands | jq
```

```json
{
  "commands": [
    { "name": "/session",  "description": "Show current session info (name, message count, context %)" },
    { "name": "/clear",    "description": "Clear current session history" },
    { "name": "/compact",  "description": "Summarise old history and keep only recent messages" },
    { "name": "/stop",     "description": "Interrupt the in-flight turn" },
    { "name": "/restart",  "description": "Graceful session restart" },
    { "name": "/model",    "description": "Show the current AI model" }
  ]
}
```

---

### GET /api/v1/_meta/routes

Returns the route manifest: every endpoint registered via `defineRoute` in the API
routers, each with its method, path, auth level, and (where exposed) its CLI
`noun`/`verb` mapping. `scripts/gen-cli.ts` reads this manifest offline to generate
the CLI's command table (`src/cli/commands.generated.ts`) and `CLI.md`; the endpoint
itself is for runtime verification (e.g. `claude-gateway doctor`), not for building
commands at request time. Requires a valid API key.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/_meta/routes | jq
```

```json
{
  "routes": [
    {
      "method": "GET",
      "path": "/v1/crons",
      "auth": "key",
      "summary": "List cron jobs accessible by this key",
      "cli": { "noun": "crons", "verb": "list", "args": [], "flags": [{ "name": "agent", "in": "query" }] }
    }
  ]
}
```

---

## Agent API

### Setup

**1. Add an API key to `config.json`**

```json
{
  "gateway": {
    "api": {
      "keys": [
        {
          "key": "my-secret-key-123",
          "description": "My app",
          "agents": ["alfred"]
        },
        {
          "key": "admin-key-456",
          "description": "Admin — full access",
          "agents": "*"
        },
        {
          "key": "automation-key-789",
          "description": "Automation — may use tools",
          "agents": ["alfred"],
          "allow_tools": true
        }
      ]
    }
  }
}
```

`agents` can be an array of agent IDs or `"*"` for full access. Keys support `${ENV_VAR}` interpolation.

`allow_tools` grants the key permission to invoke tools (Read, Bash, Grep, etc.). Tool access is governed entirely by this config — no extra field is needed in the request body. Keys without `allow_tools: true` are always conversational regardless of what the request contains.

**2. Restart the gateway**

```bash
npm start
```

---

### GET /api/v1/agents

List agents accessible by the provided API key.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/agents | jq
```

```json
{
  "agents": [
    { "id": "alfred", "name": null, "description": "Personal assistant", "model": "claude-sonnet-4-6", "allow_tools": false }
  ]
}
```

`name` is an optional display name (`null` when unset); the UI falls back to `id` in that case.

---

### POST /api/v1/agents

Create a new agent entry in `config.json`. Requires admin key. Also creates the workspace directory with stub files (`AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`).

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Agent ID — pattern `[a-z][a-z0-9_-]{1,31}` |
| `description` | Yes | Human-readable description |
| `model` | No | Claude model ID (default: `claude-sonnet-4-6`) |
| `allow_tools` | No | Whether the agent may invoke tools when accessed via the API channel (default: `true`). Pass `false` to create a conversational-only agent. |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-bot", "description": "My new bot", "model": "claude-sonnet-4-6"}' \
  http://localhost:10850/api/v1/agents | jq
```

```json
{ "agent": { "id": "my-bot", "description": "My new bot", "model": "claude-sonnet-4-6", "allow_tools": true } }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Invalid `id` format, missing `description`, or non-boolean `allow_tools` |
| 403 | Not an admin key |
| 409 | Agent ID already exists |
| 501 | Gateway started without a config path |

---

### PATCH /api/v1/agents/:agentId

Update an agent's display name, description, model, allow_tools flag, or connector enablement. Requires write access to the agent; the `connectors` field additionally requires **admin** (see below). Only fields provided are updated.

**Request body (all optional):**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string \| null | Display name shown in the UI instead of `id`. Empty string or `null` clears it (falls back to `id`) |
| `description` | string | New description |
| `model` | string | New Claude model ID |
| `allow_tools` | boolean | Override tool access for this agent |
| `connectors` | object | **Admin only** — a non-admin key gets `403`. Per-connector enablement, `{ "<connectorId>": { "enabled": boolean } }`. **Merged** into the agent's existing map, not replacing it — send only the ids you are changing. `enabled` must be a boolean, and each key must be a valid connector id (`^[a-z0-9][a-z0-9-]*$`, max 64 chars), or the request is `400` |

`connectors` is the one field on this route that is admin-gated, because it is the only one that reaches a credential somebody else owns: every route under [Connectors API](#connectors-api) is admin-only, and enabling a connector here resolves that connector's secret into the agent's MCP config at spawn. Under [`gateway.connectorsDefaultEnabled: false`](README.md#gatewayconnectorsdefaultenabled-optional) a `write` key scoped to a single agent could otherwise hand that agent any token an admin had connected.

Enablement is **opt-out**: a connected connector is available to every agent unless that agent explicitly sets `{"enabled": false}`. Connecting the connector at all is the security gate — see [Connectors API](#connectors-api). A multi-owner deployment can flip this to opt-in with [`gateway.connectorsDefaultEnabled: false`](README.md#gatewayconnectorsdefaultenabled-optional).

Ids are validated for **shape only, not existence** — pre-setting `{"enabled": false}` for a connector nobody has added yet is a legitimate way to keep it off an agent from the moment it appears.

Changing `connectors` restarts the agent's sessions so the new MCP set takes effect: a running session's MCP subprocess has the old connector set baked into its env and cannot be hot-patched. The restart is lossless — a busy session finishes its current turn and restarts after it, an idle channel session is armed to restart on its next message, and only `api` / heartbeat sessions (which respawn fresh on next use anyway) are stopped right away. Nothing in flight is killed.

```bash
curl -X PATCH \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"connectors": {"github": {"enabled": false}}}' \
  http://localhost:10850/api/v1/agents/alfred | jq
```

```bash
curl -X PATCH \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-8"}' \
  http://localhost:10850/api/v1/agents/alfred | jq
```

```json
{ "agent": { "id": "alfred", "name": null, "description": "Personal assistant", "model": "claude-opus-4-8", "allow_tools": false } }
```

---

### PUT /api/v1/agents/:agentId/avatar

Upload or replace an agent's avatar image. Requires **write** access to the agent.

**Request:** raw image binary as the request body.

| Constraint | Value |
|------------|-------|
| Allowed types | `image/jpeg`, `image/png`, `image/webp`, `image/gif` |
| Max size | 5 MB |
| Type detection | Magic bytes (ignores Content-Type header) |

```bash
curl -X PUT \
  -H "X-Api-Key: write-key" \
  --data-binary @avatar.png \
  http://localhost:10850/api/v1/agents/alfred/avatar | jq
```

```json
{ "avatarUrl": "/api/v1/agents/alfred/avatar" }
```

The file is written to `~/.claude-gateway/agents/{agentId}/avatar.{ext}` and the `avatar` field in `config.json` is updated. If an old avatar exists with a different extension, it is removed.

**Error responses:**

| Status | When |
|--------|------|
| 400 | Empty body or file too small |
| 403 | Write permission required |
| 413 | File exceeds 5 MB |
| 415 | Unrecognised image format |

---

### DELETE /api/v1/agents/:agentId/avatar

Remove an agent's avatar. Requires **write** access. Returns `204 No Content` on success.

```bash
curl -X DELETE \
  -H "X-Api-Key: write-key" \
  http://localhost:10850/api/v1/agents/alfred/avatar
```

---

### GET /api/v1/agents/:agentId/avatar

Serve the agent's avatar image. Requires read access to the agent.

- `Cache-Control: private, max-age=3600`
- Returns the raw image bytes with the correct `Content-Type`
- Returns `404` if no avatar has been set or the file is missing

```bash
curl -H "X-Api-Key: my-key" \
  http://localhost:10850/api/v1/agents/alfred/avatar -o avatar.png
```

---

### Wizard API — multi-step agent creation

The Wizard API mirrors the interactive `claude-gateway agents create` terminal wizard but is consumable by web UIs and automation. State is kept **in memory** with a 30-minute TTL (refreshed on each step transition); nothing is written to disk until the `/confirm` step.

**State machine:**

```
start → (optional avatar upload) → confirm → (optional channel) → (verify) → complete
```

---

#### POST /api/v1/agents/wizard/start

**Auth:** admin key.

Calls Claude to generate workspace markdown files based on your prompt. Returns a `wizardId` for subsequent steps.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Agent ID — pattern `[a-z][a-z0-9_-]{1,31}` |
| `prompt` | Yes | Natural-language description of the agent |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"id": "cryptobot", "prompt": "A helpful assistant that specialises in crypto analysis, speaks Thai..."}' \
  http://localhost:10850/api/v1/agents/wizard/start | jq
```

```json
{
  "wizardId": "550e8400-e29b-41d4-a716-446655440000",
  "agentId": "cryptobot",
  "files": {
    "AGENTS.md": "# Agent: Cryptobot\n\n...",
    "SOUL.md": "...",
    "USER.md": "...",
    "MEMORY.md": ""
  },
  "expiresAt": "2026-05-15T09:03:00Z"
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Invalid `id` format or missing `prompt` |
| 403 | Not an admin key |
| 409 | Agent or wizard already exists for this ID |
| 429 | Too many wizard starts in progress (max 2 concurrent) |
| 500 | Claude generation failed |

---

#### PUT /api/v1/agents/wizard/:wizardId/avatar

**Auth:** admin key. Optional step before `/confirm`.

Upload an avatar for the agent being created. The image is held in memory and written to disk during `/confirm`.

**Request:** raw image binary (same constraints as the regular avatar upload — 5 MB max, jpeg/png/webp/gif).

```json
{ "preview": true }
```

---

#### POST /api/v1/agents/wizard/:wizardId/confirm

**Auth:** admin key.

Write workspace files and avatar to disk, add the agent to `config.json`, and trigger a hot-reload so the agent starts automatically.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `files` | No | Map of filename → content. If omitted, the files generated in `/start` are used. Must include `AGENTS.md`. |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"files": {"AGENTS.md": "# Agent: Cryptobot\n\n...", "SOUL.md": "..."}}' \
  http://localhost:10850/api/v1/agents/wizard/550e8400.../confirm | jq
```

```json
{
  "agentId": "cryptobot",
  "avatarUrl": "/api/v1/agents/cryptobot/avatar",
  "next": "channel via POST /api/v1/agents/wizard/.../channel, or skip via POST .../complete"
}
```

---

#### POST /api/v1/agents/wizard/:wizardId/channel

**Auth:** admin key. Optional step after `/confirm`.

**Token-only connect.** Verify a Telegram or Discord bot token, persist it to the
agent config, seed a secure `access.json`, and hot-start the receiver so the bot
comes online immediately. **No pairing code is minted here** — pairing is
incoming-first and happens later: the owner (or a group member) DMs the bot, a
one-time code lands in Pending, and an admin approves it from the agent's
Channels card (see the Telegram/Discord Channel APIs below). This mirrors the
LINE flow.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `channel` | Yes | `"telegram"` or `"discord"` |
| `botToken` | Yes | Bot token from BotFather / Discord Developer Portal |

**Response:**

```json
{
  "channel": "telegram",
  "botName": "@my_crypto_bot",
  "connected": true
}
```

The wizard advances to step `complete`. A brand-new connection is seeded with a
closed-but-pairing-on `access.json` (`dmPolicy: "allowlist"`, `pairing: true`),
so the owner can DM the bot and self-approve via a code.

---

#### POST /api/v1/agents/wizard/:wizardId/complete

**Auth:** admin key.

Finalise the wizard and clean up state. Can be called after `/confirm` to skip
channel setup entirely, or after `/channel` (the agent keeps whatever channel was
connected). Rejected with `409` only while the wizard is still in step `pending`
(the workspace must be confirmed first).

```json
{ "agentId": "cryptobot" }
```

---

### DELETE /api/v1/agents/:agentId

Remove an agent from `config.json` and stop the running process. Requires admin key. Does **not** delete the workspace directory.

```bash
curl -X DELETE \
  -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/my-bot | jq
```

```json
{ "success": true, "id": "my-bot" }
```

---

## Telegram Channel API

Manage Telegram access control per agent — pending pairings, allowlist, and DM policy. All endpoints require an **admin** key.

### Endpoints Overview

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/telegram/pending` | Admin | List pending (non-expired) pairing requests |
| `POST` | `/api/v1/agents/:agentId/telegram/approve` | Admin | Approve a pending pairing by code (kind-aware) |
| `POST` | `/api/v1/agents/:agentId/telegram/deny` | Admin | Deny and remove a pending pairing by code |
| `PATCH` | `/api/v1/agents/:agentId/telegram/policy` | Admin | Update DM policy, pairing toggle, group policy and/or mention gate |
| `GET` | `/api/v1/agents/:agentId/telegram/allowlist` | Admin | List all users in the allowlist |
| `DELETE` | `/api/v1/agents/:agentId/telegram/allow/:userId` | Admin | Remove a user from the allowlist |
| `GET` | `/api/v1/agents/:agentId/telegram/group/allowlist` | Admin | List allowlisted group ids |
| `DELETE` | `/api/v1/agents/:agentId/telegram/group/allow/:groupId` | Admin | Remove a group from the group allowlist |

---

### GET /api/v1/agents/:agentId/telegram/pending

List all pending (non-expired) Telegram pairing requests for an agent. Expired entries are cleaned up automatically on this call.

```bash
curl -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/telegram/pending | jq
```

```json
{
  "pending": [
    {
      "code": "A3F9C1",
      "senderId": "123456789",
      "chatId": "123456789",
      "createdAt": 1775737709000,
      "expiresAt": 1775738309000,
      "kind": "dm"
    }
  ]
}
```

`kind` is `"dm"` for a direct-message knock or `"group"` for a group knock (for a
group knock, `chatId` holds the group id).

---

### POST /api/v1/agents/:agentId/telegram/approve

Approve a pending pairing by its 6-character code. **Kind-aware:** a `"dm"` knock
adds the sender to `allowFrom` and drops an `approved/<senderId>` handshake file
so the receiver sends a confirmation; a `"group"` knock adds its `chatId` to
`groupAllowlist` (no handshake — a group has no single recipient).

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `code` | Yes | 6-character pairing code |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"code": "A3F9C1"}' \
  http://localhost:10850/api/v1/agents/alfred/telegram/approve | jq
```

```json
{ "ok": true, "senderId": "123456789" }
```

For a group knock the response also carries `"groupId"`:

```json
{ "ok": true, "senderId": "123456789", "groupId": "-1001234567890" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `code` missing |
| 404 | Code not found or expired |

---

### POST /api/v1/agents/:agentId/telegram/deny

Deny and remove a pending pairing request by code.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `code` | Yes | 6-character pairing code |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"code": "A3F9C1"}' \
  http://localhost:10850/api/v1/agents/alfred/telegram/deny | jq
```

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `code` missing |
| 404 | Code not found |

---

### PATCH /api/v1/agents/:agentId/telegram/policy

Update the DM policy, the orthogonal pairing toggle, the group policy and/or the
group mention gate. **At least one field must be present**; each is applied only
if provided.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `dmPolicy` | No | One of `open`, `allowlist`, `disabled` |
| `pairing` | No | Boolean. When `dmPolicy` is `allowlist`: `true` mints a one-time code for an unknown sender; `false` silently drops (pure allowlist). Ignored for `open`/`disabled` |
| `groupPolicy` | No | One of `open`, `allowlist`, `disabled` — base policy for groups |
| `requireMention` | No | Boolean. When `true`, group messages are delivered only when the bot is @mentioned |

```bash
curl -X PATCH \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"dmPolicy": "allowlist", "pairing": true, "groupPolicy": "allowlist", "requireMention": true}' \
  http://localhost:10850/api/v1/agents/alfred/telegram/policy | jq
```

```json
{ "ok": true, "dmPolicy": "allowlist", "pairing": true, "groupPolicy": "allowlist", "requireMention": true }
```

> **Note:** `pairing` is now a separate boolean, **not** a `dmPolicy` value. A
> legacy `dmPolicy: "pairing"` file migrates automatically to
> `dmPolicy: "allowlist"` + `pairing: true`.

**Policy values (`dmPolicy` / `groupPolicy`):**

| Value | Behaviour |
|-------|-----------|
| `open` | Any user / any group can message the bot (senders/groups are captured into the allowlist) |
| `allowlist` | Only allowlisted users / groups can message; unknown senders get a pairing code when `pairing: true`, else are dropped |
| `disabled` | No messages accepted |

**Error responses:**

| Status | When |
|--------|------|
| 400 | Invalid value, non-boolean `pairing`/`requireMention`, or no field provided |

---

### GET /api/v1/agents/:agentId/telegram/allowlist

Return all users in the `allowFrom` list for the agent's Telegram channel.

```bash
curl -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/telegram/allowlist | jq
```

```json
{ "allowFrom": ["123456789", "987654321"] }
```

---

### DELETE /api/v1/agents/:agentId/telegram/allow/:userId

Remove a user from the `allowFrom` list. `:userId` must be a numeric Telegram user ID.

```bash
curl -X DELETE \
  -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/telegram/allow/123456789 | jq
```

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `userId` is not numeric |
| 404 | Agent not found |

---

### GET /api/v1/agents/:agentId/telegram/group/allowlist

Return the allowlisted group ids for the agent's Telegram channel.

```bash
curl -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/telegram/group/allowlist | jq
```

```json
{ "groupAllowlist": ["-1001234567890"] }
```

---

### DELETE /api/v1/agents/:agentId/telegram/group/allow/:groupId

Remove a group from the `groupAllowlist`. Telegram group ids are negative, so a
leading minus is allowed (e.g. `-1001234567890`). Also drops any legacy per-sender
restriction retained for that group.

```bash
curl -X DELETE \
  -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/telegram/group/allow/-1001234567890 | jq
```

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `groupId` is not a numeric Telegram chat ID |
| 404 | Agent not found |

---

## Discord Channel Management

Incoming-first pairing for Discord, mirroring the Telegram model. DMs use
`dmPolicy` + the `pairing` toggle; guilds (servers) use `groupPolicy` +
`guildAllowlist` + a single `requireMention` gate. `channelAllowlist` and
`roleAllowlist` remain backend-only filters. Guild ids are numeric snowflakes
(no leading minus).

### Endpoints Overview

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/discord/pending` | Admin | List pending (non-expired) pairing requests |
| `POST` | `/api/v1/agents/:agentId/discord/approve` | Admin | Approve a pending pairing by code (kind-aware) |
| `POST` | `/api/v1/agents/:agentId/discord/deny` | Admin | Deny and remove a pending pairing by code |
| `PATCH` | `/api/v1/agents/:agentId/discord/policy` | Admin | Update DM policy, pairing toggle, guild policy and/or mention gate |
| `GET` | `/api/v1/agents/:agentId/discord/allowlist` | Admin | List all users in the allowlist |
| `DELETE` | `/api/v1/agents/:agentId/discord/allow/:userId` | Admin | Remove a user from the allowlist |
| `GET` | `/api/v1/agents/:agentId/discord/guild/allowlist` | Admin | List allowlisted guild ids |
| `DELETE` | `/api/v1/agents/:agentId/discord/guild/allow/:guildId` | Admin | Remove a guild from the guild allowlist |

---

### GET /api/v1/agents/:agentId/discord/pending

List all pending (non-expired) Discord pairing requests. Expired entries are
cleaned up automatically on this call.

```json
{
  "pending": [
    {
      "code": "A3F9C1",
      "senderId": "111111111111111111",
      "channelId": "222222222222222222",
      "createdAt": 1775737709000,
      "expiresAt": 1775738309000,
      "kind": "dm",
      "guildId": null
    }
  ]
}
```

`kind` is `"dm"` or `"guild"`; for a guild knock, `guildId` holds the server id.

---

### POST /api/v1/agents/:agentId/discord/approve

Approve a pending pairing by code. **Kind-aware:** a `"dm"` knock adds the sender
to `allowFrom` and drops an `approved/<senderId>` handshake file (content is the
`channelId` to DM the "You're connected!" reply); a `"guild"` knock adds its
`guildId` to `guildAllowlist` (no handshake).

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `code` | Yes | 6-character pairing code |

```json
{ "ok": true, "senderId": "111111111111111111" }
```

For a guild knock the response also carries `"guildId"`:

```json
{ "ok": true, "senderId": "111111111111111111", "guildId": "333333333333333333" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `code` missing |
| 404 | Code not found or expired |

---

### POST /api/v1/agents/:agentId/discord/deny

Deny and remove a pending pairing request by code.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `code` | Yes | 6-character pairing code |

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `code` missing |
| 404 | Code not found |

---

### PATCH /api/v1/agents/:agentId/discord/policy

Update the DM policy, the pairing toggle, the guild policy and/or the guild
mention gate. **At least one field must be present**; each is applied only if
provided.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `dmPolicy` | No | One of `open`, `allowlist`, `disabled` |
| `pairing` | No | Boolean — same semantics as Telegram (mint code vs pure allowlist) |
| `groupPolicy` | No | One of `open`, `allowlist`, `disabled` — base policy for guilds |
| `requireMention` | No | Boolean. When `true`, guild messages are delivered only when the bot is @mentioned or replied-to |

```bash
curl -X PATCH \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"dmPolicy": "allowlist", "pairing": true, "groupPolicy": "allowlist", "requireMention": true}' \
  http://localhost:10850/api/v1/agents/alfred/discord/policy | jq
```

```json
{ "ok": true, "dmPolicy": "allowlist", "pairing": true, "groupPolicy": "allowlist", "requireMention": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Invalid value, non-boolean `pairing`/`requireMention`, or no field provided |

---

### GET /api/v1/agents/:agentId/discord/allowlist

Return all users in the `allowFrom` list for the agent's Discord channel.

```json
{ "allowFrom": ["111111111111111111"] }
```

---

### DELETE /api/v1/agents/:agentId/discord/allow/:userId

Remove a user from the `allowFrom` list. `:userId` must be a numeric Discord user ID.

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `userId` is not numeric |
| 404 | Agent not found |

---

### GET /api/v1/agents/:agentId/discord/guild/allowlist

Return the allowlisted guild ids for the agent's Discord channel.

```json
{ "guildAllowlist": ["333333333333333333"] }
```

---

### DELETE /api/v1/agents/:agentId/discord/guild/allow/:guildId

Remove a guild from the `guildAllowlist`. `:guildId` must be a numeric Discord
guild snowflake.

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `guildId` is not numeric |
| 404 | Agent not found |

---

### POST /api/v1/agents/:agentId/messages

Send a message to an agent. Returns a JSON response or SSE stream.

> **Breaking change (PR #69):** `chat_id` is now required. Messages are stored under `sessions/api-{chat_id}/` on disk.
>
> **Breaking change:** `session_id` now *resumes* a session and nothing else. An id
> the gateway has never issued returns `404 SESSION_NOT_FOUND` instead of quietly
> becoming a brand-new session under that name. Clients that minted their own ids
> must either call [`POST /sessions`](#post-apiv1agentsagentidsessions) first and
> use the id it returns, or omit `session_id` and adopt the one in the response.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `message` | Yes | Message text (max 10,000 chars), or a slash command (e.g. `/session`, `/clear`) |
| `chat_id` | Yes | Caller identity — used to namespace sessions (e.g. `"myapp"`, `"user-123"`) |
| `session_id` | No | Resume an existing session under this `chat_id`; omit to start a new one. Must already exist — an unknown id is `404`, never a new session |
| `stream` | No | `true` to enable SSE streaming (default `false`) |
| `timeout_ms` | No | Override the default response timeout in milliseconds (default 60000) |
| `media_files` | No | Array of `mediaPath` strings returned by the Media Upload endpoint |
| `store_user_message` | No | Set to `false` to skip persisting the user message in session history — only the assistant response is stored. Requires a write or admin key. Useful for proactive/trigger prompts where the user trigger should be invisible. |
| `image_params` | No | Composer-selected image-generation options, surfaced to the agent so it calls the built-in `generate_image` tool with them. An object with optional string fields `model`, `quality`, `size`, `aspect_ratio`, `image_ref` and optional positive number `n`. Empty/whitespace strings are ignored; a non-object (or `n < 1`) returns `400`. The latest sent value is persisted to session meta as `imageConfig` (see the sessions list endpoint) so a web client can restore the selection on reload. |

#### Slash command dispatch

If `message` starts with `/`, the endpoint executes the command instead of forwarding to Claude:

| Command | Description |
|---------|-------------|
| `/session` | Return current session info (name, message count, context %) |
| `/clear` | Clear the session history |
| `/compact` | Summarise old history and keep only recent messages |
| `/stop` | Interrupt the in-flight turn |
| `/restart` | Gracefully restart the session |
| `/model` | Return the current model for this agent |

**Command response:**

```json
{
  "command": "/session",
  "session_id": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "result": {
    "name": "My Project Discussion",
    "messageCount": 42,
    "contextPercent": 18
  }
}
```

**New session:**

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! What can you help me with?", "chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/alfred/messages | jq
```

```json
{
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "agent_id": "alfred",
  "response": "Hello! I'm Alfred, your personal assistant. I can help you with...",
  "session_id": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "duration_ms": 2341,
  "attachments": [
    { "type": "image", "url": "/v1/agents/alfred/media/api-sess-id/browser_shot_default_1234567890.jpg" }
  ]
}
```

> `attachments` is only present when the agent captured images during the turn (e.g. via `browser_screenshot`). Each entry has `type: "image"` and a `url` that can be fetched via `GET /api/v1/agents/:agentId/media/*`.

**Continue a session:**

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"message": "What did I just ask you?", "chat_id": "myapp", "session_id": "da19d84a-6a36-4f57-b419-d322d82c4db8"}' \
  http://localhost:10850/api/v1/agents/alfred/messages | jq
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Empty or too-long message, or missing `chat_id` |
| 401 | Missing API key |
| 403 | Invalid key or key has no access to that agent |
| 404 | Agent ID not found, or `session_id` names no session in this `chat_id` (`code: "SESSION_NOT_FOUND"`) |
| 409 | Session is busy processing another request |
| 504 | Agent did not respond within timeout (default 60s) — **sync mode only** |
| 500 | Internal error |

> - `session_id` is optional — omit for a stateless one-shot call
> - Sessions idle-timeout after `idleTimeoutMinutes` (default 30 min); history is restored automatically on next message
> - Error 409 = session is currently processing a request — wait and retry
> - After a soft timeout, the same `session_id` keeps returning `409` until the hard cap (a further 10 min) — the subprocess is still finishing that turn, so a retry would interleave. Omit `session_id` to start a fresh session immediately, or stay with this one and read the turn out via [`GET …/sessions/:sessionId/stream`](#resuming-an-interrupted-stream), which is never a conflict.
> - The soft timeout only ends the *request* in sync mode (`504`). In streaming mode it is a non-terminal [`timeout` event](#streaming-api-sse) — the turn is still running and the stream stays open.

---

## Public Webhook Ingress

All external, unauthenticated webhooks (LINE today; more apps can be added later) enter
through a single dispatcher route `/webhooks/:app/:agentId?`, routed to a per-app handler
by the `:app` path segment.

**This zone bypasses the gateway's API-key auth entirely** — it is mounted outside the
`/api` routers, before `express.json()`, so each handler gets the raw request bytes it
needs for its own signature validation. There is no ambient auth: every app handler
(e.g. LINE's `x-line-signature` HMAC check) **must authenticate its own requests** as its
first step.

Request bodies on this route are capped at 256KB (pre-auth cap, applies to every app).
An unknown `:app` returns `404`:

```bash
curl http://localhost:10850/webhooks/nope
```

```json
{ "error": "unknown webhook app: nope" }
```

### LINE (`app: "line"`)

**Setup:** configure `line.channelSecret` + `line.channelAccessToken` for an agent via
`PATCH /api/v1/agents/:agentId` (see Agent API above), then point the LINE Developer
Console's webhook URL at:

```
https://<your-gateway-host>/webhooks/line/<agentId>
```

`<agentId>` may be omitted — the dispatcher then falls back to the first agent with
`line.channelSecret` set — but an explicit ID is recommended once more than one agent has
LINE configured.

**Verification (`GET`):** LINE's Console "Verify" button sends a GET (or empty POST); the
handler answers unconditionally:

```json
{ "ok": true }
```

**Inbound delivery (`POST`):** the request must carry a valid `x-line-signature` header
(HMAC-SHA256 of the raw body, keyed by `channelSecret`, base64-encoded).

```bash
BODY='{"events":[{"type":"message","message":{"type":"text","id":"1","text":"hi"},"source":{"type":"user","userId":"Uxxxx"},"replyToken":"xxx","timestamp":1234567890}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "<CHANNEL_SECRET>" -binary | base64)
curl -X POST http://localhost:10850/webhooks/line/<agentId> \
  -H "Content-Type: application/json" \
  -H "x-line-signature: $SIG" \
  -d "$BODY"
```

Text, image, and file messages from allowed 1:1/group/room sources are normalized and
forwarded to the agent's `/channel` intake (the same path Telegram uses). Image and file
bytes are fetched via the LINE blob API and handed to the agent as `meta.image_path`; a
file also carries `meta.attachment_kind: "document"` and `meta.attachment_name` (the
sanitized sender-supplied name). LINE sends no MIME type for a file, so the stored
extension is derived from that name and constrained to a short alphanumeric run —
anything unusable, or any type a browser would render as active content (the HTML and
XML families, script and style), is stored as `.bin`. When the bytes cannot be fetched —
over the 20 MB media cap, an empty upload, or a failed transfer — the turn is still
forwarded, with no `meta.image_path` and a `content` that states the file is not
available and why, so the agent never mistakes a lost attachment for one it has yet to
open. Sticker, video, audio, and location messages are ignored. The
request is acknowledged (`200 {"ok":true}`) **before** event processing, so LINE never
sees a slow response.

**Error responses:**

| Status | When |
|--------|------|
| 401 | Missing or invalid `x-line-signature` (the resolved agent always has `channelSecret` set — see the 404 row below) |
| 404 | No LINE-enabled agent found — no agent has `line.channelSecret` set, or the given `:agentId` doesn't |

**Access control:** DMs and groups/rooms are closed by default (`dmPolicy` /
`groupPolicy` allowlist, per agent config); a denied sender receives a one-time pairing
code (via LINE reply) to share with the admin, who approves it the same way as Telegram
pairing.

### Slack (`app: "slack"`)

**Setup:** configure `slack.botToken` (Bot User OAuth Token, `xoxb-…`) +
`slack.signingSecret` for an agent via `PATCH /api/v1/agents/:agentId` (see Agent API
above — both must be sent together, and the token is validated with `auth.test` at save
time). Then, in the Slack app's **Event Subscriptions**, point the Request URL at:

```
https://<your-gateway-host>/webhooks/slack/<agentId>
```

Subscribe the bot to `message.im` (DMs) and `app_mention` (channel mentions). **Socket
Mode must be off** — this is the HTTP Request URL integration, not Socket Mode.

`<agentId>` may be omitted — the dispatcher then falls back to the first agent with
`slack.signingSecret` set — but an explicit ID is recommended once more than one agent has
Slack configured.

**URL verification (`POST`):** Slack's one-time handshake arrives as a *signed* POST with
`{"type":"url_verification","challenge":"…"}` (unlike LINE's unsigned Console button). The
signature is verified like any other request, then the raw `challenge` is echoed back:

```json
{ "challenge": "<the value Slack sent>" }
```

**Inbound delivery (`POST`):** the request must carry a valid `x-slack-signature` header —
`v0=` + HMAC-SHA256 of `v0:{timestamp}:{rawBody}`, keyed by `signingSecret` — together with
`x-slack-request-timestamp`. Requests whose timestamp is more than 5 minutes from now are
rejected (replay protection).

```bash
TS=$(date +%s)
BODY='{"type":"event_callback","event_id":"Ev1","authorizations":[{"user_id":"U0BOT"}],"event":{"type":"app_mention","channel":"C123","user":"U456","text":"<@U0BOT> hi","ts":"1.2","event_ts":"1.2"}}'
SIG="v0=$(printf 'v0:%s:%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "<SIGNING_SECRET>" | sed 's/^.* //')"
curl -X POST http://localhost:10850/webhooks/slack/<agentId> \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: $TS" \
  -H "x-slack-signature: $SIG" \
  -d "$BODY"
```

Text messages from allowed DMs and `@mention`s in allowed channels are normalized and
forwarded to the agent's `/channel` intake (the same path Telegram/LINE use); the bot's own
self-mention is stripped from `app_mention` text. The request is acknowledged
(`200 {"ok":true}`) **before** event processing, so Slack never sees a slow response and its
3-second-ack retry is avoided. Duplicate retries (Slack's at-least-once delivery) are
de-duplicated by `event_id`.

**Error responses:**

| Status | When |
|--------|------|
| 401 | Missing or invalid `x-slack-signature` (or a timestamp outside the 5-minute window) |
| 400 | Body was not valid JSON |
| 404 | No Slack-enabled agent found — no agent has `slack.signingSecret` set, or the given `:agentId` doesn't |

**Access control:** DMs (gated on the sender's Slack user id) and channels (gated on the
channel id) are closed by default (`slack.dmPolicy` / `slack.groupPolicy` allowlist, per
agent config); allowlist entries MUST be stable Slack ids (`U…` for users, `C…` for
channels), never display/channel names. A denied sender receives a one-time pairing code
(via `chat.postMessage`) to share with the admin, who approves it the same way as Telegram
pairing. In channels, only `@mention`s are answered unless `slack.requireMention` is set to
`false`.

**Pending-sender discovery (admin only):** the recently-denied Slack senders/channels are
surfaced for one-click allowlisting, mirroring LINE:

| Method | Endpoint | Auth |
|--------|----------|------|
| `GET` | `/api/v1/agents/:agentId/slack/pending` | Admin key — list recently-denied Slack senders (id, best-effort name, pairing code) |
| `DELETE` | `/api/v1/agents/:agentId/slack/pending/:senderId` | Admin key — dismiss one knock from the in-memory pending list |

---

## Streaming API (SSE)

Set `"stream": true` in the request body to receive a Server-Sent Events stream.

```bash
curl -N -X POST \
  -H "X-Api-Key: my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message": "Explain this code", "chat_id": "myapp", "stream": true}' \
  http://localhost:10850/api/v1/agents/alfred/messages
```

**Response:**

```
data: {"type":"text_delta","text":"Let me","seq":1}
data: {"type":"text_delta","text":" explain...","seq":2}
data: {"type":"tool_use","name":"Read","id":"toolu_abc123","seq":3}
data: {"type":"text_delta","text":"Here's the explanation...","seq":4}
data: {"type":"result","text":"Here's the full explanation...","seq":5,"request_id":"550e8400-...","session_id":"abc-123","duration_ms":4200}
data: [DONE]

> When images are captured during the turn, the `result` event also includes `"attachments": [{"type":"image","url":"..."}]`.
```

> `seq` is the event's position **within this turn**, counting from 1 — it
> restarts at 1 on the next turn, so it is a cursor only in combination with the
> turn's `request_id`. Remember both: they are what
> [resuming an interrupted stream](#resuming-an-interrupted-stream) takes.
> (`data: [DONE]` is a stream terminator, not an event, and carries neither.)

### Requests with tool use

When the API key has `allow_tools: true` in `config.json`, the agent can call tools (Read, Bash, Grep, etc.). No extra field is needed in the request body — tool access is governed entirely by the key config. This applies to both sync and streaming modes.

```bash
curl -N -X POST \
  -H "X-Api-Key: automation-key-789" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Run the setup script in /workspace and report the output",
    "chat_id": "myapp",
    "stream": true,
    "timeout_ms": 120000
  }' \
  http://localhost:10850/api/v1/agents/alfred/messages
```

> Keys without `allow_tools: true` are always conversational — tools are never invoked regardless of what the request contains.

**Workspace identity files are always protected in API sessions.**
Regardless of `allow_tools`, the agent will not create or update workspace identity files (`AGENTS.md`, `SOUL.md`, `MEMORY.md`, `CLAUDE.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) during an API session. If asked to remember something, the agent will decline. Memory updates require a Telegram or Cron session where the agent has full workspace access.

**Event types:**

> **⚠️ Breaking change — the soft timeout is no longer terminal.**
> Up to and including 1.8.2, a turn that passed `timeout_ms` emitted a terminal
> `{"type":"error","message":"Agent response timeout"}` and the stream ended
> there. It now emits a **non-terminal** `timeout` event instead, and the
> connection stays open until the turn finishes or the hard cap (a further 10
> minutes) fires.
>
> A client written against 1.8.2 or earlier that ignores unknown event types
> will not fail at `timeout_ms` any more — it will sit on an open connection for
> up to 10 extra minutes waiting for a terminal frame. **Handle `timeout`
> explicitly**: render it as "still working", and if you need the old cut-off,
> close the connection yourself when you receive it (the turn keeps running
> server-side and its reply is still persisted to history; you can read it back
> via [`GET …/stream`](#resuming-an-interrupted-stream) or from the session
> history).

Every event in the table below carries a `seq` — the turn-scoped sequence number
described above — in addition to its own fields. The `data: [DONE]` line that
closes the stream is a terminator, not an event, and has no fields at all.

| Type | Fields | Terminal | Description |
|------|--------|----------|-------------|
| `text_delta` | `text` | no | Incremental text chunk |
| `tool_use` | `name`, `id` | no | Tool invocation (e.g. Read, Grep, Bash) |
| `thinking` | `text` | no | Agent reasoning (if available) |
| `timeout` | `message`, `resumable: true` | **no** | The soft response budget elapsed, but the turn is still running — see below |
| `result` | `text`, `request_id`, `session_id`, `duration_ms`, `attachments?` | yes | Final aggregated result; `attachments` present only when images were captured |
| `error` | `message`, `code?` | yes | The turn failed |

The stream ends with `data: [DONE]` after `result`.

**Idle streams send a keepalive.** While a turn is working without producing
events — a long tool call, a slow model — the connection emits an SSE comment
line (`: keepalive`) every 15 seconds so a reverse proxy does not close it as
idle. Comment lines are discarded by every conforming SSE parser, carry no
`seq`, and never reach your event handler; if you parse the stream by hand,
ignore any line that starts with `:`.

**`timeout` is not a failure.** It means the turn passed `timeout_ms` without
finishing; the connection stays open and the turn keeps streaming, because the
subprocess is still working and its reply will still be persisted to history.
Render it as "still working", not as an error. Only `error` is a failure — that
includes the hard cap (a further 10 minutes), at which point the turn really is
abandoned.

**Branch on `code`, not on `message`.** An `error` event carries the originating
failure's code when it has one. The field is omitted when there is no code, so
treat it as optional. It is present on replayed frames too, so a client that
resumed through [`GET …/stream`](#resuming-an-interrupted-stream) learns exactly
what the original connection would have.

| `code` | Meaning | Is the turn still running? |
|--------|---------|----------------------------|
| `TIMEOUT` | The hard cap fired; the turn was interrupted with `SIGINT` | **No** — it is dead |
| `TIMEOUT_SOFT` | The caller's `timeout_ms` elapsed on an endpoint that cannot keep streaming the turn | **Yes** — its reply will land in history |
| `PROCESS_EXITED` | The subprocess crashed mid-turn | No |

`TIMEOUT` and `TIMEOUT_SOFT` are deliberately distinct: the two describe
opposite situations and their messages differ only by a tense and a full stop
(`Agent response timed out.` vs `Agent response timeout`), which is exactly the
kind of string-matching this field exists to replace.

**Which endpoints emit which timeout:**

| Endpoint | At `timeout_ms` | Hard cap | Resumable |
|----------|-----------------|----------|-----------|
| `POST …/messages` with `stream: true` | non-terminal `timeout` event, connection stays open | yes, +10 min → `error` / `TIMEOUT` | yes, via `GET …/stream` |
| `POST …/messages` (synchronous) | `504` response | yes, +10 min (server-side only) | no |
| Cross-channel live view (`POST …/chats/:chatId/sessions/:sessionId/messages`) | terminal `error` / `TIMEOUT_SOFT` | **none** | no |

The cross-channel live view keeps the pre-#421 behaviour on purpose: it has no
resume endpoint to reconnect through, so holding the connection open would buy
nothing. Its turn is *abandoned*, never interrupted — the agent keeps working
and the reply appears in the session history. Poll history, or start a fresh
turn.

**What the hard cap does.** At the cap the turn is *interrupted*, not merely
abandoned: the subprocess is sent `SIGINT` so it stops working and stops
consuming tokens. History gets exactly one assistant row for that turn — any
text the turn had already streamed, followed by `⚠️ Agent response timed out.`
A hard-capped turn never produces a later reply, so it can never leave both a
failure row and a reply row behind.

### Resuming an interrupted stream

A streamed turn is no longer bound to the request that started it. If the
connection drops — a browser reload, a flaky mobile network, a proxy idle
timeout — the turn keeps running server-side and its events keep being buffered,
so a new connection can pick it up where the old one left off.

#### GET /api/v1/agents/:agentId/sessions/:sessionId/stream

Re-attach to the session's current turn. Replays every buffered event after the
cursor, then keeps streaming live events on the same connection, terminating
with the same `result` + `[DONE]` frames the original connection would have got.

| Query param | Description |
|-------------|-------------|
| `after_seq` | Resume after this sequence number. Omit (or `0`) to replay the turn from its first event. |
| `request_id` | The turn you mean to resume — the `request_id` its frames carry. **Required whenever `after_seq > 0`**; optional when replaying from the start, and the frames you get back report the turn's own `request_id` either way. |

```bash
# The stream died after seq 12 — pick the same turn back up.
curl -N -H "X-Api-Key: my-secret-key" \
  "http://localhost:10850/api/v1/agents/alfred/sessions/abc-123/stream?after_seq=12&request_id=req-abc"
```

Read access is enough — resuming a turn reads it, it does not start one.

**A cursor without a `request_id` is not a resume.** Sequence numbers restart at
1 for every turn, so `after_seq=12` alone does not say *which* turn's twelfth
event you saw. If the session has moved on to a later turn, that cursor lands
inside it and would replay a stream you were never watching, with everything
before seq 12 silently missing. The endpoint answers `400` instead: send the
`request_id` from the frames you received, or drop `after_seq` and replay the
current turn from its first event.

**A client that reloaded has no `request_id`, and that is fine.** Drop
`after_seq`, and the frames you get back carry the turn's own `request_id` —
which is what you feed to the next resume, cursor and all.

**Resuming is never a conflict.** `409` still means "you tried to start a second
turn on a busy session"; it is never the answer to a resume. When a turn cannot
be resumed the endpoint answers `410 Gone` with a `code` saying why:

| `code` | Meaning | What to do |
|--------|---------|------------|
| `TURN_GONE` | No turn for that session — it never ran, or it finished more than 2 minutes ago | Read the session's history |
| `TURN_MISMATCH` | The session has a turn, but not the `request_id` you asked for — yours is over | Read the session's history |
| `TURN_TRUNCATED` | That cursor's events have been evicted (see the buffer limits below) — only a non-zero `after_seq` can get this | Retry **without** `after_seq` |
| `CURSOR_AHEAD` | `after_seq` is past the turn's last event | Retry **without** `after_seq` |

Each response carries a `hint` field with the same advice.

**`CURSOR_AHEAD` and `TURN_TRUNCATED` are the two you can recover from without
history.** Both mean the turn is live and only your *cursor* is unusable — past
the turn's last event, or pointing into events the buffer has already dropped.
The answer to either is the same: drop `after_seq` and call again.

A completed turn stays replayable for **2 minutes** after its terminal frame,
which is what makes a reload immediately after the answer arrives still work. The
replayed `result` frame reports `duration_ms` for the turn itself, not for the
time since you reconnected.

**Starting a new turn ends the previous one's grace window immediately.** A
session holds at most one turn: the moment a new turn starts, the completed one
is dropped, even if less than 2 minutes have passed. So if two clients share a
`session_id` — a phone reloading to resume turn *N* while a laptop has already
posted turn *N+1* — the reload gets `TURN_MISMATCH` rather than the replay the
grace window otherwise promises. Read the session's history for that turn's
result; the reply was persisted regardless. Give each client its own session —
one [`POST /sessions`](#post-apiv1agentsagentidsessions) each — if you need their
turns to be independently resumable.

The buffer is bounded per turn — 2,000 events or ~4 MB, whichever comes first —
and once the oldest events are evicted, a cursor pointing into the evicted region
gets `TURN_TRUNCATED` rather than a replay with a silent hole in it. Replaying
from the start (no `after_seq`) is never refused, though: you get the oldest
event still buffered onwards, and the first frame's `seq` tells you how much of
the turn came before it. Nothing is actually lost — the terminal `result` carries
the turn's full text regardless of how much of the delta stream survived.

---

## Models API

### GET /api/v1/models

List the models this gateway offers.

The list is fetched **live** from `{ANTHROPIC_BASE_URL}/v1/models` when a catalog base URL is configured, so a model added, removed, or reordered upstream shows up here without touching `config.json`. `MODELS_BASE_URL` overrides the base URL when the catalog is served separately from the messages endpoint, and `MODELS_API_KEY` / `ANTHROPIC_AUTH_TOKEN` supplies the bearer token; both also resolve from the `env` block of `~/.claude/settings.json`. A successful fetch is cached for 60 seconds and shared between concurrent callers.

`gateway.models` from `config.json` is the fallback, used when no base URL is configured, when the URL is `http` to a non-local host (the bearer token is never sent in cleartext), or when the fetch fails, times out, or returns an empty or unparseable catalog. One exception: while fetches are failing, a catalog fetched within the last hour is served instead of the configured list — dropping to the provisioning-time list on a blip would make a model that exists only upstream vanish from its own picker. Past that hour the configured list takes over. A catalog response supplies `id` and the display name; `alias`, `contextWindow` and `multiplier` are carried over from the configured entry with the same id, and a model with no configured counterpart gets its id as its alias and a 200000 context window. A row that identifies itself as a non-chat model (`kind`/`type` of `image`, `audio`, `embedding`, …) is dropped — a proxy that fronts image generation alongside chat may serve one catalog for both, and an image model is not selectable as a chat model. A row that says nothing about its kind is kept.

The catalog **replaces** the configured list rather than merging with it, so a model withdrawn upstream disappears from the picker instead of lingering. A configured model the catalog omits stays *addressable* — `/model <id or alias>` still accepts it, and it keeps its configured context window — so switching to a live-only model is never a one-way door.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/models | jq
```

```json
{
  "models": [
    { "id": "claude-opus-5",     "name": "Opus 5",     "alias": "opus",     "contextWindow": 200000,  "multiplier": 1 },
    { "id": "claude-opus-5[1m]", "name": "Opus 5 (1M)", "alias": "opus[1m]", "contextWindow": 1000000, "multiplier": 1 },
    { "id": "claude-opus-4-8",   "name": "Opus 4.8",   "alias": "opus48",   "contextWindow": 200000,  "multiplier": 1 },
    { "id": "claude-sonnet-5",   "name": "Sonnet 5",   "alias": "sonnet",   "contextWindow": 200000,  "multiplier": 1 },
    { "id": "gpt-5.6-sol[1m]",   "name": "GPT 5.6 Sol", "alias": "gpt56sol", "contextWindow": 1050000, "multiplier": 1 }
  ]
}
```

> The bare family alias always points at the newest model of that family (`opus` → Opus 5, `sonnet` → Sonnet 5); older members keep a versioned alias (`opus48`). This is a representative subset — the endpoint returns the full list.

The `get_models` command the chat receivers call for their model picker resolves through the same catalog and the same fallback, so the picker and this endpoint never disagree.

---

### PUT /api/v1/agents/:agentId/model

Set the active model for a specific agent. Persists to `config.json`. Requires admin key.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `model` | Yes | Claude model ID (e.g. `"claude-opus-4-8"`) |

```bash
curl -X PUT \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-8"}' \
  http://localhost:10850/api/v1/agents/alfred/model | jq
```

```json
{ "model": "claude-opus-4-8" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Missing or unknown model ID |
| 403 | Not an admin key |
| 404 | Agent not found |

---

## Session Management API

Manage API sessions for a specific agent and `chat_id`. Sessions are stored at `sessions/api-{chat_id}/` — symmetric with Telegram (`telegram-{id}`) and Discord (`discord-{id}`).

**`chat_id`** identifies the caller. Use any stable string (e.g. `"myapp"`, `"user-123"`, `"getpod"`). It is **required** on all session endpoints — pass it as:
- Query string for `GET` and `DELETE` requests: `?chat_id=myapp`
- Request body for `POST` and `PATCH` requests: `{"chat_id": "myapp", ...}`

---

### POST /api/v1/agents/:agentId/greeting

Stream a proactive welcome into an **existing** session. The endpoint reads `GREETING.md` from the agent's workspace and sends its content to the agent as a trigger prompt via SSE. Only the **assistant response** is stored in session history — the trigger prompt is invisible (uses `store_user_message: false` internally).

Returns `204 No Content` if `GREETING.md` does not exist or is empty.

**Auth:** Write or Admin key required.

**Two-step flow:**

1. Create the session first: `POST /api/v1/agents/:agentId/sessions` → redirect the user to the chat UI with the returned `session_id`.
2. Once in the chat UI, trigger the greeting: `POST /api/v1/agents/:agentId/greeting` with that `session_id` and the same `chat_id` → stream the assistant's opening message as SSE with typing animation visible to the user.

**Request:**

| Field | Required | Description |
|-------|----------|-------------|
| `session_id` | Yes | ID of an existing session to deliver the greeting into. Must already exist under `chat_id` — an unknown id is `404`, never a new session |
| `chat_id` | Yes | Same `chat_id` used when the session was created; names the history bucket (`api-{chat_id}`) the greeting is stored in |

> **Breaking change:** `chat_id` is now required. It used to default to `session_id`,
> which filed the greeting under `api-{session_id}` — an index the real chat never
> reads, so the opening message vanished from history while still consuming the
> one-shot `GREETING.md`. Pass the same `chat_id` you created the session with.

```bash
curl -N -X POST \
  -H "X-Api-Key: my-write-key" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "7f3a1c2d-89ab-4def-b012-345678901234", "chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/getpod/greeting
```

**Response `200` (SSE stream)** — greeting is streaming:

```
data: {"type":"text_delta","text":"Hello! "}
data: {"type":"text_delta","text":"Welcome to GetPod."}
data: {"type":"result","text":"Hello! Welcome to GetPod.","session_id":"7f3a1c2d-..."}
data: [DONE]
```

If the session has an active request in flight, the endpoint returns `409` before sending SSE headers.

**Response `204`** — `GREETING.md` not found or empty; nothing sent to session.

**`GREETING.md` format:**

Place the file at `~/.claude-gateway/agents/{agentId}/workspace/GREETING.md`. Its content is used as the prompt sent to the agent. It is **not** concatenated into the agent system prompt — it is a one-time trigger only.

```markdown
The user's environment is ready. Send a warm, concise welcome message
introducing yourself and what you can help with.
```

**Notes:**
- `GREETING.md` is **deleted before streaming begins**. Subsequent calls return 204 immediately, making the endpoint idempotent. Re-provisioning `GREETING.md` enables a new greeting on the next call.
- A `session_id` that names no session under `chat_id` returns `404` with `code: "SESSION_NOT_FOUND"`. The check runs *before* the unlink, so a rejected call leaves `GREETING.md` intact for the real session.
- The SSE stream format matches `POST /messages` with `stream: true` — use the same client-side handler.
- If the agent errors mid-stream, an `{"type":"error","message":"...","code":"..."}` SSE event is sent and the stream closes (`code` omitted when the failure carries none).

---

### GET /api/v1/agents/:agentId/sessions

List all API sessions for a given `chat_id`.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/sessions?chat_id=myapp" | jq
```

```json
{
  "sessions": [
    {
      "id": "da19d84a-6a36-4f57-b419-d322d82c4db8",
      "name": "Project Planning",
      "createdAt": 1775737709000,
      "lastActivity": 1775823600000
    }
  ]
}
```

---

### POST /api/v1/agents/:agentId/sessions

Create a new API session. Optionally auto-generates a session name by summarising a prompt.

The gateway mints the id; there is no way to choose one. Along with omitting
`session_id` on [`POST /messages`](#post-apiv1agentsagentidmessages), this is
the only way a session comes into existence.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `chat_id` | Yes | Caller identity |
| `prompt` | No | Initial user intent — used to auto-generate a session name |
| `name` | No | Explicit session name (overrides auto-generated name) |

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp", "prompt": "I want to discuss the deployment plan for Q3"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions | jq
```

```json
{
  "sessionId": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "sessionName": "Q3 Deployment Plan",
  "createdAt": 1775737709000
}
```

---

### GET /api/v1/agents/:agentId/sessions/:sessionId/info

Get info for a specific session — name, message count, and context usage.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a/info?chat_id=myapp" | jq
```

```json
{
  "sessionId": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "sessionName": "Q3 Deployment Plan",
  "messageCount": 42,
  "contextPercent": 18,
  "createdAt": 1775737709000,
  "lastActivity": 1775823600000
}
```

**Error responses:**

| Status | When |
|--------|------|
| 404 | Session not found |

---

### PATCH /api/v1/agents/:agentId/sessions/:sessionId

Rename a session.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `chat_id` | Yes | Caller identity |
| `session_name` | Yes | New session name (snake_case preferred; `sessionName` also accepted for backward compatibility) |

```bash
curl -X PATCH \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp", "session_name": "Q3 Infra Discussion"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a | jq
```

```json
{
  "sessionId": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "sessionName": "Q3 Infra Discussion"
}
```

**Notes:**
- Request body accepts `session_name` (snake_case, preferred) or `sessionName` (camelCase, backward compatibility). When both are present, `session_name` takes priority.
- The response body always uses camelCase (`sessionName`), consistent with all other API responses.

---

### DELETE /api/v1/agents/:agentId/sessions/:sessionId

Delete a session. Returns 204 No Content on success.

```bash
curl -X DELETE \
  -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a?chat_id=myapp"
```

---

### POST /api/v1/agents/:agentId/sessions/:sessionId/clear

Clear all history for a session.

**Request body:** `{ "chat_id": "myapp" }`

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a/clear | jq
```

```json
{ "cleared": true, "sessionId": "da19d84a-6a36-4f57-b419-d322d82c4db8" }
```

---

### POST /api/v1/agents/:agentId/sessions/:sessionId/compact

Summarise old history and keep only recent messages, reducing context usage.

**Request body:** `{ "chat_id": "myapp" }`

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a/compact | jq
```

```json
{ "success": true, "keptMessages": 10, "archivedMessages": 42 }
```

---

### POST /api/v1/agents/:agentId/sessions/:sessionId/stop

Interrupt the currently in-flight turn for this session (sends SIGINT to the subprocess).

**Request body:** `{ "chat_id": "myapp" }`

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a/stop | jq
```

```json
{ "stopped": true }
```

---

### POST /api/v1/agents/:agentId/sessions/:sessionId/restart

Gracefully restart the session (kills the subprocess and notifies when back online).

**Request body:** `{ "chat_id": "myapp" }`

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a/restart | jq
```

```json
{ "restarting": true }
```

---

## Workspace File API

Read and write an agent's workspace identity files via the API. The gateway's file watcher recomposes `CLAUDE.md` on disk after a write.

**Allowed filenames:** `SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`, `HEARTBEAT.md`, `IDENTITY.md`

**How a write reaches running sessions (frozen-at-spawn).** `CLAUDE.md` is read by a session only at spawn — a live process never re-reads it, so a change applies on the session's **next spawn**. The watcher therefore never SIGKILLs a live session just to push a change; it recomposes `CLAUDE.md` and tiers the restart by change class:

| Changed file(s) | Effect on running sessions |
|-----------------|----------------------------|
| `MEMORY.md`, `USER.md` (memory) | **No session is restarted.** The change applies on each session's next natural spawn. A memory write can never drop a live session. |
| `SOUL.md`, `AGENTS.md`, `IDENTITY.md` (identity) | Busy sessions are skipped; idle sessions are **deferred** (respawn on their next message) — never SIGKILLed mid-idle. |
| `HEARTBEAT.md` / other | Normal restart-or-defer (idle sessions restart now). |

**Memory budget (`gateway.memory`).** Self-authored memory files (`MEMORY.md`, `USER.md`) that exceed a **soft char budget** get a loud, actionable over-budget banner prepended to their `CLAUDE.md` section at compose time — instead of a silent `[TRUNCATED]` — so the agent consolidates on its next spawn (frozen-at-spawn, no restart). The soft budget sits well under the hard per-file limit (still applied as a context safety net); the banner is the primary signal for memory files. Config (global, injected by migration at `configVersion` `1.0.19`):

| Field | Default | Meaning |
|-------|---------|---------|
| `memoryBudgetChars` | `8000` | Soft budget for `MEMORY.md` (`0` = disabled). |
| `userBudgetChars` | `3000` | Soft budget for `USER.md` (`0` = disabled). |
| `overBudget` | `"warn"` | Banner severity: `"warn"` (⚠️) or `"error"` (🛑, stronger wording). An unknown value falls back to `"warn"`. |
| `writeRouting` | `true` | planning-65: inject the two-tier write contract (durable → `MEMORY.md`/`USER.md`; episodic task-log → `memory/<topic>.md`) into the Memory Rule and let dreaming route episodic ops out. `false` = kill-switch (exact pre-routing behavior). |
| `episodicArchiveDir` | `"memory"` | Workspace-relative dir episodic notes land under (slug-validated + realpath-confined). |

A memory file under its budget composes cleanly (no banner). Non-memory files are unaffected. A hard-reject memory tool (refuse an over-budget write) is a planned follow-up; v1 is the compose banner only.

**Write routing (`gateway.memory.writeRouting`, planning-65).** With routing on, the Memory Rule tells the agent that `MEMORY.md` (injected every prompt) holds only durable facts and that episodic task-log belongs in `memory/<topic>.md` (searchable via `memory_search`, not in-prompt). The nightly dreaming reviewer may then emit `tier:"episodic"` `add` ops, which the applier appends to `memory/<topic>.md` (slug `^[a-z0-9-]{1,64}$`, realpath-confined under the workspace; a memory-only change ⇒ no session restart). A one-shot CLI drains an existing over-budget file: `node dist/agent/dreaming/migrate-cli.js <workspaceDir> [--apply]` runs the deterministic terminal sweep (compactor) plus a gated episodic route-out (`propose` writes `.dreaming/migration-plan.md`; `--apply` moves). Pinned sections (`## User`/`## Feedback`/`## Preferences`) are never moved; relocated content stays searchable (recall preserved). **planning-67 (`gateway.dreaming.autoRouteOut`, default `true`):** the nightly dream runs this route-out **automatically** whenever `MEMORY.md` is over budget (after the compactor, before the reviewer — transcript-independent, idempotent, pinned-excluded, unbounded by `maxChangesPerRun`), so no per-agent CLI is needed; and an over-budget net-shrink `remove` **relocates** its block to `memory/archive/pruned.md` (searchable) before cutting it — closing the prior hole where a `remove` deleted without archiving. No dream op deletes recall; all writes are memory-only ⇒ no session restart.

**Nightly dreaming (`gateway.dreaming`).** A nightly background pass consolidates memory: a print-only `claude -p` reviewer (no tools, no `--dangerously-skip-permissions`) reads a lookback window of the agent's own session transcripts and proposes memory-consolidation ops. In **`auto`** mode (the default, planning-64 K4) the ops are applied to `MEMORY.md`/`USER.md` through a safe applier: a **rollback pre-image** is written to `.dreaming/backups/` first (retention-capped) and only when a mutation actually commits; a `replace`/`remove` anchor is applied by **index splice** (so `$` in the new text is literal) and is **skipped when ambiguous** (the target occurs more than once); a **bounded-loss** guard measures **gross original content deleted** (an `add` cannot mask a large delete) — capped at 25% under budget, raised for deletions when the file is **over budget** (removals are the shrink lever) but never a near-total wipe; over budget, an `add` (or a `replace` that would grow the file) is skipped (net-negative); and just before the atomic rename the on-disk content is re-checked against the snapshot (**CAS**) so a concurrent live-agent edit is never clobbered. Writing memory is a memory-only change ⇒ **no session restart** (Part A). In **`propose`** mode (set `mode: "propose"` to opt back into dry-run) proposals are written **only** to `DREAMS.md` + JSONL audit under `<workspace>/.dreaming/` — no memory file is mutated. When the shared KB is `auto`, only the `add`s the applier **actually wrote** are promoted to the shared vault (never a locally-skipped proposal), and only when the content carries a real fact — an `add` whose content is nothing but `MEMORY.md` index-pointer bullets is skipped, because those links resolve only inside the promoting agent's own workspace (issue #398). A durable proposal may also carry an optional `topic` kebab-slug naming the fact; it becomes the shared note's name when present. Runs on a nightly scheduler (`dreamHour`/`dreamMinute`/`dreamTimezone`), skips when a session was active within `quietMinutes`, and is a no-op when `enabled:false` or `maxChangesPerRun:0`. `dreamMinute` (0–59, default 0) pairs with `dreamHour` for minute-level scheduling — set it with `staggerWindowMinutes: 0` to fire at an exact `HH:MM` (e.g. for a controlled re-test). **planning-68:** to avoid a `dreamHour:00` thundering-herd across agents (every agent's timer fires at the same instant, each spawning a route-out + reviewer `claude -p`), a **deterministic per-agent jitter** (a stable hash of `agentId` in `[0, staggerWindowMinutes*60s)`, not `Math.random`) is added to each agent's scheduled delay, spreading runs across the window; `staggerWindowMinutes` defaults to `30`, is clamped `[0,55]` (so the offset never crosses the next hour), and `0` disables it (exact prior behavior). See the README `gateway.dreaming` reference for all fields.

**Archive staleness GC (`gateway.dreaming.staleness`).** A deterministic nightly pass (planning-66) that runs next to the compactor in `auto` mode to keep the Lane-2 archive's **search quality** high — it is a **search-quality fix, not a prompt-budget one** (planning-65 already moved task-log off the injected prompt). It **soft-invalidates** archive entries and **never deletes** them: a **superseded** entry (a deterministic `supersedes`/`replaces`/`obsoletes #N` match — which finally populates the previously-inert `supersedes_key`) or an **aged-out** entry (idle-since-last-**retrieval** past `staleTtlDays` and retrieved fewer than `minRetrievalKeep` times) is **moved** to `memory/archive/stale.md` with an `invalid_at` stamp, staying under `memory/` so it remains indexed and `memory_search`-able. An entry **retrieved after** invalidation is **promoted back** to the active archive (recall feedback). Recall is fed by an append-only read-path log (`kb_retrieval_log`), written fire-and-forget by the Bun read tool through a dedicated writable handle (never read-modify-writing chunk rows) and gated by `recordRetrievals`; the GC folds it into each entry's `last_retrieved`. Identity is a reindex-surviving content hash (`entry_hash`) stored in a standalone `kb_entry_lifecycle` table (not a cascade child of `kb_chunks`), so age survives re-chunking. Indexing writes those rows for **every** source it sees, including files the content-hash guard skips as unchanged — a source indexed before the lifecycle table existed is backfilled from its stored mtime, so its real age is preserved rather than restarted (issue #398; without this the GC could only ever consider files edited after the feature shipped). `keepImportance` and **pinned** files (`memory/pinned/**`) are never aged out; evergreen Lane-1 (`MEMORY.md`/`USER.md`) is structurally excluded. Every move is CAS-guarded with a timestamped backup and drops **no live session** (memory-only, Part A). The read-path recorder is gated to the MCP layer via `GATEWAY_RECORD_RETRIEVALS`. Fields: `enabled` (default `true`; `false` ⇒ GC no-ops), `staleTtlDays` (default `90`), `keepImportance` (default `7`), `minRetrievalKeep` (default `1`), `supersession` (default `true`), `recordRetrievals` (default `true`), `maxInvalidationsPerRun` (default `50`) — a ceiling on how many entries ONE run may soft-invalidate, oldest-idle first, with the remainder resuming on later runs. Aging is wall-clock driven, so without it the first run after anything that widens the GC's visibility (such as the lifecycle backfill above) would relocate every already-expired entry in a single night. Restores are never capped. Per-agent override under `agents[].dreaming.staleness`. Injected by migration at `configVersion` `1.0.26`.

**Knowledge archive (`gateway.knowledge.archive`).** Two-lane memory (planning-64). A per-agent SQLite/FTS5 index (`agents/<id>/kb.sqlite`, built on `node:sqlite` — zero new dependency) over the agent's `memory/*.md` notes plus the evergreen `MEMORY.md`/`USER.md`, so an agent can **retrieve on demand** what does not fit in the always-injected core. Injected by migration at `configVersion` `1.0.21`. Indexing is **hash-guarded** (unchanged files skipped), tags every chunk with **fail-closed provenance** (`owner`/`agent`/`untrusted`/`system`; unclassified ⇒ `untrusted`), and prunes only genuinely-absent files (a transient read error never drops a live source). The index is refreshed by a **detached subprocess at agent-session spawn**, so all synchronous SQLite work runs off the gateway event loop. Retrieval is exposed to the agent as two read-only MCP tools — **`memory_search`** (keyword/FTS5 over the archive → ranked snippets with file+line range, provenance, importance) and **`memory_get`** (bounded exact excerpt of a memory-scoped file by line range; path-traversal-guarded). The MCP layer runs under Bun, so those tools read `kb.sqlite` via `bun:sqlite`. Fields: `enabled` (default `true`; `false` ⇒ complete no-op, no DB created), `tokenizer` (FTS5 tokenizer, default `"unicode61"`; `"trigram"` for CJK/Thai), `chunkTokens` (default `400`), `chunkOverlap` (default `80`, clamped below `chunkTokens`). Per-agent override under `agents[].knowledge`. **Core-shrink:** when the archive is enabled and `MEMORY.md` is over its soft budget, compose injects a compact **auto-generated section index** (headings + a brief per top-level section) plus a pointer to `memory_search`, instead of the banner + truncated full text — so the bulk never enters the prompt. The index is derived deterministically at compose time (no LLM); the on-disk `MEMORY.md` is never modified, and its full content stays searchable via the archive. Falls back to the banner + full text when the archive is disabled or the file has no headings to index. **Retrieval note:** whenever the archive is enabled, a short platform-level `--- MEMORY RETRIEVAL ---` section is injected into every agent's system prompt (independent of the over-budget shrink path), so the `memory_search`/`memory_get` tools are discoverable at all times rather than only when the shrink pointer appears — a capability shared by all agents, injected once here instead of duplicated into each agent's `AGENTS.md`.

**Shared KB (`gateway.knowledge.shared`).** A cross-agent knowledge base (planning-64 K3): a shared SQLite/FTS5 vault outside any single agent's workspace (`<root>/<project>/kb.sqlite`, default root `~/.claude-gateway/shared/kb`). The gateway has no built-in project concept, so sharing is keyed by an explicit `project` value — agents with the same `project` share one vault; `project` defaults to `"global"` (all agents share by default). Notes dropped under the vault's `notes/` dir are indexed (provenance `agent` — the owner's own trust domain) and reachable via `memory_search` with `corpus:"shared"` (the shared vault) or `corpus:"all"` (this agent's memory + shared, merged by relevance). Concurrent writers are safe without an in-process lock: note files are written temp-then-atomic-rename, and the shared index is guarded by `PRAGMA busy_timeout` across processes. The gateway passes the resolved vault dir to the MCP layer via `GATEWAY_SHARED_KB_DIR`. Fields: `enabled` (default `true`), `project` (default `"global"`; validated to one safe path segment), `root` (default `~/.claude-gateway/shared/kb`), `mode` (`propose`|`auto`, default `auto` — governs per-agent→shared promotion of durable dreamed facts), `graph` (default `false`). Per-agent override under `agents[].knowledge.shared`. **On-demand read/write:** the **`memory_shared_create`**/**`memory_shared_get`**/**`memory_shared_update`**/**`memory_shared_delete`** MCP tools let any agent create, read, update, and delete notes in the vault immediately (works in either `mode`, since these are explicit calls rather than automatic promotion). A note's identity is a freeform `name` the caller picks — there is no agent-id prefix and no per-agent ownership; any agent can create, edit, or delete any note. `memory_shared_create` fails on an exact-name collision (use `memory_shared_update` instead), and before writing also searches the shared KB for content-similar notes, returning them instead of creating unless called with `confirm:true` — this keeps agents from independently creating near-duplicate notes under different names; when `confirm:true` proceeds past a near-dup nudge, each related note found is linked into the new note's content as a `[[wikilink]]` rather than left as a disconnected duplicate. `memory_shared_update` fails if the name doesn't exist yet (use `memory_shared_create` instead), and replaces the note's full content; if the new content would drop 50%+ of the existing note's lines, it returns a warning instead of writing, requiring `confirm:true` to proceed — a guard against blindly clobbering a note instead of editing it. `memory_shared_get` returns a note's full current content (`memory_search` only returns short snippets). **Nightly promotion shares this same freeform namespace** (issues #386, #398): a promoted fact is named after its dream proposal's `topic` slug when the reviewer supplied one, else its `reason`, so the same recurring fact maps to the same note across dream nights and lands as an update, not a new file. A fallback name that reads as an *editing instruction* rather than the name of a fact (an imperative edit verb plus a positional/file anchor, e.g. "insert after the cron section") is passed over, since no future occurrence of that fact could ever match such a name — the note is named from the fact itself instead, and the promotion is abandoned only when nothing nameable remains. Every declined promotion is logged with its reason — including the two that used to be silent: a merge the note-size cap refuses, and an unexpected write failure (which still never fails the local dream). A name that doesn't collide is still checked against a Node-native near-duplicate search (a `node:sqlite` port of the same OR-match FTS query the tools above use under Bun), but that query is **recall only**: an unattended merge additionally requires real token containment between the promoted fact and the candidate note. Below that bar the fact is written as its own note — two notes are a recoverable tidy-up, two unrelated facts fused into one are not. `[[wikilink]]`s to related notes clear a **lower** bar than merges, because a link is an additive claim while a merge destroys the distinction between the notes; they are attached whether the fact merges or lands as a new note, so a fact below the merge bar never becomes a disconnected graph node. Containment is measured against each candidate's full note body rather than the FTS chunk that matched — though against a **capped seed**: the query carries at most `SEED_TERM_BUDGET` significant tokens, so the bar reads as "half of the fact's leading topic words are already in this note", not half of the entire fact. Retired `stale__*` notes are excluded as merge targets, and a recurrence under a retired name folds the retired body back into the live note and deletes the twin — on **both** the create and the update path, since either leaves a live file at that name and the GC's own restore refuses from then on. A retired note stays indexed and searchable by design, so a twin left beside a live note of the same name would answer every query twice, permanently. The twin is dropped only once the merged write actually lands; a write the size cap refuses leaves it in place and logs why. Folding also prevents two files sharing one `entry_hash`. All four tools trigger an immediate reindex on write/delete, needing `GATEWAY_NODE_EXEC_PATH` (the gateway's own Node `execPath`, forwarded alongside `GATEWAY_SHARED_KB_DIR`) since the Bun MCP process cannot itself run the `node:sqlite`-based reindex CLI.

**Graph layer (`gateway.knowledge.shared.graph`).** Opt-in memory-wiki-style compile (planning-64 K5) over the shared vault, run after each shared reindex (off the event loop). Deterministic — no LLM. Reads note YAML frontmatter (`title`, `claims[]` with `id`/`text`/`status`/`confidence`, page `confidence`, `updatedAt`) and body `[[wiki-links]]`, and writes `<vault>/reports/`: `relationship-graph.md` (every link edge), `backlinks.md` (reverse edges), `contradictions.md` (claims sharing an `id` whose text/status diverges), `stale-pages.md` (≥ 90 days old), `low-confidence.md` (confidence < 0.5). The generated reports dir is never scanned as source.

### GET /api/v1/agents/:agentId/files/:filename

Read a workspace file. Returns empty `content` if the file does not exist yet (not a 404).

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/agents/alfred/files/SOUL.md | jq
```

```json
{ "filename": "SOUL.md", "content": "# Soul\n\nAlfred is warm, helpful, and precise." }
```

---

### PUT /api/v1/agents/:agentId/files/:filename

Write a workspace file. Requires write access to the agent. Max 1MB.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `content` | Yes | Full file content as a string |

```bash
curl -X PUT \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"content": "# Soul\n\nAlfred is warm, helpful, and precise."}' \
  http://localhost:10850/api/v1/agents/alfred/files/SOUL.md | jq
```

```json
{ "filename": "SOUL.md", "message": "File saved. CLAUDE.md will auto-reload." }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Filename not in allowed list, invalid format, or content not a string |
| 400 | Content exceeds 1MB |
| 403 | Key has no write access to agent |
| 404 | Agent not found |

---

## Skill API

Manage per-agent and shared skills. Skills are `SKILL.md` files stored in the agent workspace or shared directory.

### GET /api/v1/agents/:agentId/skills

List all skills for an agent (workspace + module + shared).

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/agents/alfred/skills | jq
```

```json
[
  {
    "key": "my-helper",
    "name": "my-helper",
    "description": "Does something useful",
    "scope": "workspace",
    "emoji": null,
    "userInvocable": true,
    "modulePrefix": null,
    "source_url": null
  }
]
```

**Scope values:** `workspace`, `shared`, `module`

---

### GET /api/v1/agents/:agentId/skills/:name

Get a single skill's content. Optional query param `?scope=workspace|shared` to disambiguate when the same name exists in multiple scopes.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/skills/my-helper" | jq
```

```json
{
  "key": "my-helper",
  "name": "my-helper",
  "description": "Does something useful",
  "scope": "workspace",
  "emoji": null,
  "content": "---\nname: my-helper\ndescription: \"Does something useful\"\n---\n\nInstructions here.",
  "source_url": null
}
```

---

### POST /api/v1/agents/:agentId/skills

Create a new skill. Requires write access. Use `scope: "shared"` with an admin key to create a shared skill.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill slug — lowercase alphanumeric + hyphens, 1-64 chars |
| `description` | Yes | One-line description |
| `content` | Yes | Skill instructions (Markdown body, excluding frontmatter) |
| `scope` | No | `"workspace"` (default) or `"shared"` (admin only) |

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-helper",
    "description": "Does something useful",
    "content": "When invoked, do the following:\n1. Step one\n2. Step two"
  }' \
  http://localhost:10850/api/v1/agents/alfred/skills | jq
```

```json
{
  "key": "my-helper",
  "name": "my-helper",
  "description": "Does something useful",
  "scope": "workspace",
  "emoji": null,
  "userInvocable": true,
  "modulePrefix": null,
  "content": "---\nname: my-helper\ndescription: \"Does something useful\"\n---\n\nWhen invoked...",
  "source_url": null
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Invalid skill name, reserved name, or missing fields |
| 403 | No write access, or `shared` scope without admin key |
| 409 | Skill with that name already exists |

---

### POST /api/v1/agents/:agentId/skills/install

Install a skill from a GitHub URL or raw URL pointing to a `SKILL.md` file. Requires admin key.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `url` | Yes | HTTPS URL to `SKILL.md` (GitHub URLs auto-converted to raw) |
| `scope` | No | `"workspace"` (default) or `"shared"` |
| `name` | No | Override skill name (default: parsed from frontmatter) |
| `force` | No | `true` to overwrite an existing skill |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md",
    "scope": "shared"
  }' \
  http://localhost:10850/api/v1/agents/alfred/skills/install | jq
```

```json
{
  "key": "my-skill",
  "name": "my-skill",
  "description": "Skill from GitHub",
  "scope": "shared",
  "emoji": null,
  "userInvocable": true,
  "modulePrefix": null,
  "content": "---\nname: my-skill\n...",
  "source_url": "https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md"
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Missing/non-HTTPS URL, private host, fetch failure, invalid SKILL.md |
| 400 | SKILL.md exceeds 100KB |
| 403 | Not an admin key |
| 409 | Skill already exists and `force` not set |

---

### DELETE /api/v1/agents/:agentId/skills/:name

Delete a skill by name. Requires write access. Use `?scope=shared` (admin only) to delete a shared skill.

```bash
curl -X DELETE \
  -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/skills/my-helper" | jq
```

```json
{ "message": "Skill \"my-helper\" deleted from workspace" }
```

---

### GET /api/v1/agents/:agentId/skill-metrics

Skill self-improvement (skill-learning) effectiveness rollup for the agent. Read-only; any key with access to the agent. Returns `404` if skill-learning is not active for the agent.

The metrics all derive from durable per-turn telemetry (`turn_metrics`) and per-skill provenance/usage (`skill_stats`) captured in the agent's `history.db`:

- **adoption** — funnel of auto-skills: created → loaded ≥1 → loaded ≥3 (`stickyPct` = % reaching ≥3 uses).
- **costDelta** — median tool-calls / tokens for turns with **no skill loaded** vs turns with **a skill loaded** (a global cohort comparison, not a temporal per-skill before/after), plus the number of intent clusters (directional). Each median is `null` when its cohort has no turns yet (distinct from a measured `0`).
- **recovery** — recovery-triage rate for the earlier half vs the recent half of turns (should trend down).
- **cohort** — the `enabled` on/off A/B: turn counts + median tool-calls per cohort (the causal signal).
- **netTokens** — the bottom line: `savedByReuse − spentReviewing` (`net`). The feature is a win only when `net > 0`.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/skill-metrics" | jq
```

```json
{
  "agentId": "alfred",
  "generatedAt": 1723800000000,
  "adoption": { "autoSkills": 4, "loadedAtLeast1": 3, "loadedAtLeast3": 2, "stickyPct": 50 },
  "costDelta": { "clusters": 6, "medianToolCallsBefore": 9, "medianToolCallsAfter": 4, "medianTokensBefore": 12000, "medianTokensAfter": 6000 },
  "recovery": { "ratePctRecent": 4, "ratePctEarlier": 11 },
  "cohort": { "enabledTurns": 120, "disabledTurns": 40, "enabledMedianToolCalls": 5, "disabledMedianToolCalls": 8 },
  "netTokens": { "savedByReuse": 48000, "spentReviewing": 9000, "net": 39000 }
}
```

**Skill Learning (behavior).** When `gateway.skillLearning.enabled` is true (the shipped default, injected by config migration at `configVersion` `1.0.18`), after a *qualifying* session goes idle a **print-only** reviewer (`claude -p`, no tools, no `--dangerously-skip-permissions`, async spawn) distils the transcript into a skill *proposal*. The **gateway**, not the model, writes the file via a provenance-guarded writer: learned skills are stamped `origin: auto` in frontmatter and land in the agent's **workspace** `skills/` dir, live on the next turn via the existing hot-reload — `mode: "propose"` writes to a `skills/.pending/` review queue instead. A session qualifies when its peak tool-calls ≥ `minToolCalls`, or a recovery fired, or a user-correction heuristic matched — capped per day (`maxReviewsPerDay`). A **daily curator** prunes `origin: auto` skills that are both unused (`< minUsesToKeep`) and stale (`> maxAgeDays`), enforces `maxAutoSkills` (LRU), and never touches hand-authored or `pinned` skills. Telemetry capture is always-on (even when disabled) so the `enabled` on/off cohort remains computable. Config lives under `gateway.skillLearning` with per-agent overrides honored over the global default.

**Skill Learning (notifications).** Every live auto-write appends an audit line to `<workspace>/SKILLS_LEARNED.md` (always on). When `skillLearning.notify` is true (default), a short ping is also **fanned out to every channel the agent has configured** — Telegram, Discord, and LINE — via a transport registry. Each channel resolves its own recipients from `<workspace>/.<channel>-state/access.json` → `allowFrom`: Telegram sends directly (chat_id == user_id), Discord opens a DM channel for each user then posts, LINE pushes via the Messaging API (dormant until a LINE access token is configured). The web/`api` channel has no proactive push and is not notified. A burst of writes coalesces into a single digest. Notifications are best-effort and never block the review path.

**Skill Learning (menu size).** The CLAUDE.md **AVAILABLE SKILLS** menu compacts `origin: auto` skill descriptions to a short one-liner (full body still loads on invoke); hand-authored, module, and shared skills keep their full descriptions. This keeps CLAUDE.md bounded as auto-skills accumulate toward `maxAutoSkills`.

---

## Cron API

Manage persistent scheduled jobs. All routes require the same API key auth as the Agent API. Write operations (`POST`, `PUT`, `DELETE`) additionally verify the key has access to the job's `agentId`.

Jobs are persisted to `~/.claude-gateway/crons.json` and survive gateway restarts.

### Job schema

**Create / update fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `agentId` | Yes (create) | Agent to associate this job with |
| `name` | Yes (create) | Human-readable job name |
| `scheduleKind` | No | `"cron"` (default) or `"at"` |
| `schedule` | If `scheduleKind=cron` | 5-field cron expression e.g. `"0 9 * * *"` |
| `scheduleAt` | If `scheduleKind=at` | ISO 8601 timestamp for one-shot run |
| `timezone` | No | IANA zone (e.g. `"Asia/Bangkok"`) the `scheduleKind=cron` expression fires in — DST-safe. Defaults to `"UTC"` (legacy jobs unchanged). An unresolvable zone is rejected with `400`. Ignored for `scheduleKind=at` (absolute instants carry no zone ambiguity). |
| `type` | No | `"command"` (default) or `"agent"` |
| `command` | If `type=command` | Shell command to run |
| `prompt` | If `type=agent` | Prompt sent to the agent as a new turn |
| `telegram` | No | Telegram chat_id to deliver the agent response (optional for `type=agent`) |
| `discord` | No | Discord channel_id to deliver the agent response (optional for `type=agent`) |
| `timeoutMs` | No | Execution timeout in ms (default 120000) — applies to both `command` and `agent` |
| `deleteAfterRun` | No | `true` to auto-delete after first run (one-shot jobs) |
| `enabled` | No | `true` (default) / `false` to create disabled |

**`type` comparison:**

| | `command` | `agent` |
|---|---|---|
| Runs | Shell command | Agent turn (new Claude session) |
| Key field | `command` | `prompt` (channels optional) |
| Output | stdout/stderr | Agent response text |
| Delivery | Logged only | Sent to Telegram and/or Discord if set, otherwise logged only |

> **Note:** For `type=agent`, only `prompt` is required. `telegram` and `discord` are optional — set either (or both) to deliver the agent response to those channels; with neither, the job still runs on schedule and its response is logged only (no delivery).

---

### GET /api/v1/crons

List all jobs accessible by the API key (filtered to key's agent scope).

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/crons | jq
```

```json
{
  "jobs": [
    {
      "id": "8f787a4b-eaa8-4ace-a0b3-ff3d0004f2df",
      "agentId": "claude-founder",
      "name": "morning-brief",
      "scheduleKind": "cron",
      "schedule": "0 9 * * *",
      "type": "agent",
      "prompt": "Give me a morning summary.",
      "telegram": "<CHAT_ID>",
      "enabled": true,
      "createdAt": 1775737709284,
      "state": {
        "lastRunAt": 1775737800000,
        "lastStatus": "success",
        "lastError": null,
        "consecutiveErrors": 0,
        "runCount": 5
      }
    }
  ]
}
```

---

### GET /api/v1/crons/status

Scheduler health summary.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/crons/status | jq
```

```json
{
  "total": 3,
  "enabled": 2,
  "running": 0
}
```

---

### POST /api/v1/crons — Create a job

#### Example: Daily agent prompt (cron)

Run every day at 09:00 — agent sends a morning summary to Telegram.

```bash
curl -s -X POST http://localhost:10850/api/v1/crons \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-founder",
    "name": "morning-brief",
    "scheduleKind": "cron",
    "schedule": "0 9 * * *",
    "type": "agent",
    "prompt": "Give me a morning summary.",
    "telegram": "<CHAT_ID>"
  }' | jq
```

#### Example: Daily job in a specific timezone

Run every day at 09:00 **Bangkok time** — not 09:00 UTC. Add `timezone` (any IANA zone); node-cron resolves DST at fire time.

```bash
curl -s -X POST http://localhost:10850/api/v1/crons \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-founder",
    "name": "morning-brief-bkk",
    "scheduleKind": "cron",
    "schedule": "0 9 * * *",
    "timezone": "Asia/Bangkok",
    "type": "agent",
    "prompt": "Give me a morning summary.",
    "telegram": "<CHAT_ID>"
  }' | jq
```

#### Example: Daily agent prompt — deliver to Discord

Run every day at 09:00 — agent sends a morning summary to a Discord channel.

```bash
curl -s -X POST http://localhost:10850/api/v1/crons \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-founder",
    "name": "morning-brief-discord",
    "scheduleKind": "cron",
    "schedule": "0 9 * * *",
    "type": "agent",
    "prompt": "Give me a morning summary.",
    "discord": "<CHANNEL_ID>"
  }' | jq
```

#### Example: Deliver to both Telegram and Discord

```bash
curl -s -X POST http://localhost:10850/api/v1/crons \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-founder",
    "name": "morning-brief-all",
    "scheduleKind": "cron",
    "schedule": "0 9 * * *",
    "type": "agent",
    "prompt": "Give me a morning summary.",
    "telegram": "<CHAT_ID>",
    "discord": "<CHANNEL_ID>"
  }' | jq
```

#### Example: One-shot agent turn at a specific time

Runs once at the given time, then auto-deletes.

```bash
curl -s -X POST http://localhost:10850/api/v1/crons \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-founder",
    "name": "good-night",
    "scheduleKind": "at",
    "scheduleAt": "2026-04-09T23:00:00.000Z",
    "type": "agent",
    "prompt": "good night",
    "telegram": "<CHAT_ID>",
    "deleteAfterRun": true
  }' | jq
```

#### Example: Recurring shell command (cron)

Run a shell command every minute.

```bash
curl -s -X POST http://localhost:10850/api/v1/crons \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-founder",
    "name": "test-echo",
    "scheduleKind": "cron",
    "schedule": "* * * * *",
    "type": "command",
    "command": "echo hello"
  }' | jq
```

#### Example: One-shot shell command at a specific time

```bash
curl -s -X POST http://localhost:10850/api/v1/crons \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-founder",
    "name": "deploy",
    "scheduleKind": "at",
    "scheduleAt": "2026-04-10T10:00:00.000Z",
    "type": "command",
    "command": "make deploy",
    "deleteAfterRun": true
  }' | jq
```

#### Example: Create a disabled job (enable later)

```bash
curl -s -X POST http://localhost:10850/api/v1/crons \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-founder",
    "name": "weekly-report",
    "scheduleKind": "cron",
    "schedule": "0 18 * * 5",
    "type": "agent",
    "prompt": "Generate a weekly progress report.",
    "telegram": "<CHAT_ID>",
    "enabled": false
  }' | jq
```

---

### GET /api/v1/crons/:id

Get a single job by ID.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/crons/8f787a4b-eaa8-4ace-a0b3-ff3d0004f2df | jq
```

---

### PUT /api/v1/crons/:id — Update a job

Only the fields you include are updated. All fields are optional.

#### Example: Change schedule

```bash
curl -s -X PUT http://localhost:10850/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": "0 8 * * 1-5"
  }' | jq
```

#### Example: Change prompt

```bash
curl -s -X PUT http://localhost:10850/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Give me an evening summary instead."
  }' | jq
```

#### Example: Disable a job

```bash
curl -s -X PUT http://localhost:10850/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' | jq
```

#### Example: Re-enable a job

```bash
curl -s -X PUT http://localhost:10850/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}' | jq
```

---

### DELETE /api/v1/crons/:id

Delete a job permanently.

```bash
curl -s -X DELETE http://localhost:10850/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" | jq
```

```json
{ "ok": true }
```

---

### POST /api/v1/crons/:id/run

Trigger a job immediately, regardless of its schedule.

```bash
curl -s -X POST http://localhost:10850/api/v1/crons/<id>/run \
  -H "X-Api-Key: my-secret-key-123" | jq
```

```json
{ "ok": true }
```

---

### GET /api/v1/crons/:id/runs

Get the run history of a job (last 20 runs by default).

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/crons/<id>/runs | jq
```

```json
{
  "runs": [
    {
      "runAt": 1775738700000,
      "status": "success",
      "output": "Good morning! Here is your summary...",
      "durationMs": 3241,
      "error": null
    },
    {
      "runAt": 1775735100000,
      "status": "error",
      "output": null,
      "durationMs": 120000,
      "error": "Agent timed out"
    }
  ]
}
```

---

### Cron expression reference

```
┌───── minute (0–59)
│ ┌───── hour (0–23)
│ │ ┌───── day of month (1–31)
│ │ │ ┌───── month (1–12)
│ │ │ │ ┌───── day of week (0–7, 0=Sun, 7=Sun)
│ │ │ │ │
* * * * *
```

| Expression | Meaning |
|-----------|---------|
| `* * * * *` | Every minute |
| `0 9 * * *` | Every day at 09:00 |
| `0 9 * * 1-5` | Weekdays at 09:00 |
| `0 18 * * 5` | Every Friday at 18:00 |
| `*/15 * * * *` | Every 15 minutes |
| `0 0 1 * *` | First day of month at midnight |

---

## Chat History API

Access per-agent conversation history stored in the history DB (SQLite). `chatId` uses the format `telegram-{rawId}`, `discord-{rawId}`, or `api-{rawId}`.

### GET /api/v1/agents/sessions

List all sessions across **all agents** in a single call. Admin key required. Queries each agent's history DB sequentially and returns a nested structure grouped by agent.

```bash
curl -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/sessions | jq
```

```json
{
  "agents": [
    {
      "agentId": "alfred",
      "description": "Personal assistant",
      "sessions": [
        {
          "chatId": "telegram-997170033",
          "sessionId": "abc-123",
          "source": "telegram",
          "messageCount": 42,
          "createdAt": 1775737709000,
          "lastActivity": 1775823600000,
          "lastMessage": "Sure, I can help with that!",
          "sessionName": "Project Planning",
          "imageConfig": { "model": "openai/gpt-image-1", "quality": "medium" },
          "model": "claude-opus-4-8"
        }
      ]
    }
  ]
}
```

**Session fields:**

| Field | Type | Description |
|-------|------|-------------|
| `chatId` | string | Channel chat ID (`telegram-{id}` / `discord-{id}` / `api-{id}`) |
| `sessionId` | string | Unique session identifier |
| `source` | string | `telegram`, `discord`, or `api` |
| `messageCount` | number | Total messages in this session |
| `createdAt` | number | Session start timestamp (ms) |
| `lastActivity` | number | Last message timestamp (ms) |
| `lastMessage` | string\|null | Preview of the last message content |
| `sessionName` | string\|null | Human-readable session name (set via `/rename` or `POST /sessions`) |
| `imageConfig` | object\|null | Last `image_params` sent for this session (composer image-generation options); `null` when none set. Lets a web client restore the composer selection on reload. |
| `model` | string\|null | Real Claude model that produced the session's latest turn, captured from the stream and updated every turn (so a mid-session `/model` switch is reflected). `null` for legacy sessions recorded before this was tracked, or when no turn has run yet. |

**Error responses:**

| Status | When |
|--------|------|
| 403 | Not an admin key |

---

### GET /api/v1/agents/:agentId/chats

List all chats (across all channels) for an agent.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/agents/alfred/chats | jq
```

```json
{
  "chats": [
    { "chatId": "telegram-<CHAT_ID>", "messageCount": 42, "lastActivity": "2026-05-10T03:00:00.000Z" }
  ]
}
```

---

### GET /api/v1/agents/:agentId/chats/:chatId/sessions

List sessions for a specific chat. Supports `telegram`, `discord`, and `api` chats.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/sessions" | jq
```

```json
{
  "sessions": [
    { "sessionId": "abc-123", "messageCount": 10, "createdAt": "2026-05-10T02:00:00.000Z", "lastActivity": "2026-05-10T03:00:00.000Z" }
  ]
}
```

**Error responses:**

| Status | When |
|--------|------|
| 403 | Key has no access to agent |
| 404 | Agent not found |

---

### GET /api/v1/agents/:agentId/chats/:chatId/messages

Paginated message history (cursor-based). Returns messages in reverse chronological order by default; pass `order=asc` to read forward.

**Query parameters:**

| Param | Description |
|-------|-------------|
| `limit` | Max messages to return (default 50, max 1000). Values above the max are clamped; non-numeric, `0`, or negative fall back to the default. |
| `before` | Return messages before this timestamp (ms) |
| `after` | Return messages after this timestamp (ms) |
| `before_id` | Id component of the cursor, paired with `before`. Echo back `nextCursorId` here to page correctly across messages that share a `ts` (see below). Ignored without `before`. |
| `after_id` | Id component of the cursor, paired with `after` (the `order=asc` counterpart of `before_id`). Ignored without `after`. |
| `session_id` | Filter to a specific session |
| `order` | `asc` reads forward (oldest→newest) from `after`; `desc` (default) reads newest→oldest. Case-insensitive; any other value returns `400`. |

`before`, `after`, `before_id`, and `after_id` must be numeric; a present-but-non-numeric value returns `400`.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/messages?limit=20" | jq
```

```json
{
  "messages": [
    { "role": "assistant", "content": "Hi there!", "ts": 1775737712000, "sessionId": "abc-123" },
    { "role": "user", "content": "Hello!", "ts": 1775737709000, "sessionId": "abc-123" }
  ],
  "hasMore": true,
  "nextCursor": 1775737709000,
  "nextCursorId": 8412
}
```

When `hasMore` is `true`, the response carries a **composite cursor**: `nextCursor` (the boundary message's `ts`) and `nextCursorId` (its row id). `nextCursorId` is `null` whenever `nextCursor` is.

**Seek-forward example** (jump to a date and read that day's first messages in one round-trip):

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/messages?order=asc&after=<startOfDay-1>&limit=20" | jq
```

`nextCursor` continues forward via `after` when `order=asc` (vs. `before` for the default `desc`).

**Paging across equal-`ts` messages.** `ts` is millisecond-granular and not unique — an image burst coalesced into one turn, or rapid messages, can share a `ts`. To page a run of tied rows without skipping the remainder at the boundary, echo **both** cursor components back: `before=<nextCursor>&before_id=<nextCursorId>` for the default `desc`, or `after=<nextCursor>&after_id=<nextCursorId>` for `order=asc`. The query then matches the boundary as a composite `(ts, id)` tuple. Passing only `before`/`after` (the `ts`) remains valid and byte-for-byte backward compatible; it just retains the legacy behavior of dropping not-yet-shown rows that share the exact boundary `ts`.

---

### GET /api/v1/agents/:agentId/chats/:chatId/messages/search

Full-text search across messages using SQLite FTS5.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `q` | Yes | Search query string |
| `limit` | No | Max results (default 20, max 100) |
| `offset` | No | Pagination offset (default 0) |

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/messages/search?q=meeting" | jq
```

```json
{
  "messages": [
    { "role": "user", "content": "Schedule a meeting tomorrow", "ts": 1775737709000, "sessionId": "abc-123" }
  ],
  "total": 1
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `q` is missing or empty |

---

### GET /api/v1/agents/:agentId/chats/:chatId/messages/active-days

Returns the distinct **local calendar days** that have at least one message inside a `[from, to)`
window. Intended for a jump-to-date calendar: the client requests the visible month once and
draws a "has history" dot under each returned day, without paging the whole thread into memory.
The query rides the `(chat_id, ts)` index as a bounded range scan, so a one-month window returns
at most ~31 days.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `from` | Yes | Window start, UTC epoch ms, **inclusive** (`ts >= from`) |
| `to` | Yes | Window end, UTC epoch ms, **exclusive** (`ts < to`) |
| `tz_offset` | No | Viewer's timezone offset in **minutes east of UTC** (`local = UTC + offset`). Bangkok (UTC+7) is `+420`, India (UTC+5:30) is `+330`, New York (UTC-4 DST) is `-240`. Default `0` (UTC bucketing). Clients computing this from JavaScript should send `-new Date().getTimezoneOffset()` (that API returns the opposite sign). |
| `session_id` | No | Restrict to a single session (parity with the messages endpoint) |

Days are returned as `YYYY-MM-DD` strings, **distinct and sorted ascending**. An empty or
inverted window (`to <= from`) and a window with no messages both return `{ "days": [] }` with
status `200`. The window may span at most **366 days** (`to - from`); a larger range returns 400,
since the calendar only ever requests one visible month at a time.

> **Window is filtered in UTC, days are bucketed in local time.** `from`/`to` are matched against
> the raw stored `ts` (UTC ms), while the returned day labels use `tz_offset`. For a viewer east of
> UTC, the first local day of a month begins *before* its UTC midnight (e.g. Bangkok's `2026-07-01`
> starts at `2026-06-30T17:00Z`). Send `from`/`to` covering the visible month **in the viewer's
> local time** — i.e. widen the UTC window by `tz_offset` — so edge days aren't under-counted.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/messages/active-days?from=1751328000000&to=1754006400000&tz_offset=420" | jq
```

```json
{
  "days": ["2026-07-02", "2026-07-03", "2026-07-05", "2026-07-09"]
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `from` or `to` is missing or non-numeric |
| 400 | `tz_offset` is present but non-numeric |
| 400 | window is larger than 366 days (`to - from`) |

---

### POST /api/v1/agents/:agentId/chats/:chatId/sessions/:sessionId/messages

Inject a message into an existing Telegram, Discord, or API session and stream the assistant's response via SSE. Useful for cross-channel continuation.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `content` | Yes | Message text (max 10,000 chars) |
| `senderName` | No | Optional display name for the injected message |

```bash
curl -N -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"content": "Continue from where we left off", "senderName": "API"}' \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/sessions/abc-123/messages"
```

**Response** (SSE stream):

```
data: {"type":"text_delta","text":"Sure, let me continue..."}
data: {"type":"result","text":"Sure, let me continue...","session_id":"abc-123"}
data: [DONE]
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `content` is missing or too long |
| 403 | Key has no access to agent |
| 404 | Agent not found |

**Timeouts differ from the main messages endpoint.** This stream has a fixed
60-second budget, and passing it is **terminal** here: the connection closes
with `{"type":"error","message":"Agent response timeout","code":"TIMEOUT_SOFT"}`.
There is no `timeout` event, no hard cap, and no resume endpoint for this path —
the turn is abandoned, not interrupted, so the agent keeps working and its reply
still lands in the session history. Read it back from
[`GET …/chats/:chatId/sessions`](#get-apiv1agentsagentidchatschatidsessions) or
start a fresh turn. See [Streaming API (SSE)](#streaming-api-sse) for how
`TIMEOUT_SOFT` differs from `TIMEOUT`.

---

## Media API

Upload and serve media files (images and PDFs) associated with an agent. Uploaded files are stored in the agent's media directory and can be referenced in messages via `media_files[]`.

### POST /api/v1/agents/:agentId/media

Upload a media file as a raw binary body. Supported MIME types: `image/*`, `application/pdf`.

**Request headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | MIME type of the file (e.g. `image/jpeg`, `application/pdf`) |
| `X-Filename` | No | Original filename — used to preserve extension |

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: image/jpeg" \
  -H "X-Filename: photo.jpg" \
  --data-binary @/path/to/photo.jpg \
  http://localhost:10850/api/v1/agents/alfred/media | jq
```

```json
{ "mediaPath": "ui-upload/2026-05-10/gw-1746837600000.jpg" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | No file body received |
| 403 | Key has no access to agent |
| 404 | Agent not found |
| 413 | File exceeds max upload size |
| 415 | Unsupported MIME type |

---

### GET /api/v1/agents/:agentId/media/*

Serve a media file by path. The path must stay within the agent's media directory.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/media/ui-upload/2026-05-10/gw-1746837600000.jpg" \
  --output photo.jpg
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Path traversal attempt or invalid path |
| 403 | Key has no access to agent |
| 404 | Agent or file not found |

---

## App Store API

Manage Docker-compose apps installed on the gateway. Apps can be sourced from the community registry or a custom GitHub repository.

**Auth levels:** All App Store endpoints require API key auth. Write operations (install, update, uninstall, start/stop/restart) require an **admin** key.

**Proxy routes:** Installed apps are exposed at `/app/:name/:portName/*` (no auth required at proxy layer — authentication is handled by each app).

---

### Endpoints Overview

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/apps/registry` | Key | Fetch community registry (5-min cached) |
| `GET` | `/api/v1/apps/registry/:name` | Key | Get versions of a specific registry app |
| `GET` | `/api/v1/apps` | Key | List all installed apps |
| `POST` | `/api/v1/apps/install` | Admin | Start async install → returns `jobId` |
| `POST` | `/api/v1/apps/inspect` | Admin | Read-only preview of a source → required/generated secrets (no install) |
| `GET` | `/api/v1/apps/jobs/:jobId` | Key | Poll install/update job status + logs |
| `GET` | `/api/v1/apps/:name` | Key | Get installed app info |
| `DELETE` | `/api/v1/apps/:name` | Admin | Uninstall app (docker down + cleanup) |
| `POST` | `/api/v1/apps/:name/start` | Admin | Start stopped app |
| `POST` | `/api/v1/apps/:name/stop` | Admin | Stop running app |
| `POST` | `/api/v1/apps/:name/restart` | Admin | Restart app |
| `GET` | `/api/v1/apps/:name/version` | Key | Check current + latest version |
| `POST` | `/api/v1/apps/:name/update` | Admin | Start async update with rollback → returns `jobId` |
| `POST` | `/api/v1/apps/:name/reconfigure` | Admin | Start async env/host-port reconfigure (keeps volumes) → returns `jobId` |

---

### GET /api/v1/apps/registry

Fetch the community registry (cached 5 minutes, falls back to stale on network failure).

```bash
curl -H "X-Api-Key: my-key" http://localhost:10850/api/v1/apps/registry | jq
```

```json
{
  "updated_at": "2026-05-19T00:00:00.000Z",
  "apps": [
    {
      "name": "agent-note",
      "description": "Note-taking app with AI agent",
      "repo": "https://github.com/0xMaxMa/app-agent-note",
      "author": "0xMaxMa",
      "versions": [
        { "version": "1.0.0", "commit": "abc123def456abc123def456abc123def456abc1", "approved_at": "2026-05-01T00:00:00.000Z" }
      ]
    }
  ]
}
```

---

### GET /api/v1/apps/registry/:name

Get all versions of a specific app from the community registry.

```bash
curl -H "X-Api-Key: my-key" http://localhost:10850/api/v1/apps/registry/agent-note | jq
```

**Error responses:**

| Status | When |
|--------|------|
| 404 | App not found in registry |
| 502 | Registry fetch failed |

---

### GET /api/v1/apps

List all installed apps and their status.

```bash
curl -H "X-Api-Key: my-key" http://localhost:10850/api/v1/apps | jq
```

```json
{
  "apps": [
    {
      "name": "agent-note",
      "version": "1.0.0",
      "commit": "abc123def456abc123def456abc123def456abc1",
      "githubUrl": "https://github.com/0xMaxMa/app-agent-note",
      "installPath": "/home/user/.claude-gateway/apps/agent-note",
      "ports": [{ "name": "web", "service": "app", "containerPort": 4000, "type": "web", "rateLimit": 200 }],
      "sockets": {},
      "installedAt": "2026-05-19T10:00:00.000Z",
      "updatedAt": "2026-05-19T10:00:00.000Z",
      "status": "running",
      "source": "registry"
    }
  ]
}
```

**`status` values:** `running` | `stopped` | `error` | `building`

> **Live status:** `GET /api/v1/apps` and `GET /api/v1/apps/:name` reconcile the stored status against the live Docker runtime (`docker compose ps`) on read, so a container that crashed, was OOM-killed, was stopped from outside the gateway, or is stuck in a crash-restart loop reports `stopped`/`error` rather than a stale `running`. A `running` container (or one doing a clean/transient restart) → `running`; a container stuck `restarting` after a non-zero exit (crash-loop), an exit with a non-signal non-zero code, or a `dead` container → `error`; no containers, a clean exit, or a container force-killed by an explicit stop (exit 137/SIGKILL or 143/SIGTERM) → `stopped`. If Docker cannot be queried (daemon down, compose file missing) the last stored status is returned unchanged, and an app mid-install (`building`) is not reconciled.

> **Boot restore:** an app whose containers the boot-time restore is still bringing up is **not** reconciled either — its stored status is returned as-is, so a read landing mid-restore cannot see the not-yet-created containers and write `stopped` underneath it. Because the apps restored are exactly those stored as `running`, that status alone cannot tell a rebuild in progress from an app that is actually serving, so the entry carries `restoring` while the restore is in flight. If that restore **failed**, the app reports `error` together with two further fields, and the stored `running` intent is deliberately left alone so the next boot retries it:
>
> | Field | Description |
> |-------|-------------|
> | `restoring` | `true` while this process's boot restore is still bringing the app up — its containers may not exist yet, so the reported `status` is the stored intent, not observed state |
> | `restoreError` | Why this process's boot restore of the app failed (compose error or timeout) |
> | `restoreFailedAt` | ISO timestamp of that failure |
>
> All three are absent unless they apply (never `false`), and are in-memory only — they describe the current gateway process. The batch to restore is marked before the gateway accepts its first request, so there is no startup window in which an app awaiting restore reports a bare `running`. `restoring` clears the moment that app's own restore ends, so a boot's restore surfaces as either in-flight or failed rather than both at once. The failure fields clear as soon as the app is observed `running`, or on an explicit start/stop.

**`source` values:** `registry` | `custom` | `local`

---

### POST /api/v1/apps/install

Start an asynchronous install job. Returns immediately with a `jobId` to poll.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `registry_app` | One of | App name from community registry |
| `version` | No | Specific version from registry (default: latest) |
| `github_url` | One of | GitHub repo URL — must be `https://github.com/<owner>/<repo>` (no other hosts accepted) |
| `commit` | If `github_url` | 40-char hex commit SHA (branch names not accepted). Omit to auto-resolve HEAD. |
| `local_path` | One of | Absolute path to local project dir (dev mode — symlinked, source never deleted) |
| `env_vars` | No | Pre-supplied env vars as a JSON **object** (not array). Keys must match vars declared in `app.yaml`. |
| `ports` | No | Host-port overrides as a JSON **object** mapping port name → host port (e.g. `{ "web": 4000 }`). Default host port comes from `app.yaml`. Overrides must be integers ≥ 1024 and not banned (`22`, `80`, `443`, `10850`). The integer/banned/`< 1024` checks are synchronous (`400`); a port **name** that the app does not declare is caught only once the source is fetched, so it surfaces as a **failed install job**, not a sync `400` (the app's `app.yaml` is not available until the job runs). Reconfigure, by contrast, validates names synchronously because the app is already installed. |

**Mode A — registry install:**
```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{"registry_app": "agent-note"}' \
  http://localhost:10850/api/v1/apps/install | jq
```

**Mode A — registry install with specific version:**
```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{"registry_app": "agent-note", "version": "1.0.0"}' \
  http://localhost:10850/api/v1/apps/install | jq
```

**Mode B — custom GitHub repo:**
```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "github_url": "https://github.com/myorg/my-app",
    "commit": "abc123def456abc123def456abc123def456abc1",
    "env_vars": { "DATABASE_URL": "postgres://..." }
  }' \
  http://localhost:10850/api/v1/apps/install | jq
```

**Mode C — local dev (symlink):**

Use when developing an app locally. Creates a symlink `~/.claude-gateway/apps/{name}` → your project directory instead of cloning. The full install pipeline (validate, compose, build, start) runs the same as other modes. Uninstalling removes only the symlink — your source directory is never touched.

```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{"local_path": "/home/dev/projects/my-app"}' \
  http://localhost:10850/api/v1/apps/install | jq
```

After editing source, restart the app to pick up changes:
```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  http://localhost:10850/api/v1/apps/my-app/restart | jq
```

```json
{ "jobId": "550e8400-e29b-41d4-a716-446655440000" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Missing required fields, invalid commit format, invalid `github_url` format, `env_vars` not an object, or path does not exist |
| 403 | Not an admin key |

> Poll `GET /api/v1/apps/jobs/:jobId` to track progress. Install pipeline: clone/symlink → validate `app.yaml` → generate compose → build images → start containers → register proxy routes. On failure, container logs are appended to `logs` before rollback.

---

### POST /api/v1/apps/inspect

Read-only preview of an install source. Fetches and parses the app's `app.yaml`
(shallow clone for registry/GitHub sources; direct read for a local path)
**without installing anything and leaving no files behind**, and returns the
metadata needed for an accurate pre-install summary — most importantly which
secrets the operator must supply versus which the gateway auto-generates.

This is essential for a **GitHub-URL** install: such apps have no registry entry,
so `GET /api/v1/apps/registry/:name` cannot reveal their required secrets — only
this endpoint can.

**Request body:** same source fields as install (`registry_app` [+ `version`],
`github_url` [+ `commit`], or `local_path`). `env_vars` is ignored — nothing is
injected. One of the three sources is required.

```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{"github_url": "https://github.com/myorg/my-app"}' \
  http://localhost:10850/api/v1/apps/inspect | jq
```

**Response `200`:**
```json
{
  "name": "my-app",
  "version": "1.0.0",
  "source": "custom",
  "commit": "abc123def456abc123def456abc123def456abc1",
  "secretKeys": ["DB_PASSWORD"],
  "generatedKeys": [{ "key": "SESSION_SECRET", "encoding": "hex", "bytes": 32 }],
  "secretDefaults": { "NEXTAUTH_URL": "http://localhost:3737" },
  "ports": [{ "name": "web", "service": "app", "hostPort": 12000, "containerPort": 3000, "type": "web" }],
  "agentDeclaration": null,
  "warnings": []
}
```

- `secretKeys` — env vars the operator **must** supply (declared as bare keys in `app.yaml`).
- `generatedKeys` — secrets the gateway fills with a fresh random value at install (declared as `KEY=!generate:<encoding>:<bytes>`); never prompted for.
- `secretDefaults` — defaults for prompted secrets declared as `KEY=!default:<value>`. The key is still listed in `secretKeys` (prompted and editable), but the value here pre-fills the field; if the operator leaves it blank the default is written to `.env`. Only keys with a declared default appear. Precedence at install: operator-supplied value → default → empty.

**Error responses:**

| Status | When |
|--------|------|
| 400 | Missing source fields, invalid `github_url`/`commit` format, repo unreachable, or `app.yaml` missing/invalid |
| 403 | Not an admin key |

---

### GET /api/v1/apps/jobs/:jobId

Poll the status of an async install or update job.

```bash
curl -H "X-Api-Key: my-key" \
  http://localhost:10850/api/v1/apps/jobs/550e8400-e29b-41d4-a716-446655440000 | jq
```

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "logs": [
    "[2026-05-19T10:00:01.000Z] Cloning https://github.com/0xMaxMa/app-agent-note",
    "[2026-05-19T10:00:05.000Z] Checked out commit abc123de",
    "[2026-05-19T10:00:06.000Z] Validating app.yaml",
    "[2026-05-19T10:00:07.000Z] Generating docker-compose.yml",
    "[2026-05-19T10:00:07.000Z] Building images",
    "[2026-05-19T10:00:45.000Z] Starting containers",
    "[2026-05-19T10:00:50.000Z] Containers healthy",
    "[2026-05-19T10:00:50.000Z] Install complete: {\"web\":\"/app/agent-note/web/\"}"
  ],
  "result": {
    "appName": "agent-note",
    "proxyUrls": { "web": "/app/agent-note/web/" },
    "secretKeys": ["DATABASE_URL"],
    "agentDeclaration": null
  },
  "startedAt": 1747648800000,
  "updatedAt": 1747648850000
}
```

**`status` values:** `pending` | `running` | `completed` | `failed`

When `status` is `failed`, `error` contains the failure message. If the containers started but failed the healthcheck, container logs are appended to `logs` before rollback. An update that fails before the new containers start says so (`Update failed during the directory swap`) rather than reporting a container failure. Rollback is normally invisible, with one deliberate exception: if live bind-mount data cannot be moved back into the restored app directory, the app is **not** restarted on a half-restored directory — the `-failed-` directory still holding that data is kept, `error` reports `Update failed and rollback also failed`, and the logs name the paths and the directory to recover them from:

```json
{
  "id": "...",
  "status": "failed",
  "logs": [
    "[2026-05-19T10:00:45.000Z] Starting containers",
    "[2026-05-19T10:00:47.000Z]   my-app  | 2026/05/19 10:00:46 API_KEY is required",
    "[2026-05-19T10:00:47.000Z]   my-app  | 2026/05/19 10:00:47 API_KEY is required",
    "[2026-05-19T10:00:47.000Z] Build/start failed — rolling back"
  ],
  "error": "Command failed: docker compose — container my-app is unhealthy",
  "startedAt": 1747648845000,
  "updatedAt": 1747648847000
}
```

**Error responses:**

| Status | When |
|--------|------|
| 404 | Job ID not found |

---

### GET /api/v1/apps/:name

Get info for an installed app.

```bash
curl -H "X-Api-Key: my-key" \
  http://localhost:10850/api/v1/apps/agent-note | jq
```

Returns the full `AppEntry` object (same shape as items in `GET /api/v1/apps`).

---

### DELETE /api/v1/apps/:name

Uninstall an app: `docker compose down --rmi all`, remove proxy routes, sockets, agent entry, and app files.

```bash
curl -X DELETE \
  -H "X-Api-Key: admin-key" \
  http://localhost:10850/api/v1/apps/agent-note | jq
```

```json
{ "deleted": true, "name": "agent-note" }
```

**Error responses:**

| Status | When |
|--------|------|
| 403 | Not an admin key |
| 404 | App not installed |

---

### POST /api/v1/apps/:name/start|stop|restart

Start, stop, or restart an installed app's containers. Admin key required. Runs
synchronously and responds `200` once `docker compose` completes — there is no
`jobId` to poll. `stop`/`start` are idempotent (stopping an already-stopped app
or starting an already-running one is a clean no-op).

```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  http://localhost:10850/api/v1/apps/agent-note/restart | jq
```

```json
{ "name": "agent-note", "action": "restart" }
```

**Errors:** `403` if the key is not an admin key · `404` if the app is not
installed (or `:action` is not one of `start`/`stop`/`restart`) · `409` if a
mutating job (install/update/reconfigure/backup/restore) is currently in
progress for the app · `500` on an underlying `docker compose` failure.

---

### GET /api/v1/apps/:name/version

Check the currently installed version vs latest in the registry. Only meaningful for `source: "registry"` apps.

```bash
curl -H "X-Api-Key: my-key" \
  http://localhost:10850/api/v1/apps/agent-note/version | jq
```

```json
{
  "installed": "1.0.0",
  "installed_commit": "abc123def456abc123def456abc123def456abc1",
  "latest": "1.1.0",
  "latest_commit": "def456abc123def456abc123def456abc123def4",
  "behind": true,
  "updateable": true
}
```

For custom/local apps, `latest` and `latest_commit` are `null` and `updateable` is `false`.

---

### POST /api/v1/apps/:name/update

Start an async update. Uses blue/green swap: the new version is cloned and built in a hidden `.cg-update-*` staging directory **beside the app's install path** (same filesystem, so the swap is a rename), old containers are stopped, the staging directory is swapped into the permanent install path, and only then are the new containers started. Rollback is automatic if the new containers fail their health check. The `.env` from the previous install is copied forward, so volumes and secrets are preserved.

Starting *after* the swap is what keeps relative bind mounts (`./postgres/pgdata`) pointing at the app's permanent directory — a stack started from the staging path would bind newly created empty data and a stateful service would re-initialise (issue #396). App-owned bind directories are carried across the swap by rename, preserving inode and ownership.

If the updated release also ships content at a bind path (a tracked `.gitkeep`, seed files, an `init.sql`), the two are merged: **existing data always wins**, and release-provided files the previous version did not have are kept. A collision on a non-directory path — or a live directory the gateway user cannot even list, which no entry-by-entry merge can reach — preserves the existing data and logs a warning naming both the path and the release files being discarded, so a config file you bind-mount from the repo must be re-applied by hand after the update.

The `.cg-update-*` staging checkout left behind by a crash mid-update is swept on gateway boot. Release snapshots (`<appDir>-old-*`, `<appDir>-failed-*`) are **not**: either can hold the only copy of live bind-mount data, and the sweep deletes with `sudo rm -rf`. They are reported on the gateway console at boot and left for you to recover or remove.

A rollback restores the previous **image** as well as the previous source. A `build:` service's new image reuses the running one's tag (`<project>-<service>:latest`), so before building, the update tags each of the app's built images `<project>-<service>:cg-rollback-<id>` — that keeps the old image addressable and alive (under the containerd image store an untagged image is not retained as a `<none>` image). A rollback points the tag back at it, so the app returns on the exact release it was serving; the private tag is dropped once the update settles either way. If an image cannot be restored, the rollback rebuilds from the rolled-back source instead of starting the failed release's build, and logs which reference it could not restore.

The image tags are put back **before** the rollback decides whether to restart the app, so the deliberate no-restart case above still leaves `<project>-<service>:latest` naming the release the restored source actually is — finishing that recovery by hand cannot bring old source up on the failed release's build. In that case the private `cg-rollback-*` tags are also **kept** rather than dropped, since they are the last reference holding the pre-update image; the job log names them.

If the app declares an agent, its registration follows the new release: an agent whose name changed is deregistered under the old name before the new one is registered, and an agent the release no longer declares is deregistered entirely. Either way the agent's directory and session history are preserved (only the `workspace` symlink and the `config.json` entry are removed), and `MEMORY.md` is carried forward — written after the new registration exists, so it survives a rename.

The update target depends on the app's `source`:
- `registry` — the latest published registry version.
- `custom` (installed from a GitHub URL) — the current default-branch `HEAD` of the app's repo, resolved via `git ls-remote`. If the resolved commit already matches the installed one, the job completes as a no-op.
- `local` (symlinked directory) — not updatable; returns `400`.

```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  http://localhost:10850/api/v1/apps/agent-note/update | jq
```

```json
{ "jobId": "661f9511-f30c-52e5-b827-557766551111" }
```

Poll the returned `jobId` with `GET /api/v1/apps/jobs/:jobId` to track progress.

**Error responses:**

| Status | When |
|--------|------|
| 400 | App source is `local` (symlinked apps cannot be updated) |
| 403 | Not an admin key |
| 404 | App not installed |

---

### POST /api/v1/apps/:name/reconfigure

Start an async reconfigure of an already-installed app — change its env vars and/or host ports, then force-recreate the container **in place**. Named volumes (and their data) are preserved: this is a `docker compose up --force-recreate`, never a `down -v`. The container always restarts so it picks up the new values.

**Request body** (at least one of `env_vars` / `ports` is required):

| Field | Required | Description |
|-------|----------|-------------|
| `env_vars` | One of | Env vars to **merge** into the app's existing `.env` as a JSON **object** (values must be strings). Keys not supplied are preserved; existing self-generated secrets are kept, not rotated. Passing an **empty string** (`""`) for a self-generating (`!generate`) key rotates it — the installer discards the old value and generates a fresh secret. |
| `ports` | One of | Host-port overrides as a JSON **object** mapping port name → host port (e.g. `{ "web": 4000 }`). Overrides must be integers ≥ 1024 and not banned (`22`, `80`, `443`, `10850`), and must not collide with another installed app. A port name not declared by the app is rejected with `400` (see errors). |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "env_vars": { "DATABASE_URL": "postgres://..." },
    "ports": { "web": 4000 }
  }' \
  http://localhost:10850/api/v1/apps/agent-note/reconfigure | jq
```

```json
{ "jobId": "772fa622-a41d-63f6-c938-668877662222" }
```

Poll the returned `jobId` with `GET /api/v1/apps/jobs/:jobId` to track progress. When a host port changes, the proxy route is re-registered and the returned job's `proxyUrls` reflect the new port.

**Rollback on failure:** if a host-port reconfigure fails to recreate the container (e.g. the new port is unbindable or the healthcheck never passes), the app is rolled back to its previous ports — the old compose/`.env` are restored, the old container is brought back up, and the old proxy routes are re-registered — so the app stays reachable. The job is still reported as `failed`.

**Error responses:**

| Status | When |
|--------|------|
| 400 | Neither `env_vars` nor `ports` supplied; a `ports` value is non-integer / banned / `< 1024` / collides with another app; an `env_vars` value is not a string; app source is `local` |
| 403 | Not an admin key |
| 404 | App not installed |
| 409 | App is already being installed / updated / reconfigured |

---

### POST /api/v1/apps/housekeeping

Reclaim leaked Docker **build cache** and **dangling images** left behind by app install/update (issue #302). The gateway builds/pulls images on every install and update but never reclaimed the build cache or orphaned layers those operations leave, so a long-lived host leaks steadily. This endpoint surfaces and — on request — reclaims that junk, **safely**.

**Body:** `{ "mode": "report" | "prune" }` (default `"report"`).

- **`report`** — read-only. Returns the reclaimable build cache, the dangling-image count, and the orphaned-volume names. Mutates nothing.
- **`prune`** — executes **only the safe reclaim**: `docker builder prune -f --filter until=<window>h` (time-filtered, so a concurrent build's fresh layers survive) and `docker image prune -f` (dangling `<none>` layers only — **never `-a`**). Returns which reclaims ran plus a fresh report.

**Safety floor (always enforced, regardless of config):**

- Never `docker system prune -a`, never `docker image/builder prune -a`.
- **Never** an automatic `docker volume prune` — orphaned volumes can hold real app data, so they are **reported but never auto-deleted**.
- Never touches another app's tagged images.

```bash
# Report only
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"mode":"report"}' \
  http://localhost:10850/api/v1/apps/housekeeping | jq

# Safe prune (build cache + dangling images only)
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"mode":"prune"}' \
  http://localhost:10850/api/v1/apps/housekeeping | jq
```

**Report response:**

```json
{
  "mode": "report",
  "report": {
    "buildCacheReclaimable": "1.457GB",
    "danglingImageCount": 0,
    "orphanVolumes": ["orphan_vol_a", "orphan_vol_b"]
  }
}
```

**Prune response:**

```json
{
  "mode": "prune",
  "pruned": { "buildCache": true, "danglingImages": true },
  "report": { "buildCacheReclaimable": "0B", "danglingImageCount": 0, "orphanVolumes": ["orphan_vol_a"] }
}
```

The same reclaim runs **automatically** after every successful install/update (best-effort — a prune failure never fails the parent operation). It is gated by `gateway.appHousekeeping` in the config:

```jsonc
"gateway": {
  "appHousekeeping": {
    "buildCachePrune": true,        // default on
    "buildCacheMaxAgeHours": 168,   // 7-day window
    "danglingImagePrune": true      // safe subset (no -a)
    // volumes are report-only — no auto-delete key on purpose
  }
}
```

Set all toggles to `false` to make the automatic path issue **zero** prune calls. (The manual `prune` mode above is an explicit operator action and always runs the safe reclaim.)

**Error responses:**

| Status | When |
|--------|------|
| 400 | `mode` is neither `report` nor `prune` |
| 403 | Not an admin key |

---

### App Proxy

Installed apps with `ports` declared in their `app.yaml` are accessible at:

```
/app/:appName/:portName/*
```

No gateway auth is required — apps handle their own authentication. Rate limiting is applied per-port as declared in `app.yaml` (`rate_limit` field, default 200 req/s).

Both `:appName` and `:portName` must match `[a-z0-9][a-z0-9-]{1,63}` — requests with names outside this pattern are rejected with `400`.

```
# Example: web app on port 4000 with portName "web"
http://localhost:10850/app/agent-note/web/

# Example: API on port 3000 with portName "api"
http://localhost:10850/app/getpod-manager/api/v1/metrics
```

**Port type behaviour:**

| Type | Path behaviour |
|------|---------------|
| `api` | Strips `/app/:name/:portName` prefix before forwarding |
| `web` | Preserves full original URL path (required for SPAs) |

---

### app.yaml Reference

Every installable app must include an `app.yaml` at the repository root.

**Minimal example:**

```yaml
apiVersion: "1.0"
name: my-app
version: "1.0.0"
commit: "abc123def456abc123def456abc123def456abc1"
description: "My application"

services:
  app:
    build: .
    ports:
      - name: web
        container: 4000
        host: 4000
        type: web
        rate_limit: 200
```

**Full field reference:**

| Field | Required | Description |
|-------|----------|-------------|
| `apiVersion` | Yes | Always `"1.0"` |
| `name` | Yes | App slug `[a-z0-9][a-z0-9-]{1,63}` |
| `version` | Yes | Semantic version |
| `commit` | Yes | Pinned commit SHA |
| `description` | No | Human-readable description |
| `resources.cpu` | No | CPU limit (default 1.0, max 4.0) |
| `resources.memory` | No | Memory limit e.g. `"256M"`, `"1G"` (max 2G) |
| `services.<name>` | Yes | One or more service definitions |
| `services.agent` | No | Agent service declaration (see below) |

**Service fields:**

| Field | Description |
|-------|-------------|
| `build` | Relative path to Dockerfile directory |
| `image` | Docker image (mutually exclusive with `build`) |
| `command` | Override container command |
| `entrypoint` | Override container entrypoint |
| `environment` | Static env vars (`KEY=value`), secret keys to prompt for (`KEY` without `=`), or self-generating secrets (`KEY=!generate:<encoding>:<bytes>`) |
| `volumes` | Volume mounts (named volumes or host paths within app dir). A relative source must start with `./` and stay inside the app dir — `../` is rejected at parse time, as is any embedded `/../`. **Breaking change:** an app installed before this rule that declares a `../` source can no longer be updated or reconfigured until its manifest is corrected. |
| `ports` | Array of port declarations (see **Port fields** below) |
| `depends_on` | Service dependency list |
| `healthcheck` | Docker healthcheck (test, interval, timeout, retries) |
| `gateway_api` | Host script bridge via Unix socket (see below) |

**Port fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Port identifier used in the proxy path (`/app/:name/:portName`). Unique within the service. |
| `container` | Yes | Port the app listens on **inside** the container. Integer `>= 1024`, not a banned port (`22`, `80`, `443`, `10850`), unique within the service. |
| `host` | Yes | Port exposed on the **host**. Integer `>= 1024`, not a banned port (`22`, `80`, `443`, `10850`), unique within the service. A manifest with a port that has no integer `host` is rejected at install/inspect (`ports["<name>"].host is required and must be an integer`). Default it to the same value as `container`; the installer can override it via the install/reconfigure `ports` field. |
| `type` | No | `api` (strips the `/app/:name/:portName` prefix before forwarding) or `web` (preserves the full path, required for SPAs). |
| `rate_limit` | No | Requests per second for this port (positive number, default 200). |

**Banned fields:** `network_mode: host`, `privileged`, `cap_add`. The gateway always injects `cap_drop: ALL`, `restart: unless-stopped`, `env_file: .env`, and resource limits.

**Self-generating secrets (`!generate`):** An `environment` entry of the form `KEY=!generate:<encoding>:<bytes>` declares a per-install random string. The installer fills it with `crypto.randomBytes(<bytes>)` at install time — the author never hands a value to the installer, and such keys are **not** reported in `secretKeys` (they are never prompted for). Encodings: `hex`, `base64`, `base64url` (URL/connection-string safe — no `+` `/` `=`). Length must be `8`–`512` bytes; an unknown encoding or bad length fails at parse. An explicit `env_vars` value for the key overrides generation. `update` preserves the value already in `.env` (never regenerates). A **local** install also preserves a value already present in the app dir's `.env`: re-installing a local app over a source tree that still holds a prior `.env` keeps the secret stable, so the app can reconnect to persisted data (e.g. a `pgdata` bind mount). A registry/GitHub install always generates fresh (any `.env` checked out from the source is ignored). Precedence: operator-supplied `env_vars` → existing `.env` (local install / update) → generate. Example: `- NEXTAUTH_SECRET=!generate:base64:32`.

**Agent service declaration:**

```yaml
services:
  agent:
    path: ./agent      # relative path to agent workspace within repo
    name: my-agent     # agent ID, must match [a-z][a-z0-9-]{1,63}
```

When declared, the gateway injects a `debian:stable-slim` container, mounts the claude CLI and node binaries, and registers the agent in `config.json`. Messages to this agent are dispatched via `docker exec`.

**Host script bridge (`gateway_api`):**

```yaml
services:
  app:
    gateway_api:
      socket: /var/run/gateway.sock
      scripts:
        resize-disk:
          path: scripts/resize-disk.sh
          timeout: 60s
          args:
            - name: size_gb
              type: string
              pattern: "^\\d+$"
```

The gateway mounts a **directory** (not a socket file) into the container. This means the socket file (`gateway.sock` inside that directory) is stable across gateway restarts — the container's bind mount points to the directory inode, so it always sees the latest socket.

The container connects to `http+unix://<socket>/tool/script/<name>` and POST `{"args": {"size_gb": "20"}}` to invoke a declared script. The gateway only exposes `PATH` and `HOME` to scripts.

**Request body limit:** 1 MB. Requests larger than this are rejected with `413`.

**Arg validation:** Each argument is validated against its declared `pattern` (compiled once at socket startup, not per request). Values exceeding 256 characters are rejected.

---

## Connectors API

A **connector** is an MCP server the gateway injects into a Claude Code session's
`mcp-config.json`. The gateway owns three things and nothing else: the connector
definition, the per-connector secret, and the per-agent enablement. At spawn, an
enabled + connected connector is resolved into an `mcpServers` entry and Claude Code
then talks to the real MCP server directly.

Every connector lives in `gateway.customConnectors` in `config.json` — admin-trusted
raw `mcpServers` JSON, **not** code-reviewed. Connectors differ along exactly one axis,
`credentialOwner`: who holds the credential and is responsible for keeping it valid.

| `credentialOwner` | Who holds the credential | Written by |
|-------------------|--------------------------|------------|
| `none` | Nobody — `secretNames` is empty, there is nothing to connect or disconnect | `POST /v1/connectors/custom` |
| `static` | A human pasted a value; it is valid until someone replaces it | `POST /v1/connectors/custom`, `POST /:id/connect` |
| `gateway` | This gateway ran the OAuth flow, holds the `refresh_token`, and renews the `access_token` itself. The only value the refresh sweep acts on | `POST /v1/connectors/custom` with `oauth: true` |
| `external` | An external control plane owns the sign-in and pushes fresh tokens in; the gateway never refreshes | `POST /:id/oauth/receive` |

The field is written once, by the route that creates the entry, and read verbatim
everywhere after — nothing re-derives it at read time.

An entry is raw `mcpServers`-entry JSON with `{placeholder}` tokens standing in
for secrets, e.g.:

```json
{
  "type": "streamable-http",
  "url": "https://mcp.example.com/v2/mcp",
  "headers": { "Authorization": "Bearer {api_key}" }
}
```

At add time the gateway extracts every `{name}` placeholder into `secretNames`; at spawn
it substitutes each one from the secret store. A connector counts as **connected** when
every one of its `secretNames` has a value — the secret store alone answers that
question, never `config.json`.

**Secret storage.** Values live in `~/.claude-gateway/mcp-token.env`, a `KEY=value`
file at mode `0600`, parsed fresh on every read (a "connect" takes effect on the next
session spawn, with no gateway restart). Connector keys are namespaced
`CUSTOM__<connectorId>__<placeholderName>` so two connectors that both use `{api_key}`
cannot collide. Override the path with `GATEWAY_MCP_TOKEN_ENV_PATH` (used by tests).

> A reserved second namespace, `CUSTOMINT__<connectorId>__<name>`, holds the gateway's
> own OAuth bookkeeping (refresh token, client id, expiry, failure counters). Placeholder
> names beginning with `__` are rejected at add time, and the two namespaces are separate
> prefixes so a pasted `{__refresh_token}` cannot resolve to gateway-internal state even
> if a future caller forgets to validate.

**Connector ids** are slugs: `^[a-z0-9][a-z0-9-]*$`, max 64 characters. Ids are used
directly as `config.json` object keys and are interpolated into secret-file key names, so
every route validates the shape of `:id` before touching either — anything else is `400
Invalid connector id`, ahead of any lookup.

**Auth levels:** read routes take any valid API key; every mutating route requires an
**admin** key (`agents: "*"`). When `gateway.api.keys` is not configured at all, auth is
skipped entirely, the same as the rest of the API.

---

### GET /api/v1/connectors

List every connector with its current connected state.

```bash
curl -s -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/connectors | jq
```

```json
{
  "connectors": [
    {
      "id": "firecrawl",
      "label": "Firecrawl",
      "description": "Web scraping and crawling",
      "credentialOwner": "gateway",
      "connected": true,
      "repoUrl": "https://firecrawl.dev",
      "refresh": {
        "consecutiveFailures": 3,
        "permanentFailures": 0,
        "nextAttemptAt": 1893456000000
      }
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `credentialOwner` | `none` \| `static` \| `gateway` \| `external` — see the table above. Also tells a UI which way to offer connecting: a paste-token box (`static`), a "Sign in" link pointing at `/oauth/start` (`gateway`), or neither |
| `connected` | Every required secret is present (always `true` for `credentialOwner: "none"`) |
| `refresh` | **Absent when healthy.** Present only while a `gateway`-owned connector's background token refresh is failing — either transiently (a network error, DNS, a 5xx) or because the authorization server itself refused the grant. See below. Never present for any other owner: this gateway holds a `refresh_token` for none of them. |

`connected` is computed purely from secret presence, and a transient refresh
failure deliberately never deletes the stored token (an outage must not destroy a
valid sign-in). So a connector whose provider disappeared hours ago still reports
`connected: true` while every call through its expired token fails. `refresh` is
what lets a UI say "connected, but refreshing is failing" instead of showing an
indefinite green checkmark:

| Field | Description |
|-------|-------------|
| `refresh.consecutiveFailures` | Transient failures in a row; resets to `0` on the first success, and on any answer from the authorization server (including a refusal — that proves the host is reachable) |
| `refresh.permanentFailures` | Refusals from the authorization server in a row (`invalid_grant` and friends). At `3` the sweep gives up and deletes the connector's credentials, so `2` means one tick away from being disconnected — the most actionable value this block can carry. Resets to `0` on the first success. |
| `refresh.nextAttemptAt` | Epoch ms. The sweep skips this connector until then |
| `refresh.unrefreshable` | Present and `true` only when this connector can never refresh: it has an access_token, no refresh_token was ever stored, and the token is either expired or has no recorded expiry at all. Both counters read `0` — nothing failed, there is simply nothing to refresh with. Reconnecting is the only fix. |

The two counters are mutually exclusive: a refusal ends the transient streak and a
network failure ends the permanent one, so exactly one of them is non-zero at a
time. The block is present whenever either is — or when `unrefreshable` is set,
which is the one case where both counters are `0`.

`unrefreshable` is reachable through ordinary configuration, not just a hand-edited
file: an authorization server that advertises scopes not including `offline_access`
issues a token response with no refresh_token at all. The sweep then skips that
connector on every tick, silently and forever, and without this flag `connected`
would stay `true` over a token that expired an hour in.

The missing-expiry case covers tokens this gateway never minted — every path that
stores one records an expiry beside it, defaulting to an hour when the server omits
`expires_in`. An `oauth: true` connector holding a pasted `access_token` is the way
to get there; `POST /v1/connectors/custom` now rejects that combination, so this
reports the rows that predate the check.

The retry interval doubles with each consecutive transient failure — 5m, 10m, 20m,
… capped at 6 hours — so a permanently dead MCP URL costs a handful of attempts a
day rather than one every five minutes forever, and still recovers on its own the
moment the provider answers again. There is no give-up state for transient
failures: only the authorization server explicitly declaring the grant dead
(`invalid_grant` and friends, three times running) clears the credentials.

**Errors.** This route answers `500 {"error": "Connector configuration could not be
read"}` if the connector list cannot be assembled at all; the reason is logged, not
returned. A single unreadable *entry* degrades to one row with `connected: false`
instead, and the rest of the list is still returned. If the secret store itself
(`mcp-token.env`) cannot be read, every connector reports `connected: false` — the
honest answer while the file is unreadable — and the failure is logged at most once
a minute rather than once per poll.

---

### GET /api/v1/connectors/:id/status

Connected state for one connector — cheap enough to poll while an OAuth sign-in
completes in another tab.

```json
{ "id": "firecrawl", "connected": true }
```

A `gateway`-owned connector whose background refresh is currently failing also carries the
same `refresh` block documented under `GET /api/v1/connectors` above:

```json
{
  "id": "firecrawl",
  "connected": true,
  "refresh": { "consecutiveFailures": 3, "permanentFailures": 0, "nextAttemptAt": 1893456000000 }
}
```

`404` when the id is not a configured connector.

---

### POST /api/v1/connectors/:id/connect

Store a pasted token into a connector that declares exactly one secret. **Admin.**
This is what lets a paste-token connector be reconnected after `DELETE`
soft-disconnected it, without retyping its config.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `token` | string | The secret. Trimmed; must be non-empty |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"token": "<paste-token-here>"}' \
  http://localhost:10850/api/v1/connectors/stripe/connect | jq
```

```json
{ "id": "stripe", "connected": true }
```

| Status | When |
|--------|------|
| `400` | Missing/blank `token`; `credentialOwner: "gateway"` (use `/oauth/start`); `credentialOwner: "external"` (use `/oauth/receive`); or it needs more than one secret (remove and re-add it via `POST /v1/connectors/custom`) |
| `404` | Unknown id |

Sessions already running for an agent that uses this connector are restarted (idle
channel sessions on their next message, busy ones after the current turn) so the new
secret actually reaches them — an MCP subprocess reads its config once, at spawn.

---

### POST /api/v1/connectors/:id/oauth/receive

Accept a fresh `access_token` **plus the full connector shape** pushed in by an external
control plane. **Admin.**

This exists because an externally-owned connector never runs its token exchange here. The
gateway runs inside the user's own VM, reachable from that user's own shell — a shared
`client_secret` cannot live here safely. So a control plane the deployer runs owns the
client secret, the exchange and the refresh loop, and pushes the resulting short-lived
token to this route over the internal network, authenticated with an admin API key like
any other admin caller.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `access_token` | string | Required, non-empty |
| `label` | string | Required, non-empty |
| `config` | object | Required. Must contain **exactly one** `{access_token}` placeholder and no others |
| `description` | string | Optional |
| `sourceUrl` | string | Optional |

`secretNames` is never read from the request body — it is derived from `config` and
required to be exactly `["access_token"]`.

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{
        "access_token": "<token>",
        "label": "Gmail",
        "config": {
          "type": "streamable-http",
          "url": "https://mcp.example.com/gmail",
          "headers": { "Authorization": "Bearer {access_token}" }
        }
      }' \
  http://localhost:10850/api/v1/connectors/gmail/oauth/receive | jq
```

```json
{ "id": "gmail", "connected": true }
```

The entry is written to `gateway.customConnectors` with `credentialOwner: "external"`,
and every session already using this connector is restarted so the
next spawn picks up the fresh token.

**`400` on a reserved id.** This is the only route that takes a connector id
verbatim instead of minting it through the slugifier, so it is the only one that
can name a server the gateway writes into every session's `mcp-config.json`
itself. `gateway` and `telegram` are therefore rejected:

```json
{ "error": "Connector id 'gateway' is reserved by the gateway's own MCP servers" }
```

Without this the push would succeed, store its token, and report `connected: true`
on every status surface — while the session writer silently dropped the colliding
entry, so the connector never reached a single session and could not be fixed
except by deleting it.

---

### DELETE /api/v1/connectors/:id

Disconnect. **Admin.** Admin is checked *before* the id is looked up, so a non-admin
caller cannot use this route to learn which ids exist.

What it removes depends on the entry:

| `credentialOwner` | Effect |
|-------------------|--------|
| `static` | Clears the secrets only — the entry (label, config, `sourceUrl`) survives so it can be reconnected without retyping. The definition exists nowhere else |
| `gateway` | Clears the OAuth `access_token` only (plus the internal bookkeeping below); the entry survives, and so does any *other* `{placeholder}` value that was pasted when the connector was added. Only `access_token` is the gateway's to re-mint at sign-in — a `{workspace_id}` alongside it can be re-supplied by no route at all (`/connect` is closed to `gateway` owners), so clearing it would make one Disconnect permanent |
| `none` | Removes the entry. There is no secret to clear, so a soft disconnect would leave the row reporting "connected" forever |
| `external` | Removes the entry — its definition lives in the control plane, and reconnecting re-pushes a full entry via `/oauth/receive` |

For a `gateway`-owned entry the gateway also clears its refresh token, client id, expiry,
failure counters, token generation and cached dynamic-client registration. Those are
internal bookkeeping and are not in `secretNames`; left behind, the still-valid refresh
token would let the background sweep silently mint a new access token and resurrect the
connector the user just disconnected, and a stale cached registration would make the
next `/oauth/start` reuse a `client_id` the provider may no longer recognise.

Sessions already using the connector are restarted so they stop offering a tool whose
credential is gone. Which sessions those are is decided by comparing each running
session's spawn-time connector fingerprint against what the connector resolves to *now* —
so a cleared secret, an edited config, or a removed entry all count, and a session
spawned before the connector existed is left alone. When the whole entry is removed, the
connector's per-agent enablement flags in `config.json` are removed with it, so a later
connector that slugs to the same id does not inherit them.

```json
{ "id": "firecrawl", "connected": false }
```

---

### POST /api/v1/connectors/custom

Add a user-pasted connector. **Admin.**

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Required, non-empty. The id is slugified from it (`"Google Calendar!"` → `google-calendar`), with `-2`, `-3`, … appended on collision |
| `config` | object | Required. Raw `mcpServers` entry with `{placeholder}` tokens |
| `secrets` | object | Optional `{ "<placeholderName>": "<value>" }`. All values must be strings; blank ones are skipped, leaving the connector "not connected" until filled in later via `/connect` |
| `description` | string | Optional |
| `sourceUrl` | string | Optional — where the admin says the config came from. Unverified |
| `oauth` | boolean | Optional. Asks the gateway to run the sign-in itself — stores `credentialOwner: "gateway"`. Requires `config.url` and an `{access_token}` placeholder, and refuses an `access_token` in `secrets` (the gateway mints that one at `/oauth/start`). Without it the entry is `static` (it declares `{placeholder}`s) or `none` (it declares none) |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{
        "label": "Firecrawl",
        "oauth": true,
        "config": {
          "type": "streamable-http",
          "url": "https://mcp.firecrawl.dev/v2/mcp-oauth",
          "headers": { "Authorization": "Bearer {access_token}" }
        }
      }' \
  http://localhost:10850/api/v1/connectors/custom | jq
```

```json
{ "id": "firecrawl", "label": "Firecrawl", "connected": false }
```

| Status | When |
|--------|------|
| `400` | `label`/`config` missing or the wrong type; `secrets` not an object of strings; **a `secrets` key that is not a `{placeholder}` in `config`** (nothing would ever read it back, so it is reported instead of silently stored); `oauth` not a boolean; `oauth: true` without `config.url` or without an `{access_token}` placeholder; **`oauth: true` with an `access_token` in `secrets`** (see below); **or a placeholder name starting with `__`, which the gateway reserves for itself** |

The id is chosen inside the config write lock, so two concurrent adds of the same label
get distinct ids rather than the second overwriting the first. If every secret is present
the connector is immediately connected, and sessions that resolve it are restarted.

**`oauth: true` will not take a pasted `access_token`.** That combination asks for a
`gateway`-owned entry — one the refresh sweep renews from the `refresh_token` the
sign-in stores — and a pasted token arrives without one, because the gateway never saw
the exchange it came out of. It would read `connected: true` and then simply stop
working when it aged out, with nothing to renew it and no failure recorded (the sweep
skips a connector it cannot refresh). Sign in via `/oauth/start`, or omit `oauth` to
store the token as a `static` connector, which is what a hand-held token is. The
connector's *other* placeholders are unaffected — a `{workspace_id}` on an OAuth
connector is configuration the sign-in neither writes nor can supply.

Removal is the unified `DELETE /v1/connectors/:id` above — there is no separate
`/custom/:id` delete route.

---

### POST /api/v1/connectors/custom/:id/oauth/start

Begin OAuth sign-in for a `gateway`-owned connector (added with `oauth: true`). **Admin.**

Unlike `/oauth/receive`, the whole dance runs **here**, inside the user's own VM — RFC
8414 metadata discovery, RFC 7591 dynamic client registration, PKCE (S256), the code
exchange and the refresh loop. No external service ever sees the resulting token.

Requires [`gateway.publicUrl`](README.md#gatewaypublicurl) to be set: the provider needs
a reachable HTTPS callback, which is `<publicUrl>/oauth/mcp/callback`.

```bash
curl -X POST -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/connectors/custom/firecrawl/oauth/start | jq
```

```json
{ "authorizeUrl": "https://as.example.com/authorize?response_type=code&client_id=..." }
```

Open `authorizeUrl` in the end user's browser. A `client_id` registered by a previous
attempt is reused rather than orphaning a new one at the provider on every click — but
only while the `redirect_uri` it was registered against still matches, so changing
`gateway.publicUrl` correctly forces re-registration.

The gateway registers a client dynamically (RFC 7591) whenever the provider advertises a
`registration_endpoint`. For a provider that advertises none, set a pre-registered
`client_id` in the `MCP_OAUTH_CLIENT_ID__<CONNECTOR_ID>` environment variable (id
upper-cased, every non-alphanumeric run replaced with `_` — connector `google-calendar`
reads `MCP_OAUTH_CLIENT_ID__GOOGLE_CALENDAR`). Without either, `/oauth/start` returns
`502` naming the env var it looked for.

The `scope` requested is the MCP server's own `scopes_supported` (RFC 9728
protected-resource metadata) when it publishes one, falling back to the authorization
server's list (RFC 8414) and then to `offline_access`. The resource's list comes first
deliberately: the AS's is every scope it issues for every resource behind it, so
consenting to it would grant this gateway a whole provider's privileges — and on an AS
whose catalogue includes scopes this client is not entitled to, it is an
`invalid_scope` refusal that kills the sign-in. Set
`MCP_OAUTH_SCOPES__<CONNECTOR_ID>` (space-separated, same id transform as
`MCP_OAUTH_CLIENT_ID__`) to override both — that is the way out of an `invalid_scope`,
or of a provider that only issues a refresh token when `offline_access` is asked for
and never advertises it, without patching the gateway.

| Status | When |
|--------|------|
| `400` | The connector is not `credentialOwner: "gateway"` (an `external` one is told to use `/oauth/receive` instead), or its `config.url` is missing |
| `404` | Unknown id |
| `500` | No valid `gateway.publicUrl` configured |
| `502` | Discovery or client registration failed upstream |

---

### GET /oauth/mcp/callback

The provider's redirect target. **Public — no API key**, because the end user's browser
has none to present. Its security rests on the `state` value: single-use, TTL'd and
unguessable, the same posture the CLI pairing routes already use.

Registered at **both** `/oauth/mcp/callback` and `/gateway/oauth/mcp/callback`. The
`redirect_uri` sent to the provider is `<publicUrl>/oauth/mcp/callback`, and
`publicUrl` always ends in `/gateway` — so behind the usual reverse proxy, which
strips that prefix, the request arrives at the bare path, while a gateway reached
directly on its own port receives the prefixed one. Both are the same handler; a
flow started against one and returning to the other completes normally.

Query params are the standard `code` / `state` / `error`. On success the gateway
exchanges the code, stores the access token (plus refresh token and expiry, internally)
in a single write, and restarts sessions that use the connector so the sign-in reaches
the agent the user is actually talking to — without that, status would report
"connected" while a running session still had no such tool. A restart failure is logged,
not surfaced: the token is stored either way.

The connector is re-read before the exchange and again immediately before the write. If
it was deleted, or handed to another owner via
[`/oauth/receive`](#post-apiv1connectorsidoauthreceive), while the user sat on the
provider's consent screen, the token is discarded and the callback answers
`connector_gone` — nothing is stored. Without that re-check a returning callback could
resurrect a connector the admin had just disconnected, or leave internal refresh state
behind on an entry the gateway no longer owns, which nothing would ever collect.

Where the browser lands depends on
[`gateway.oauthReturnUrl`](README.md#gatewayoauthreturnurl-optional):

| `oauthReturnUrl` | Success | Failure |
|------------------|---------|---------|
| Set | `302` to that URL | `302` to that URL with `?connector_oauth_error=<code>` |
| Unset | A plain "Connected — you can close this tab" page | A plain error page (`400`/`409`/`502`) |

"Set" means set to a well-formed `http(s)` URL — anything else (including a
`javascript:` or `data:` URL, which `new URL()` parses happily) is logged at startup and
treated as unset, so it can never become the `Location` of a redirect on this public
route.

Error codes are `expired_link` (unknown, expired or already-used `state`),
`missing_code`, `connector_gone`, `exchange_failed`, or the provider's own `error` value
passed through.

There is deliberately no interstitial "Connected!" page with a timed meta-refresh — when
the deployer has told the gateway where "back" is, a real redirect goes straight there.

---

### Token refresh

For `oauth: true` connectors the gateway refreshes tokens itself, on the same 60-second
interval that prunes pairing state. A connector is refreshed when its recorded expiry is
within 5 minutes.

- Failures back off for 5 minutes rather than retrying every tick.
- After **3** consecutive failures **that the authorization server itself declared**
  (`invalid_grant`, `invalid_client`, `unauthorized_client`, `invalid_scope`) the gateway
  gives up and clears the connector's tokens, so its status honestly flips to "not
  connected" instead of showing a green checkmark backed by a token that will never
  refresh again. Anything else — DNS, a timeout, a `502`, a discovery step that returned
  the wrong shape — only backs off and never counts toward that limit: giving up deletes
  the user's credentials, and a provider being unreachable says nothing about whether the
  grant is still valid.
- Discovery metadata is cached for 6 hours on this path (an admin-initiated
  `/oauth/start` always re-discovers).
- A tick is skipped while the previous sweep is still in flight. Two concurrent sweeps
  would POST the same refresh token twice, and a provider that rotates refresh tokens
  (the default for a public OAuth 2.1 client) treats the second use as replay and revokes
  the whole grant.
- If a manual reconnect lands while a refresh is in flight, the newer token wins — the
  slower, now-stale refresh result is discarded rather than clobbering it.
- A successful refresh restarts sessions using that connector, for the same reason
  `/oauth/receive` does.

---

## Package Updates

Endpoints for checking and installing newer versions of `@0xmaxma/claude-gateway` and `@anthropic-ai/claude-code`. All package endpoints require an **admin** API key (`admin: true` in config).

---

### GET /api/v1/packages

Returns the current and latest version for both packages. Result is cached for 5 minutes to avoid hammering the npm registry.

`latest` is read from the npm registry for both packages. `current` is resolved per package: `claude-gateway` (an npm global) via `npm list -g`, and `claude-code` (native installer) from the installed binary (`claude --version`). If Claude Code is not installed, its `current` is `null` and the UI renders `—`. `hasUpdate` is `true` only when `latest` is strictly newer than `current` by semver ordering, so a binary that is *ahead* of the registry `latest` does not report a spurious update.

```bash
curl -H "X-Api-Key: admin-secret" \
  http://localhost:10850/api/v1/packages | jq
```

```json
{
  "packages": [
    {
      "package": "@0xmaxma/claude-gateway",
      "current": "1.2.0",
      "latest": "1.3.1",
      "hasUpdate": true
    },
    {
      "package": "@anthropic-ai/claude-code",
      "current": "1.0.5",
      "latest": "1.1.0",
      "hasUpdate": true
    }
  ]
}
```

**Error responses:**

| Status | When |
|--------|------|
| 401 | No API key provided |
| 403 | Non-admin API key |
| 503 | npm registry unreachable |

---

### POST /api/v1/packages/:name/update

Installs the latest version of the specified package. `:name` accepts `claude-gateway` or `claude-code`.

- **claude-gateway**: runs `npm install -g @0xmaxma/claude-gateway@latest` then sends itself `SIGTERM`, requesting a non-zero (`EX_TEMPFAIL`) exit code so a `Restart=on-failure` unit restarts it too — a graceful `exit(0)` reads as success to `on-failure` and never restarts (issue #450). `Restart=always` units and pm2's `autorestart` restart on any exit code regardless.
- **claude-code**: runs the native updater (`claude update`) so the actual binary on PATH is updated. No restart needed. (npm install is not used — Claude Code ships via the native installer, so an npm-global copy would not be the running binary.)

If the package is already on the latest version the call is a no-op (`updated: false`).

```bash
curl -X POST \
  -H "X-Api-Key: admin-secret" \
  http://localhost:10850/api/v1/packages/claude-gateway/update | jq
```

```json
{
  "package": "@0xmaxma/claude-gateway",
  "from": "1.2.0",
  "to": "1.3.1",
  "updated": true,
  "warning": "service will restart"
}
```

`warning` values:

| Value | Meaning |
|-------|---------|
| `"service will restart"` | Running under systemd or pm2 — process manager will auto-restart |
| `"process will stop — restart manually"` | Plain process (dev) — will exit after update |
| `null` | No restart needed (claude-code) |

**Error responses:**

| Status | When |
|--------|------|
| 401 | No API key provided |
| 403 | Non-admin API key |
| 404 | Unknown package name |
| 500 | `npm install` failed — body contains stderr |
| 503 | npm registry unreachable |
