# Claude Gateway — API Reference

All API endpoints require an API key configured in `config.json`. Pass it via:
- `X-Api-Key: <key>` header
- `Authorization: Bearer <key>` header

---

## Endpoints Overview

### Agent API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/agents` | List agents accessible by the provided key |
| `POST` | `/api/v1/agents/:agentId/messages` | Send a message — sync JSON or SSE stream |

### Cron API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/crons` | List jobs (filtered to key's accessible agents) |
| `GET` | `/api/v1/crons/status` | Scheduler status (total, enabled, running) |
| `POST` | `/api/v1/crons` | Create a new job |
| `GET` | `/api/v1/crons/:id` | Get a single job |
| `PUT` | `/api/v1/crons/:id` | Update a job |
| `DELETE` | `/api/v1/crons/:id` | Delete a job |
| `POST` | `/api/v1/crons/:id/run` | Trigger a job manually |
| `GET` | `/api/v1/crons/:id/runs` | Get run history (last 20 by default) |

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

### GET /api/v1/agents

List agents accessible by the provided API key.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:3000/api/v1/agents | jq
```

```json
{
  "agents": [
    { "id": "alfred", "description": "Personal assistant" }
  ]
}
```

### POST /api/v1/agents/:agentId/messages

Send a message to an agent. Returns a JSON response or SSE stream.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `message` | Yes | Message text (max 10,000 chars) |
| `session_id` | No | Resume an existing session; omit to start a new one |
| `stream` | No | `true` to enable SSE streaming (default `false`) |
| `timeout_ms` | No | Override the default response timeout in milliseconds (default 60000). Useful when the key has `allow_tools: true` and runs long-running tools |

> Tool access is configured per API key in `config.json` — see `allow_tools` below.

**New session:**

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! What can you help me with?"}' \
  http://localhost:3000/api/v1/agents/alfred/messages | jq
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
  -d '{"message": "What did I just ask you?", "session_id": "da19d84a-6a36-4f57-b419-d322d82c4db8"}' \
  http://localhost:3000/api/v1/agents/alfred/messages | jq
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Empty message or exceeds 10,000 characters |
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
  -d '{"message": "Explain this code", "stream": true}' \
  http://localhost:3000/api/v1/agents/alfred/messages
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
    "stream": true,
    "timeout_ms": 120000
  }' \
  http://localhost:3000/api/v1/agents/alfred/messages
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
| `telegram` | If `type=agent` | Telegram chat_id to deliver the agent response (required for `type=agent`) |
| `timeoutMs` | No | Execution timeout in ms (default 120000) — applies to both `command` and `agent` |
| `deleteAfterRun` | No | `true` to auto-delete after first run (one-shot jobs) |
| `enabled` | No | `true` (default) / `false` to create disabled |

**`type` comparison:**

| | `command` | `agent` |
|---|---|---|
| Runs | Shell command | Agent turn (new Claude session) |
| Key field | `command` | `prompt` + `telegram` |
| Output | stdout/stderr | Agent response text |
| Delivery | Logged only | Sent to Telegram chat |

---

### GET /api/v1/crons

List all jobs accessible by the API key (filtered to key's agent scope).

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:3000/api/v1/crons | jq
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
      "telegram": "997170033",
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
  http://localhost:3000/api/v1/crons/status | jq
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
curl -s -X POST http://localhost:3000/api/v1/crons \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-founder",
    "name": "morning-brief",
    "scheduleKind": "cron",
    "schedule": "0 9 * * *",
    "type": "agent",
    "prompt": "Give me a morning summary.",
    "telegram": "997170033"
  }' | jq
```

#### Example: One-shot agent turn at a specific time

Runs once at the given time, then auto-deletes.

```bash
curl -s -X POST http://localhost:3000/api/v1/crons \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-founder",
    "name": "good-night",
    "scheduleKind": "at",
    "scheduleAt": "2026-04-09T23:00:00.000Z",
    "type": "agent",
    "prompt": "good night",
    "telegram": "997170033",
    "deleteAfterRun": true
  }' | jq
```

#### Example: Recurring shell command (cron)

Run a shell command every minute.

```bash
curl -s -X POST http://localhost:3000/api/v1/crons \
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
curl -s -X POST http://localhost:3000/api/v1/crons \
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
curl -s -X POST http://localhost:3000/api/v1/crons \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-founder",
    "name": "weekly-report",
    "scheduleKind": "cron",
    "schedule": "0 18 * * 5",
    "type": "agent",
    "prompt": "Generate a weekly progress report.",
    "telegram": "997170033",
    "enabled": false
  }' | jq
```

---

### GET /api/v1/crons/:id

Get a single job by ID.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:3000/api/v1/crons/8f787a4b-eaa8-4ace-a0b3-ff3d0004f2df | jq
```

---

### PUT /api/v1/crons/:id — Update a job

Only the fields you include are updated. All fields are optional.

#### Example: Change schedule

```bash
curl -s -X PUT http://localhost:3000/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": "0 8 * * 1-5"
  }' | jq
```

#### Example: Change prompt

```bash
curl -s -X PUT http://localhost:3000/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Give me an evening summary instead."
  }' | jq
```

#### Example: Disable a job

```bash
curl -s -X PUT http://localhost:3000/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' | jq
```

#### Example: Re-enable a job

```bash
curl -s -X PUT http://localhost:3000/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}' | jq
```

---

### DELETE /api/v1/crons/:id

Delete a job permanently.

```bash
curl -s -X DELETE http://localhost:3000/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" | jq
```

```json
{ "ok": true }
```

---

### POST /api/v1/crons/:id/run

Trigger a job immediately, regardless of its schedule.

```bash
curl -s -X POST http://localhost:3000/api/v1/crons/<id>/run \
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
  http://localhost:3000/api/v1/crons/<id>/runs | jq
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
