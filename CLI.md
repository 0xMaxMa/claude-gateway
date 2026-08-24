# Claude Gateway — CLI Reference

> **Auto-generated from the route manifest** (`scripts/gen-cli.ts`). Do not edit by hand.
> Every command is a thin client over the HTTP API; see `API.md` for the raw HTTP reference.

The `claude-gateway` binary accepts friendly `<noun> <verb>` subcommands. Running it with **no subcommand still boots the server** (unchanged), so systemd/pm2/npm start are unaffected.

## Global flags

| Flag | Meaning |
|------|---------|
| `--url <url>` | Gateway base URL (else `$CLAUDE_GATEWAY_URL`, else `config.gateway.publicUrl`, else `http://<bind>:<port>`) |
| `--key <key>` | API key (else `$CLAUDE_GATEWAY_API_KEY`, else the first admin key in config) |
| `--json` | Print the raw JSON response only (stdout reserved for JSON) |
| `--data <json>` | JSON object merged into the request body (write commands) |
| `--help` | Show help for the command |

## Lifecycle & diagnostics (do not require a running server)

| Command | Description |
|---------|-------------|
| `claude-gateway gateway status` | Show whether the gateway is running + version/uptime |
| `claude-gateway gateway restart` | Restart via the owning manager (systemd/pm2/foreground) |
| `claude-gateway gateway stop` | Stop the gateway |
| `claude-gateway doctor` | Check config/env/connectivity |
| `claude-gateway debug-bundle` | Write a small redacted diagnostics bundle for a stuck session |
| `claude-gateway api <METHOD> <path>` | Escape hatch: call any endpoint directly |

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

