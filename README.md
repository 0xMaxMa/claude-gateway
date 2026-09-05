
# Claude Gateway

A self-hosted multi-agent gateway for Claude Code — with agents that improve themselves, manage their own memory through nightly dreaming, and build a searchable knowledge base from what they learn.

<p align="center">
  <img src="resource/claude_gateway.svg" alt="Claude Gateway" width="680" />
</p>

---

## Features

- 🧠 **Skill self-improvement** — agents learn reusable skills from their own work: after a substantive turn a background reviewer creates or updates a skill, hot-reloaded for the next turn. Provenance-guarded (never overwrites human-written skills), capped per day, and audited to `SKILLS_LEARNED.md`. See [`gateway.skillLearning`](#gatewayskilllearning)
- 📚 **Knowledge base (two-lane memory)** — per-agent SQLite/FTS5 searchable archive exposed through `memory_search` / `memory_get` MCP tools, so agents recall notes that don't fit the always-injected core; chunks carry fail-closed provenance and the index is refreshed off the gateway event loop. See [`gateway.knowledge`](#gatewayknowledge)
- 🌙 **Nightly dreaming** — background consolidation of long-term memory: a print-only reviewer proposes ops that a safe applier writes to `MEMORY.md` / `USER.md` (backup, bounded-loss, net-negative when over budget). Deterministic compaction, budget-scaled pruning, and staleness GC keep memory near budget without forgetting — archived entries stay searchable. See [`gateway.dreaming`](#gatewaydreaming)
- 🤖 **Multi-agent** — run multiple bots from a single gateway, each with isolated sessions
- 🔌 **Multi-channel MCP** — modular tool system per channel (Telegram, Discord, LINE, Slack, Cron, Skills, extensible to more)
- 🧩 **Agent skills** — extensible skill system via SKILL.md files; agents can create, delete, and install skills from URLs at runtime with hot-reload
- 🎭 **Agent identity** — define personality, tone, and rules via workspace markdown files
- 📡 **Live status messages** — real-time status updates showing tool usage, thinking, and progress
- ⌨️ **Typing indicators** — continuous typing animation while the agent is working (Telegram and Discord)
- 🌊 **Streaming API** — SSE (Server-Sent Events) endpoint for real-time response streaming
- ↪️ **Auto-forward** — agent text output automatically forwarded to Telegram even without explicit reply tool calls
- ⏰ **Heartbeat / scheduled tasks** — cron-based proactive messages and recurring tasks via HEARTBEAT.md + REST API; agent jobs deliver output to Telegram, Discord, or both
- 💬 **Persistent chat history** — two-layer storage: session context (`.jsonl`) + permanent SQLite DB with FTS5 full-text search; survives `/compact` and session eviction
- 🧹 **Auto-cleanup** — configurable retention policy prunes messages and media files older than N days on a daily schedule
- 🗄️ **Long-term memory** — persistent memory system across sessions
- 🔄 **Config auto-migration** — automatic schema migration when config format changes
- 🔐 **Access control** — allowlist, open, or pairing-based Telegram access policies
- 🌐 **HTTP API** — REST API with key-based auth for external integrations
- 🛍️ **App Store** — install, update, and host Docker-compose apps on the gateway; apps get a reverse proxy at `/app/:name/:portName/*`, optional Unix socket bridge for host scripts, and optional AI agent injection
- ⬆️ **Self-update** — check for newer versions of `claude-gateway` and `claude-code` and trigger an update via a single API call (no SSH or shell access needed), or from the terminal with `claude-gateway update` / `claude-gateway claude update`
- 💾 **Session persistence** — conversation history saved and restored across restarts
- 🖥️ **PTY shell (wrap-shell mode)** — optional interactive pseudo-terminal backend (`gateway.headless: false`) for tools that require a real TTY; includes a live browser viewer (xterm.js) and a `/api/v1/sessions/:sessionId/screen` endpoint that returns the visible screen as plain text — agents can poll it to detect hang states, menus, or unexpected output without parsing ANSI escape codes; a `/cli` chat command (Telegram/Discord/LINE) opens the same viewer for a single agent, agent-scoped and without an admin key; app-agents always stay headless

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

**3. Start**

```bash
claude-gateway gateway start
```

`claude-gateway` on its own prints help — starting the server is always the explicit
`gateway start`, so a stray or mistyped command can never leave a gateway listening.

No config file needed — on first run, if `~/.claude-gateway/config.json` doesn't exist yet, the gateway creates it automatically with `"agents": []` and a fresh random admin API key, and prints that key once:

```
[gateway] No config found — created one at ~/.claude-gateway/config.json
[gateway] Admin API key (save this now — it will not be shown again):
[gateway]   <random-hex-key>
[gateway] The CLI (claude-gateway agents create, etc.) picks this up automatically from ~/.claude-gateway/config.json.
```

Save that key somewhere safe — it isn't shown again (though you can always read it back from `config.json` on disk). See [`config.template.json`](config.template.json) for the full config format (models list, more options) if you want to customize it by hand later.

**4. Create an agent**

```bash
claude-gateway agents create
```

Interactive wizard — describe the agent, Claude generates the workspace files, review and accept them, then optionally connect a Telegram or Discord bot. Hot-reloads immediately, no restart needed. The CLI picks up the admin key from `config.json` automatically — no need to pass `--key`. (You can also add an agent entry to `config.json` by hand instead — same template link as above.)

**Run as a service (optional)**

To keep the gateway running after you log out or the machine reboots, let the CLI install the
service for you. It shows the exact unit it will write, asks before installing, and verifies
`/health` afterwards:

```bash
claude-gateway service install              # systemd *user* unit — no sudo
claude-gateway service install --print      # just show what it would install
claude-gateway service status
claude-gateway service uninstall            # asks first — this stops a running gateway
```

Install and uninstall both prompt before acting; pass `--yes` in scripts (without it, a
non-interactive run is refused rather than left hanging). Always stop the gateway through
`service uninstall` or `systemctl --user stop claude-gateway.service` — a bare `kill <pid>` bypasses
systemd's own stop tracking, so `Restart=always` brings it right back regardless of exit code.

`install`'s exit code distinguishes three outcomes: `0` fully healthy, `1` install/enable itself
failed or a validation/confirmation gate refused (nothing was written), `2` install/enable
succeeded but `/health` never answered within the poll window. A script that only checks the exit
code — not the JSON result on stdout — can still tell "didn't happen" apart from "happened, health
unconfirmed" this way.

`install` also refuses (rather than just warning) if a `claude-gateway.service` unit already
exists and is enabled or active at *system* scope (e.g. one written by provisioning outside this
CLI) — installing a second, independent unit alongside it would race for the port on the next
reboot. It prints the exact `sudo systemctl disable --now claude-gateway.service` to resolve it;
pass `--force` to install anyway.

The systemd path writes `~/.config/systemd/user/claude-gateway.service`. Run
`loginctl enable-linger $USER` once if it must keep running while you're logged out.
The unit sets `OOMPolicy=continue` so that an OOM-killed child process (e.g. a dev server an
agent spawned on its own) doesn't take the whole gateway down with it — only `Restart=always`
restarting the *gateway's own* process is intended. Re-running `claude-gateway service install`
against an already-active unit whose rendered content changed (a newer CLI version, or different
flags) automatically restarts it via `systemctl ... restart`, so the update takes effect
immediately; re-running with unchanged content leaves the running unit alone.
Prefer [PM2](https://pm2.keymetrics.io)? `claude-gateway service install --manager pm2` registers
and saves the process instead (run `pm2 startup` separately for boot-time start).

**System-scope installs (for automated/infra provisioning)**

Pass `--scope system` to install a root-owned unit at `/etc/systemd/system/claude-gateway.service`
instead — for provisioning that needs the gateway to run under a fixed system account rather than
whoever happens to run the install interactively. It requires:

```bash
sudo claude-gateway service install --scope system --run-as gwuser --yes
```

- The caller must already be root — `--scope system` never escalates via `sudo` on its own, and
  refuses immediately if it isn't.
- `--run-as <user>` is required and becomes the unit's `User=`; `WantedBy=` is
  `multi-user.target` instead of `default.target`, so it starts at boot regardless of any login
  session (the `loginctl enable-linger` hint is skipped — it's meaningless here).
- `WorkingDirectory=`/`HOME=`/the config path all resolve to `--run-as`'s own home directory
  (looked up via `getent passwd`, not the installing root process's home) — the unit runs as that
  user, so its paths must be theirs. A `~/...` in `--config`/`--env-file` expands against that same
  home. `$GATEWAY_CONFIG` from the installing (root) process's own environment is **not** consulted
  for a system-scope install — only an explicit `--config` is — since it belongs to root's
  environment, not `--run-as`'s. If the user's `~/.claude-gateway` doesn't exist yet, the install
  creates it and `chown`s it to them; if it already exists but is owned by someone else (e.g. a
  prior install used a different `--run-as`), ownership is reassigned to match. An
  already-correctly-owned directory is left untouched. Refuses if `--run-as` doesn't resolve to a
  real user on this host.
- A system-scope install never refuses itself over the system-scope conflict check described
  above — that check exists to protect a *user*-scope install from colliding with an externally
  provisioned system-scope unit, and a system-scope install *is* that unit.
- `--after <target1,target2>`, `--env-file <path>`, and `--env KEY=VALUE[,KEY=VALUE...]` further
  customize the generated unit (both scopes): extra `After=` ordering targets, an
  `EnvironmentFile=-<path>` for feeding secrets in without ever writing them into the unit text,
  and additional non-secret `Environment=` lines. `--env` refuses to override `HOME`, `PATH`, or
  `GATEWAY_CONFIG` (the installer's own reserved names) — use `--env-file` for anything sensitive.
- `service status --scope system` and `service uninstall --scope system` work the same way against
  the system-scope unit (uninstall also requires root).

Once installed, drive it through the CLI — it detects whichever manager owns the process:

```bash
claude-gateway gateway status   # manager, URL, health
claude-gateway gateway restart
claude-gateway gateway stop
claude-gateway gateway logs     # tail the gateway's own log (works even when it is dead)
```

Managing PM2 directly still works too:

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

### Start the gateway

```bash
npm start
```

Config is auto-loaded from `~/.claude-gateway/config.json` — if it doesn't exist yet, `npm start` creates it automatically with `"agents": []` and a fresh admin key (see the Start step in the npm-install path above). Bot tokens are auto-loaded from `~/.claude-gateway/agents/<id>/.env`.

### Create an agent

The interactive wizard handles everything — workspace files, bot token, and pairing:

```bash
claude-gateway agents create
```

Steps:
1. Choose an agent id and describe its role — Claude generates workspace files
2. Review and accept the generated files
3. Optionally connect a channel: **Telegram** or **Discord** — paste the bot token, wizard verifies it automatically
4. Agent hot-reloads immediately — send any message to the bot, then approve pairing:
   ```bash
   claude-gateway channels approve --agent <id> --channel telegram --code <code>
   ```

To manage an existing agent — regenerate `AGENTS.md`, or connect/update/disconnect Telegram, Discord, LINE, or Slack — run `claude-gateway agents update`.

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
    "logs": {
      "level": "info",
      "maxFileBytes": 16777216,
      "maxFiles": 3,
      "retentionDays": 14
    },
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

### `gateway.publicUrl` (optional)

The externally reachable gateway base URL. Set it manually to enable short-lived
public file shares used by `generate_image` reference edits and `share_file`
(formerly `share_image`, which still works as a deprecated image-only alias).
The URL must end in `/gateway`; changing it requires a gateway restart.

```json
{
  "gateway": {
    "publicUrl": "https://vm.example.com/gateway"
  }
}
```

Minted share URLs have the stable form
`https://vm.example.com/gateway/shared/TOKEN`. When `publicUrl` is set the mint
response includes this ready-built `url`; when it is unset the response still
returns the `token` (the share endpoint stays enabled) and callers with their own
public base — e.g. LINE, which derives its host from the inbound webhook — build
`<base>/shared/<token>` themselves. HTTP is accepted only for local development
hosts such as `http://host.docker.internal:10850/gateway`.

### `gateway.oauthReturnUrl` (optional)

Where to send the browser after a connector OAuth sign-in finishes. The gateway is
product-agnostic and never hardcodes a downstream app's domain, so this is opt-in.

```json
{
  "gateway": {
    "oauthReturnUrl": "https://app.example.com/settings/connectors"
  }
}
```

Set, the callback issues a real `302` to it on **every** terminal outcome — success, and
also a denied, expired or failed sign-in, which carries `?connector_oauth_error=<code>`.
Unset, the callback renders a plain "Connected — you can close this tab" page instead.
The value is validated once at startup: anything that isn't a well-formed `http(s)` URL
is logged and ignored rather than injecting a broken redirect into every future callback.
The scheme is part of that check — this value becomes the `Location` of a redirect sent
to the end user's own browser from a public route, so a `javascript:` or `data:` URL
here would be script running on every sign-in, and is refused like any other malformed
value.

### `gateway.customConnectors` (optional)

User-pasted MCP connectors, keyed by a slugified id. Normally written through the API
(`POST /api/v1/connectors/custom`) rather than by hand.

```json
{
  "gateway": {
    "customConnectors": {
      "firecrawl": {
        "label": "Firecrawl",
        "config": {
          "type": "streamable-http",
          "url": "https://mcp.firecrawl.dev/v2/mcp-oauth",
          "headers": { "Authorization": "Bearer {access_token}" }
        },
        "secretNames": ["access_token"],
        "credentialOwner": "gateway"
      }
    }
  }
}
```

Each entry is raw `mcpServers`-entry JSON with `{placeholder}` tokens standing in for
secrets. `credentialOwner` records who holds the credential and keeps it valid — `none`,
`static` (a pasted value), `gateway` (this gateway ran the OAuth flow and refreshes the
token itself) or `external` (a control plane pushes tokens in). It is written by the
route that creates the entry; see [API.md](./API.md#connectors-api). **Only the placeholder names are stored here** — the values live in
`~/.claude-gateway/mcp-token.env` (mode `0600`), namespaced
`CUSTOM__<connectorId>__<placeholderName>`, and are substituted in when a session spawns.
Override that file's path with `GATEWAY_MCP_TOKEN_ENV_PATH`.

Custom connectors are **admin-trusted but not code-reviewed** — the config is whatever
the admin pasted, and it becomes an MCP server in every agent's session. Per-agent
enablement is opt-out and lives on the agent instead (`PATCH /api/v1/agents/:id` with
`connectors`); connecting a connector at all is the security gate. See
[API.md](./API.md#connectors-api) for the full model, the OAuth flow, and the refresh
behaviour.

### `gateway.connectorsDefaultEnabled` (optional)

Whether a connected connector is available to an agent that has no explicit entry in its
own `connectors` map. Defaults to `true` — opt-out: connecting a connector makes it
available everywhere, and an agent only misses it if explicitly disabled.

```json
{
  "gateway": {
    "connectorsDefaultEnabled": false
  }
}
```

Set it to `false` on a gateway that hosts agents for **more than one person**. The default
suits the common single-operator install, but with several owners it hands a credential
connected by one of them to every agent on the box — including agents whose chat users are
not that person. With `false`, each agent has to be opted in explicitly (`PATCH
/api/v1/agents/:id` with `{"connectors": {"<id>": {"enabled": true}}}`).

Changing this affects the next session spawn, like any other connector change.

### `gateway.logs` (optional)

Verbosity, rotation and retention for the files in `logDir`. The whole block is optional —
omit it and the defaults below apply.

| Field | Default | Description |
|-------|---------|-------------|
| `level` | `"info"` | Minimum level written, to both the file and stdout. One of `debug`, `info`, `warn`, `error` |
| `maxFileBytes` | `16777216` (16 MiB) | Rotate `<name>.log` to `<name>.log.1` once an append would carry it past this size |
| `maxFiles` | `3` | Rotated generations kept per stream; the oldest is deleted. Lowering it collects the generations it orphans at the next rotation. `0` = keep none |
| `retentionDays` | `14` | Delete logs (live and rotated) older than this, at boot and once a day. `0` = keep forever |

`level` is the one that governs disk usage. Session processes log every stream event at `debug`,
which on a live host measured 19,995 `debug` lines to 5 `info` lines inside a single 217 MB file —
so `debug` is off by default. Set `"level": "debug"` when you are actually chasing something, and
expect the directory to grow quickly while it is on. Rotation and retention bound what is *kept*;
only the level bounds what is *written*.

Retention is age-based because each session writes its own `<agent>:session:<uuid>.log` and never
returns to it — `maxFiles` prunes generations of one stream, so it can never reach them.

This block is **hot-reloaded**: edit it in `config.json` and it applies on the next config reload,
no restart. That matters because turning the level up is something you do while chasing a live
problem, and a restart would kill the sessions you are trying to observe.

### `session`

| Field | Default | Description |
|-------|---------|-------------|
| `idleTimeoutMinutes` | `30` | Kill idle session subprocess after N minutes of inactivity. Inactivity means no incoming message **and** no subprocess output — a session actively producing output (e.g. a self-paced `/loop`) is not treated as idle |
| `maxConcurrent` | `20` | Max simultaneous active sessions per agent; oldest idle is evicted when exceeded |

### `gateway.history` (optional)

Global default retention policy. Can be overridden per-agent with an `history` key inside the agent config.

```json
{
  "gateway": {
    "history": {
      "retentionDays": 90,
      "maxHistoryMessages": 30,
      "cleanupHour": 3,
      "cleanupTimezone": "Asia/Bangkok"
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `retentionDays` | `null` (keep forever) | Delete messages older than N days on each cleanup cycle |
| `maxHistoryMessages` | `50` | Max history messages re-injected into a session at spawn. Lower it to shrink the context loaded at session start. `0` = inject no history |
| `cleanupHour` | `3` | Hour of day to run cleanup (24h, in `cleanupTimezone`) |
| `cleanupTimezone` | `"UTC"` | IANA timezone for the cleanup schedule |

Per-agent override example:
```json
{
  "agents": [
    {
      "id": "alfred",
      "history": { "retentionDays": 30, "maxHistoryMessages": 30 }
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
| `pairing` | New users DM the bot to receive a pairing code; approve with `claude-gateway channels approve` |

### `gateway.headless`

Controls the Claude subprocess backend for all non-app agents.

| Value | Backend | Description |
|-------|---------|-------------|
| `true` *(default)* | Headless (`--print`) | Stateless invocation, lowest overhead |
| `false` | PTY shell wrapper | Interactive pseudo-terminal — full TUI support |

**App-agents always run headless** regardless of this setting.

`--dangerously-skip-permissions` is always injected by the gateway automatically — there is no per-agent config field for it.

In PTY mode that flag makes Claude Code open a "Bypass Permissions mode" confirmation dialog at startup, which the wrapper accepts on your behalf. How it is accepted depends on the Claude Code build: releases up to **2.1.247** render numbered options (`1. No, exit` / `2. Yes, I accept`) and are accepted with the digit, while **2.1.248 and newer** drop the numbers, so the wrapper walks the caret onto the accept row and only then presses Enter. If a future release changes the dialog beyond what the wrapper recognises, it deliberately sends **no** keystroke and leaves the dialog on screen rather than risk selecting "No, exit" (which would exit Claude Code) — set `PTY_SHELL_SKIP_DIALOG_DISMISS=1` to turn the auto-accept off entirely.

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

### `gateway.skillLearning`

Controls [skill self-improvement](#skill-self-improvement) — agents learning reusable skills from their own work. Telemetry capture is always on; the reviewer/writer/curator honor `enabled`.

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch for the reviewer/writer/curator (telemetry is captured regardless) |
| `mode` | `"auto"` | `auto` writes skills directly; `propose` queues them for approval instead |
| `minToolCalls` | `5` | Minimum tool calls in a turn before it's eligible for review |
| `reviewModel` | `claude-haiku-4-5-…` | Model used for the background review pass |
| `maxAutoSkills` | `50` | Cap on the number of non-pinned `origin: auto` skills kept per agent (pinned skills are never evicted and don't count toward the cap) |
| `maxAgeDays` | `30` | Curator prunes auto-skills older than this (with too few uses) |
| `minUsesToKeep` | `2` | Auto-skills used fewer times than this are prune candidates |
| `maxReviewsPerDay` | `20` | Per-day cap on background review runs |
| `pruneHour` / `pruneTimezone` | `3` / `UTC` | When the daily curator runs |
| `notify` | `true` | Push a per-write ping to every configured channel (see [notifications](#skill-self-improvement)); the `SKILLS_LEARNED.md` diary is written regardless |

```json
{
  "gateway": {
    "skillLearning": {
      "enabled": true,
      "mode": "auto",
      "notify": true
    }
  }
}
```

Per-agent overrides are supported under the agent's own `skillLearning` block; unset fields fall back to the gateway default.

### `gateway.memory`

Memory budget discipline. Self-authored memory files (`MEMORY.md`, `USER.md`) that exceed a **soft** char budget get a loud over-budget banner prepended to their `CLAUDE.md` section at compose time — instead of a silent `[TRUNCATED]` — nudging the agent to consolidate. The banner reaches the agent on its next spawn (frozen-at-spawn, no restart) and self-heals once the file is back under budget. The banner lives only in the composed `CLAUDE.md`; the source file on disk is never rewritten with it.

| Field | Default | Description |
|-------|---------|-------------|
| `memoryBudgetChars` | `8000` | Soft budget for `MEMORY.md` (`0` = disabled) |
| `userBudgetChars` | `3000` | Soft budget for `USER.md` (`0` = disabled) |
| `overBudget` | `"warn"` | Banner severity: `warn` (⚠️) or `error` (🛑, stronger wording); an unknown value falls back to `warn` |
| `writeRouting` | `true` | Inject the **two-tier write contract** into the Memory Rule (`MEMORY.md` = durable facts; task-log → `memory/<topic>.md`) and let nightly dreaming route episodic ops out. `false` = kill-switch (exact pre-routing behavior) |
| `episodicArchiveDir` | `"memory"` | Workspace-relative dir episodic notes are written under (validated, path-traversal-guarded) |

```json
{
  "gateway": {
    "memory": {
      "memoryBudgetChars": 8000,
      "userBudgetChars": 3000,
      "overBudget": "warn",
      "writeRouting": true,
      "episodicArchiveDir": "memory"
    }
  }
}
```

The soft budget sits well under the hard per-file limit (still applied as a context safety net); the banner is the primary over-budget signal for memory files.

**Write routing (planning-65).** `MEMORY.md` is injected into every prompt, so it should hold only **durable semantic facts** (preferences, standing rules, identity, lessons). **Episodic task-log** (completed work, PR/issue status, dated events) belongs in `memory/<topic>.md` — indexed and retrieved on demand via `memory_search`, never carried in-prompt. When `writeRouting` is on, the Memory Rule states this tier contract to the agent, and the nightly dreaming reviewer may emit `tier:"episodic"` ops that the applier appends to `memory/<topic>.md` (slug-validated + realpath-confined; a memory-only change ⇒ no session restart). To drain an existing over-budget `MEMORY.md`, run the one-shot migration `node dist/agent/dreaming/migrate-cli.js <workspaceDir> [--apply]` — a deterministic terminal sweep (compactor) plus a gated episodic route-out (`propose` writes `.dreaming/migration-plan.md`; `--apply` performs the moves). Pinned sections (`## User`, `## Feedback`, `## Preferences`) are never moved, and every relocated entry stays searchable via `memory_search` (recall preserved). **planning-67:** with `gateway.dreaming.autoRouteOut` on (the default), the nightly dream performs this same route-out **automatically** whenever `MEMORY.md` is over budget — no manual per-agent run — and every over-budget net-shrink `remove` now **relocates** its block to `memory/archive/pruned.md` (searchable) before cutting it, so no dream op ever silently forgets.

### `gateway.dreaming`

Nightly memory **dreaming** — background consolidation of an agent's long-term memory. A print-only `claude -p` reviewer (no tools, no `--dangerously-skip-permissions`) reads a lookback window of the agent's own session transcripts and proposes memory-consolidation ops. In **`auto`** mode (the default) a safe applier writes the ops to `MEMORY.md`/`USER.md` (rollback pre-image first; ordered apply with anchor re-resolution; bounded-loss + append-only fallback; net-negative when over budget) — a memory-only change, so no session is restarted. In **`propose`** mode the proposals are written **only** to a `DREAMS.md` diary + JSONL audit under `<workspace>/.dreaming/` — no memory file is modified (set `mode: "propose"` to keep this dry-run behavior).

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch (`false` ⇒ no scheduler, no run) |
| `mode` | `"auto"` | `auto` = apply ops via the safe applier (backup, bounded-loss, net-negative); `propose` = diary-only dry-run |
| `dreamHour` / `dreamTimezone` | `3` / `UTC` | When the nightly dream runs (invalid tz → UTC) |
| `dreamMinute` | `0` | Minute-of-hour the dream fires at, paired with `dreamHour` (0–59). Set with `staggerWindowMinutes: 0` to fire at an exact `HH:MM` (e.g. for a controlled re-test) |
| `quietMinutes` | `30` | Skip a run if a session was active within this window |
| `lookbackDays` | `3` | How far back to scan sessions |
| `maxChangesPerRun` | `3` | Cap on proposed ops per run (`0` ⇒ no-op) |
| `reviewModel` | `claude-haiku-4-5-…` | Cheap model for the reviewer |
| `promotionThreshold` / `minRecallCount` | `0.6` / `2` | Scoring thresholds for promoting a fact |
| `autoRouteOut` | `true` | planning-67: in `auto` mode, drain an **over-budget** `MEMORY.md` by routing its episodic task-log to `memory/<topic>.md` automatically each night (archive-safe, pinned excluded, idempotent) instead of a manual per-agent `migrate-cli`. `false` = kill-switch |
| `staggerWindowMinutes` | `30` | planning-68: spread agents' nightly runs across a window (a deterministic per-agent jitter is added to the delay) so they don't all fire at `dreamHour:00` together. Clamped `[0,55]`; `0` = disabled (all fire at `dreamHour:00`) |
| `staleness` | *(object)* | Archive staleness GC sub-config (planning-66) — see below |

Per-agent overrides are supported under the agent's own `dreaming` block; unset fields fall back to the gateway default. `enabled:false` or `maxChangesPerRun:0` makes a run a no-op.

> **⚠️ Upgrade note:** the default `mode` for both `gateway.dreaming` and `gateway.knowledge.shared` changed from `propose` (dry-run) to `auto` (configVersion 1.0.24). Once the K4 applier landed (backup + net-negative + bounded-loss + CAS + never-empty; memory-only write ⇒ no session restart), `auto` became the intended default: nightly dreaming now applies consolidation to `MEMORY.md`/`USER.md` and promotes durable memories to the shared vault. Like the `gateway.bind` migration, the migrator upgrades the *retired* `propose` default to `auto` once and logs a one-time warning; an explicit `mode` you set at 1.0.24+ is never touched. To keep dry-run, set `mode: "propose"` explicitly.

**Keeping `MEMORY.md` near budget (`auto` mode).** Two mechanisms stop the on-disk `MEMORY.md` from growing unbounded while preserving recall:

- **Deterministic compaction** — before the LLM reviewer, every `auto` run moves completed/terminal log entries out of `MEMORY.md` into `memory/archive/completed.md`, leaving a one-line pointer. It is **domain-agnostic** (not just dev): an entry is archived when its lead line carries an explicit done marker — an UPPERCASE status word (`DONE`, `COMPLETED`, `RESOLVED`, `CLOSED`, `CANCELLED`, `ARCHIVED`, `MERGED`, `SUPERSEDED`, `OBSOLETE`, `DEPRECATED`, `EXPIRED`, `SHIPPED`, `FINISHED`), a checked task box `[x]`, a ✅, or a ~~strikethrough~~ — and it works on both list bullets and `###` entry headers. The archive lives under `memory/` so it is still indexed and **searchable via `memory_search`** — the agent recalls completed work on demand instead of carrying its full changelog in-prompt. It is conservative (uppercase words only, so prose like "Closes #123", "we're not done", or an unchecked `[ ]` box is never archived), idempotent, and never drops an open/active item.
- **Budget-scaled pruning** — when `MEMORY.md` is over its soft budget, the reviewer is put in an explicit net-shrink mode (propose only length-reducing ops) and `maxChangesPerRun` scales up **for removals** (the add cap stays tight), so an over-budget file converges toward budget instead of trickling at a few edits per night.
- **Archive staleness GC (`gateway.dreaming.staleness`, planning-66)** — a deterministic pass that runs next to the compactor (auto mode) to keep the Lane-2 archive's **search quality** high. This is a **search-quality fix, not a prompt-budget one**: planning-65 already moved task-log off the injected prompt, so the point here is that `memory_search` should keep surfacing *current* truth instead of stale/superseded facts. Each nightly run **soft-invalidates** archive entries — superseded ones (a deterministic `supersedes/replaces/obsoletes #N` match, which finally populates the previously-inert `supersedes_key`) and aged-out ones (idle-since-last-**retrieval** past `staleTtlDays` and retrieved fewer than `minRetrievalKeep` times) — by **moving** them to `memory/archive/stale.md` and stamping `invalid_at`. It **never deletes**: a staled entry stays under `memory/` so it is still indexed and **searchable** (ยุบได้แต่ไม่ลืม). An entry that is **retrieved after** it was invalidated is **promoted back** to the active archive (the recall feedback loop — proof we aged it out too soon). Recall is fed by an append-only read-path log (`kb_retrieval_log`, gated by `recordRetrievals`) that the GC folds into each entry's `last_retrieved`. High-importance entries (`keepImportance`) and **pinned** files (`memory/pinned/**`) are never aged out; evergreen Lane-1 (`MEMORY.md`/`USER.md`) is structurally excluded. Every move is CAS-guarded with a timestamped backup, and — being a memory-only write — drops **no live session**. One run may soft-invalidate at most `staleness.maxInvalidationsPerRun` entries (default `50`), oldest-idle first, with the remainder resuming on later runs — aging is wall-clock driven, so without a ceiling the first run after anything that widens the GC's visibility (such as backfilling lifecycle rows for previously invisible sources) would relocate every already-expired entry in one night. Restores are never capped. Kill-switches: `staleness.enabled:false` (GC no-ops), `maxInvalidationsPerRun:0` (never invalidates, still restores) and `recordRetrievals:false` (age falls back to first-seen only).

### `gateway.knowledge`

**Two-lane memory** — a per-agent searchable knowledge archive so an agent can recall what does not fit in the always-injected core. A SQLite/FTS5 index (`agents/<id>/kb.sqlite`, built on Node's built-in `node:sqlite` — no new dependency) covers the agent's `memory/*.md` notes plus the evergreen `MEMORY.md`/`USER.md`. Every chunk is tagged with **fail-closed provenance** (`owner`/`agent`/`untrusted`/`system`; unclassified ⇒ `untrusted`). The index is refreshed by a detached subprocess at session spawn, entirely **off the gateway event loop**.

Two read-only MCP tools expose it to the agent: **`memory_search`** (keyword/FTS5 → ranked snippets with file+line, provenance, importance) and **`memory_get`** (bounded, path-traversal-guarded excerpt of a memory-scoped file). When `MEMORY.md` grows past its `gateway.memory` soft budget, compose injects a compact **auto-generated section index** + a pointer to `memory_search` instead of the truncated full text (**core-shrink**) — the on-disk file is never modified and its full content stays searchable. Whenever the archive is on, a short `--- MEMORY RETRIEVAL ---` note is also injected into every agent's system prompt so the tools stay discoverable at all times (not only when the file is over budget).

| Field | Default | Description |
|-------|---------|-------------|
| `archive.enabled` | `true` | Master switch (`false` ⇒ complete no-op, no DB created, no core-shrink) |
| `archive.tokenizer` | `"unicode61"` | FTS5 tokenizer (`"trigram"` for CJK/Thai) |
| `archive.chunkTokens` | `400` | Target chunk size in ~tokens |
| `archive.chunkOverlap` | `80` | Overlap between chunks (clamped below `chunkTokens`) |
| `shared.enabled` | `true` | Enable the cross-agent shared KB |
| `shared.project` | `"global"` | Sharing partition key (one safe path segment) — agents with the same value share one vault; `"global"` ⇒ shared-by-default |
| `shared.root` | `~/.claude-gateway/shared/kb` | Shared vault root dir (`<root>/<project>/`) |
| `shared.mode` | `"auto"` | Per-agent→shared promotion mode; `auto` = promote durable dreamed facts, `propose` = dry-run |
| `shared.graph` | `false` | Compile the memory-wiki graph + dashboards over the shared vault to `<vault>/reports/*.md` (opt-in). Independent of the dashboard **Knowledge base** tab, which computes its graph on-demand |
| `shared.staleness` | *(object)* | Shared-note TTL lifecycle GC; uses the same fields/defaults as `dreaming.staleness` (whole notes only; no numeric `supersedes #N` syntax) |
| `reflection.enabled` | `true` | Enable the singleton, per-shared-vault reflection scheduler (daily timer; see cadence note below) |
| `reflection.dayOfWeek` / `hour` / `minute` / `timezone` | `0` / `4` / `0` / `UTC` | `hour`/`minute` is the **daily** staleness-GC slot; `dayOfWeek` selects the weekday that additionally runs LLM consolidation (Sunday 04:00 UTC by default; invalid timezone falls back to UTC) |
| `reflection.maxClustersPerRun` / `reviewModel` | `5` / `claude-haiku-4-5-…` | Hard cap on changed linked-note clusters per consolidation run and the bounded synthesis model |

**Shared KB.** A shared SQLite/FTS5 vault outside any single agent's workspace lets agents build a common knowledge base. Notes under `<root>/<project>/notes/*.md` are indexed and reachable via `memory_search` with `corpus:"shared"` (the shared vault) or `corpus:"all"` (this agent's memory + shared, merged by relevance). Concurrent writers are safe without a lock — atomic note writes (temp+rename) plus a cross-process `PRAGMA busy_timeout` on the index. Per-agent overrides under the agent's own `knowledge` block. The MCP layer runs under Bun, so the read tools query `kb.sqlite` via `bun:sqlite`. Two write paths feed the vault, sharing one freeform-name namespace (issue #386, no agent-id prefix, no ownership scoping): the nightly dreaming promoter (gated by `mode:"auto"`; it promotes only content that carries a real fact — content that is nothing but `MEMORY.md` index-pointer bullets is skipped, since those links resolve only inside the promoting agent's own workspace — and names each note after the proposal's `topic` slug when the reviewer supplied one, falling back to its `reason`, so a recurring fact updates the same note across nights instead of piling up near-duplicates; a fallback name that reads as an editing instruction rather than the name of a fact is passed over, and the note is named from the fact itself instead — the promotion is only abandoned when nothing nameable remains, and every skip is logged — including a write the note-size cap refuses and an unexpected write failure. A name that doesn't collide is checked against a near-duplicate search, but an unattended **merge** now also requires real token containment against the candidate — below that bar the fact gets its own note, since two notes are recoverable while two unrelated facts fused into one are not. `[[wikilink]]`s to related notes use a lower bar than merges, because a link is additive where a merge is destructive — and they are attached whether the fact merges or lands as a new note, so a note below the merge bar is never a disconnected graph node. Containment is scored against each candidate's full body rather than the matched chunk, though against a capped seed — the bar means "half of the fact's leading topic words are already here", not half of the whole fact. Retired `stale__*` notes are never merge targets; a recurrence of a retired name folds the retired body back in and removes the twin on both the create and the update path, because a retired note stays searchable and a twin beside a live note of the same name would answer every query twice forever. The twin is only dropped once the merged write lands (issue #398)) and the **`memory_shared_create`**/**`memory_shared_get`**/**`memory_shared_update`**/**`memory_shared_delete`** MCP tools, which let any agent create, read, update, or delete any note on demand regardless of `mode`. `memory_shared_create` warns instead of writing when it finds content-similar existing notes (pass `confirm:true` to proceed — related notes get `[[wikilink]]`ed into the new note rather than left disconnected); `memory_shared_update` warns instead of writing when the edit would drop 50%+ of the existing note's lines (same `confirm:true` escape hatch). Immediate reindex after every write or delete.

**Shared lifecycle + reflection (issues #392, #398).** Each shared note receives a stable whole-file lifecycle identity during indexing — including notes whose content has not changed since they were first indexed, which are backfilled from their source mtime so their real age is preserved. Its deterministic TTL GC runs **daily**, soft-invalidating aged low-recall notes by moving them to `notes/stale__<name>.md` (never deleting them from the searchable vault); a retrieval after invalidation restores the original active name. Shared `memory_search` and `memory_shared_get` reads feed the same append-only retrieval log as personal archive recall. The singleton reflection scheduler runs **once per resolved shared-vault root**, not once per agent, and fires **daily** at `hour:minute` (a fire that lands a hair early re-arms on the *next* day's slot rather than serving the same one twice): every fire runs the inexpensive TTL GC (no model call), while graph/LLM consolidation runs only on `dayOfWeek` — and even then is skipped when `kb_index_state.revision` has not changed since the prior consolidation. Weekly model spend is therefore unchanged, while a note that is retired and then retrieved returns to the active set within a day instead of up to a week. For changed vaults it clusters only active wikilink-connected notes deterministically, then makes at most `reflection.maxClustersPerRun` bounded reviewer calls to merge genuinely duplicate clusters; related-but-distinct notes remain merely linked.

**Knowledge base viewer.** The web dashboard's **Knowledge base** tab renders the shared vault as an Obsidian-style force-directed graph (nodes = notes sized by link degree and coloured by `type`; edges = `[[wiki-links]]`; contradicting claims and stale notes are flagged). It is fed by `GET /knowledge/graph`, which computes the model **on-demand** from the vault (no dependency on `shared.graph` or the nightly reindex). When the vault is empty it shows a clearly-labelled demo dataset (with a size selector for scale testing). A **source** selector switches the graph between the cross-agent Shared KB and any single agent's own Lane-2 memory (`workspace/memory`), a node **search** box filters the graph, and clicking a node opens its full note (fetched via `GET /knowledge/note`) rendered as Markdown below the graph.

**Nightly dreaming viewer.** A **Nightly dreaming** tab renders each agent's memory-consolidation audit trail (`.dreaming/DREAMS.md` + `promotions.jsonl`) as a newest-first timeline of runs — mode (propose/auto), outcome, the proposed/applied changes with scores + anchors, and per-run token/session counts — fed by `GET /knowledge/dreams` and filterable by agent. For a `propose`-mode run you can **accept** proposals directly from the tab: an **Accept** button per proposal (and **Accept all** per run) POSTs to `POST /knowledge/dreams/apply`, which applies the selected ops to `MEMORY.md`/`USER.md` through the same K4 safe applier auto mode uses (backup + bounded-loss + net-negative + CAS; memory-only ⇒ no restart) and — when the shared KB is `auto` — promotes applied `add`s to the shared vault. Accepts are idempotent (recorded to `.dreaming/accepted.jsonl`); applied proposals show ✓ and a proposal whose anchor has since drifted is safely skipped and stays pending for a later retry.

### `gateway.bind`

Network interface the HTTP/WebSocket server binds to. Defaults to `127.0.0.1` (localhost-only), so the dashboard and API are **not** exposed to the local network out of the box. Set to `0.0.0.0` to listen on all interfaces (for example when a containerized reverse proxy needs to reach the gateway). The `GATEWAY_BIND` environment variable, when set, takes precedence over this field.

> **⚠️ Binding to `0.0.0.0`? Configure an admin key in `gateway.api.keys`.** The
> monitoring surface (`/status`, `/processes`) and the dashboard require an
> **admin** API key (`admin: true`) or a dashboard session when keys are
> configured — a scoped or write-only key is rejected (`401`), because the
> dashboard grants cross-agent, host-wide power (including PTY keystroke injection
> into any session). The dashboard prompts for an admin key at `/dashboard` and
> stores an `HttpOnly` session cookie (issued only to an admin key). `/health`
> stays public but returns only `{"status":"ok"}` (no agent ids). With **no** keys
> configured the gateway **fails closed on a non-loopback bind**: `/status`,
> `/processes`, and `/dashboard` return `503` until you set `gateway.api.keys`
> (a startup warning is logged); if keys are set but **none is admin**, the
> dashboard is inaccessible and a startup warning is logged. On a loopback bind
> they stay open, so local keyless installs are unaffected. The gateway serves
> plain HTTP; put TLS in
> front (reverse proxy) so credentials are not sent in the clear.

```json
{
  "gateway": {
    "bind": "127.0.0.1"
  }
}
```

> **⚠️ Upgrade note:** the default bind changed from `0.0.0.0` to `127.0.0.1` (configVersion 1.0.13). To avoid silently cutting off external access, the config migrator is **behavior-preserving**: whenever it upgrades a config that never set `gateway.bind`, it pins `bind` to `0.0.0.0` and logs a one-time warning, so a deployment that was reachable from another host stays reachable. This applies to *any* upgraded config with no `bind` key — including one already stamped `1.0.13` that never received a bind (an earlier version gated this on `< 1.0.13` and left such configs stuck on the `127.0.0.1` default). New installs (no prior config, so no migration runs) keep the secure `127.0.0.1` default. If you *want* localhost-only after upgrading, set `gateway.bind` to `127.0.0.1` explicitly (or the `GATEWAY_BIND` env var).

### `gateway.publicUrl`

Absolute, externally-reachable origin of the gateway (for example `https://gateway.example.com`, or `https://host.example.com/gateway` behind an ingress path prefix). The process cannot infer its own public URL — it binds localhost by default and sits behind a reverse proxy — so it must be set explicitly for features that hand out a phone-openable link. Currently that is the `/cli` terminal viewer; when `publicUrl` is unset, `/cli` replies that the viewer is not configured. Leave it blank to keep `/cli` disabled. A trailing slash is optional. Use an `https://` origin — Telegram Mini Apps require HTTPS.

The CLI does **not** route through this URL when it runs on the gateway's own host: both addresses are the same server, and the public one only adds a reverse-proxy hop that may enforce its own authentication. It talks to the local bind instead, keeping `publicUrl` as a fallback if that address cannot be reached. Pass `--url` to exercise the proxy path deliberately. See [CLI.md](./CLI.md) for the full precedence.

```json
{
  "gateway": {
    "publicUrl": "https://gateway.example.com"
  }
}
```

### Terminal Viewer — interactive terminal mode

The dashboard's **Terminal Viewer** opens read-only (a live mirror of the PTY). A toggle in the top-right of the viewer switches it into an **interactive terminal**: keystrokes typed into the panel — printable characters, Enter, arrows, Ctrl-combos, Esc — are streamed into the live PTY, and the panel title changes to reflect the active mode. This is a per-browser client-side choice (Issue #201); there is no server config flag to enable it.

Because interactive mode turns a read-only view into a remote-write surface, access is protected upstream rather than by a feature flag:

- **Authentication** — the WebSocket requires a valid dashboard ticket or **admin** API key. The ticket is minted at `POST /api/v1/pty-stream-ticket`, which itself requires an admin API key or a valid dashboard session cookie — so an unauthenticated (or non-admin) caller cannot obtain one. The dashboard gets its session by logging in with an admin key at `/dashboard` (`HttpOnly` cookie); no token is embedded in the page.
- **`gateway.bind`** — the gateway binds to `127.0.0.1` (localhost) by default, so the dashboard is not reachable from the network out of the box. On a non-loopback bind (`0.0.0.0`), configure an admin key in `gateway.api.keys` so the dashboard and monitoring endpoints require an admin credential, and prefer a TLS-terminating reverse proxy so credentials are not sent in the clear.

Inbound frames are always bounded (text-only, size-capped) and are dropped for headless sessions (no PTY).

#### `/cli` — open the terminal viewer from chat

The `/cli` command (Telegram, Discord, LINE) opens the same live terminal viewer for **one agent**, without an admin key. It requires `gateway.publicUrl` and an agent running with `gateway.headless: false`. Unlike the admin dashboard, a `/cli` session is **agent-scoped**: its cookie and PTY ticket can only reach the originating agent's own sessions — never another agent, the process tree, or a cross-agent stream.

The viewer link is never a credential; unlocking it requires a proof tied to an allowlist-gated chat action:

- **Telegram** opens a Mini App and the gateway verifies Telegram's signed `initData` (HMAC with the agent's own bot token) — nothing secret rides in the URL, and the `initData` user must match the user who ran `/cli`.
- **Discord** and **LINE** send an open-viewer link plus an **Approve** button; the browser stays locked until you approve in the chat, so a leaked or forwarded link cannot be unlocked by anyone who cannot approve there.

The first browser to open a link owns it (opening the link in a second browser is rejected), the viewer defaults to read-only (toggle for input), and viewer sessions expire (30 min) — send `/cli` again to reconnect.

### `gateway.api.keys`

Each key has a `key` string (supports `${ENV_VAR}` interpolation), an optional `description`, and an `agents` field — either an array of agent IDs or `"*"` for full access. Keys support both `Authorization: Bearer` and `X-Api-Key` headers.

### Bot tokens

Tokens are stored per-agent at `~/.claude-gateway/agents/<id>/.env` and auto-loaded at startup **and before every config reload** — so an agent added to `config.json` while the gateway is running starts without a restart, even though its token only exists in a brand-new `.env`. Use `${AGENT_BOT_TOKEN}` syntax in config to reference them, or set them as shell environment variables. Lines are `KEY=value`; `#` comments and blank lines are ignored, and surrounding quotes are stripped, the same as in `~/.claude-gateway/.env`.

A variable you exported yourself always wins over the `.env` file and is never replaced by a reload. A token the gateway did read from a `.env` is refreshed when that file changes, so **rotating a token takes effect on the next config reload** rather than at the next restart. Note that only `config.json` is watched — editing a `.env` by hand applies on the following reload, while the MCP `agent_create` / `agent_update` tools write both files and so take effect immediately. If a `${VAR}` cannot be resolved from anywhere, that one agent is skipped — the rest of the gateway starts normally — and the skip is logged to `logs/gateway.log` with the name of the missing variable.

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
| `cron` | `ToolModule` | `cron_list`, `cron_create`, `cron_update`, `cron_delete`, `cron_run`, `cron_get_runs` | Manage scheduled jobs via gateway REST API |
| `skills` | `ToolModule` | `skill_create`, `skill_delete`, `skill_install` | Create, delete, and install agent skills at runtime |

Tools are **prefixed by channel name** to avoid collisions. Each module controls its own visibility and lifecycle.

**Adding a new channel** (e.g. Slack) means implementing `ChannelModule` interface in `mcp/tools/slack/module.ts` and registering it in `server.ts`.

**Connectors** are the other half of the MCP picture: where the modules above are tools the gateway itself implements, a connector is an **external** MCP server the gateway injects into a session's `mcp-config.json`. The gateway stores only the connector definition, the per-connector secret (`~/.claude-gateway/mcp-token.env`) and the per-agent enablement — Claude Code then talks to that server directly. See [`gateway.customConnectors`](#gatewaycustomconnectors-optional) and [API.md](./API.md#connectors-api).

### Process Modes

| Mode | Process | Behaviour |
|------|---------|-----------|
| `TELEGRAM_RECEIVER_MODE` | `receiver-server.ts` | Polls Telegram, handles commands, POSTs to callback — **no MCP** |
| `TELEGRAM_SEND_ONLY` | `server.ts` | Exposes MCP tools (`telegram_*`, `cron_*`) — **no polling** |

#### Receiver lifecycle

Receivers are child processes, so they only stop when the gateway runs its
shutdown path. Two mechanisms keep them from outliving it:

- **`SIGTERM`, `SIGINT` and `SIGHUP` all run the same graceful shutdown.**
  `SIGHUP` matters because Node's default action for it terminates the process
  *without* running handlers — so before this was wired, closing a tmux pane or
  dropping an SSH session killed the gateway and left every receiver reparented
  to `init`. Teardown escalates `SIGTERM` → `SIGKILL` after a short grace period,
  so a receiver wedged in an in-flight long-poll cannot survive it.

- **A boot-time sweep reclaims leftovers.** `SIGKILL` and the OOM killer can
  never be handled in-process, so at startup the gateway terminates any
  `receiver-server.ts` process that was spawned from *its own* installation and
  has been reparented to `init` (proof that its supervisor is gone), logging how
  many it reclaimed — and separately warning about any it could **not** reclaim,
  since those are still running. Receivers belonging to another checkout on the
  same host, or to a gateway that is still running, are never touched.

  On a host where an ancestor is a child subreaper (`systemd --user`,
  `docker run --init`/tini, s6), orphans reparent to that subreaper instead of to
  `init` and the sweep finds nothing. Clean shutdown still works; what is lost is
  the `SIGKILL`/OOM recovery — though such a host usually has a supervisor that
  reaps the process group itself.

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

Status updates are sent every 5-10 seconds (first update at 5s, then every 10s). A single
message is **edited in place** for the whole turn; a tick with nothing new to show issues no
update at all, and the message is replaced only if it is deleted or becomes uneditable.

---

## Command Line (CLI)

The `claude-gateway` binary doubles as a command-line client for a running gateway — a friendlier alternative to hand-built `curl` calls. It works the same whether the gateway was started with `make start`, pm2, or systemd (it resolves the target from your config). Run it with no arguments to see what it can do; **only `gateway start` boots the server**.

```bash
claude-gateway                             # help (never starts a server)
claude-gateway gateway start               # run the gateway in the foreground
claude-gateway gateway status              # is it running? which manager owns it?
claude-gateway gateway logs --follow       # stream the gateway log (reads files, needs no server)
claude-gateway service install             # run it as a systemd-user (or --manager pm2) service
claude-gateway update check                # newer claude-gateway published?
claude-gateway claude update               # update Claude Code via its own updater
claude-gateway doctor                      # check config / key / connectivity
claude-gateway agents create               # interactive wizard — new agent + optional channel
claude-gateway channels pending --agent alfred   # incoming Telegram/Discord pairing requests
claude-gateway crons list                  # friendly <noun> <verb> commands
claude-gateway crons run <jobId>
claude-gateway debug-bundle                # small redacted bundle for a stuck session (works even if the server is down)
claude-gateway api GET /v1/agents          # escape hatch: call any endpoint directly
```

### Reading the logs

`gateway logs` reads the log files directly, so it answers whether or not the gateway is
running — which is usually exactly when you need it.

```bash
claude-gateway gateway logs                       # last 50 lines of logs/gateway.log
claude-gateway gateway logs --lines 200 --follow  # more history, then stream
claude-gateway gateway logs --agent alfred        # that agent's stream instead
claude-gateway gateway logs --json                # the stored JSON lines, verbatim
```

Each line is stored as one JSON object and rendered as `<ts> <LEVEL> <message>` with `data`
appended; `--json` prints the stored line unchanged, for piping into `jq`. `--agent <id>` takes
any stream id in the log directory — agents (`alfred`), receivers (`alfred:receiver`), and
sessions (`alfred:session:<uuid>`) each get their own file — and an unknown id lists the ids that
do exist rather than reporting an empty result. `--follow` survives a rotation: when the file it
is watching is renamed away it reopens the new one instead of going quiet.

Unlike `debug-bundle`, this output is **not redacted** — it is the local file you could already
`cat`. Skim before pasting it anywhere.

> **Upgrading from < 1.8:** a service unit that runs the binary with no command still starts the
> gateway, with a deprecation warning. Point `ExecStart` at `claude-gateway gateway start`, or
> reinstall the unit with `claude-gateway service install`.

Working on the CLI itself? The globally installed `claude-gateway` is the published npm package, not
your checkout, so a bare `claude-gateway` still runs whatever version is on your `PATH`. Use `make cli`
to build and exercise the local sources instead:

```bash
make cli ARGS="--help"
make cli ARGS="gateway status"
```

Commands are **generated from the same route manifest the server mounts**, so every endpoint exposed as a friendly command stays in sync with the API automatically. Global flags: `--url`, `--key`, `--json`, `--data <json>`, `--help`.

See **[CLI.md](./CLI.md)** for the full command reference.

---

## HTTP API

> For day-to-day operation, prefer the **[CLI](#command-line-cli)** above (`claude-gateway <noun> <verb>`) — it resolves the URL and key for you and is easier to read. This section is the **raw HTTP reference** for programmatic clients and integrations.

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
| `POST` | `/api/v1/apps/inspect` | Preview a source's required/generated secrets before install, no install (admin) |
| `GET` | `/api/v1/apps/jobs/:jobId` | Poll install/update job status and logs |
| `GET` | `/api/v1/apps` | List installed apps |
| `GET` | `/api/v1/apps/:name` | Get app info |
| `DELETE` | `/api/v1/apps/:name` | Uninstall app (admin) |
| `POST` | `/api/v1/apps/:name/start\|stop\|restart` | Start/stop/restart app containers (admin) |
| `POST` | `/api/v1/apps/:name/update` | Blue-green update with auto-rollback → `jobId` (admin) |
| `POST` | `/api/v1/apps/:name/reconfigure` | Change env vars / host ports on an installed app, with rollback → `jobId` (admin) |
| `GET` | `/api/v1/connectors` | List connectors with connected state |
| `GET` | `/api/v1/connectors/:id/status` | Connected state for one connector (for polling) |
| `POST` | `/api/v1/connectors/:id/connect` | Store a pasted token (admin) |
| `POST` | `/api/v1/connectors/:id/oauth/receive` | Accept a token pushed by an external control plane (admin) |
| `DELETE` | `/api/v1/connectors/:id` | Disconnect a connector (admin) |
| `POST` | `/api/v1/connectors/custom` | Add a user-pasted connector (admin) |
| `POST` | `/api/v1/connectors/custom/:id/oauth/start` | Begin OAuth 2.1 + PKCE sign-in → `authorizeUrl` (admin) |
| `GET` | `/oauth/mcp/callback` | OAuth redirect target (public — guarded by a single-use `state`) |
| `GET` | `/app/:name/:portName/*` | Reverse proxy to installed app (no auth) |

**Wizard API** — create agents programmatically with the same flow as the interactive `claude-gateway agents create` terminal wizard. The wizard generates workspace files via Claude, writes them on confirm, and optionally pairs a Telegram/Discord bot. State is in-memory with a 30-minute TTL; nothing is written until `/confirm`. See [API.md](./API.md) for the full wizard flow.

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

The swap carries live bind-mount data forward into the new app directory. A data directory the app's own container created is owned by that image's uid (postgres leaves its `pgdata` mode 0700), and `rename(2)` on a directory needs write permission on the directory itself — so the gateway user cannot move it. Those paths are moved by a throwaway root helper container instead, mounting the nearest common ancestor of the two app directories so the move stays a real rename rather than a copy; each escalation is logged in the job. If a rollback cannot move such a path back, the update does **not** restart the app on a half-restored directory: the `-failed-` directory holding the live data is kept, the job fails with `ROLLBACK FAILED`, and the log names the paths and the directory to recover them from. That directory is kept for good — the boot sweep that reclaims update scratch dirs skips release snapshots, because it deletes with `sudo rm -rf` and a snapshot can hold the only copy of a database. It reports them on the console instead. The pre-update image tags are restored before that decision and the private `cg-rollback-*` tags are kept, so finishing the recovery by hand starts the restored source on its own build, not on the failed release's.

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
├── Makefile                            ← make start / cli / mcp-install / release / pm2-* / system-*
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
│   ├── gen-cli.ts                       ← generates src/cli/commands.generated.ts + CLI.md from the route registry
│   ├── mock-line-webhook.ts             ← local LINE webhook simulator for dev testing
│   ├── release.sh                       ← interactive release (make release)
│   └── setup-claude-settings.js         ← enables channelsEnabled in Claude Code
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
        │   ├── module.ts              ← ToolModule: cron_list, create, update, delete, run, get_runs
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
├── mcp-token.env                       ← connector secrets, mode 0600 (see `gateway.customConnectors`)
├── logs/
│   ├── alfred.log
│   ├── alfred.log.1                    ← rotated generation (see `gateway.logs`)
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

### Skill self-improvement

Agents can **learn skills from their own work**. Telemetry is captured for every turn; when a turn does enough substantive work (default ≥ 5 tool calls) and the session goes idle, a lightweight background reviewer reads the transcript and decides whether a reusable skill should be **created or updated**. Written skills are **hot-reloaded** — usable in the next turn without a restart. Controlled by [`gateway.skillLearning`](#gatewayskilllearning) (enabled by default).

- **Provenance guard** — the writer only ever creates new `origin: auto` skills or edits skills it previously authored. Hand-written / user skills are never overwritten.
- **Caps** — a per-day review cap and a maximum number of auto-skills bound the churn; a daily curator prunes the least-used auto-skills.
- **Audit diary** — every automatic write appends a line to `<workspace>/SKILLS_LEARNED.md` (always on, offline, immutable).
- **Notifications** — when `skillLearning.notify` is on (default), a short ping is fanned out to **every channel the agent has configured** (Telegram, Discord, and LINE when set up). Each channel resolves recipients from its own `.<channel>-state/access.json` allowlist. The web/`api` channel has no proactive push and is not notified. Bursts coalesce into a single digest.
- **Progressive disclosure** — auto-skill descriptions are truncated in the CLAUDE.md skill menu to keep per-turn context small; the full skill body still loads on invoke.

Metrics are exposed via `GET /api/v1/agents/:agentId/skill-metrics` and the `skill_metrics` MCP tool (adoption funnel, cost-to-complete deltas, net-token ledger).

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
   claude-gateway channels approve --agent alfred --channel discord --code abc123
   ```
   (use `--channel telegram` for Telegram; omit `--channel` on `channels pending` to check both)
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
claude-gateway agents update   # choose "Connect/update a channel" or "Disconnect a channel"
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
- Handled inbound message types are **text, image, and file** (documents up to the 20 MB media cap). Sticker, video, audio, and location are ignored. LINE reports no MIME type for a file, so its extension is derived from the sender-supplied name and sanitized before use. A file the gateway cannot fetch (too large, empty, or a failed transfer) still reaches the agent — as a message that says the attachment is unavailable, rather than one that looks like a file waiting to be read.
- Group/room `requireMention` uses LINE's **native mention** only (`mention.mentionees[].isSelf`). Typing the bot's name as plain text does **not** count, and `@All` does **not** count as a bot mention. LINE attaches mentions to **text messages only**, so an image or file posted in a group cannot satisfy the gate — send media in a DM, or set `requireMention: false` for that agent.
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
| `/model` | Show the current AI model. On Discord and LINE, `/model <id or alias>` also switches to any model in the list — an id the list does not contain is refused rather than written into `config.json`. **Direct messages only**: switching rewrites `config.json` for the whole agent and restarts every session in every chat, and the group access gates check the guild, channel and mention but never the user. Listing is unrestricted |
| `/models` | Switch AI model. On Telegram this is an inline keyboard; selecting a model triggers a graceful restart and notifies when back online, and **Dismiss** closes the picker without changing the model. Discord and LINE have no inline keyboard, so they get the same list as text plus `/model <id or alias>` to pick from it |

The list behind both commands is the live catalog from `{ANTHROPIC_BASE_URL}/v1/models` when a base URL is configured, falling back to `gateway.models` in `config.json` — see [GET /api/v1/models](API.md#get-apiv1models). Before this, `config.json`'s list was written once at provisioning and never re-read, so a catalog that changed upstream could never reach the picker.

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

### Writing tests that wait

Two rules, enforced by `tests/unit/test-timing-hygiene.test.ts`:

- **Wait for a signal, never for a duration.** `createWatcher()` / `watchWorkspace()` /
  `watchSkills()` return a handle with a `ready` promise; the PTY wrapper announces itself
  with a `system/init` event. Sleeping "long enough" instead is a bet on how fast the machine
  is — and chokidar runs with `ignoreInitial: true`, so a write that lands before its initial
  scan finishes emits *nothing* and the test waits out its whole deadline for an event that
  will never arrive.
- **Poll with the shared helper**, `tests/helpers/wait-for.ts`, rather than a local copy. Its
  timeout is a safety net sized so only a broken build hits it, and on a timeout it reports
  the predicate it was waiting on instead of a bare "timeout exceeded".

A fixed sleep is still fine for asserting that something *doesn't* happen — there the sleep
only bounds how hard the test looks, so a slow machine can't turn correct behaviour red.

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
