# Claude Gateway

A self-hosted multi-agent gateway for Claude Code. Connect Claude agents to Telegram, HTTP APIs, and scheduled tasks — each agent runs in an isolated session with its own personality, memory, and tools.

```
                           ┌─────────────────────────────────────────────────┐
                           │              Claude Gateway                     │
                           │                                                 │
Telegram Bot A ──►  TelegramReceiver(A)  ──► AgentRunner(A) ─┬─► Session(chat:111) ──► Claude + MCP
                                                              ├─► Session(chat:222) ──► Claude + MCP
Telegram Bot B ──►  TelegramReceiver(B)  ──► AgentRunner(B) ──┴─► Session(chat:333) ──► Claude + MCP
                                                              │
HTTP Client    ──►  POST /api/v1/.../messages ────────────────┴─► Session(api:uuid)  ──► Claude
                    (sync JSON or SSE stream)
                           │                                                 │
                           │  GatewayRouter   (/health, /status, /ui, /api)  │
                           │  CronScheduler   (HEARTBEAT.md + REST API)      │
                           │  TypingManager   (live status indicators)        │
                           └─────────────────────────────────────────────────┘

                    ┌──────────────────────────────┐
                    │    MCP Server (per session)   │
                    │    mcp/gateway/server.ts      │
                    │                               │
                    │  telegram_reply               │
                    │  telegram_react               │
                    │  telegram_edit_message         │
                    │  telegram_download_attachment  │
                    │  cron_list / cron_create / ... │
                    └──────────────────────────────┘
```

Each agent runs a **dedicated TelegramReceiver** (single poller per bot token) and a **session pool** of isolated Claude subprocesses — one per chat or API session. Each session gets its own **MCP server** (`mcp/gateway/server.ts`) exposing channel-specific tools (Telegram reply, react, cron management). Sessions persist history via `SessionStore`, so Claude remembers the conversation even after idle restart.

---

## Features

- **Multi-agent** — run multiple bots from a single gateway, each with isolated sessions
- **Multi-channel MCP** — modular tool system per channel (Telegram, Cron, extensible to Discord/WhatsApp)
- **Agent identity** — define personality, tone, and rules via workspace markdown files
- **Live status messages** — real-time status updates showing tool usage, thinking, and progress
- **Typing indicators** — continuous typing animation while the agent is working
- **Streaming API** — SSE (Server-Sent Events) endpoint for real-time response streaming
- **Auto-forward** — agent text output automatically forwarded to Telegram even without explicit reply tool calls
- **Heartbeat / scheduled tasks** — cron-based proactive messages and recurring tasks via HEARTBEAT.md + REST API
- **Long-term memory** — persistent memory system across sessions
- **Config auto-migration** — automatic schema migration when config format changes
- **Access control** — allowlist, open, or pairing-based Telegram access policies
- **HTTP API** — REST API with key-based auth for external integrations
- **Session persistence** — conversation history saved and restored across restarts

---

## Requirements

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) v2.1.0+ installed and authenticated — `channels mode` is required (`claude --version`)
- [Bun](https://bun.sh) — runs the MCP server subprocess (`mcp/gateway/server.ts`)
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

### 2. Install MCP server dependencies

The gateway MCP server uses Bun with its own `package.json`. Install once:

```bash
make mcp-install    # runs: cd mcp/gateway && bun install
```

This installs `grammy` (Telegram Bot API) and `@modelcontextprotocol/sdk` into `mcp/gateway/node_modules/`.

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
| `AGENTS.md` | **Yes** | Core identity, rules, capabilities |
| `IDENTITY.md` | No | Agent name, emoji, avatar, personality identity |
| `SOUL.md` | No | Tone, personality, speaking style |
| `USER.md` | No | User profile and preferences |
| `TOOLS.md` | No | Available tools and how to use them |
| `MEMORY.md` | No | Long-term memory (auto-appended by the agent) |
| `HEARTBEAT.md` | No | Scheduled/proactive tasks |
| `BOOTSTRAP.md` | No | One-time first-run setup (auto-deleted after) |

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

## Architecture

### Session Pool

Each agent maintains a **session pool** — a separate Claude subprocess per chat ID (Telegram) or session UUID (API). Sessions are fully isolated: Claude sees only its own conversation history with no cross-session leakage.

```
TelegramReceiver  (1 per agent, spawned by gateway)
  - single long-poll connection per bot token
  - handles access control (allowlist / pairing)
  - runs as: bun mcp/gateway/tools/telegram/receiver-server.ts (RECEIVER_MODE)
  - POSTs incoming messages to AgentRunner callback

AgentRunner  (session pool manager)
  ├── SessionProcess(chat:111)  ──► Claude subprocess + MCP server (SEND_ONLY)
  ├── SessionProcess(chat:222)  ──► Claude subprocess + MCP server (SEND_ONLY)
  └── SessionProcess(api:uuid)  ──► Claude subprocess (no MCP — API-only)
```

### MCP Tool System

The MCP server (`mcp/gateway/server.ts`) uses a **modular multi-channel architecture**. Each channel is a separate module implementing `ChannelModule` or `ToolModule` interfaces:

| Module | Interface | Tools | Purpose |
|--------|-----------|-------|---------|
| `telegram` | `ChannelModule` | `telegram_reply`, `telegram_react`, `telegram_edit_message`, `telegram_download_attachment` | Send messages, reactions, edit messages in Telegram |
| `cron` | `ToolModule` | `cron_list`, `cron_create`, `cron_delete`, `cron_run`, `cron_get_runs` | Manage scheduled jobs via gateway REST API |

Tools are **prefixed by channel name** to avoid collisions. Each module controls its own visibility and lifecycle.

**Adding a new channel** (e.g. Discord) means implementing `ChannelModule` interface in `mcp/gateway/tools/discord/module.ts` and registering it in `server.ts`.

### Process Modes

| Mode | Process | Behaviour |
|------|---------|-----------|
| `TELEGRAM_RECEIVER_MODE` | `receiver-server.ts` | Polls Telegram, handles commands, POSTs to callback — **no MCP** |
| `TELEGRAM_SEND_ONLY` | `server.ts` | Exposes MCP tools (`telegram_*`, `cron_*`) — **no polling** |

### Session Persistence

History is persisted to `SessionStore` (`.jsonl` files) after each message. When a session is spawned after an idle restart, history is injected into the initial prompt so Claude resumes the conversation seamlessly.

---

## Live Status Messages

While an agent is working, the gateway sends real-time status updates to Telegram showing what the agent is doing:

```
☑️ : 🧠 Analyzing the codebase structure...
☑️ : 📖 Reading: src/agent-runner.ts
☑️ : 🔍 Searching for: "sendMessage" in src/
🕐 : ✏️ Editing: src/typing.ts
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

Pass API key via `X-Api-Key: <key>` or `Authorization: Bearer <key>` header.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/agents` | List agents accessible by the provided key |
| `POST` | `/api/v1/agents/:agentId/messages` | Send a message — sync JSON or SSE stream |
| `GET` | `/api/v1/crons` | List cron jobs accessible by key |
| `GET` | `/api/v1/crons/status` | Scheduler status |
| `POST` | `/api/v1/crons` | Create a scheduled job |
| `GET` | `/api/v1/crons/:id` | Get a single job |
| `PUT` | `/api/v1/crons/:id` | Update a job |
| `DELETE` | `/api/v1/crons/:id` | Delete a job |
| `POST` | `/api/v1/crons/:id/run` | Trigger a job manually |
| `GET` | `/api/v1/crons/:id/runs` | Get run history |

See **[API.md](./API.md)** for full reference with request/response schemas and curl examples.

---

## File Structure

### Project

```
claude-gateway/
├── Makefile                            ← make start / create-agent / pair / mcp-install
├── config.template.json                ← config template (source of truth for migration)
│
├── src/                                ← Gateway core (TypeScript, compiled to dist/)
│   ├── index.ts                        ← entrypoint — loads config, starts agents
│   ├── types.ts                        ← shared TypeScript types
│   │
│   │── agent-runner.ts                 ← session pool manager (spawn/evict sessions)
│   ├── session-process.ts              ← single Claude subprocess per session
│   ├── session-store.ts                ← persist/load conversation history (.jsonl)
│   ├── session-compactor.ts            ← summarise + compact old history
│   ├── telegram-receiver.ts            ← spawns TelegramReceiver subprocess per agent
│   │
│   ├── gateway-router.ts               ← HTTP server (/health, /status, /ui, /api)
│   ├── api-router.ts                   ← REST API router (sync + SSE streaming)
│   ├── api-auth.ts                     ← API key auth middleware (timing-safe)
│   │
│   ├── config-loader.ts                ← load + validate config.json
│   ├── config-migrator.ts              ← auto-migration for config schema changes
│   ├── config-watcher.ts               ← hot-reload config on file change
│   │
│   ├── cron-manager.ts                 ← persistent cron job manager (REST + agentTurn)
│   ├── cron-router.ts                  ← Cron API router (auth + agent-scoped access)
│   ├── cron-scheduler.ts               ← heartbeat task scheduler
│   ├── heartbeat-parser.ts             ← parse HEARTBEAT.md YAML
│   ├── heartbeat-history.ts            ← track scheduled task execution
│   │
│   ├── workspace-loader.ts             ← assembles CLAUDE.md from workspace files
│   ├── memory-manager.ts               ← long-term memory persistence
│   ├── context-isolation.ts            ← context guard for session isolation
│   ├── security.ts                     ← input validation and sanitization
│   ├── markdown.ts                     ← markdown/HTML utilities
│   ├── webhook-manager.ts              ← webhook event dispatch
│   ├── logger.ts                       ← structured logging with per-agent files
│   └── web-ui.ts                       ← live HTML dashboard
│
├── scripts/
│   ├── create-agent.ts                 ← interactive agent creation wizard
│   ├── create-agent-prompts.ts         ← agent workspace generation prompts
│   ├── update-agent.ts                 ← agent config updater
│   ├── interactive-select.ts           ← interactive selection UI helper
│   ├── pair.ts                         ← approve Telegram pairing
│   └── setup-claude-settings.js        ← enables channelsEnabled in Claude Code
│
└── mcp/
    └── gateway/                        ← MCP server (runs in Bun, separate node_modules)
        ├── package.json                ← dependencies: grammy, @modelcontextprotocol/sdk
        ├── server.ts                   ← MCP entry point — registers all tool modules
        ├── types.ts                    ← ChannelModule / ToolModule interfaces
        ├── channel-manager.ts          ← module lifecycle (init, start, stop, restart)
        ├── router.ts                   ← route resolution + channel context rendering
        │
        └── tools/
            ├── telegram/               ← Telegram channel module
            │   ├── module.ts           ← ChannelModule: telegram_reply, react, edit, download
            │   ├── receiver-server.ts  ← standalone receiver (polling mode, no MCP)
            │   ├── pure.ts             ← markdown → Telegram HTML conversion
            │   ├── typing.ts           ← typing indicator state
            │   └── skills/
            │       ├── access/SKILL.md     ← /telegram:access skill
            │       └── configure/SKILL.md  ← /telegram:configure skill
            │
            └── cron/                   ← Cron tool module
                ├── module.ts           ← ToolModule: cron_list, create, delete, run, get_runs
                ├── client.ts           ← HTTP client for gateway cron REST API
                └── skills/
                    └── cron/SKILL.md   ← /cron skill
```

### Runtime data (`~/.claude-gateway/`)

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
            ├── CLAUDE.md               ← auto-generated from workspace files, do not edit
            ├── AGENTS.md               ← agent identity, rules, capabilities
            ├── IDENTITY.md             ← name, emoji, avatar
            ├── SOUL.md                 ← tone, personality, speaking style
            ├── USER.md                 ← user profile and preferences
            ├── TOOLS.md               ← available tools and usage
            ├── MEMORY.md               ← long-term memory (auto-appended)
            ├── HEARTBEAT.md            ← scheduled/proactive tasks
            ├── .sessions/              ← per-session MCP config
            │   └── <session_id>/
            │       └── .mcp-config.json ← auto-generated MCP config for this session
            └── .telegram-state/
                └── access.json         ← allowlist and pairing state
```

---

## Heartbeat / Scheduled Tasks

Define proactive tasks in `HEARTBEAT.md`:

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

**Session management**

| Command | Description |
|---------|-------------|
| `/session` | Show current session info (name, message count, context %) |
| `/sessions` | List all sessions with inline keyboard — switch or delete |
| `/new <name>` | Create a new session, optionally with a name |
| `/rename <name>` | Rename the current session |
| `/clear` | Clear current session history (with confirmation) |
| `/compact` | Summarise old history and keep only recent messages |
| `/restart` | Graceful session restart — shows a confirmation button; confirms and notifies when the session is back online |

**Agent**

| Command | Description |
|---------|-------------|
| `/model` | Show the current AI model |
| `/models` | Switch AI model — shows an inline keyboard; selecting a model triggers a graceful restart and notifies when back online |

**Account**

| Command | Description |
|---------|-------------|
| `/start` | Pairing instructions |
| `/status` | Check your pairing state |
| `/help` | Show available commands |

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
| `/api/v1/crons/*` | Cron job management — see [API.md](./API.md) |

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
- Check workspace path exists and contains `AGENTS.md`
- Check `dangerouslySkipPermissions: true` is set in config
- Check logs in `~/.claude-gateway/logs/<id>.log`

**Agent not responding to messages**
- Verify `dmPolicy` — if `allowlist`, check the user's ID is in `access.json`
- Ensure no other process is polling the same bot token (causes 409 Conflict)
- Only `TelegramReceiver` polls Telegram — MCP session subprocesses run in `SEND_ONLY` mode (no polling)

**Session loses memory after restart**
- History is persisted in `~/.claude-gateway/agents/<id>/sessions/<chat_id>.jsonl`
- If the file is missing, the session starts fresh (no error)

**Personality not applied**
- `CLAUDE.md` is auto-regenerated from workspace files on startup and on any file change
- Trigger a reload by saving any `.md` file in the workspace

**Heartbeat not firing**
- Verify `HEARTBEAT.md` YAML is valid
- Check cron expression (5 fields: `min hour day month weekday`)
- Check rate limit — default 30 min between proactive messages

**API returns 403**
- Check the key value matches exactly (env var interpolation uses `${VAR}` syntax)
- Verify the key's `agents` list includes the target agent ID, or set `"agents": "*"`

**MCP tools not working (telegram_reply, cron_list, etc.)**
- Ensure `mcp/gateway/node_modules/` exists — run `make mcp-install` if not
- Check that `.mcp-config.json` is generated in the session directory
- Verify Bun is installed (`bun --version`)

**Status messages not appearing in Telegram**
- First status update is sent after 5 seconds — very fast tasks may complete before it fires
- Check that the MCP server is running in `SEND_ONLY` mode for session subprocesses
- Verify the bot has permission to send messages in the chat
