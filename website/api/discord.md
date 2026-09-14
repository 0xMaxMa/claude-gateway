# Discord Channel Management {#discord-channel-management}

Incoming-first pairing for Discord, mirroring the Telegram model. DMs use
`dmPolicy` + the `pairing` toggle; guilds (servers) use `groupPolicy` +
`guildAllowlist` + a single `requireMention` gate. `channelAllowlist` and
`roleAllowlist` remain backend-only filters. Guild ids are numeric snowflakes
(no leading minus).

## Endpoints Overview {#endpoints-overview}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/discord/pending` | Admin | List pending (non-expired) pairing requests |
| `POST` | `/api/v1/agents/:agentId/discord/approve` | Admin | Approve a pending pairing by code (kind-aware) |
| `POST` | `/api/v1/agents/:agentId/discord/deny` | Admin | Deny and remove a pending pairing by code |
| `PATCH` | `/api/v1/agents/:agentId/discord/policy` | Admin | Update DM policy, pairing toggle, guild policy and/or mention gate |
| `GET` | `/api/v1/agents/:agentId/discord/allowlist` | Admin | List all users in the allowlist |
| `DELETE` | `/api/v1/agents/:agentId/discord/allow/:userId` | Admin | Remove a user from the allowlist |
| `GET` | `/api/v1/agents/:agentId/discord/guild/allowlist` | Admin | List allowlisted guild ids |
| `DELETE` | `/api/v1/agents/:agentId/discord/guild/allow/:guildId` | Admin | Remove a guild from the guild allowlist |

---

## GET /api/v1/agents/:agentId/discord/pending {#get-apiv1agentsagentiddiscordpending}

List all pending (non-expired) Discord pairing requests. Expired entries are
cleaned up automatically on this call.

```json
{
  "pending": [
    {
      "code": "A3F9C1",
      "senderId": "111111111111111111",
      "channelId": "222222222222222222",
      "createdAt": 1775737709000,
      "expiresAt": 1775738309000,
      "kind": "dm",
      "guildId": null
    }
  ]
}
```

`kind` is `"dm"` or `"guild"`; for a guild knock, `guildId` holds the server id.

---

## POST /api/v1/agents/:agentId/discord/approve {#post-apiv1agentsagentiddiscordapprove}

Approve a pending pairing by code. **Kind-aware:** a `"dm"` knock adds the sender
to `allowFrom` and drops an `approved/<senderId>` handshake file (content is the
`channelId` to DM the "You're connected!" reply); a `"guild"` knock adds its
`guildId` to `guildAllowlist` (no handshake).

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `code` | Yes | 6-character pairing code |

```json
{ "ok": true, "senderId": "111111111111111111" }
```

For a guild knock the response also carries `"guildId"`:

```json
{ "ok": true, "senderId": "111111111111111111", "guildId": "333333333333333333" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `code` missing |
| 404 | Code not found or expired |

---

## POST /api/v1/agents/:agentId/discord/deny {#post-apiv1agentsagentiddiscorddeny}

Deny and remove a pending pairing request by code.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `code` | Yes | 6-character pairing code |

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `code` missing |
| 404 | Code not found |

---

## PATCH /api/v1/agents/:agentId/discord/policy {#patch-apiv1agentsagentiddiscordpolicy}

Update the DM policy, the pairing toggle, the guild policy and/or the guild
mention gate. **At least one field must be present**; each is applied only if
provided.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `dmPolicy` | No | One of `open`, `allowlist`, `disabled` |
| `pairing` | No | Boolean — same semantics as Telegram (mint code vs pure allowlist) |
| `groupPolicy` | No | One of `open`, `allowlist`, `disabled` — base policy for guilds |
| `requireMention` | No | Boolean. When `true`, guild messages are delivered only when the bot is @mentioned or replied-to |

```bash
curl -X PATCH \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"dmPolicy": "allowlist", "pairing": true, "groupPolicy": "allowlist", "requireMention": true}' \
  http://localhost:10850/api/v1/agents/alfred/discord/policy | jq
```

```json
{ "ok": true, "dmPolicy": "allowlist", "pairing": true, "groupPolicy": "allowlist", "requireMention": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Invalid value, non-boolean `pairing`/`requireMention`, or no field provided |

---

## GET /api/v1/agents/:agentId/discord/allowlist {#get-apiv1agentsagentiddiscordallowlist}

Return all users in the `allowFrom` list for the agent's Discord channel.

```json
{ "allowFrom": ["111111111111111111"] }
```

---

## DELETE /api/v1/agents/:agentId/discord/allow/:userId {#delete-apiv1agentsagentiddiscordallowuserid}

Remove a user from the `allowFrom` list. `:userId` must be a numeric Discord user ID.

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `userId` is not numeric |
| 404 | Agent not found |

---

## GET /api/v1/agents/:agentId/discord/guild/allowlist {#get-apiv1agentsagentiddiscordguildallowlist}

Return the allowlisted guild ids for the agent's Discord channel.

```json
{ "guildAllowlist": ["333333333333333333"] }
```

---

## DELETE /api/v1/agents/:agentId/discord/guild/allow/:guildId {#delete-apiv1agentsagentiddiscordguildallowguildid}

Remove a guild from the `guildAllowlist`. `:guildId` must be a numeric Discord
guild snowflake.

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `guildId` is not numeric |
| 404 | Agent not found |

---
