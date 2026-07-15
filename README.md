
# Claude Gateway

A self-hosted multi-agent gateway for Claude Code. Connect Claude agents to Telegram, HTTP APIs, and scheduled tasks — each agent runs in an isolated session with its own personality, memory, and tools.

<p align="center">
  <img src="resource/claude_gateway.svg" alt="Claude Gateway" width="680" />
</p>

---

## Features

- **Multi-agent** — run multiple bots from a single gateway, each with isolated sessions
- **Multi-channel MCP** — modular tool system per channel (Telegram, Discord, Cron, Skills, extensible to Slack/WhatsApp)
- **Agent skills** — extensible skill system via SKILL.md files; agents can create, delete, and install skills from URLs at runtime with hot-reload
- **Agent identity** — define personality, tone, and rules via workspace markdown files
- **Live status messages** — real-time status updates showing tool usage, thinking, and progress
- **Typing indicators** — continuous typing animation while the agent is working (Telegram and Discord)
- **Streaming API** — SSE (Server-Sent Events) endpoint for real-time response streaming
- **Auto-forward** — agent text output automatically forwarded to Telegram even without explicit reply tool calls
- **Heartbeat / scheduled tasks** — cron-based proactive messages and recurring tasks via HEARTBEAT.md + REST API; agent jobs deliver output to Telegram, Discord, or both
- **Persistent chat history** — two-layer storage: session context (`.jsonl`) + permanent SQLite DB with FTS5 full-text search; survives `/compact` and session eviction
- **Auto-cleanup** — configurable retention policy prunes messages and media files older than N days on a daily schedule
- **Long-term memory** — persistent memory system across sessions
- **Config auto-migration** — automatic schema migration when config format changes
- **Access control** — allowlist, open, or pairing-based Telegram access policies
- **HTTP API** — REST API with key-based auth for external integrations
- **App Store** — install, update, and host Docker-compose apps on the gateway; apps get a reverse proxy at `/app/:name/:portName/*`, optional Unix socket bridge for host scripts, and optional AI agent injection
- **Self-update API** — check for newer versions of `claude-gateway` and `claude-code` and trigger an update via a single API call; no SSH or shell access needed
- **Session persistence** — conversation history saved and restored across restarts
- **PTY shell (wrap-shell mode)** — optional interactive pseudo-terminal backend (`gateway.headless: false`) for tools that require a real TTY; includes a live browser viewer (xterm.js) and a `/api/v1/sessions/:sessionId/screen` endpoint that returns the visible screen as plain text — agents can poll it to detect hang states, menus, or unexpected output without parsing ANSI escape codes; app-agents always stay headless

---

## Requirements

- Node.js 22+
- [Claude Code CLI](https://claude.ai/code) v2.1.0+ installed and authenticated — `channels mode` is required (`claude --version`)
  - The gateway must be able to find the `claude` executable: either have `claude` on the `PATH` of the process that launches the gateway, or set `CLAUDE_BIN` to its full path. When `CLAUDE_BIN` is unset, the gateway also probes the native-installer locations (`~/.local/bin/claude`, then `~/.local/share/claude/versions/`) and the legacy npm/nvm layout, so a Claude Code installer migration does not break new sessions. If none resolve, set `CLAUDE_BIN` explicitly (e.g. `CLAUDE_BIN=~/.local/bin/claude`).
- [Bun](https://bun.sh) — runs the MCP server subprocess (`mcp/server.ts`)
- A bot token per agent — Telegram (from [@BotFather](https://t.me/BotFather)) or Discord (from [Discord Developer Portal](https://discord.com/developers/applications))
- **PTY backend only** (`claude.headless: false`): native build tools required for `node-pty` — `gcc`, `python3`, and `node-gyp` must be available at `npm install` time (pre-built binaries are included for common platforms; build tools are only needed if a pre-built binary is unavailable for your platform)

---

## Quick Start

### Install via npm (for users)

**1. Install**

```bash
npm install -g @0xmaxma/claude-gateway
```

Requires [Bun](https://bun.sh) — MCP server dependencies are installed automatically via `postinstall`.

**2. Configure environment (optional)**

The gateway auto-loads `~/.claude-gateway/.env` on startup:

```bash
mkdir -p ~/.claude-gateway
cat > ~/.claude-gateway/.env << 'EOF'
# HTTP port (default: 10850)
# PORT=10850

# Bind address (default: 0.0.0.0 — all interfaces)
# Set to 127.0.0.1 if a host-network reverse proxy (e.g. Traefik) is used
# GATEWAY_BIND=127.0.0.1

# Path to gateway config (default: ~/.claude-gateway/config.json)
# GATEWAY_CONFIG=~/.claude-gateway/config.json
EOF
```

All variables are optional. Full list: [`.env.example`](.env.example)

**3. Create an agent**

Add an agent entry to `~/.claude-gateway/config.json` manually (see [`config.template.json`](config.template.json) for the format), or clone the repo and run `make create-agent` for the interactive wizard (see **For development** below).

**4. Start**

```bash
claude-gateway
```

**Run as a service with PM2 (optional)**

To keep the gateway running after logout or system restarts, use [PM2](https://pm2.keymetrics.io):

```bash
npm install -g pm2
pm2 start $(which claude-gateway) --name gateway
pm2 save       # persist the process list
pm2 startup    # register PM2 to start on boot (follow the printed command)
```

Useful commands:

```bash
pm2 status           # check gateway status
pm2 logs gateway     # tail logs
pm2 restart gateway  # restart
pm2 stop gateway     # stop
pm2 delete gateway   # remove from PM2
```

---

### For development

```bash
git clone https://github.com/0xMaxMa/claude-gateway
cd claude-gateway
npm install          # also runs bun install in mcp/
npm run build
```

### Create an agent

The interactive wizard handles everything — workspace files, config, bot token, and pairing:

```bash
make create-agent
```

Steps:
1. Choose an agent name
2. Describe the agent — Claude generates workspace files
3. Review and accept generated files
4. Choose a channel: **Telegram** or **Discord**
5. Paste the bot token — wizard verifies it automatically
6. Send any message to the bot to complete pairing
7. Agent sends a welcome message

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
| `MEMORY.md` | No | Long-term memory (auto-appended by the agent) |
| `HEARTBEAT.md` | No | Scheduled/proactive tasks |
| `skills/` | No | Directory of SKILL.md files — agent-specific skills |

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
        "botToken": "${ALFRED_BOT_TOKEN}"
      },
      "claude": {
        "model": "claude-sonnet-4-6",
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

### `gateway.history` (optional)

Global default retention policy. Can be overridden per-agent with an `history` key inside the agent config.

```json
{
  "gateway": {
    "history": {
      "retentionDays": 90,
      "cleanupHour": 3,
      "cleanupTimezone": "Asia/Bangkok"
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `retentionDays` | `null` (keep forever) | Delete messages older than N days on each cleanup cycle |
| `cleanupHour` | `3` | Hour of day to run cleanup (24h, in `cleanupTimezone`) |
| `cleanupTimezone` | `"UTC"` | IANA timezone for the cleanup schedule |

Per-agent override example:
```json
{
  "agents": [
    {
      "id": "alfred",
      "history": { "retentionDays": 30 }
    }
  ]
}
```

### `dmPolicy`

Access policy is configured per-channel in the agent's workspace state file, not in `config.json`:

| File | Path |
|------|------|
| Telegram | `~/.claude-gateway/agents/<id>/workspace/.telegram-state/access.json` |
| Discord | `~/.claude-gateway/agents/<id>/workspace/.discord-state/access.json` |

| Value | Behaviour |
|-------|-----------|
| `allowlist` | Only user IDs in `allowFrom` can DM the agent (**default**) |
| `open` | Anyone can DM the agent |
| `pairing` | New users DM the bot to receive a pairing code; approve with `npm run pair` |

### `gateway.headless`

Controls the Claude subprocess backend for all non-app agents.

| Value | Backend | Description |
|-------|---------|-------------|
| `true` *(default)* | Headless (`--print`) | Stateless invocation, lowest overhead |
| `false` | PTY shell wrapper | Interactive pseudo-terminal — full TUI support |

**App-agents always run headless** regardless of this setting.

`--dangerously-skip-permissions` is always injected by the gateway automatically — there is no per-agent config field for it.

```json
{
  "gateway": {
    "headless": false
  }
}
```

This setting is hot-reloadable — new sessions pick it up without a restart.

### `gateway.selfHealing.autoRecover`

Opt-in self-healing for the turn-trace watchdog (Epic #195). When a turn stalls, the gateway always detects it, logs a scrubbed incident, and notifies the affected chat. This flag additionally controls whether the gateway may *act* on a stall.

| Value | Behaviour |
|-------|-----------|
| `false` *(default)* | Detection + incident logging + notification only — no automatic action |
| `true` | The watchdog may run a whitelisted recovery for a stalled turn: a keystroke into the TUI (esc / enter / arrow / menu selection), a session restart, a reversible safe-mode fallback to the headless backend, and — after a successful unblock — a guarded resend of the last message (only if the turn produced no output, so it is never double-submitted) |

Recovery actions are clamped to a per-stage whitelist and a per-turn budget, and any local triage treats the on-screen text as untrusted data validated against a closed schema. Safe-mode auto-fallback on a hard PTY failure is independent of this flag (it is always reversible and never presses keys). In-memory only — a gateway restart re-reads your real config.

```json
{
  "gateway": {
    "selfHealing": {
      "autoRecover": true
    }
  }
}
```

### `gateway.bind`

Network interface the HTTP/WebSocket server binds to. Defaults to `127.0.0.1` (localhost-only), so the dashboard and API are **not** exposed to the local network out of the box. Set to `0.0.0.0` to listen on all interfaces (for example when a containerized reverse proxy needs to reach the gateway). The `GATEWAY_BIND` environment variable, when set, takes precedence over this field.

```json
{
  "gateway": {
    "bind": "127.0.0.1"
  }
}
```

> **⚠️ Upgrade note (configVersion 1.0.13):** the default bind changed from `0.0.0.0` to `127.0.0.1`. To avoid silently cutting off external access, the config migrator is **behavior-preserving**: when it upgrades a config created before this change and that config never set `gateway.bind`, it pins `bind` to `0.0.0.0` and logs a one-time warning, so a deployment that was reachable from another host stays reachable. New installs (no prior config, so no migration runs) keep the secure `127.0.0.1` default. If you *want* localhost-only after upgrading, set `gateway.bind` to `127.0.0.1` explicitly (or the `GATEWAY_BIND` env var).

### Terminal Viewer — interactive terminal mode

The dashboard's **Terminal Viewer** opens read-only (a live mirror of the PTY). A toggle in the top-right of the viewer switches it into an **interactive terminal**: keystrokes typed into the panel — printable characters, Enter, arrows, Ctrl-combos, Esc — are streamed into the live PTY, and the panel title changes to reflect the active mode. This is a per-browser client-side choice (Issue #201); there is no server config flag to enable it.

Because interactive mode turns a read-only view into a remote-write surface, access is protected upstream rather than by a feature flag:

- **Authentication** — the WebSocket requires a valid dashboard ticket or API key.
- **`gateway.bind`** — the gateway binds to `127.0.0.1` (localhost) by default, so the dashboard is not reachable from the network out of the box. Expose a non-loopback bind (`0.0.0.0`) **only** behind a trusted authenticating reverse proxy.

Inbound frames are always bounded (text-only, size-capped) and are dropped for headless sessions (no PTY).

### `gateway.api.keys`

Each key has a `key` string (supports `${ENV_VAR}` interpolation), an optional `description`, and an `agents` field — either an array of agent IDs or `"*"` for full access. Keys support both `Authorization: Bearer` and `X-Api-Key` headers.

### Bot tokens

Tokens are stored per-agent at `~/.claude-gateway/agents/<id>/.env` and auto-loaded at startup. Use `${AGENT_BOT_TOKEN}` syntax in config to reference them, or set them as shell environment variables.

---

## Architecture

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

                    ┌───────────────────────────────────┐
                    │    MCP Server (per session)        │
                    │    mcp/server.ts                   │
                    │                                    │
                    │  telegram_reply                    │
                    │  telegram_react                    │
                    │  telegram_edit_message              │
                    │  telegram_download_attachment       │
                    │  cron_list / cron_create / ...      │
                    │  skill_create / skill_delete / ...  │
                    └───────────────────────────────────┘
```

Each agent runs a **dedicated TelegramReceiver** (single poller per bot token) and a **session pool** of isolated Claude subprocesses — one per chat or API session. Each session gets its own **MCP server** (`mcp/server.ts`) exposing channel-specific tools (Telegram reply, react, cron management, skill management). Sessions persist history via `SessionStore`, so Claude remembers the conversation even after idle restart.

### Session Pool

Each agent maintains a **session pool** — a separate Claude subprocess per chat ID (Telegram) or session UUID (API). Sessions are fully isolated: Claude sees only its own conversation history with no cross-session leakage.

```
TelegramReceiver  (1 per agent, spawned by gateway)
  - single long-poll connection per bot token
  - handles access control (allowlist / pairing)
  - runs as: bun mcp/tools/telegram/receiver-server.ts (RECEIVER_MODE)
  - POSTs incoming messages to AgentRunner callback

AgentRunner  (session pool manager)
  ├── SessionProcess(chat:111)  ──► Claude subprocess + MCP server (SEND_ONLY)
  ├── SessionProcess(chat:222)  ──► Claude subprocess + MCP server (SEND_ONLY)
  └── SessionProcess(api:uuid)  ──► Claude subprocess (no MCP — API-only)
```

### MCP Tool System

The MCP server (`mcp/server.ts`) uses a **modular multi-channel architecture**. Each channel is a separate module implementing `ChannelModule` or `ToolModule` interfaces:

| Module | Interface | Tools | Purpose |
|--------|-----------|-------|---------|
| `telegram` | `ChannelModule` | `telegram_reply`, `telegram_react`, `telegram_edit_message`, `telegram_download_attachment` | Send messages, reactions, edit messages in Telegram |
| `discord` | `ChannelModule` | `discord_reply`, `discord_react`, `discord_edit_message` | Send messages, reactions, edit messages in Discord |
| `cron` | `ToolModule` | `cron_list`, `cron_create`, `cron_delete`, `cron_run`, `cron_get_runs` | Manage scheduled jobs via gateway REST API |
| `skills` | `ToolModule` | `skill_create`, `skill_delete`, `skill_install` | Create, delete, and install agent skills at runtime |

Tools are **prefixed by channel name** to avoid collisions. Each module controls its own visibility and lifecycle.

**Adding a new channel** (e.g. Slack) means implementing `ChannelModule` interface in `mcp/tools/slack/module.ts` and registering it in `server.ts`.

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
☑️ : 📖 Reading: src/agent/runner.ts
☑️ : 🔍 Searching for: "sendMessage" in src/
🕐 : ✏️ Editing: mcp/tools/telegram/typing.ts
(elapsed: 2m 30s)
```

- **Tool tracking** — each tool call is displayed with a descriptive label (e.g. `📖 Reading: config.ts`, `⚡ Running: npm test`)
- **History** — previous steps shown with ☑️, current step with 🕐
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
| `GET` | `/api/v1/agents/sessions` | List all sessions across all agents (admin key) |
| `GET` | `/api/v1/agents/:agentId/chats` | List chats for an agent |
| `DELETE` | `/api/v1/agents/:agentId/chats/:chatId` | Delete a chat and all its messages |
| `GET` | `/api/v1/agents/:agentId/chats/:chatId/sessions` | List sessions for a specific chat |
| `GET` | `/api/v1/agents/:agentId/chats/:chatId/messages` | Paginated message history (cursor-based) |
| `POST` | `/api/v1/agents/:agentId/chats/:chatId/sessions/:sessionId/messages` | Inject a message into an existing session |
| `POST` | `/api/v1/agents/:agentId/media` | Upload a media file (image or PDF) |
| `GET` | `/api/v1/agents/:agentId/media/*` | Serve a media file by path |
| `PUT` | `/api/v1/agents/:agentId/avatar` | Upload or replace agent avatar (admin/write) |
| `DELETE` | `/api/v1/agents/:agentId/avatar` | Remove agent avatar (admin/write) |
| `GET` | `/api/v1/agents/:agentId/avatar` | Serve agent avatar image |
| `POST` | `/api/v1/agents/wizard/start` | Start wizard: generate agent workspace via Claude (admin) |
| `PUT` | `/api/v1/agents/wizard/:wizardId/avatar` | Upload avatar to wizard before confirm (admin) |
| `POST` | `/api/v1/agents/wizard/:wizardId/confirm` | Write workspace to disk and add agent to config (admin) |
| `POST` | `/api/v1/agents/wizard/:wizardId/channel` | Verify bot token and generate pairing code (admin) |
| `POST` | `/api/v1/agents/wizard/:wizardId/channel/verify` | Poll for pairing code confirmation (admin) |
| `POST` | `/api/v1/agents/wizard/:wizardId/complete` | Skip channel and finalise wizard (admin) |
| `GET` | `/api/v1/apps/registry` | Browse community app registry (admin key) |
| `POST` | `/api/v1/apps/install` | Install app from registry, GitHub, or local path → `jobId` (admin) |
| `GET` | `/api/v1/apps/jobs/:jobId` | Poll install/update job status and logs |
| `GET` | `/api/v1/apps` | List installed apps |
| `GET` | `/api/v1/apps/:name` | Get app info |
| `DELETE` | `/api/v1/apps/:name` | Uninstall app (admin) |
| `POST` | `/api/v1/apps/:name/start\|stop\|restart` | Start/stop/restart app containers (admin) |
| `POST` | `/api/v1/apps/:name/update` | Blue-green update with auto-rollback → `jobId` (admin) |
| `GET` | `/app/:name/:portName/*` | Reverse proxy to installed app (no auth) |

**Wizard API** — create agents programmatically with the same flow as the interactive `make create-agent` terminal wizard. The wizard generates workspace files via Claude, writes them on confirm, and optionally pairs a Telegram/Discord bot. State is in-memory with a 30-minute TTL; nothing is written until `/confirm`. See [API.md](./API.md) for the full wizard flow.

See **[API.md](./API.md)** for full reference with request/response schemas and curl examples.

---

## App Store

Install Docker-compose apps on the gateway. Apps get a reverse-proxied HTTP endpoint, an optional Unix socket bridge for executing host scripts, and optional AI agent injection.

**Quick install from registry:**

```bash
curl -X POST http://localhost:10850/api/v1/apps/install \
  -H "X-Api-Key: <admin-key>" \
  -H "Content-Type: application/json" \
  -d '{"registry_app": "getpod-manager", "env_vars": {"API_KEY": "<secret>"}}'
```

**Poll until done:**

```bash
curl http://localhost:10850/api/v1/apps/jobs/<jobId> -H "X-Api-Key: <key>" | jq .status
```

**App is then live at** `/app/getpod-manager/<portName>/`.

Apps can also be installed from a GitHub URL (`github_url` + `commit`) or a local path (`local_path`) for development. Updates use a **blue-green swap with automatic rollback** — the old containers stay intact until the new version passes its healthcheck.

**Reverse proxy configuration:**

The gateway proxies `/app/:name/:portName/*` to the app containers. Two env vars control how the gateway reaches them:

| Env var | Default | Description |
|---------|---------|-------------|
| `GATEWAY_BIND` | `127.0.0.1` | Gateway HTTP listen address. Overrides the `gateway.bind` config field when set. Defaults to localhost-only; set to `0.0.0.0` when a **containerized** reverse proxy (Caddy, nginx in Docker) needs to reach the gateway across container boundaries. A **host-network** proxy (Traefik on host) can keep the localhost default. |
| `DOCKER_HOST` | _(system default)_ | Docker socket/TCP address. When set to `tcp://host:port` (e.g. DinD), the gateway automatically uses the host extracted from `DOCKER_HOST` to proxy to app containers instead of `127.0.0.1`. |

Example Caddyfile for apps behind Caddy in Docker:

```caddy
handle /app* {
    reverse_proxy dev-server:10850
}
```

(`handle`, not `handle_path` — preserve the `/app` prefix so the gateway's router can match it.)

See **[API.md — App Store section](./API.md#app-store-api)** for the full reference including `app.yaml` schema, `gateway_api` host-script bridge, and agent injection.

---

## File Structure

### Project

```
claude-gateway/
├── Makefile                            ← make start / create-agent / update-agent / pair / mcp-install
├── config.template.json                ← config template (source of truth for migration)
│
├── src/                                ← Gateway core (TypeScript, compiled to dist/)
│   ├── index.ts                        ← entrypoint — loads config, starts agents
│   ├── types.ts                        ← shared TypeScript types
│   ├── logger.ts                       ← structured logging with per-agent files
│   │
│   ├── agent/                          ← Agent management
│   │   ├── runner.ts                   ← session pool manager (spawn/evict sessions)
│   │   ├── workspace-loader.ts         ← assembles CLAUDE.md from workspace files + skills
│   │   └── context-isolation.ts        ← context guard for session isolation
│   │
│   ├── session/                        ← Session lifecycle
│   │   ├── process.ts                  ← single Claude subprocess per session
│   │   ├── store.ts                    ← persist/load conversation history (.jsonl)
│   │   └── compactor.ts               ← summarise + compact old history
│   │
│   ├── telegram/                       ← Telegram integration
│   │   ├── receiver.ts                 ← spawns TelegramReceiver subprocess per agent
│   │   └── markdown.ts                 ← markdown/HTML utilities
│   │
│   ├── api/                            ← HTTP API
│   │   ├── gateway-router.ts           ← HTTP server (/health, /status, /ui, /api)
│   │   ├── router.ts                   ← REST API router (sync + SSE streaming)
│   │   ├── auth.ts                     ← API key auth middleware (timing-safe)
│   │   └── cron-router.ts             ← Cron API router (auth + agent-scoped access)
│   │
│   ├── config/                         ← Configuration
│   │   ├── loader.ts                   ← load + validate config.json
│   │   ├── migrator.ts                 ← auto-migration for config schema changes
│   │   └── watcher.ts                  ← hot-reload config on file change
│   │
│   ├── cron/                           ← Cron scheduling
│   │   ├── manager.ts                  ← persistent cron job manager (REST + agentTurn)
│   │   └── scheduler.ts               ← heartbeat task scheduler
│   │
│   ├── heartbeat/                      ← Proactive tasks
│   │   ├── parser.ts                   ← parse HEARTBEAT.md YAML
│   │   └── history.ts                  ← track scheduled task execution
│   │
│   ├── skills/                         ← Agent skills system
│   │   ├── index.ts                    ← re-exports (parser, loader, invoker, watcher)
│   │   ├── parser.ts                   ← parse SKILL.md frontmatter + body
│   │   ├── loader.ts                   ← load skills from directories, build registry
│   │   ├── invoker.ts                  ← detect /skill-name in messages, inject context
│   │   └── watcher.ts                  ← hot-reload skills on file changes (chokidar)
│   │
│   ├── history/                        ← Persistent chat history (Layer 2)
│   │   ├── db.ts                       ← SQLite WAL + FTS5 history DB (pruneOlderThan, listChats, search)
│   │   ├── cleanup.ts                  ← daily retention scheduler (scheduleCleanup, resolveRetentionDays)
│   │   ├── media-store.ts              ← media file store with MIME allowlist and path traversal guard
│   │   └── types.ts                    ← HistoryMessage, ChatSummary, SessionSummary types
│   │
│   ├── memory/                         ← Long-term memory
│   │   └── manager.ts                  ← memory persistence
│   │
│   ├── webhook/                        ← Webhooks
│   │   └── manager.ts                  ← webhook event dispatch
│   │
│   └── ui/                             ← Dashboard
│       └── web-ui.ts                   ← live HTML dashboard
│
├── scripts/
│   ├── create-agent.ts                 ← interactive agent creation wizard (with channel selection)
│   ├── create-agent-prompts.ts         ← agent workspace generation prompts
│   ├── update-agent.ts                 ← update agent.md or manage channels (add/remove)
│   ├── interactive-select.ts           ← interactive selection UI helper
│   ├── pair.ts                         ← approve channel pairing (Telegram / Discord)
│   └── setup-claude-settings.js        ← enables channelsEnabled in Claude Code
│
└── mcp/                                ← MCP server (runs in Bun, separate node_modules)
    ├── package.json                    ← dependencies: grammy, @modelcontextprotocol/sdk
    ├── server.ts                       ← MCP entry point — registers all tool modules
    ├── types.ts                        ← ChannelModule / ToolModule interfaces
    ├── channel-manager.ts              ← module lifecycle (init, start, stop, restart)
    ├── router.ts                       ← route resolution + channel context rendering
    │
    └── tools/
        ├── telegram/                   ← Telegram channel module
        │   ├── module.ts              ← ChannelModule: telegram_reply, react, edit, download
        │   ├── receiver-server.ts     ← standalone receiver (polling mode, no MCP)
        │   ├── pure.ts               ← markdown → Telegram HTML conversion
        │   ├── typing.ts             ← typing indicator state
        │   └── skills/
        │       ├── access/SKILL.md        ← /telegram:access skill
        │       └── configure/SKILL.md     ← /telegram:configure skill
        │
        ├── cron/                       ← Cron tool module
        │   ├── module.ts              ← ToolModule: cron_list, create, delete, run, get_runs
        │   ├── client.ts             ← HTTP client for gateway cron REST API
        │   └── skills/
        │       └── cron/SKILL.md          ← /cron skill
        │
        └── skills/                     ← Skills tool module
            ├── module.ts              ← ToolModule: skill_create, skill_delete, skill_install
            └── handlers.ts            ← skill CRUD + URL install handlers
```

### Runtime data (`~/.claude-gateway/`)

```
~/.claude-gateway/
├── config.json                         ← gateway config
├── logs/
│   ├── alfred.log
│   └── warrior.log
├── shared-skills/                      ← shared skills (synced to ~/.claude/skills/ on boot and on change)
│   └── <skill-name>/
│       └── SKILL.md                    ← skill definition (same format as agent skills)
└── agents/
    └── alfred/
        ├── .env                        ← bot token (auto-created by wizard)
        ├── sessions/
        │   └── <chat_id>.jsonl         ← conversation history (SessionStore)
        ├── history.db                  ← SQLite chat history (Layer 2 — survives /compact)
        ├── history-cleanup.log         ← cleanup run log (max 1 MB, auto-rotated)
        ├── media/                      ← uploaded media files (served via /api/v1/agents/:id/media/*)
        └── workspace/
            ├── CLAUDE.md               ← auto-generated from workspace files, do not edit
            ├── AGENTS.md               ← agent identity, rules, capabilities
            ├── IDENTITY.md             ← name, emoji, avatar
            ├── SOUL.md                 ← tone, personality, speaking style
            ├── USER.md                 ← user profile and preferences
            ├── MEMORY.md               ← long-term memory (auto-appended)
            ├── HEARTBEAT.md            ← scheduled/proactive tasks
            ├── skills/                 ← agent-specific skills (hot-reloaded)
            │   └── <skill-name>/
            │       └── SKILL.md        ← skill definition with frontmatter
            ├── .sessions/              ← per-session MCP config
            │   └── <session_id>/
            │       └── mcp-config.json ← auto-generated MCP config for this session
            ├── .telegram-state/
            │   └── access.json         ← Telegram allowlist and pairing state
            └── .discord-state/
                └── access.json         ← Discord allowlist and pairing state
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

## Agent Skills

Skills are reusable capabilities defined as `SKILL.md` files with YAML frontmatter. They are injected into the agent's system prompt and can be invoked via `/skill-name` commands.

### Skill locations

| Location | Scope | Description |
|----------|-------|-------------|
| `workspace/skills/<name>/SKILL.md` | Per-agent | Agent-specific skills |
| `~/.claude-gateway/shared-skills/<name>/SKILL.md` | All agents | Shared skills — synced to `~/.claude/skills/` at boot and on change |
| `mcp/tools/<channel>/skills/<name>/SKILL.md` | All agents | Built-in channel skills (e.g. `/telegram:access`) |

### SKILL.md format

```yaml
---
name: my-skill
description: What this skill does
user_invocable: true          # false = system-only, not shown to user
argument_description: "[args]" # optional, shown in /skill-name [args]
---

Skill instructions go here. Claude follows these instructions
when the user invokes /my-skill.
```

### Runtime skill management

Agents can manage skills at runtime via MCP tools:

| Tool | Description |
|------|-------------|
| `skill_create` | Create a new skill in the workspace |
| `skill_delete` | Delete an existing skill |
| `skill_install` | Install a skill from a GitHub URL or raw URL |

Skills are **hot-reloaded** — changes to skill files are detected automatically and the skill registry is updated without restarting the session.

### Shared skills sync

Skills placed in `~/.claude-gateway/shared-skills/` are automatically synced to `~/.claude/skills/` — the user-level directory that Claude Code scans for every session:

- **At boot** — gateway copies all shared skills before spawning any agent
- **On change** — any add, edit, or delete under `shared-skills/` triggers a re-sync
- **Cleanup** — each synced skill is tagged with a `.shared` marker file; if a skill is removed from `shared-skills/`, the marker is used to delete the stale copy from `~/.claude/skills/` automatically (user-installed skills without the marker are never touched)

This means adding a skill to `shared-skills/` makes it available to **all agents** without per-agent setup or a gateway restart.

---

## Config Auto-Migration

When the config schema changes (new fields added in `config.template.json`), the gateway automatically detects and migrates your `config.json`:

- Preserves all existing values
- Adds missing fields with defaults from the template
- Migrates automatically on startup (no confirmation needed)
- Tracks schema version for future migrations

---

## Pairing New Users

New agents default to `dmPolicy: "allowlist"` with the orthogonal `pairing`
toggle **on**, so pairing works out of the box — no setup needed.

1. Ask the user to DM the bot — they receive a 6-character pairing code
2. Approve it:
   ```bash
   npm run pair -- --agent=alfred --code=abc123 --channel=discord
   ```
   (omit `--channel` or use `--channel=telegram` for Telegram)
3. The bot confirms pairing within 5 seconds
4. Lock down after everyone is paired (optional) — turn the pairing toggle off
   so unknown senders are dropped silently (the base policy is already
   `allowlist`):
   ```
   /gateway:discord-access dm-pairing off     # Discord
   /telegram:access pairing off               # Telegram
   ```

`pairing` is an **orthogonal on/off toggle**, not a `dmPolicy` value: the base
policy stays `open` | `allowlist` | `disabled`, and pairing layers on top of
`allowlist`. A legacy `access.json` with `"dmPolicy": "pairing"` is migrated
automatically on read to `{ dmPolicy: "allowlist", pairing: true }`.

To manage channels (add/remove Telegram or Discord) on an existing agent:
```bash
make update-agent   # choose "Manage channels"
```

---

## Channel Conditions & Limitations

Each channel gates inbound messages in two tiers — **DM/1:1** and **group** — and
each has platform-level conditions that must be met *before* the gateway ever
sees a message. If those aren't met the bot looks online but stays silent.

| Channel | Scope | Message reaches the bot when… | Access gate | Answers in group when… |
|---------|-------|-------------------------------|-------------|------------------------|
| **Telegram** | DM | always (long-polling) | `dmPolicy` + `pairing` → `allowFrom` | — |
| | Group | bot is **Admin**, or **Privacy Mode is OFF** + re-added; otherwise only `/cmd`, @mentions, replies | `groupPolicy` + `groupAllowlist` | `requireMention` false, or @mentioned/replied |
| **Discord** | DM | **Message Content Intent** enabled | `dmPolicy` + `pairing` → `allowFrom` | — |
| | Guild | **Message Content Intent** + **View Channel** + **Read Message History** | `groupPolicy` + `guildAllowlist` (+ optional `channelAllowlist`/`roleAllowlist`) | `requireMention` false, or @mentioned/replied |
| **LINE** | 1:1 | webhook delivered (valid signature) | `dmPolicy` | — |
| | Group/Room | webhook delivered + bot is a member | `groupPolicy` + `groupAllowlist` | `requireMention` false, or **native** @mention |

**Telegram limits**
- Exactly one process may poll a bot token — a second poller causes `409 Conflict`.
- Bot **commands are DM-only**; in groups they're silently dropped.
- Group **Privacy Mode is ON by default** — see [Telegram Groups](#telegram-groups). Admin status bypasses it; a Privacy-Mode change only applies after the bot is removed and re-added.
- Pairing codes: DM knocks reply the code privately; group knocks post the code in the group (needs a message that actually reaches the bot, i.e. Admin/Privacy-off).

**Discord limits**
- **MESSAGE CONTENT INTENT** is a privileged intent — without it message text arrives empty, so the bot can neither answer nor pair. Enable it in the Developer Portal.
- The bot needs channel permissions **View Channel**, **Read Message History**, **Send Messages** (+ **Create Public Threads** / **Send Messages in Threads** if `DISCORD_AUTO_THREAD=true`).
- `channelAllowlist` / `roleAllowlist` are backend-only filters (no web UI) applied after the guild gate.

**LINE limits**
- Inbound arrives via the Express **webhook**, not polling; the signature is verified over the **exact raw bytes**. Front it with the bun CORS proxy (see `/tunnel`) — never point cloudflared straight at the gateway, or chunked bodies break the signature and webhooks are dropped.
- Group/room `requireMention` uses LINE's **native mention** only (`mention.mentionees[].isSelf`). Typing the bot's name as plain text does **not** count, and `@All` does **not** count as a bot mention.
- Delivery is **reply-token-first (free) → push fallback (metered)**. The single-use reply token lives only ~1 min; after that, replies consume the OA's monthly push quota.
- Max **5 message objects** per reply/push request (the gateway auto-chunks to fit).

---

## Telegram Groups

The bot can respond in Telegram groups and supergroups. A group must be in the
agent's `groupAllowlist` before the bot will answer there.

### Delivery gotcha: Privacy Mode (read this first)

Telegram bots ship with **Privacy Mode ON** (`getMe` returns
`can_read_all_group_messages: false`). A privacy-mode bot only *receives*, inside
a group:

- messages that start with `/` (commands),
- messages that @mention the bot's username, and
- replies to the bot's own messages.

Everything else is filtered by Telegram **before it reaches the gateway** — the
bot looks online but never sees the message, so it can neither answer nor mint a
pairing code. On top of that, bot commands (`/start`, `/status`, …) are
**DM-only**: the receiver silently drops them in groups so pairing codes can't
leak to other members. Net effect in a default-privacy group: a plain message is
invisible and a command is dropped, so nothing happens.

Do one of these so the bot actually receives group messages:

- **Promote the bot to Admin in the group (easiest).** An admin bot receives
  every message regardless of Privacy Mode — no BotFather change, no re-add. Any
  admin role works, even the most restricted.
- **Disable Privacy Mode**, then **remove and re-add the bot** to the group (the
  new setting only applies on re-join): [@BotFather](https://t.me/BotFather) →
  `/setprivacy` → pick the bot → **Disable**.

### Register the group

Once the bot can receive group messages, add the group to `groupAllowlist` one of
two ways.

**Option A — pairing code (recommended).** With `groupPolicy: "allowlist"` and
`pairing: true` (both defaults), send any message in the group. The bot replies
with a 6-character code. Approve it from a gateway agent session:

```
/telegram:access pair <code>
```

That adds the group id to `groupAllowlist` (the code also lands in the agent's
`pending` as a `"kind": "group"` entry).

**Option B — edit `access.json` directly.** Get the group id by forwarding any
group message to [@userinfobot](https://t.me/userinfobot) — a negative number
like `-1001234567890` — then edit:

```
~/.claude-gateway/agents/<your-agent-id>/workspace/.telegram-state/access.json
```

```json
{
  "dmPolicy": "allowlist",
  "pairing": true,
  "allowFrom": ["..."],
  "groupPolicy": "allowlist",
  "groupAllowlist": ["-1001234567890"],
  "requireMention": true
}
```

`access.json` is re-read on every inbound message — changes take effect
immediately, no restart.

### Mention gate

`requireMention` is a single top-level boolean (default `true`):

- `true` — the bot answers in an allowlisted group only when @mentioned or
  replied to. This relies on Telegram delivering the @mention; if the bot ignores
  mentions, make it an Admin (see above).
- `false` — the bot answers **every** message in an allowlisted group. This only
  does anything if the bot can *see* every message, i.e. you also promoted it to
  Admin or disabled Privacy Mode.

Toggle it with `/telegram:access group mention <on|off>`.

> **Legacy schema note:** older docs showed a per-group `"groups": { "<id>": {…} }`
> map. That form is still accepted and auto-migrated on read to the flat
> `groupAllowlist` + top-level `requireMention` shown above, but new setups should
> use the flat schema. A per-group member restriction from the old schema is
> preserved under `legacyGroupAllowFrom`; there is no command to edit it.

---

## Telegram Commands

Bot commands are **DM-only** — sent in a group they are silently ignored (this
keeps pairing codes and session state from leaking to other members). Once
paired, the following commands are available in a private chat:

**Session management**

| Command | Description |
|---------|-------------|
| `/session` | Show current session info (name, message count, context %) |
| `/sessions` | List all sessions with inline keyboard — switch or delete |
| `/new <name>` | Create a new session, optionally with a name |
| `/rename <name>` | Rename the current session |
| `/clear` | Clear current session history (with confirmation) |
| `/compact` | Summarise old history and keep only recent messages |
| `/stop` | Interrupt the in-flight turn (gateway sends SIGINT to the subprocess) |
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

The gateway runs an HTTP server on port 10850 (set `PORT` env var to change, `GATEWAY_BIND` to set the bind address):

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
- Check logs in `~/.claude-gateway/logs/<id>.log`

**Agent not responding to messages**
- Verify `dmPolicy` in `access.json` — if `allowlist`, check the user's ID is in `allowFrom`
- Ensure no other process is polling the same bot token (causes 409 Conflict)
- Only `TelegramReceiver` polls Telegram — MCP session subprocesses run in `SEND_ONLY` mode (no polling)

**Bot silent in a Telegram group**
- The group must be in `groupAllowlist` — see [Telegram Groups](#telegram-groups). An empty `pending` after messaging usually means the message never reached the bot.
- Most common cause: **Privacy Mode** (default ON). A non-admin bot only receives commands, @mentions, and replies in groups — a plain message needed to mint the pairing code is filtered by Telegram. Promote the bot to Admin, or disable Privacy Mode in BotFather and re-add it.
- `/start` and other commands are dropped in groups by design — use a normal message (or an @mention) to trigger the pairing code.
- If `requireMention: true`, the bot only answers when @mentioned or replied to.

**Bot silent in a Discord server (guild)**
- Enable the **MESSAGE CONTENT INTENT** in the Discord Developer Portal (Bot settings) — without it the bot receives events but empty message text, so it can't respond or pair.
- The guild must be in `guildAllowlist` (`groupPolicy: allowlist`), and the bot needs **View Channel** + **Read Message History** in that channel.
- If `requireMention: true`, the bot only answers when @mentioned or replied to.

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
- Ensure `mcp/node_modules/` exists — run `make mcp-install` if not
- Check that `mcp-config.json` is generated in the session directory
- Verify Bun is installed (`bun --version`)

**Status messages not appearing in Telegram**
- First status update is sent after 5 seconds — very fast tasks may complete before it fires
- Check that the MCP server is running in `SEND_ONLY` mode for session subprocesses
- Verify the bot has permission to send messages in the chat
