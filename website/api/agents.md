# Agent API {#agent-api}

## Setup {#setup}

**1. Add an API key to `config.json`**

```json
{
  "gateway": {
    "api": {
      "keys": [
        {
          "key": "my-secret-key-123",
          "description": "My app",
          "agents": ["alfred"]
        },
        {
          "key": "admin-key-456",
          "description": "Admin — full access",
          "agents": "*",
          "admin": true
        },
        {
          "key": "automation-key-789",
          "description": "Automation — may use tools",
          "agents": ["alfred"],
          "allow_tools": true
        }
      ]
    }
  }
}
```

`agents` can be an array of agent IDs or `"*"` for access to all agents. Administrative operations additionally require `admin: true`; write operations require `write: true` or admin access. Keys support `${ENV_VAR}` interpolation.

Tool access (Read, Bash, Grep, etc.) is configured server-side. An explicit agent `allow_tools` value takes precedence; otherwise the API uses the key's `allow_tools` flag. No request-body field grants tool access. Set the agent value to `false` to enforce conversational-only behavior.

**2. Restart the gateway**

```bash
npm start
```

---

## GET /api/v1/agents {#get-apiv1agents}

List agents accessible by the provided API key.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/agents | jq
```

```json
{
  "agents": [
    { "id": "alfred", "name": null, "description": "Personal assistant", "model": "claude-sonnet-4-6", "allow_tools": false }
  ]
}
```

`name` is an optional display name (`null` when unset); the UI falls back to `id` in that case.

`orchestration_enabled` reports the effective gateway mode for this Agent. When true, clients must continue observing session history after an acknowledgement stream ends: completed tasks produce later assistant replies. False or absent retains legacy request/response behavior.

---

## POST /api/v1/agents {#post-apiv1agents}

Create a new agent entry in `config.json`. Requires admin key. Also creates the workspace directory with stub files (`AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`).

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Agent ID — pattern `[a-z][a-z0-9_-]{1,31}` |
| `description` | Yes | Human-readable description |
| `model` | No | Claude model ID (default: `claude-sonnet-4-6`) |
| `allow_tools` | No | Whether the agent may invoke tools when accessed via the API channel (default: `true`). Pass `false` to create a conversational-only agent. |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-bot", "description": "My new bot", "model": "claude-sonnet-4-6"}' \
  http://localhost:10850/api/v1/agents | jq
```

```json
{ "agent": { "id": "my-bot", "description": "My new bot", "model": "claude-sonnet-4-6", "allow_tools": true } }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Invalid `id` format, missing `description`, or non-boolean `allow_tools` |
| 403 | Not an admin key |
| 409 | Agent ID already exists |
| 501 | Gateway started without a config path |

---

## PATCH /api/v1/agents/:agentId {#patch-apiv1agentsagentid}

Update an agent's display name, description, model, allow_tools flag, or connector enablement. Requires write access to the agent; the `connectors` field additionally requires **admin** (see below). Only fields provided are updated.

**Request body (all optional):**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string \| null | Display name shown in the UI instead of `id`. Empty string or `null` clears it (falls back to `id`) |
| `description` | string | New description |
| `model` | string | New Claude model ID |
| `allow_tools` | boolean | Override tool access for this agent |
| `connectors` | object | **Admin only** — a non-admin key gets `403`. Per-connector enablement, `{ "<connectorId>": { "enabled": boolean } }`. **Merged** into the agent's existing map, not replacing it — send only the ids you are changing. `enabled` must be a boolean, and each key must be a valid connector id (`^[a-z0-9][a-z0-9-]*$`, max 64 chars), or the request is `400` |

`connectors` is the one field on this route that is admin-gated, because it is the only one that reaches a credential somebody else owns: every mutating route under [Connectors API](/api/overview#connectors-api) is admin-only, and enabling a connector here resolves that connector's secret into the agent's MCP config at spawn. Under [`gateway.connectorsDefaultEnabled: false`](/reference/configuration) a `write` key scoped to a single agent could otherwise hand that agent any token an admin had connected.

Enablement is **opt-out**: a connected connector is available to every agent unless that agent explicitly sets `{"enabled": false}`. Connecting the connector at all is the security gate — see [Connectors API](/api/overview#connectors-api). A multi-owner deployment can flip this to opt-in with [`gateway.connectorsDefaultEnabled: false`](/reference/configuration).

Ids are validated for **shape only, not existence** — pre-setting `{"enabled": false}` for a connector nobody has added yet is a legitimate way to keep it off an agent from the moment it appears.

Changing `connectors` restarts the agent's sessions so the new MCP set takes effect: a running session's MCP subprocess has the old connector set baked into its env and cannot be hot-patched. The restart is lossless — a busy session finishes its current turn and restarts after it, an idle channel session is armed to restart on its next message, and only `api` / heartbeat sessions (which respawn fresh on next use anyway) are stopped right away. Nothing in flight is killed.

```bash
curl -X PATCH \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"connectors": {"github": {"enabled": false}}}' \
  http://localhost:10850/api/v1/agents/alfred | jq
```

```bash
curl -X PATCH \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-8"}' \
  http://localhost:10850/api/v1/agents/alfred | jq
```

```json
{ "agent": { "id": "alfred", "name": null, "description": "Personal assistant", "model": "claude-opus-4-8", "allow_tools": false } }
```

---

## PUT /api/v1/agents/:agentId/avatar {#put-apiv1agentsagentidavatar}

Upload or replace an agent's avatar image. Requires **write** access to the agent.

**Request:** raw image binary as the request body.

| Constraint | Value |
|------------|-------|
| Allowed types | `image/jpeg`, `image/png`, `image/webp`, `image/gif` |
| Max size | 5 MB |
| Type detection | Magic bytes (ignores Content-Type header) |

```bash
curl -X PUT \
  -H "X-Api-Key: write-key" \
  --data-binary @avatar.png \
  http://localhost:10850/api/v1/agents/alfred/avatar | jq
```

```json
{ "avatarUrl": "/api/v1/agents/alfred/avatar" }
```

The file is written to `~/.claude-gateway/agents/{agentId}/avatar.{ext}` and the `avatar` field in `config.json` is updated. If an old avatar exists with a different extension, it is removed.

**Error responses:**

| Status | When |
|--------|------|
| 400 | Empty body or file too small |
| 403 | Write permission required |
| 413 | File exceeds 5 MB |
| 415 | Unrecognised image format |

---

## DELETE /api/v1/agents/:agentId/avatar {#delete-apiv1agentsagentidavatar}

Remove an agent's avatar. Requires **write** access. Returns `204 No Content` on success.

```bash
curl -X DELETE \
  -H "X-Api-Key: write-key" \
  http://localhost:10850/api/v1/agents/alfred/avatar
```

---

## GET /api/v1/agents/:agentId/avatar {#get-apiv1agentsagentidavatar}

Serve the agent's avatar image. Requires read access to the agent.

- `Cache-Control: private, max-age=3600`
- Returns the raw image bytes with the correct `Content-Type`
- Returns `404` if no avatar has been set or the file is missing

```bash
curl -H "X-Api-Key: my-key" \
  http://localhost:10850/api/v1/agents/alfred/avatar -o avatar.png
```

---

## Wizard API — multi-step agent creation {#wizard-api--multi-step-agent-creation}

The Wizard API mirrors the interactive `claude-gateway agents create` terminal wizard but is consumable by web UIs and automation. State is kept **in memory** with a 30-minute TTL (refreshed on each step transition); nothing is written to disk until the `/confirm` step.

**State machine:**

```
start → (optional avatar upload) → confirm → (optional channel) → (verify) → complete
```

---

### POST /api/v1/agents/wizard/start {#post-apiv1agentswizardstart}

**Auth:** admin key.

Calls Claude to generate workspace markdown files based on your prompt. Returns a `wizardId` for subsequent steps.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Agent ID — pattern `[a-z][a-z0-9_-]{1,31}` |
| `prompt` | Yes | Natural-language description of the agent |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"id": "cryptobot", "prompt": "A helpful assistant that specialises in crypto analysis, speaks Thai..."}' \
  http://localhost:10850/api/v1/agents/wizard/start | jq
```

```json
{
  "wizardId": "550e8400-e29b-41d4-a716-446655440000",
  "agentId": "cryptobot",
  "files": {
    "AGENTS.md": "# Agent: Cryptobot\n\n...",
    "SOUL.md": "...",
    "USER.md": "...",
    "MEMORY.md": ""
  },
  "expiresAt": "2026-05-15T09:03:00Z"
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Invalid `id` format or missing `prompt` |
| 403 | Not an admin key |
| 409 | Agent already exists, or a `confirmed`/`complete` wizard is already in progress for this ID (a `pending` draft is replaced instead) |
| 429 | Too many wizard starts in progress (max 2 concurrent) |
| 500 | Claude generation failed |

---

### PUT /api/v1/agents/wizard/:wizardId/avatar {#put-apiv1agentswizardwizardidavatar}

**Auth:** admin key. Optional step before `/confirm`.

Upload an avatar for the agent being created. The image is held in memory and written to disk during `/confirm`.

**Request:** raw image binary (same constraints as the regular avatar upload — 5 MB max, jpeg/png/webp/gif).

```json
{ "preview": true }
```

---

### POST /api/v1/agents/wizard/:wizardId/confirm {#post-apiv1agentswizardwizardidconfirm}

**Auth:** admin key.

Write workspace files and avatar to disk, add the agent to `config.json`, and trigger a hot-reload so the agent starts automatically.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `files` | No | Map of filename → content. If omitted, the files generated in `/start` are used. Must include `AGENTS.md`. |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"files": {"AGENTS.md": "# Agent: Cryptobot\n\n...", "SOUL.md": "..."}}' \
  http://localhost:10850/api/v1/agents/wizard/550e8400.../confirm | jq
```

```json
{
  "agentId": "cryptobot",
  "avatarUrl": "/api/v1/agents/cryptobot/avatar",
  "next": "channel via POST /api/v1/agents/wizard/.../channel, or skip via POST .../complete"
}
```

---

### POST /api/v1/agents/wizard/:wizardId/channel {#post-apiv1agentswizardwizardidchannel}

**Auth:** admin key. Optional step after `/confirm`.

**Token-only connect.** Verify a Telegram or Discord bot token, persist it to the
agent config, seed a secure `access.json`, and hot-start the receiver so the bot
comes online immediately. **No pairing code is minted here** — pairing is
incoming-first and happens later: the owner (or a group member) DMs the bot, a
one-time code lands in Pending, and an admin approves it from the agent's
Channels card (see the Telegram/Discord Channel APIs below). This mirrors the
LINE flow.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `channel` | Yes | `"telegram"` or `"discord"` |
| `botToken` | Yes | Bot token from BotFather / Discord Developer Portal |

**Response:**

```json
{
  "channel": "telegram",
  "botName": "@my_crypto_bot",
  "connected": true
}
```

The wizard advances to step `complete`. A brand-new connection is seeded with a
closed-but-pairing-on `access.json` (`dmPolicy: "allowlist"`, `pairing: true`),
so the owner can DM the bot and self-approve via a code.

---

### POST /api/v1/agents/wizard/:wizardId/complete {#post-apiv1agentswizardwizardidcomplete}

**Auth:** admin key.

Finalise the wizard and clean up state. Can be called after `/confirm` to skip
channel setup entirely, or after `/channel` (the agent keeps whatever channel was
connected). Rejected with `409` only while the wizard is still in step `pending`
(the workspace must be confirmed first).

```json
{ "agentId": "cryptobot" }
```

---

## POST /api/v1/agents/describe/rewrite {#post-apiv1agentsdescriberewrite}

**Auth:** admin key.

Stateless helper for the "describe your agent" step of agent creation. Calls Claude to
clean up a rough draft description into clearer, moderately clarified text — no
`wizardId`/`agentId` involved, single string in, single string out.

**Request body:**

| Field | Required | Description |
|-------|----------|--------------|
| `text` | Yes | Draft description to re-write (max 8,000 characters) |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"text": "bot that like. helps with crypto stuff and is fun to talk 2"}' \
  http://localhost:10850/api/v1/agents/describe/rewrite | jq
```

```json
{
  "text": "A friendly assistant that helps with crypto-related questions in a fun, conversational tone."
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Missing/empty `text`, or `text` exceeds 8,000 characters |
| 403 | Not an admin key |
| 429 | Too many re-write requests in progress (max 2 concurrent) |
| 500 | Claude generation failed |
| 502 | Claude produced no usable output (empty after fence-stripping) |

---

## DELETE /api/v1/agents/:agentId {#delete-apiv1agentsagentid}

Remove an agent from `config.json` and stop the running process. Requires admin key. Does **not** delete the workspace directory.

```bash
curl -X DELETE \
  -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/my-bot | jq
```

```json
{ "success": true, "id": "my-bot" }
```

---
