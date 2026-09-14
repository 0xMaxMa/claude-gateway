# CLI and HTTP API

The CLI is a client for a running gateway, with local commands for lifecycle and diagnostics. Start with help to inspect exact options:

```bash
claude-gateway --help
claude-gateway agents list --json
claude-gateway doctor
```

## Connect to the right gateway

`--url` and `--key` explicitly select the server and API key. Environment alternatives are `CLAUDE_GATEWAY_URL` and `CLAUDE_GATEWAY_API_KEY`; a local CLI can read the admin key from configuration automatically. When a local gateway is detected, ordinary commands prefer its local address over `gateway.publicUrl`.

`--json` reserves stdout for the JSON result. `--data` merges a JSON object into a write request. See [CLI.md](https://github.com/0xMaxMa/claude-gateway/blob/main/CLI.md) for the generated command inventory, exact precedence, and exit codes.

## Make a read-only API request

Using an API key already stored in your shell environment:

```bash
curl --fail http://127.0.0.1:10850/api/v1/agents \
  -H "X-Api-Key: $CLAUDE_GATEWAY_API_KEY"
```

The result lists agents accessible to that key. The API also accepts `Authorization: Bearer <key>`. `/health` is public and returns liveness only. Dashboard and host monitoring need admin access when keys are configured.

## Send a message

Replace `assistant` with an accessible agent ID. `chat_id` identifies this integration's conversation namespace:

```bash
curl --fail http://127.0.0.1:10850/api/v1/agents/assistant/messages \
  -H "X-Api-Key: $CLAUDE_GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Introduce yourself in one sentence.","chat_id":"example-app"}'
```

Save the returned session identifier if you need to continue that session; send it as `session_id` with the same `chat_id`. An unknown session ID returns `404`, rather than silently creating a different session. Add `"stream": true` and use `curl -N` for SSE; consume error events as well as text and completion events.

## Find the right surface

| Need | Endpoint family |
| --- | --- |
| Agents and messages | `/api/v1/agents` |
| Available models | `/api/v1/models` |
| Session operations | `/api/v1/agents/:agentId/sessions` |
| Cron jobs | `/v1/crons` |
| App installation jobs | `/v1/apps` |
| Generated route metadata | `/api/v1/_meta/routes` |

The `/api/v1` and `/v1` prefixes vary by surface; use the documented route exactly. For full schemas, SSE events, error codes, and authorization rules, use [API.md](https://github.com/0xMaxMa/claude-gateway/blob/main/API.md). No API behavior is changed by this documentation site.
