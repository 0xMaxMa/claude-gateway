# System Endpoints {#system-endpoints}

## GET /processes

Read the live dashboard process inventory. Uses the same admin-key/dashboard-cookie
authentication as `/status`. Collection is asynchronous, shared across concurrent
requests, and cached for three seconds. The dashboard polls every ten seconds
while the System page is visible.

The response contains `processes`, `containers`, `warnings`, and `numCpus`.
Processes are grouped as `gateway`, `agent`, `worker`, `container`, `safemode`,
`receiver`, or `orphan`. Agent/worker records include known session, model, task,
and harness metadata; safemode records include the saved name and interactive or
headless mode. `pid` is the host PID; `containerPid`, when observable, is the PID
inside the container. Container records include their Docker ID and state.

CPU is the process's lifetime average reported by `ps`; the UI normalizes it by
the host core count. Memory is RSS, summed once per distinct host PID, including
container processes. Shared pages can still contribute to more than one process's
RSS. Container totals are subtotals, not extra usage added to the overall total.
Unavailable container observations are labeled explicitly. Remote Docker and
Docker Desktop cannot supply this host's process accounting.

Raw process arguments and environment variables are not returned. Registered live
safemode owners and descendants are separate from gateway orphans. This is a
read-only inventory: displaying safemode does not authorize stopping it when the
gateway restarts.

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

## GET /api/v1/capabilities {#capabilities}

Tells a client which optional features **this** gateway build supports, so the
client can show or hide functionality based on what the server can actually do —
instead of parsing version strings or probing endpoints and guessing from the error.

**Auth:** requires a valid API key (`X-Api-Key` / `Authorization: Bearer`) when
`gateway.api.keys` is configured, exactly like the rest of `/api/v1`. It is *not*
public like `/health`: the response includes the gateway version, which `/health`
deliberately withholds from unauthenticated callers. With no keys configured it is
open, matching the other `/api` routers. Only mounted when `gateway.api.keys` is set
(again like `/api/v1`).

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/capabilities | jq
```

```json
{
  "version": "2.0.9",
  "capabilities": {
    "cross_channel_message": ["telegram"]
  }
}
```

### Response schema

| Field | Type | Meaning |
|-------|------|---------|
| `version` | `string` | The gateway's `package.json` version. **Informational only** — never gate a feature on it; use the capability keys. |
| `capabilities` | `object` | One entry per supported feature. A key that is **absent** means the feature is **not** supported. |
| `capabilities.cross_channel_message` | `string[]` | Channel identifiers for which a client may inject a message into a session that belongs to that channel via `POST /api/v1/agents/:agentId/chats/:chatId/sessions/:sessionId/messages`. The injected message is delivered into the session and echoed to the channel's conversation so its users see what was sent from elsewhere. A channel is listed only once that round-trip actually works for it. |

### Capability keys

| Key | Value | Meaning |
|-----|-------|---------|
| `cross_channel_message` | `string[]` of channel ids | Cross-channel message injection is supported for sessions whose channel is in the array. Currently `["telegram"]`. |

Channel identifiers are the gateway's canonical channel names — the same strings a
session reports as its `channel` — drawn from `CHAT_CHANNELS` in
`src/history/types.ts`: `telegram`, `discord`, `line`, `slack`, `whatsapp`,
`whatsapp_cloud`, `wechat`. Nothing else will ever appear in a channel array; a
client should compare against these values verbatim.

### Capability value formats

Every capability value has **one of exactly three shapes**. Future capabilities must
use one of these; there is no fourth.

| Shape | Use it for | Client rule | Illustrative example |
|-------|-----------|-------------|----------------------|
| `boolean` | A simple on/off feature | `value === true` | `"session_cancel": true` |
| `string[]` | A feature supported for an enumerated set (channels, formats, providers) | `value.includes(x)` — an **empty array means supported by nothing** | `"cross_channel_message": ["telegram"]` |
| `object` | A feature with parameters or limits; the fields inside are themselves additive-only | key present ⇒ supported; read the fields you know, treat a **missing field as unknown** and behave conservatively | `"attachments": { "max_bytes": 20971520, "mime_types": ["image/png"] }` |

The examples other than `cross_channel_message` are **illustrative only** — they are
not served by the gateway today. The real response currently contains exactly one key.

Rules that hold for every key, now and later:

- **Keys are `snake_case` nouns** naming the feature (`cross_channel_message`), not
  verbs or version tags.
- **A key is either absent (unsupported) or present with its declared shape.** The
  shape of a published key **never changes**. If a feature needs a different shape
  (say a boolean must become a per-channel list), a **new key** is introduced and the
  old one is kept or removed — it is never redefined.
- **Additive-only, never re-meant.** New keys (and, for `object` values, new fields)
  may be added at any time; an existing key never changes meaning. Removing a feature
  means removing its key, not flipping it to `false`/`[]`.
- **Never a bare number or string.** A limit or a mode belongs inside an `object`
  value (`{ "max_bytes": ... }`), so the key can grow more fields later without
  changing shape.
- **`version` is informational.** Clients feature-detect via capability keys and must
  not compare version strings — a fork, a backport, or a pre-release build can carry
  any version while supporting any subset of capabilities.

### Client guidance

1. **`404` means "no capabilities".** Gateways older than this endpoint return `404`
   for it (with Express's default HTML body, not JSON — don't parse it). Treat that as
   an empty `capabilities` object and hide every feature that depends on one. Do not
   treat it as an error. Send your API key on the probe: on those older gateways the
   `/api` auth middleware runs *before* route matching, so an **unauthenticated** probe
   gets `401`/`403` exactly as any other `/api/v1` route would — that is a credentials
   problem, not a capability signal.
2. **A missing key means unsupported.** Never assume a default for a key you don't see.
3. **Check the array, not the key, for `cross_channel_message`.** Before offering
   cross-channel injection for a conversation, verify that the conversation's channel
   identifier is *included* in `capabilities.cross_channel_message`. A gateway may list
   `telegram` but not `discord`; offering the feature on a Discord session would fail.
4. **Cache per gateway, refetch on reconnect.** The manifest only changes when the
   gateway is upgraded, so fetching once per session/connection is enough; refetch
   after a reconnect or a `version` change seen in `/status`.
5. **Type every key as optional** on the client. A minimal TypeScript shape:

```ts
type ChatChannel = 'telegram' | 'discord' | 'line' | 'slack' | 'whatsapp' | 'whatsapp_cloud' | 'wechat';

interface GatewayCapabilities {
  version: string; // informational — do not gate on it
  capabilities: {
    cross_channel_message?: ChatChannel[];
    // future keys are added here; every one stays optional
  };
}

// 404 → the gateway predates capability discovery: no capabilities.
async function fetchCapabilities(base: string, key: string): Promise<GatewayCapabilities['capabilities']> {
  const res = await fetch(`${base}/api/v1/capabilities`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 404) return {}; // older gateway: no capability discovery
  if (!res.ok) throw new Error(`capabilities: HTTP ${res.status}`); // 401/403 = bad key, not "unsupported"
  return ((await res.json()) as GatewayCapabilities).capabilities ?? {};
}

const caps = await fetchCapabilities(gatewayUrl, apiKey);
const canInject = caps.cross_channel_message?.includes(conversation.channel) === true;
```

---

## Local safemode controls

Safemode has no public HTTP endpoint. Its local CLI works independently of the
server; allowlisted host agents use `capabilities_list(scope="safemode")` to discover
explicitly assigned sessions, then `task_spawn` with `target_profile="gateway-managed"`.
The gateway tracks and reports results through the normal task lifecycle.
The private orchestration bridge checks membership, operator configuration and
execution authorization before access. See the [safemode guide](../guide/safemode.md)
for request IDs, asynchronous receipts, explicit takeover and result retrieval.
