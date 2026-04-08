# Claude Gateway

A self-hosted multi-agent Telegram gateway. Run multiple Telegram bots — each powered by an isolated Claude agent with its own personality, memory, and scheduled behaviours.

```
Telegram Bot A ──► TelegramReceiver (agent A) ──► SessionProcess(chat:111) ──► Claude subprocess
                                                ──► SessionProcess(chat:222) ──► Claude subprocess
Telegram Bot B ──► TelegramReceiver (agent B) ──► SessionProcess(chat:333) ──► Claude subprocess

HTTP Client ──► POST /api/v1/agents/:id/messages ──► SessionProcess(uuid) ──► Claude subprocess
             (sync JSON or SSE stream)

                        ↑
                  GatewayRouter (/health, /status, /ui, /api)
                  CronScheduler (heartbeat.md)
                  TypingManager (live status + typing indicators)
```

Each agent runs a **dedicated TelegramReceiver** (single Telegram poller per bot token) and a **session pool** of isolated Claude subprocesses — one per chat or API session. Sessions persist their history via `SessionStore`, so Claude remembers the conversation even after idle restart.

---

## Features

- **Multi-agent** — run multiple Telegram bots from a single gateway, each with isolated sessions
- **Agent identity** — define personality, tone, and rules via workspace markdown files
- **Live status messages** — real-time Telegram status updates showing what the agent is doing (tool usage, thinking, progress)
- **Typing indicators** — continuous typing animation while the agent is working
- **Streaming API** — SSE (Server-Sent Events) endpoint for real-time response streaming
- **Auto-forward** — agent text output automatically forwarded to Telegram even without explicit reply tool calls
- **Heartbeat / scheduled tasks** — cron-based proactive messages and recurring tasks
- **Long-term memory** — persistent memory system across sessions
- **Config auto-migration** — automatic schema migration when config format changes
- **Access control** — allowlist, open, or pairing-based Telegram access policies
- **HTTP API** — REST API with key-based auth for external integrations
- **Session persistence** — conversation history saved and restored across restarts

---

## Requirements

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) v2.1.0+ installed and authenticated — channels mode is required (`claude --version`)
- [Bun](https://bun.sh) (used to run the Telegram plugin MCP server)
- A Telegram bot token per agent (from [@BotFather](https://t.me/BotFather))

---

## Quick Start

### 1. Install

```bash
git clone <repo>
cd claude-gateway
npm install
npm run build
```

### 2. Install the Telegram plugin

Registers the gateway's Telegram plugin with Claude Code, enables channels mode, and installs dependencies. Only needs to be run once.

```bash
make plugin-install
```

### 3. Create an agent

The interactive wizard handles everything — workspace files, config, bot token, and pairing:

```bash
make create-agent
```

Steps:
1. Choose an agent name
2. Describe the agent — Claude generates workspace files
3. Review and accept generated files
4. Create a Telegram bot via @BotFather and paste the token
5. Send any message to the bot to complete pairing
6. Agent sends a welcome message

### 4. Start the gateway

```bash
npm start
```

Config is auto-loaded from `~/.claude-gateway/config.json`. Bot tokens are auto-loaded from `~/.claude-gateway/agents/<id>/.env`.

---

## Workspace Files

Each agent has a workspace directory with markdown files that define its behaviour:

| File | Required | Purpose |
|------|----------|---------|
| `agent.md` | **Yes** | Core identity, rules, capabilities |
| `soul.md` | No | Tone, personality, speaking style |
| `user.md` | No | User profile and preferences |
| `tools.md` | No | Available tools and how to use them |
| `memory.md` | No | Long-term memory (auto-appended by the agent) |
| `heartbeat.md` | No | Scheduled/proactive tasks |
| `bootstrap.md` | No | One-time first-run setup (auto-deleted after) |

On startup (and on any file change), all files are assembled into `CLAUDE.md` which the Claude subprocess reads as its system prompt. Do not edit `CLAUDE.md` directly.

---

## Configuration Reference

Config lives at `~/.claude-gateway/config.json` (or set `GATEWAY_CONFIG` env var / `--config` flag).

```json
{
  "configVersion": "1.0.0",
  "gateway": {
    "logDir": "~/.claude-gateway/logs",
    "timezone": "Asia/Bangkok",
    "api": {
      "keys": [
        {
          "key": "${MY_API_KEY}",
          "description": "Internal app",
          "agents": ["alfred"]
        },
        {
          "key": "${ADMIN_API_KEY}",
          "description": "Admin",
          "agents": "*"
        }
      ]
    }
  },
  "agents": [
    {
      "id": "alfred",
      "description": "Personal assistant",
      "workspace": "~/.claude-gateway/agents/alfred/workspace",
      "env": "",
      "session": {
        "idleTimeoutMinutes": 30,
        "maxConcurrent": 20
      },
      "telegram": {
        "botToken": "${ALFRED_BOT_TOKEN}",
        "allowedUsers": [123456789],
        "dmPolicy": "allowlist"
      },
      "claude": {
        "model": "claude-sonnet-4-6",
        "dangerouslySkipPermissions": true,
        "extraFlags": []
      },
      "heartbeat": {
        "rateLimitMinutes": 30
      }
    }
  ]
}
```

### `session`

| Field | Default | Description |
|-------|---------|-------------|
| `idleTimeoutMinutes` | `30` | Kill idle session subprocess after N minutes of inactivity |
| `maxConcurrent` | `20` | Max simultaneous active sessions per agent; oldest idle is evicted when exceeded |

### `dmPolicy`

| Value | Behaviour |
|-------|-----------|
| `allowlist` | Only user IDs in `allowedUsers` can DM the agent |
| `open` | Anyone can DM the agent |
| `pairing` | New users DM the bot to receive a pairing code; approve with `npm run pair` |

### `dangerouslySkipPermissions`

Set to `true` for all agents running headless (no interactive terminal). Without it the agent cannot use MCP tools like sending Telegram replies.

### `gateway.api.keys`

Each key has a `key` string (supports `${ENV_VAR}` interpolation), an optional `description`, and an `agents` field — either an array of agent IDs or `"*"` for full access. Keys support both `Authorization: Bearer` and `X-Api-Key` headers.

### Bot tokens

Tokens are stored per-agent at `~/.claude-gateway/agents/<id>/.env` and auto-loaded at startup. Use `${AGENT_BOT_TOKEN}` syntax in config to reference them, or set them as shell environment variables.

---

## Multi-Session Architecture

Each agent maintains a **session pool** — a separate Claude subprocess per chat ID (Telegram) or session UUID (API). Sessions are fully isolated: Claude sees only its own conversation history with no cross-session leakage.

```
TelegramReceiver  (1 per agent, spawned by gateway)
  - single long-poll connection per bot token
  - handles access control (allowlist / pairing)
  - POSTs incoming messages to AgentRunner callback

AgentRunner  (session pool manager)
  ├── SessionProcess(chat:111)  Claude subprocess + SEND_ONLY plugin
  ├── SessionProcess(chat:222)  Claude subprocess + SEND_ONLY plugin
  └── SessionProcess(api:uuid)  Claude subprocess, no Telegram plugin
```

**Telegram plugin modes:**

| Mode | Used by | Behaviour |
|------|---------|-----------|
| `TELEGRAM_RECEIVER_MODE` | TelegramReceiver | Polls Telegram + POSTs to callback, no MCP |
| `TELEGRAM_SEND_ONLY` | SessionProcess (Telegram) | Exposes MCP reply/react/edit tools, no polling |

**Session memory:** History is persisted to `SessionStore` (`.jsonl` files) after each message. When a session is spawned after an idle restart, history is injected into the initial prompt so Claude resumes the conversation seamlessly.

---

## Live Status Messages

While an agent is working, the gateway sends real-time status updates to Telegram showing what the agent is doing:

```
✅ 🧠 Analyzing the codebase structure...
✅ 📖 Reading: src/agent-runner.ts
✅ 🔍 Searching for: "sendMessage" in src/
🕐 ✏️ Editing: src/typing.ts
(elapsed: 2m 30s)
```

- **Tool tracking** — each tool call is displayed with a descriptive label (e.g. `📖 Reading: config.ts`, `⚡ Running: npm test`)
- **History** — previous steps shown with ✅, current step with 🕐
- **Thinking** — agent's reasoning shown with 🧠
- **Elapsed time** — total time since the agent started working
- **Auto-cleanup** — status message is deleted when the agent finishes

Status updates are sent every 5-10 seconds (first update at 5s, then every 10s).

---

## HTTP API

When `gateway.api.keys` is configured, the gateway exposes a REST API for external clients.

### Quickstart: Using the Agent API

**Step 1 — Add an API key to `config.json`**

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
        }
      ]
    }
  }
}
```

`agents` can be an array of agent IDs or `"*"` for full access. Keys support `${ENV_VAR}` interpolation.

**Step 2 — Restart the gateway**

```bash
npm start
```

Config is loaded at startup — a restart is required after changing API keys.

**Step 3 — List available agents**

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

**Step 4 — Send a message (new session)**

Omit `session_id` to start a fresh conversation. The response includes a `session_id` — save it for follow-up messages.

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

**Step 5 — Continue the conversation (same session)**

Pass the `session_id` from the previous response to resume the same context. Claude remembers the full conversation history.

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"message": "What did I just ask you?", "session_id": "da19d84a-6a36-4f57-b419-d322d82c4db8"}' \
  http://localhost:3000/api/v1/agents/alfred/messages | jq
```

```json
{
  "request_id": "7f3c2a1b-...",
  "agent_id": "alfred",
  "response": "You asked: \"Hello! What can you help me with?\"",
  "session_id": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "duration_ms": 1876
}
```

> **Tips:**
> - Auth header: `X-Api-Key: <key>` or `Authorization: Bearer <key>` — both work
> - `session_id` is optional — omit for a stateless one-shot call
> - Sessions idle-timeout after `idleTimeoutMinutes` (default 30 min); history is restored automatically on next message
> - Error 409 = session is currently processing a request — wait and retry
> - Add `"stream": true` to the request body for SSE streaming (see [Streaming API](#streaming-api-sse))

---

### Endpoints

See [Quickstart: Using the Agent API](#quickstart-using-the-agent-api) for full examples with request/response JSON.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/agents/:agentId/messages` | Send a message — sync JSON or SSE stream |
| `GET` | `/api/v1/agents` | List agents accessible by the provided key |

**Error responses (POST):**

| Status | When |
|--------|------|
| 400 | Empty message or exceeds 10,000 characters |
| 401 | Missing API key |
| 403 | Invalid key or key has no access to that agent |
| 404 | Agent ID not found |
| 409 | Session is busy processing another request |
| 504 | Agent did not respond within 60s |
| 500 | Internal error |

---

## Streaming API (SSE)

The HTTP API supports Server-Sent Events for real-time streaming responses.

**Request:**

```bash
curl -N -X POST \
  -H "X-Api-Key: my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message": "Explain this code", "stream": true}' \
  http://localhost:3000/api/v1/agents/alfred/messages
```

**Response (SSE):**

```
data: {"type":"text_delta","text":"Let me"}
data: {"type":"text_delta","text":" explain..."}
data: {"type":"tool_use","name":"Read","id":"toolu_abc123"}
data: {"type":"text_delta","text":"Here's the explanation..."}
data: {"type":"result","text":"Here's the full explanation...","request_id":"550e8400-...","session_id":"abc-123","duration_ms":4200}
data: [DONE]
```

**Stream event types:**

| Type | Fields | Description |
|------|--------|-------------|
| `text_delta` | `text` | Incremental text chunk |
| `tool_use` | `name`, `id` | Tool invocation (e.g. Read, Grep, Bash) |
| `thinking` | `text` | Agent reasoning (if available) |
| `result` | `text`, `request_id`, `session_id`, `duration_ms` | Final aggregated result |
| `error` | `message` | Error event |

The stream ends with `data: [DONE]`. Set `stream: false` (default) for the synchronous JSON response mode.

---

## File Structure

### Project

```
claude-gateway/
├── Makefile                            ← make start / create-agent / pair / plugin-install / add-user
├── config.template.json                ← config template (source of truth for migration)
├── src/                                ← gateway source (TypeScript)
│   ├── index.ts                        ← entrypoint, loads config and starts agents
│   ├── agent-runner.ts                 ← session pool manager (spawn/evict SessionProcesses)
│   ├── session-process.ts              ← single Claude subprocess per session
│   ├── telegram-receiver.ts            ← standalone Telegram poller (1 per agent)
│   ├── session-store.ts                ← persist/load conversation history (.jsonl)
│   ├── gateway-router.ts               ← HTTP server (/health, /status, /ui, /api)
│   ├── api-router.ts                   ← REST API router (sync + SSE streaming)
│   ├── api-auth.ts                     ← API key auth middleware (timing-safe)
│   ├── config-loader.ts                ← load + validate config.json
│   ├── config-migrator.ts              ← auto-migration for config schema changes
│   ├── cron-scheduler.ts               ← heartbeat task scheduler
│   ├── heartbeat-parser.ts             ← parse heartbeat.md YAML
│   ├── heartbeat-history.ts            ← track scheduled task execution
│   ├── memory-manager.ts               ← long-term memory persistence
│   ├── workspace-loader.ts             ← assembles CLAUDE.md from workspace files
│   ├── context-isolation.ts            ← context guard for session isolation
│   ├── security.ts                     ← input validation and sanitization
│   ├── webhook-manager.ts              ← webhook event dispatch
│   ├── logger.ts                       ← structured logging with per-agent files
│   ├── types.ts                        ← shared TypeScript types
│   └── web-ui.ts                       ← live HTML dashboard
├── scripts/
│   ├── create-agent.ts                 ← interactive agent creation wizard
│   ├── create-agent-prompts.ts         ← agent workspace generation prompts
│   ├── update-agent.ts                 ← agent config updater
│   ├── interactive-select.ts           ← interactive selection UI helper
│   ├── pair.ts                         ← approve Telegram pairing
│   └── setup-claude-settings.js        ← enables channelsEnabled in Claude Code
└── plugins/
    ├── marketplace.json                ← plugin registry
    └── telegram/
        ├── server.ts                   ← Telegram MCP server (reply/react/edit/download tools)
        ├── typing.ts                   ← typing indicator + live status messages
        ├── pure.ts                     ← pure utility functions
        └── skills/
            ├── access/SKILL.md         ← /telegram:access skill
            └── configure/SKILL.md      ← /telegram:configure skill
```

### Agents data (`~/.claude-gateway/`)

```
~/.claude-gateway/
├── config.json                         ← gateway config
├── logs/
│   ├── alfred.log
│   └── warrior.log
└── agents/
    └── alfred/
        ├── .env                        ← bot token (auto-created by wizard)
        ├── sessions/
        │   └── <chat_id>.jsonl         ← conversation history (SessionStore)
        └── workspace/
            ├── CLAUDE.md               ← auto-generated, do not edit
            ├── agent.md
            ├── soul.md
            ├── user.md
            ├── memory.md
            ├── heartbeat.md
            └── .telegram-state/
                ├── access.json         ← allowlist and pairing state
                └── .mcp-config.json    ← auto-generated MCP config for Telegram plugin
```

---

## Heartbeat / Scheduled Tasks

Define proactive tasks in `heartbeat.md`:

```yaml
tasks:
  - name: morning-brief
    cron: "0 8 * * *"
    prompt: "Give a brief morning summary."

  - name: check-in
    interval: 6h
    prompt: "Check if there are any reminders to send."
```

- `cron` — standard 5-field cron expression
- `interval` — shorthand: `30m`, `1h`, `6h`, `1d`, `1w`
- If the agent replies with `HEARTBEAT_OK` (case-insensitive), no message is sent to Telegram
- `rateLimitMinutes` in config suppresses tasks if a proactive message was already sent recently (default: 30 min)

---

## Config Auto-Migration

When the config schema changes (new fields added in `config.template.json`), the gateway automatically detects and migrates your `config.json`:

- Preserves all existing values
- Adds missing fields with defaults from the template
- Prompts for confirmation before writing (use `--auto-migrate` to skip)
- Tracks schema version for future migrations

---

## Pairing New Users

1. Set `dmPolicy` to `pairing` in `access.json` (or in config):
   ```json
   { "dmPolicy": "pairing" }
   ```
2. Ask the user to DM the bot — they receive a 6-character pairing code
3. Approve it:
   ```bash
   npm run pair -- --agent=alfred --code=abc123
   ```
4. The bot confirms pairing within 5 seconds
5. Lock down after everyone is paired:
   ```bash
   npm run pair -- --agent=alfred --policy=allowlist
   ```

Or use the Makefile shortcut:
```bash
make add-user AGENT=alfred
```

This switches `dmPolicy` to `pairing`, prints pairing instructions, and reminds you to switch back to `allowlist` when done.

---

## Telegram Commands

Once paired, the following bot commands are available in a private chat:

| Command | Description |
|---------|-------------|
| `/start` | Pairing instructions |
| `/help` | Show available commands |
| `/status` | Check your pairing state |
| `/model` | Show the current AI model |
| `/models` | Switch AI model — shows an inline keyboard; selecting a model triggers a graceful restart and notifies when back online |
| `/restart` | Graceful session restart — shows a confirmation button; confirms and notifies when the session is back online |

> **Note:** `/model`, `/models`, and `/restart` require the agent to be running in `TELEGRAM_RECEIVER_MODE` with a reachable `CLAUDE_CHANNEL_CALLBACK` endpoint. If no active session exists when switching model or restarting, the change is applied immediately and a success message is shown without a restart.

---

## Monitoring

The gateway runs an HTTP server on port 3000 (set `PORT` env var to change):

| Endpoint | Description |
|----------|-------------|
| `GET /health` | All agent IDs and running status |
| `GET /status` | JSON stats per agent (sessions, uptime) |
| `GET /ui` | Live HTML dashboard (auto-refreshes every 5s) |
| `POST /api/v1/agents/:id/messages` | Send a message to an agent (requires API key) |
| `GET /api/v1/agents` | List accessible agents (requires API key) |

---

## Development

```bash
# Build TypeScript
npm run build

# Unit tests only (fast, no external deps)
npm run test:unit

# Integration tests
npm run integration

# All tests
npm test

# Type check without building
npm run typecheck
```

---

## Troubleshooting

**Agent fails to start**
- Check workspace path exists and contains `agent.md`
- Check `dangerouslySkipPermissions: true` is set in config
- Check logs in `~/.claude-gateway/logs/<id>.log`

**Agent not responding to messages**
- Verify `dmPolicy` — if `allowlist`, check the user's ID is in `access.json`
- Ensure no other process is polling the same bot token (causes 409 Conflict)
- With multi-session, only `TelegramReceiver` polls — session subprocesses use `SEND_ONLY` mode

**Session loses memory after restart**
- History is persisted in `~/.claude-gateway/agents/<id>/sessions/<chat_id>.jsonl`
- If the file is missing, the session starts fresh (no error)

**Personality not applied**
- `CLAUDE.md` is auto-regenerated from workspace files on startup and on any file change
- Trigger a reload by saving any `.md` file in the workspace

**Heartbeat not firing**
- Verify `heartbeat.md` YAML is valid
- Check cron expression (5 fields: `min hour day month weekday`)
- Check rate limit — default 30 min between proactive messages

**API returns 403**
- Check the key value matches exactly (env var interpolation uses `${VAR}` syntax)
- Verify the key's `agents` list includes the target agent ID, or set `"agents": "*"`

**Status messages not appearing in Telegram**
- First status update is sent after 5 seconds — very fast tasks may complete before it fires
- Check that the Telegram plugin is running in `SEND_ONLY` mode for session subprocesses
- Verify the bot has permission to send messages in the chat
