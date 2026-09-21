# HTTP API reference {#http-api-reference}

This reference documents the gateway API, including orchestration, tasks and voice. Start with [endpoint and authorization tables](/api/overview), then use the detailed request fields, response schemas, errors and examples for each family below.

## Authentication and public paths {#authentication-and-public-paths}

Configure API keys in `gateway.api.keys` in `config.json`. Send `X-Api-Key: <key>` or `Authorization: Bearer <key>`. The API returns `401` for a missing key and `403` for an invalid key. Agent access is checked separately; `agents: "*"` grants all-agent scope, `write: true` allows scoped writes, and `admin: true` allows administrative operations. See [key configuration examples](/api/agents#setup).

Public and cookie/ticket-authenticated exceptions are identified in the [overview](/api/overview): health checks, provider-verified webhooks, capability share URLs, the dashboard, the paired terminal and OAuth callbacks have their own access rules. Monitoring requires admin access when keys are configured and fails closed on non-loopback keyless binds.

Use `http://127.0.0.1:10850` for a local gateway or your configured gateway origin. API routers are mounted under `/api`, so router-local `/v1/...` paths (including route-manifest entries) become public `/api/v1/...` URLs. Root paths such as `/health`, `/dashboard`, `/webhooks/...`, `/shared/...` and `/oauth/mcp/callback` do not take this prefix. No real credentials are included in these examples: replace example values with your own configured keys and identifiers.

```bash
curl --fail http://127.0.0.1:10850/api/v1/agents \
  -H "X-Api-Key: $CLAUDE_GATEWAY_API_KEY"
```

## Endpoint families {#endpoint-families}

| Family | Reference |
| --- | --- |
| Endpoint overview | [Open reference](/api/overview) |
| System, health and route metadata | [Open reference](/api/system) |
| Agents, avatars and creation wizard | [Open reference](/api/agents) |
| Messages and slash commands | [Open reference](/api/messages) |
| SSE, tool events and reconnects | [Open reference](/api/streaming) |
| Jev evaluations and scoped usage | [Open reference](/guide/jev#http-evaluation-and-usage) |
| Models | [Open reference](/api/models) |
| Session management | [Open reference](/api/sessions) |
| Chat history and search | [Open reference](/api/history) |
| Workspace files | [Open reference](/api/workspace) |
| Skills and metrics | [Open reference](/api/skills) |
| Telegram access controls | [Open reference](/api/telegram) |
| WhatsApp and Cloud API | [Open reference](/api/whatsapp) |
| WeChat | [Open reference](/api/wechat) |
| Discord access controls | [Open reference](/api/discord) |
| LINE and Slack webhooks | [Open reference](/api/webhooks) |
| Cron jobs | [Open reference](/api/crons) |
| Media upload and delivery | [Open reference](/api/media) |
| File shares and image artifacts | [Open reference](/api/shares) |
| App Store, backups, proxy and app.yaml | [Open reference](/api/apps) |
| Connectors and OAuth | [Open reference](/api/connectors) |
| Package updates | [Open reference](/api/packages) |
| Paired terminal viewer | [Open reference](/api/terminal) |
| PTY screen and WebSocket | [Open reference](/api/pty) |
| Orchestration and activity | [Open reference](/api/orchestration) |
| Tasks and worker lifecycle | [Open reference](/api/tasks) |
| Voice settings and streaming | [Open reference](/api/voice) |

For command-line usage, see [CLI and HTTP API](/reference/cli-api).
