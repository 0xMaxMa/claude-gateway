# System Endpoints {#system-endpoints}

## GET /health {#get-health}

Liveness check. No auth required. Intentionally minimal — it returns **only**
liveness so it is safe to expose to external probes even when the gateway is bound
to a non-loopback interface. Agent ids moved to `/status` (authenticated).

```bash
curl http://localhost:10850/health
```

```json
{ "status": "ok" }
```

---

## GET /status {#get-status}

Per-agent stats and heartbeat history. **Requires an _admin_ API key or a dashboard
session cookie when `gateway.api.keys` is configured**. With no keys, it is open only on a loopback bind; a non-loopback bind returns `503`. Returns 401
when keys are set and no valid admin credential is supplied (a valid non-admin key is
also rejected).

```bash
# API key
curl -H "X-Api-Key: $KEY" http://localhost:10850/status | jq
```

```json
{
  "agents": [
    {
      "id": "alfred",
      "isRunning": true,
      "messagesReceived": 12,
      "messagesSent": 48,
      "lastActivityAt": "2026-05-10T02:00:00.000Z",
      "heartbeat": {
        "tasks": ["morning-check"],
        "lastResults": [
          { "taskName": "morning-check", "suppressed": false, "rateLimited": false, "durationMs": 1200, "ts": 1746835200000 }
        ]
      },
      "sessions": [
        { "chatId": "<CHAT_ID>", "messageCount": 5, "lastActivity": "2026-05-10T01:50:00.000Z" }
      ]
    }
  ],
  "uptime": 3600,
  "startedAt": "2026-05-10T01:00:00.000Z"
}
```

---

## GET /ui {#get-ui}

This legacy path is not registered in the current gateway. Use [`GET /dashboard`](/api/overview#system), which requires an admin key or dashboard login when keys are configured. A keyless non-loopback deployment fails closed.

---

## GET /api/v1/commands {#get-apiv1commands}

List the slash commands available in the chat UI. No auth required.

```bash
curl http://localhost:10850/api/v1/commands | jq
```

```json
{
  "commands": [
    { "name": "/session",  "description": "Show current session info (name, selected model, measured context usage)" },
    { "name": "/sessions", "description": "List sessions" },
    { "name": "/help",     "description": "Show available commands" },
    { "name": "/clear",    "description": "Reset Claude Code context; keep chat history" },
    { "name": "/compact",  "description": "Compact Claude Code context; keep chat history" },
    { "name": "/stop",     "description": "Interrupt the in-flight turn" },
    { "name": "/restart",  "description": "Graceful session restart" },
    { "name": "/model",    "description": "Show the current AI model" }
  ]
}
```

---

## GET /api/v1/_meta/routes {#get-apiv1_metaroutes}

Returns the route manifest: every endpoint registered via `defineRoute` in the API
routers, each with its method, path, auth level, and (where exposed) its CLI
`noun`/`verb` mapping. `scripts/gen-cli.ts` reads this manifest offline to generate
the CLI's command table (`src/cli/commands.generated.ts`) and the [CLI command reference](../reference/cli.md); the endpoint
itself is for runtime verification (e.g. `claude-gateway doctor`), not for building
commands at request time. Requires a valid API key.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/_meta/routes | jq
```

```json
{
  "routes": [
    {
      "method": "GET",
      "path": "/v1/crons",
      "auth": "key",
      "summary": "List cron jobs accessible by this key",
      "cli": { "noun": "crons", "verb": "list", "args": [], "flags": [{ "name": "agent", "in": "query" }] }
    }
  ]
}
```

---
