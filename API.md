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
| `sessionName` | Yes | New session name |

```bash
curl -X PATCH \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp", "sessionName": "Q3 Infra Discussion"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a | jq
```

```json
{
  "sessionId": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "sessionName": "Q3 Infra Discussion"
}
```

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
