# Cron API {#cron-api}

Manage persistent scheduled jobs. All routes require the same API key auth as the Agent API. Write operations (`POST`, `PUT`, `DELETE`) additionally verify the key has access to the job's `agentId`.

Jobs are persisted to `~/.claude-gateway/crons.json` and survive gateway restarts. Existing agent-type jobs require no data migration when enabling orchestration: CronManager supplies a stable internal principal scoped to the Agent and job, while retaining the existing cron session ID. The Agent’s `allow_tools` policy still applies (unset defaults to false); external API requests still require their authenticated principal.

## Job schema {#job-schema}

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

## GET /api/v1/crons {#get-apiv1crons}

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

## GET /api/v1/crons/status {#get-apiv1cronsstatus}

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

## POST /api/v1/crons — Create a job {#post-apiv1crons--create-a-job}

### Example: Daily agent prompt (cron) {#example-daily-agent-prompt-cron}

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

### Example: Daily job in a specific timezone {#example-daily-job-in-a-specific-timezone}

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

### Example: Daily agent prompt — deliver to Discord {#example-daily-agent-prompt--deliver-to-discord}

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

### Example: Deliver to both Telegram and Discord {#example-deliver-to-both-telegram-and-discord}

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

### Example: One-shot agent turn at a specific time {#example-one-shot-agent-turn-at-a-specific-time}

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

### Example: Recurring shell command (cron) {#example-recurring-shell-command-cron}

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

### Example: One-shot shell command at a specific time {#example-one-shot-shell-command-at-a-specific-time}

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

### Example: Create a disabled job (enable later) {#example-create-a-disabled-job-enable-later}

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

## GET /api/v1/crons/:id {#get-apiv1cronsid}

Get a single job by ID.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/crons/8f787a4b-eaa8-4ace-a0b3-ff3d0004f2df | jq
```

---

## PUT /api/v1/crons/:id — Update a job {#put-apiv1cronsid--update-a-job}

Only the fields you include are updated. All fields are optional.

### Example: Change schedule {#example-change-schedule}

```bash
curl -s -X PUT http://localhost:10850/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": "0 8 * * 1-5"
  }' | jq
```

### Example: Change prompt {#example-change-prompt}

```bash
curl -s -X PUT http://localhost:10850/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Give me an evening summary instead."
  }' | jq
```

### Example: Disable a job {#example-disable-a-job}

```bash
curl -s -X PUT http://localhost:10850/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' | jq
```

### Example: Re-enable a job {#example-re-enable-a-job}

```bash
curl -s -X PUT http://localhost:10850/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}' | jq
```

---

## DELETE /api/v1/crons/:id {#delete-apiv1cronsid}

Delete a job permanently.

```bash
curl -s -X DELETE http://localhost:10850/api/v1/crons/<id> \
  -H "X-Api-Key: my-secret-key-123" | jq
```

```json
{ "ok": true }
```

---

## POST /api/v1/crons/:id/run {#post-apiv1cronsidrun}

Trigger a job immediately, regardless of its schedule.

```bash
curl -s -X POST http://localhost:10850/api/v1/crons/<id>/run \
  -H "X-Api-Key: my-secret-key-123" | jq
```

```json
{ "ok": true }
```

---

## GET /api/v1/crons/:id/runs {#get-apiv1cronsidruns}

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

## Cron expression reference {#cron-expression-reference}

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
