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
| `GET` | `/status` | Key or dashboard session¹ | Per-agent stats + heartbeat history |
| `GET` | `/processes` | Key or dashboard session¹ | Host process tree for the dashboard |
| `GET` | `/dashboard` | Session cookie¹ | Web UI dashboard (serves the login page when unauthenticated) |
| `POST` | `/dashboard/login` | None (validates a key) | Exchange an API key for an `HttpOnly` `dash_session` cookie (8h) |
| `POST` | `/dashboard/logout` | Session cookie | Revoke the dashboard session and clear the cookie |
| `GET` | `/api/v1/commands` | None | List slash commands available in the chat UI |

¹ **Auth applies when `gateway.api.keys` is configured.** "Key or dashboard session"
accepts an API key (`X-Api-Key` / `Authorization: Bearer`) **or** the `dash_session`
cookie issued by `POST /dashboard/login`. With **no** keys configured the behavior
depends on the bind: on a **loopback** bind (`127.0.0.1`) they stay open (a keyless
local install has no credential to check); on a **non-loopback** bind (`0.0.0.0` or a
real IP) they **fail closed** — `/status`, `/processes`, and `/dashboard` return `503`
until `gateway.api.keys` is set, so the surface is never exposed unauthenticated to the
network. `/health` stays public in all cases.

### Agent API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents` | Key | List agents accessible by the provided key |
| `POST` | `/api/v1/agents` | Admin | Create a new agent |
| `PATCH` | `/api/v1/agents/:agentId` | Write | Update agent name, description, model, or allow_tools |
| `DELETE` | `/api/v1/agents/:agentId` | Admin | Delete an agent |
| `POST` | `/api/v1/agents/:agentId/messages` | Key | Send a message — sync JSON or SSE stream; supports slash commands |
| `POST` | `/api/v1/agents/:agentId/greeting` | Write | Stream a proactive welcome from `GREETING.md` into an existing session (SSE); returns 204 if file absent |
| `GET` | `/api/v1/models` | Key | List all supported Claude models |
| `PUT` | `/api/v1/agents/:agentId/model` | Admin | Set the active model for an agent |

### Session Management API

All session endpoints require `chat_id` (query param for GET/DELETE, body for POST/PATCH).
Sessions are stored at `sessions/api-{chat_id}/` — symmetric with `telegram-{id}` and `discord-{id}`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/sessions` | Key | List API sessions for a `chat_id` |
| `POST` | `/api/v1/agents/:agentId/sessions` | Key | Create a new API session (auto-names from prompt) |
| `GET` | `/api/v1/agents/:agentId/sessions/:sessionId/info` | Key | Get session info (name, message count, context %) |
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

### App Store API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/apps/registry` | Key | Fetch community registry (5-min cached) |
| `GET` | `/api/v1/apps/registry/:name` | Key | Get versions of a registry app |
| `GET` | `/api/v1/apps` | Key | List installed apps |
| `POST` | `/api/v1/apps/install` | Admin | Start async install → `jobId` |
| `GET` | `/api/v1/apps/jobs/:jobId` | Key | Poll install/update job status + logs |
| `GET` | `/api/v1/apps/:name` | Key | Get installed app info |
| `DELETE` | `/api/v1/apps/:name` | Admin | Uninstall app |
| `POST` | `/api/v1/apps/:name/start` | Admin | Start stopped app |
| `POST` | `/api/v1/apps/:name/stop` | Admin | Stop running app |
| `POST` | `/api/v1/apps/:name/restart` | Admin | Restart app |
| `GET` | `/api/v1/apps/:name/version` | Key | Check installed vs latest version |
| `POST` | `/api/v1/apps/:name/update` | Admin | Start async update with rollback → `jobId` |
| `GET` | `/app/:name/:portName/*` | None | Reverse proxy to installed app |

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
# /processes requires an API key when gateway.api.keys is configured
curl -s -H "X-Api-Key: $KEY" http://localhost:10850/processes | grep -o 'sessions/[^/]*' | head -1
```

#### Live screen stream (WebSocket)

For a real-time mirror of the PTY (instead of a one-shot snapshot), connect to the
PTY stream WebSocket. Streams are **per session**, so a `session` is always required —
each session of an agent is an isolated stream.

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST` | `/api/v1/pty-stream-ticket` | Key *or* dashboard session | Exchange an API key **or** the `dash_session` cookie for a one-time, 30s-TTL ticket bound to a specific `{ agentId, sessionId }` |
| `WS` | `/api/v1/agents/:agentId/pty-stream` | Ticket *or* Key | Subscribe to the live PTY stream for one session |

> The browser dashboard authenticates with the `HttpOnly` `dash_session` cookie
> (from `POST /dashboard/login`), which is sent automatically — it no longer embeds
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

Per-agent stats and heartbeat history. **Requires an API key or a dashboard session
cookie when `gateway.api.keys` is configured** (open otherwise). Returns 401 when
keys are set and no valid credential is supplied.

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

Update an agent's display name, description, model, or allow_tools flag. Requires write access to the agent. Only fields provided are updated.

**Request body (all optional):**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string \| null | Display name shown in the UI instead of `id`. Empty string or `null` clears it (falls back to `id`) |
| `description` | string | New description |
| `model` | string | New Claude model ID |
| `allow_tools` | boolean | Override tool access for this agent |

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

The Wizard API mirrors the interactive `make create-agent` terminal wizard but is consumable by web UIs and automation. State is kept **in memory** with a 30-minute TTL (refreshed on each step transition); nothing is written to disk until the `/confirm` step.

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

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `message` | Yes | Message text (max 10,000 chars), or a slash command (e.g. `/session`, `/clear`) |
| `chat_id` | Yes | Caller identity — used to namespace sessions (e.g. `"myapp"`, `"user-123"`) |
| `session_id` | No | Resume an existing session; omit to start a new one |
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
| 404 | Agent ID not found |
| 409 | Session is busy processing another request |
| 504 | Agent did not respond within timeout (default 60s) |
| 500 | Internal error |

> - `session_id` is optional — omit for a stateless one-shot call
> - Sessions idle-timeout after `idleTimeoutMinutes` (default 30 min); history is restored automatically on next message
> - Error 409 = session is currently processing a request — wait and retry

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

Text and image messages from allowed 1:1/group/room sources are normalized and forwarded
to the agent's `/channel` intake (the same path Telegram uses). The request is
acknowledged (`200 {"ok":true}`) **before** event processing, so LINE never sees a slow
response.

**Error responses:**

| Status | When |
|--------|------|
| 401 | Missing or invalid `x-line-signature` (the resolved agent always has `channelSecret` set — see the 404 row below) |
| 404 | No LINE-enabled agent found — no agent has `line.channelSecret` set, or the given `:agentId` doesn't |

**Access control:** DMs and groups/rooms are closed by default (`dmPolicy` /
`groupPolicy` allowlist, per agent config); a denied sender receives a one-time pairing
code (via LINE reply) to share with the admin, who approves it the same way as Telegram
pairing.

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
data: {"type":"text_delta","text":"Let me"}
data: {"type":"text_delta","text":" explain..."}
data: {"type":"tool_use","name":"Read","id":"toolu_abc123"}
data: {"type":"text_delta","text":"Here's the explanation..."}
data: {"type":"result","text":"Here's the full explanation...","request_id":"550e8400-...","session_id":"abc-123","duration_ms":4200}
data: [DONE]

> When images are captured during the turn, the `result` event also includes `"attachments": [{"type":"image","url":"..."}]`.
```

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

| Type | Fields | Description |
|------|--------|-------------|
| `text_delta` | `text` | Incremental text chunk |
| `tool_use` | `name`, `id` | Tool invocation (e.g. Read, Grep, Bash) |
| `thinking` | `text` | Agent reasoning (if available) |
| `result` | `text`, `request_id`, `session_id`, `duration_ms`, `attachments?` | Final aggregated result; `attachments` present only when images were captured |
| `error` | `message` | Error event |

The stream ends with `data: [DONE]`.

---

## Models API

### GET /api/v1/models

List all supported Claude models from gateway config.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/models | jq
```

```json
{
  "models": [
    { "id": "claude-opus-4-8", "name": "Claude Opus 4.8", "alias": "opus",   "contextWindow": 1000000, "multiplier": 3 },
    { "id": "claude-opus-4-7", "name": "Claude Opus 4.7", "alias": "opus47", "contextWindow": 1000000, "multiplier": 3 },
    { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "alias": "sonnet", "contextWindow": 1000000, "multiplier": 1 }
  ]
}
```

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
2. Once in the chat UI, trigger the greeting: `POST /api/v1/agents/:agentId/greeting` with `session_id` → stream the assistant's opening message as SSE with typing animation visible to the user.

**Request:**

| Field | Required | Description |
|-------|----------|-------------|
| `session_id` | Yes | ID of an existing session to deliver the greeting into |
| `chat_id` | No | Same `chat_id` used when the session was created; ensures the greeting message is stored in the correct history bucket. Defaults to `session_id` when omitted (creates a secondary index entry) |

```bash
curl -N -X POST \
  -H "X-Api-Key: my-write-key" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "7f3a1c2d-89ab-4def-b012-345678901234"}' \
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
- The SSE stream format matches `POST /messages` with `stream: true` — use the same client-side handler.
- If the agent errors mid-stream, an `{"type":"error","message":"..."}` SSE event is sent and the stream closes.

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
{ "compacted": true, "keptMessages": 10, "sessionId": "da19d84a-6a36-4f57-b419-d322d82c4db8" }
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

Read and write an agent's workspace identity files via the API. The gateway's file watcher auto-reloads `CLAUDE.md` after a write.

**Allowed filenames:** `SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`, `HEARTBEAT.md`, `IDENTITY.md`

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
| `telegram` | If `type=agent` | Telegram chat_id to deliver the agent response |
| `discord` | If `type=agent` | Discord channel_id to deliver the agent response |
| `timeoutMs` | No | Execution timeout in ms (default 120000) — applies to both `command` and `agent` |
| `deleteAfterRun` | No | `true` to auto-delete after first run (one-shot jobs) |
| `enabled` | No | `true` (default) / `false` to create disabled |

**`type` comparison:**

| | `command` | `agent` |
|---|---|---|
| Runs | Shell command | Agent turn (new Claude session) |
| Key field | `command` | `prompt` + `telegram` and/or `discord` |
| Output | stdout/stderr | Agent response text |
| Delivery | Logged only | Sent to Telegram and/or Discord |

> **Note:** For `type=agent`, at least one of `telegram` or `discord` is required. Both can be set to deliver to multiple channels simultaneously.

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
          "imageConfig": { "model": "openai/gpt-image-1", "quality": "medium" }
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
| `GET` | `/api/v1/apps/jobs/:jobId` | Key | Poll install/update job status + logs |
| `GET` | `/api/v1/apps/:name` | Key | Get installed app info |
| `DELETE` | `/api/v1/apps/:name` | Admin | Uninstall app (docker down + cleanup) |
| `POST` | `/api/v1/apps/:name/start` | Admin | Start stopped app |
| `POST` | `/api/v1/apps/:name/stop` | Admin | Stop running app |
| `POST` | `/api/v1/apps/:name/restart` | Admin | Restart app |
| `GET` | `/api/v1/apps/:name/version` | Key | Check current + latest version |
| `POST` | `/api/v1/apps/:name/update` | Admin | Start async update with rollback → returns `jobId` |

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

When `status` is `failed`, `error` contains the failure message. If the containers started but failed the healthcheck, container logs are appended to `logs` before rollback:

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

Start, stop, or restart an installed app's containers.

```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  http://localhost:10850/api/v1/apps/agent-note/restart | jq
```

```json
{ "name": "agent-note", "action": "restart" }
```

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

Start an async update to the latest registry version. Uses blue/green swap: build new version in `/tmp/`, stop old containers, start new, swap directories, rollback automatically if new containers fail health check.

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
| 400 | App source is `custom` or `local` (cannot be updated via this endpoint) |
| 403 | Not an admin key |
| 404 | App not installed |

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
| `environment` | Static env vars (`KEY=value`) or secret keys (`KEY` without `=`) |
| `volumes` | Volume mounts (named volumes or host paths within app dir) |
| `ports` | Array of port declarations (see below) |
| `depends_on` | Service dependency list |
| `healthcheck` | Docker healthcheck (test, interval, timeout, retries) |
| `gateway_api` | Host script bridge via Unix socket (see below) |

**Banned fields:** `network_mode: host`, `privileged`, `cap_add`. The gateway always injects `cap_drop: ALL`, `restart: unless-stopped`, `env_file: .env`, and resource limits.

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

- **claude-gateway**: runs `npm install -g @0xmaxma/claude-gateway@latest` then calls `process.exit(0)` so the process manager (systemd/pm2) restarts the service.
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
