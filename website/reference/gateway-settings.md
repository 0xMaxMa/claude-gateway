# Gateway settings

These settings are read from `config.json`. Examples are partial objects to merge into an existing configuration. Defaults in the tables refer to runtime fallback values; the installed template may explicitly choose a different value.

For when saved values take effect, environment precedence, and verification, see [Applying configuration changes](./configuration-changes.md). A field's presence in this reference does not imply that an existing runtime component hot-reloads it.

## `gateway.timezone` (optional)

IANA timezone, default `"UTC"`. Shared default for the per-feature scheduling
timezones below when they are unset or invalid: `gateway.history.cleanupTimezone`,
`gateway.appBackup.cleanupTimezone`, `gateway.skillLearning.pruneTimezone`,
`gateway.dreaming.dreamTimezone`, and `gateway.knowledge.reflection.timezone`. A
valid per-feature field still overrides this shared default for that one feature;
an invalid per-feature value falls through to `gateway.timezone` rather than being
treated as set. An invalid `gateway.timezone` itself falls back to `"UTC"` rather
than crashing that scheduler.

## `gateway.publicUrl` (optional)

The externally reachable gateway base URL. Set it manually to enable short-lived
public file shares used by `generate_image` reference edits and `share_file`
(formerly `share_image`, which still works as a deprecated image-only alias).
The URL must end in `/gateway`; new share links use the reloaded value. Existing links and proxy configuration are unchanged.

```json
{
  "gateway": {
    "publicUrl": "https://vm.example.com/gateway"
  }
}
```

Created share URLs have the stable form
`https://vm.example.com/gateway/shared/TOKEN`. When `publicUrl` is set the mint
response includes this ready-built `url`; when it is unset the response still
returns the `token` (the share endpoint stays enabled) and callers with their own
public base — e.g. LINE, which derives its host from the inbound webhook — build
`<base>/shared/<token>` themselves. HTTP is accepted only for local development
hosts such as `http://host.docker.internal:10850/gateway`.

In orchestration tasks, pass the original absolute file path from the active task
workspace, an input attachment, or the current session’s media directory to
`share_file` or `task_stage_file`. The gateway copies authorized files into session
media automatically. The old workflow of copying to the agent-wide `media/` root
is outside worker scope. `ARTIFACT_PATH_DENIED` identifies a path outside that
scope; use the authorized original path rather than retrying the same path.

## `gateway.oauthReturnUrl` (optional)

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
The value is validated when preparing a redirect: anything that isn't a well-formed `http(s)` URL
is logged and ignored rather than injecting a broken redirect into every future callback.
The scheme is part of that check — this value becomes the `Location` of a redirect sent
to the end user's own browser from a public route, so a `javascript:` or `data:` URL
here would be script running on every sign-in, and is refused like any other malformed
value.

## `gateway.customConnectors` (optional)

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
route that creates the entry; see [Connectors API](../api/connectors.md). **Only the placeholder names are stored here** — the values live in
`~/.claude-gateway/mcp-token.env` (mode `0600`), namespaced
`CUSTOM__<connectorId>__<placeholderName>`, and are substituted in when a session spawns.
Override that file's path with `GATEWAY_MCP_TOKEN_ENV_PATH`.

Custom connectors are **admin-trusted but not code-reviewed** — the config is whatever
the admin pasted. Per-agent enablement lives on the agent (`PATCH /api/v1/agents/:id`
with `connectors`). Set an entry's `defaultEnabled: false` to require explicit
per-agent opt-in, for example when pairing a personal browser. An omitted value
preserves the gateway default; `true` does not override a gateway-wide opt-in policy. See
[Connectors API](../api/connectors.md) for the full model, the OAuth flow, and the refresh
behaviour.

## `gateway.connectorsDefaultEnabled` (optional)

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

## `gateway.logs` (optional)

Verbosity, rotation and retention for the files in `logDir`. The whole block is optional —
omit it and the defaults below apply.

| Field | Default | Description |
|-------|---------|-------------|
| `level` | `"info"` | Minimum level written, to both the file and stdout. One of `debug`, `info`, `warn`, `error` |
| `maxFileBytes` | `16777216` (16 MiB) | Rotate `<name>.log` to `<name>.log.1` once an append would carry it past this size |
| `maxFiles` | `3` | Rotated generations kept per stream; the oldest is deleted. Lowering it collects the generations it orphans at the next rotation. `0` = keep none |
| `retentionDays` | `14` | Delete logs (live and rotated) older than this, at boot and once a day. `0` = keep forever |

`level` is the one that governs disk usage. Session processes log every stream event at `debug`,
so `debug` is off by default. Set `"level": "debug"` when you are actually chasing something, and
expect the directory to grow quickly while it is on. Rotation and retention bound what is *kept*;
only the level bounds what is *written*.

Retention is age-based because each session writes its own `<agent>:session:<uuid>.log` and never
returns to it — `maxFiles` prunes generations of one stream, so it can never reach them.

This block is **hot-reloaded**: edit it in `config.json` and it applies on the next config reload,
no restart. That matters because turning the level up is something you do while chasing a live
problem, and a restart would kill the sessions you are trying to observe.

## `session`

| Field | Default | Description |
|-------|---------|-------------|
| `idleTimeoutMinutes` | `30` | Kill idle session subprocess after N minutes of inactivity. Inactivity means no incoming message **and** no subprocess output — a session actively producing output (e.g. a self-paced `/loop`) is not treated as idle |
| `maxConcurrent` | `20` | Max simultaneous active sessions per agent; oldest idle is evicted when exceeded |

## `gateway.history` (optional)

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
| `cleanupTimezone` | `"UTC"` | IANA timezone for the cleanup schedule; falls back to `gateway.timezone` when unset or invalid |

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

## `dmPolicy`

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

## Voice and orchestration

See [voice setup](../guide/voice.md), [orchestration behavior](../guide/orchestration.md), and [orchestration settings](./orchestration-settings.md) for the per-agent configuration.

## `gateway.headless`

Controls the Claude subprocess backend for all non-app agents.

| Value | Backend | Description |
|-------|---------|-------------|
| `true` *(default)* | Headless (`--print`) | Headless stream-JSON process; orchestration workers can resume saved CLI sessions |
| `false` | PTY shell wrapper | Interactive pseudo-terminal — full TUI support |

**Legacy app-agents always run headless** regardless of this setting. Enabling orchestration automatically sets and saves `gateway.headless: true`. Disabling orchestration does not reset it.

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

## `gateway.selfHealing.autoRecover`

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

## `gateway.bind`

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

## Terminal Viewer — interactive terminal mode

The dashboard's **Terminal Viewer** opens read-only (a live mirror of the PTY). A toggle in the top-right of the viewer switches it into an **interactive terminal**: keystrokes typed into the panel — printable characters, Enter, arrows, Ctrl-combos, Esc — are streamed into the live PTY, and the panel title changes to reflect the active mode. This is a per-browser client-side choice (Issue #201); there is no server config flag to enable it.

Because interactive mode turns a read-only view into a remote-write surface, access is protected upstream rather than by a feature flag:

- **Authentication** — when API keys are configured, the WebSocket requires a valid dashboard ticket or **admin** API key. The ticket is minted at `POST /api/v1/pty-stream-ticket`, which itself requires an admin API key or a valid dashboard session cookie — so an unauthenticated or non-admin caller cannot obtain one in keyed deployments. Keyless loopback installations retain local monitoring access; do not treat loopback reachability as per-user authentication. The dashboard gets its session by logging in with an admin key at `/dashboard` (`HttpOnly` cookie); no token is embedded in the page.
- **`gateway.bind`** — the gateway binds to `127.0.0.1` (localhost) by default, so the dashboard is not reachable from the network out of the box. On a non-loopback bind (`0.0.0.0`), configure an admin key in `gateway.api.keys` so the dashboard and monitoring endpoints require an admin credential, and prefer a TLS-terminating reverse proxy so credentials are not sent in the clear.

Inbound frames are always bounded (text-only, size-capped) and are dropped for headless sessions (no PTY).

#### `/cli` — open the terminal viewer from chat

The `/cli` command (Telegram, Discord, LINE) opens the same live terminal viewer for **one agent**, without an admin key. It requires `gateway.publicUrl` and an agent running with `gateway.headless: false`. Unlike the admin dashboard, a `/cli` session is **agent-scoped**: its cookie and PTY ticket can only reach the originating agent's own sessions — never another agent, the process tree, or a cross-agent stream.

The viewer link is never a credential; unlocking it requires a proof tied to an allowlist-gated chat action:

- **Telegram** opens a Mini App and the gateway verifies Telegram's signed `initData` (HMAC with the agent's own bot token) — nothing secret rides in the URL, and the `initData` user must match the user who ran `/cli`.
- **Discord** and **LINE** send an open-viewer link plus an **Approve** button; the browser stays locked until you approve in the chat, so a leaked or forwarded link cannot be unlocked by anyone who cannot approve there.

The first browser to open a link owns it (opening the link in a second browser is rejected), the viewer defaults to read-only (toggle for input), and viewer sessions expire (30 min) — send `/cli` again to reconnect.

## `gateway.api.keys`

Each key has a `key` string (supports `${ENV_VAR}` interpolation), an optional `description`, and an `agents` field — either an array of agent IDs or `"*"` for all-agent scope. Administrator access separately requires `admin: true`; all-agent scope alone is not an administrator grant. Keys support both `Authorization: Bearer` and `X-Api-Key` headers.

## Bot tokens

Tokens are stored per-agent at `~/.claude-gateway/agents/<id>/.env` and auto-loaded at startup **and before every config reload** — so an agent added to `config.json` while the gateway is running starts without a restart, even though its token only exists in a brand-new `.env`. Use `${AGENT_BOT_TOKEN}` syntax in config to reference them, or set them as shell environment variables. Lines are `KEY=value`; `#` comments and blank lines are ignored, and surrounding quotes are stripped, the same as in `~/.claude-gateway/.env`.

A variable you exported yourself always wins over the `.env` file and is never replaced by a reload. A token the gateway did read from a `.env` is refreshed when that file changes, so **rotating a token takes effect on the next config reload** rather than at the next restart. Note that only `config.json` is watched — editing a `.env` by hand applies on the following reload, while the MCP `agent_create` / `agent_update` tools write both files and so take effect immediately. If a `${VAR}` cannot be resolved from anywhere, that one agent is skipped — the rest of the gateway starts normally — and the skip is logged to `logs/gateway.log` with the name of the missing variable.

WhatsApp Cloud's credentials (`accessToken`, `phoneNumberId`, `appSecret`, `verifyToken`) are plain fields under the agent's `whatsapp_cloud` config block, not a dedicated "bot token" field — but they resolve through the exact same mechanism as Telegram/Discord bot tokens: reference them as `${VAR}` in `config.json` and put the value in the agent's `.env` (or export it as a shell variable), same as above.

---

Implementation: [config loader](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/config/loader.ts), [configuration template](https://github.com/0xMaxMa/claude-gateway/blob/b917843/config.template.json).
