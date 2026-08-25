# Claude Gateway — CLI Reference

> **Auto-generated from the route manifest** (`scripts/gen-cli.ts`). Do not edit by hand.
> Every command is a thin client over the HTTP API; see `API.md` for the raw HTTP reference.

The `claude-gateway` binary accepts friendly `<noun> <verb>` subcommands.

**Starting the gateway is explicit.** `claude-gateway gateway start` runs the server in the
foreground; every other invocation — no arguments, `--help`, or a typo — prints help or an
error and exits, so exploring the CLI can never leave a stray server on the gateway port.

> **Upgrading from &lt; 1.8:** a service unit whose `ExecStart` runs the binary with no command
> still starts the server, with a deprecation warning. Change it to `claude-gateway gateway start`
> (or reinstall the unit with `claude-gateway service install`); a future release will drop the shim.

## Global flags

| Flag | Meaning |
|------|---------|
| `--url <url>` | Gateway base URL (else `$CLAUDE_GATEWAY_URL`, else `config.gateway.publicUrl`, else `http://<bind>:<port>`) |
| `--key <key>` | API key (else `$CLAUDE_GATEWAY_API_KEY`, else the first admin key in config) |
| `--json` | Print the raw JSON response only (stdout reserved for JSON) |
| `--data <json>` | JSON object merged into the request body (write commands) |
| `--help` | Show help for the command |

**Exception — local health probes.** `gateway status` and `service install` report on the gateway
process *on this host*, so they resolve `--url` → `http://<bind>:<port>` and ignore
`$CLAUDE_GATEWAY_URL` and `config.gateway.publicUrl`. Those usually name a reverse proxy, which
may be unreachable from the box itself — or may still be answering from a different instance, which
would report a dead local service as healthy. Pass `--url` explicitly to probe another host.
`doctor` keeps the normal precedence (it diagnoses the path the CLI's API calls take) and adds a
second `localHealth` check whenever a local gateway is detected behind a different URL.

## Lifecycle & diagnostics (do not require a running server)

| Command | Description |
|---------|-------------|
| `claude-gateway gateway start` | Run the gateway in the foreground (the only command that boots it) |
| `claude-gateway gateway status` | Show the owning manager and `/health` on the local bind address |
| `claude-gateway gateway restart` | Restart via the owning manager (systemd-user/systemd-system/pm2/foreground) |
| `claude-gateway gateway stop` | Stop the gateway |
| `claude-gateway doctor` | Check config, key resolution, owning manager, and connectivity |
| `claude-gateway debug-bundle` | Write a small redacted diagnostics bundle for a stuck session |
| `claude-gateway api <METHOD> <path>` | Escape hatch: call any endpoint directly |

A bare `claude-gateway gateway` (or `crons`, `service`, …) prints its verbs and exits **1** —
you forgot the verb. The same listing with `--help` exits **0**.

## Running as a service

| Command | Description |
|---------|-------------|
| `claude-gateway service install [--manager systemd\|pm2] [--config <path>] [--yes] [--print]` | Generate and start a service |
| `claude-gateway service status [--manager systemd\|pm2]` | Report installed/enabled/active state as JSON |
| `claude-gateway service uninstall [--manager systemd\|pm2] [--yes]` | Stop and remove the service |

- `systemd` (the default) installs a **user** unit at `~/.config/systemd/user/claude-gateway.service` —
  no `sudo`, and it runs as the user that owns `~/.claude-gateway`. Run
  `loginctl enable-linger <user>` once if it must survive logout.
- Every path in the generated unit (node, entry point, config, working directory) is absolute, and
  `ExecStart` always uses the explicit `gateway start` command. No secrets are written into the
  unit — the gateway reads `~/.claude-gateway/.env` itself.
- `--print` shows exactly what would be installed and exits without touching anything. Install and
  uninstall both ask for confirmation unless `--yes` is given (uninstall stops a running gateway),
  and refuse to run non-interactively without it.
- `install` verifies `/health` on the **local bind address**, and `uninstall` reports the state the
  manager actually reports afterwards — never the state that was intended.
- After installing, `gateway restart`/`stop` detect and drive that same service.

## Versions & updates

| Command | Description |
|---------|-------------|
| `claude-gateway version` | Print the installed gateway version |
| `claude-gateway update check` | Read-only: installed vs. published gateway version |
| `claude-gateway update [--yes]` | Show current → target, confirm, then `npm install -g` the latest |
| `claude-gateway claude version` | Print the installed Claude Code version |
| `claude-gateway claude update check` | Read-only version check for Claude Code |
| `claude-gateway claude update [--yes]` | Update Claude Code through its own native updater |

Both use the same detection and install strategy as the dashboard's Update button
(`src/packages/registry.ts`). Claude Code is updated by its native updater, never by
`npm install -g` — that would install a second copy that isn't the binary on `PATH`.
Updating the gateway replaces the files on disk; the running process keeps serving the previous
build until `claude-gateway gateway restart`.

## Agents & channels (require a running server)

| Command | Description |
|---------|-------------|
| `claude-gateway agents list` | List agents accessible by this key |
| `claude-gateway agents create [id] [--description <v>]` | Interactive wizard — generate workspace files, confirm, optionally connect Telegram/Discord |
| `claude-gateway agents update [--agent <id>]` | Regenerate AGENTS.md, or connect/update/disconnect Telegram/Discord/LINE/Slack |
| `claude-gateway channels pending --agent <id> [--channel telegram\|discord]` | List incoming pairing requests |
| `claude-gateway channels approve --agent <id> --channel <v> --code <v>` | Approve a pending pairing request |
| `claude-gateway channels deny --agent <id> --channel <v> --code <v>` | Deny and remove a pending pairing request |

## Resource commands

### `crons`

| Command | Method | Path | Auth | Description |
|---------|--------|------|------|-------------|
| `claude-gateway crons create --agentId <v> --name <v> [--type <v>] [--schedule <v>] [--scheduleKind <v>] [--scheduleAt <v>] [--command <v>] [--prompt <v>]` | POST | `/v1/crons` | key | Create a cron job |
| `claude-gateway crons delete <id>` | DELETE | `/v1/crons/:id` | key | Delete a cron job |
| `claude-gateway crons get <id>` | GET | `/v1/crons/:id` | key | Get a single cron job |
| `claude-gateway crons list [--agent <v>]` | GET | `/v1/crons` | key | List cron jobs accessible by this key |
| `claude-gateway crons run <id>` | POST | `/v1/crons/:id/run` | key | Trigger a cron job now |
| `claude-gateway crons runs <id> [--limit <v>]` | GET | `/v1/crons/:id/runs` | key | Get cron job run history |
| `claude-gateway crons status` | GET | `/v1/crons/status` | key | Cron scheduler status |
| `claude-gateway crons update <id>` | PUT | `/v1/crons/:id` | key | Update a cron job |

