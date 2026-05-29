# Claude Gateway — API Reference

All API endpoints require an API key configured in `config.json`. Pass it via:
- `X-Api-Key: <key>` header
- `Authorization: Bearer <key>` header

---

## Endpoints Overview

### System

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Health check — status + agent list |
| `GET` | `/status` | None | Per-agent stats + heartbeat history |
| `GET` | `/ui` | None | Web UI dashboard |
| `GET` | `/api/v1/commands` | None | List slash commands available in the chat UI |

### Agent API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents` | Key | List agents accessible by the provided key |
| `POST` | `/api/v1/agents` | Admin | Create a new agent |
| `PATCH` | `/api/v1/agents/:agentId` | Write | Update agent description, model, or allow_tools |
| `DELETE` | `/api/v1/agents/:agentId` | Admin | Delete an agent |
| `POST` | `/api/v1/agents/:agentId/messages` | Key | Send a message — sync JSON or SSE stream; supports slash commands |
| `POST` | `/api/v1/agents/:agentId/greeting` | Write | Create a proactive welcome session from `GREETING.md`; returns 202 immediately, generates greeting in background; returns 204 if file absent |
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

### Workspace File API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/files/:filename` | Key | Read a workspace file |
| `PUT` | `/api/v1/agents/:agentId/files/:filename` | Write | Write a workspace file |

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
| `POST` | `/api/v1/agents/:agentId/chats/:chatId/sessions/:sessionId/messages` | Key | Inject a message into an existing channel session (SSE stream) |

### Media API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/agents/:agentId/media` | Key | Upload a media file (image/* or PDF) — returns `mediaPath` |
| `GET` | `/api/v1/agents/:agentId/media/*` | Key | Serve a media file by path |

**Auth levels:** `Key` = any valid API key, `Write` = key with write access to the agent, `Admin` = key with `agents: "*"`.

---

## System Endpoints

### GET /health

Health check. No auth required.

```bash
curl http://localhost:10850/health
```

```json
{ "status": "ok", "agents": ["alfred", "claude-founder"] }
```

---

### GET /status

Per-agent stats and heartbeat history. No auth required.

```bash
curl http://localhost:10850/status | jq
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
    { "id": "alfred", "description": "Personal assistant", "model": "claude-sonnet-4-6", "allow_tools": false }
  ]
}
```

---

### POST /api/v1/agents

Create a new agent entry in `config.json`. Requires admin key. Also creates the workspace directory with stub files (`AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`).

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Agent ID — pattern `[a-z][a-z0-9_-]{1,31}` |
| `description` | Yes | Human-readable description |
| `model` | No | Claude model ID (default: `claude-sonnet-4-6`) |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-bot", "description": "My new bot", "model": "claude-sonnet-4-6"}' \
  http://localhost:10850/api/v1/agents | jq
```

```json
{ "agent": { "id": "my-bot", "description": "My new bot", "model": "claude-sonnet-4-6" } }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Invalid `id` format or missing `description` |
| 403 | Not an admin key |
| 409 | Agent ID already exists |
| 501 | Gateway started without a config path |

---

### PATCH /api/v1/agents/:agentId

Update an agent's description, model, or allow_tools flag. Requires write access to the agent. Only fields provided are updated.

**Request body (all optional):**

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | New description |
| `model` | string | New Claude model ID |
| `allow_tools` | boolean | Override tool access for this agent |

```bash
curl -X PATCH \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-7"}' \
  http://localhost:10850/api/v1/agents/alfred | jq
```

```json
{ "agent": { "id": "alfred", "description": "Personal assistant", "model": "claude-opus-4-7", "allow_tools": false } }
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

Verify a Telegram or Discord bot token and generate a 6-character pairing code that the user must DM to the bot.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `channel` | Yes | `"telegram"` or `"discord"` |
| `botToken` | Yes | Bot token from BotFather / Discord Developer Portal |

```json
{
  "channel": "telegram",
  "botName": "@my_crypto_bot",
  "pairingCode": "A3F9C1",
  "instruction": "Send this code as a DM to @my_crypto_bot to complete pairing"
}
```

---

#### POST /api/v1/agents/wizard/:wizardId/channel/verify

**Auth:** admin key.

Poll for pairing confirmation. The client should call this endpoint repeatedly until `success: true`. Each call does a non-blocking Telegram `getUpdates` check for the pairing code.

On success, the bot token is written to `config.json` and `access.json` is created so the DM sender is in the allowlist. A welcome message is sent automatically.

> **Note:** Discord pairing verification via this endpoint is not yet supported (`501`).

```json
{ "success": true, "agentId": "cryptobot" }
```

or while waiting:

```json
{ "success": false, "pending": true }
```

---

#### POST /api/v1/agents/wizard/:wizardId/complete

**Auth:** admin key.

Finalise the wizard and clean up state. Can be called after `/confirm` to skip channel setup entirely, or after `/channel` to abandon pairing (the agent will be created without a Telegram/Discord channel). Requires step `confirmed` or `pairing` (calling from `pending` returns `409`).

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
  "duration_ms": 2341
}
```

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
| `result` | `text`, `request_id`, `session_id`, `duration_ms` | Final aggregated result |
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
    { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "alias": "sonnet", "contextWindow": 200000, "multiplier": 1 },
    { "id": "claude-opus-4-7", "name": "Claude Opus 4.7", "alias": "opus", "contextWindow": 200000, "multiplier": 3 }
  ]
}
```

---

### PUT /api/v1/agents/:agentId/model

Set the active model for a specific agent. Persists to `config.json`. Requires admin key.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `model` | Yes | Claude model ID (e.g. `"claude-opus-4-7"`) |

```bash
curl -X PUT \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-7"}' \
  http://localhost:10850/api/v1/agents/alfred/model | jq
```

```json
{ "model": "claude-opus-4-7" }
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

Create a proactive welcome session. The endpoint reads `GREETING.md` from the agent's workspace directory and sends its content to the agent as a trigger prompt. Only the **assistant response** is stored in session history — the trigger prompt itself is invisible to the session (uses `store_user_message: false` internally).

Returns `204 No Content` (no session created) if `GREETING.md` does not exist or is empty.

**Auth:** Write or Admin key required.

**Request:**

| Field | Required | Description |
|-------|----------|-------------|
| `chat_id` | Yes | Caller identity — same as other session endpoints. Accepted in request body (preferred) or as a query param for backward compatibility |
| `session_name` | No | Explicit session title (max 200 chars); skips the LLM auto-naming call (~15s) when provided |

```bash
curl -X POST \
  -H "X-Api-Key: my-write-key" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "getpod", "session_name": "Welcome to GetPod"}' \
  http://localhost:10850/api/v1/agents/getpod/greeting
```

**Response `202`** — session created; greeting is generating in the background:

```json
{
  "greeted": true,
  "sessionId": "7f3a1c2d-89ab-4def-b012-345678901234",
  "sessionName": "Welcome to GetPod"
}
```

The session exists immediately and the client can redirect to it. The assistant's greeting message arrives asynchronously (poll `GET /sessions/:id/messages` or open the chat UI to receive it).

**Response `204`** — `GREETING.md` not found or empty; no session created.

**`GREETING.md` format:**

Place the file at `~/.claude-gateway/agents/{agentId}/workspace/GREETING.md`. Its content is used as the prompt sent to the agent. It is **not** concatenated into the agent system prompt — it is a one-time trigger only.

```markdown
The user's environment is ready. Send a warm, concise welcome message
introducing yourself and what you can help with.
```

**Notes:**
- `GREETING.md` is **deleted before the `202` response** is sent. Subsequent calls return 204 immediately, making the endpoint idempotent. Re-provisioning GREETING.md will trigger a new greeting on next call.
- Pass `session_name` to avoid the ~15s LLM title-generation call. If omitted, the session is auto-named from the greeting prompt content (same logic as `POST /sessions`).
- Greeting generation runs in the background. If generation fails, the empty session is cleaned up automatically; the client should handle the case where the session has no messages yet.

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
          "sessionName": "Project Planning"
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

Paginated message history (cursor-based). Returns messages in reverse chronological order.

**Query parameters:**

| Param | Description |
|-------|-------------|
| `limit` | Max messages to return (default 50, max 200) |
| `before` | Return messages before this timestamp (ms) |
| `after` | Return messages after this timestamp (ms) |
| `session_id` | Filter to a specific session |

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/messages?limit=20" | jq
```

```json
{
  "messages": [
    { "role": "user", "content": "Hello!", "ts": 1775737709000, "sessionId": "abc-123" },
    { "role": "assistant", "content": "Hi there!", "ts": 1775737712000, "sessionId": "abc-123" }
  ],
  "hasMore": false
}
```

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
- **claude-code**: runs `npm install -g @anthropic-ai/claude-code@latest`. No restart needed.

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
