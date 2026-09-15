# Telegram Channel API {#telegram-channel-api}

Manage Telegram access control per agent — pending pairings, allowlist, and DM policy. All endpoints require an **admin** key.

## Endpoints Overview {#endpoints-overview}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/telegram/pending` | Admin | List pending (non-expired) pairing requests |
| `POST` | `/api/v1/agents/:agentId/telegram/approve` | Admin | Approve a pending pairing by code (kind-aware) |
| `POST` | `/api/v1/agents/:agentId/telegram/deny` | Admin | Deny and remove a pending pairing by code |
| `PATCH` | `/api/v1/agents/:agentId/telegram/policy` | Admin | Update DM policy, pairing toggle, group policy and/or mention gate |
| `GET` | `/api/v1/agents/:agentId/telegram/allowlist` | Admin | List all users in the allowlist |
| `DELETE` | `/api/v1/agents/:agentId/telegram/allow/:userId` | Admin | Remove a user from the allowlist |
| `GET` | `/api/v1/agents/:agentId/telegram/group/allowlist` | Admin | List allowlisted group ids |
| `DELETE` | `/api/v1/agents/:agentId/telegram/group/allow/:groupId` | Admin | Remove a group from the group allowlist |

---

## GET /api/v1/agents/:agentId/telegram/pending {#get-apiv1agentsagentidtelegrampending}

List all pending (non-expired) Telegram pairing requests for an agent. Expired entries are cleaned up automatically on this call.

```bash
curl -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/telegram/pending | jq
```

```json
{
  "pending": [
    {
      "code": "A3F9C1",
      "senderId": "123456789",
      "chatId": "123456789",
      "createdAt": 1775737709000,
      "expiresAt": 1775738309000,
      "kind": "dm"
    }
  ]
}
```

`kind` is `"dm"` for a direct-message knock or `"group"` for a group knock (for a
group knock, `chatId` holds the group id).

---

## POST /api/v1/agents/:agentId/telegram/approve {#post-apiv1agentsagentidtelegramapprove}

Approve a pending pairing by its 6-character code. **Kind-aware:** a `"dm"` knock
adds the sender to `allowFrom` and drops an `approved/<senderId>` handshake file
so the receiver sends a confirmation; a `"group"` knock adds its `chatId` to
`groupAllowlist` (no handshake — a group has no single recipient).

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `code` | Yes | 6-character pairing code |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"code": "A3F9C1"}' \
  http://localhost:10850/api/v1/agents/alfred/telegram/approve | jq
```

```json
{ "ok": true, "senderId": "123456789" }
```

For a group knock the response also carries `"groupId"`:

```json
{ "ok": true, "senderId": "123456789", "groupId": "-1001234567890" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `code` missing |
| 404 | Code not found or expired |

---

## POST /api/v1/agents/:agentId/telegram/deny {#post-apiv1agentsagentidtelegramdeny}

Deny and remove a pending pairing request by code.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `code` | Yes | 6-character pairing code |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"code": "A3F9C1"}' \
  http://localhost:10850/api/v1/agents/alfred/telegram/deny | jq
```

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `code` missing |
| 404 | Code not found |

---

## PATCH /api/v1/agents/:agentId/telegram/policy {#patch-apiv1agentsagentidtelegrampolicy}

Update the DM policy, the orthogonal pairing toggle, the group policy and/or the
group mention gate. **At least one field must be present**; each is applied only
if provided.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `dmPolicy` | No | One of `open`, `allowlist`, `disabled` |
| `pairing` | No | Boolean. When `dmPolicy` is `allowlist`: `true` mints a one-time code for an unknown sender; `false` silently drops (pure allowlist). Ignored for `open`/`disabled` |
| `groupPolicy` | No | One of `open`, `allowlist`, `disabled` — base policy for groups |
| `requireMention` | No | Boolean. When `true`, group messages are delivered only when the bot is @mentioned |

```bash
curl -X PATCH \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"dmPolicy": "allowlist", "pairing": true, "groupPolicy": "allowlist", "requireMention": true}' \
  http://localhost:10850/api/v1/agents/alfred/telegram/policy | jq
```

```json
{ "ok": true, "dmPolicy": "allowlist", "pairing": true, "groupPolicy": "allowlist", "requireMention": true }
```

> **Note:** `pairing` is now a separate boolean, **not** a `dmPolicy` value. A
> legacy `dmPolicy: "pairing"` file migrates automatically to
> `dmPolicy: "allowlist"` + `pairing: true`.

**Policy values (`dmPolicy` / `groupPolicy`):**

| Value | Behaviour |
|-------|-----------|
| `open` | Any user / any group can message the bot (senders/groups are captured into the allowlist) |
| `allowlist` | Only allowlisted users / groups can message; unknown senders get a pairing code when `pairing: true`, else are dropped |
| `disabled` | No messages accepted |

**Error responses:**

| Status | When |
|--------|------|
| 400 | Invalid value, non-boolean `pairing`/`requireMention`, or no field provided |

---

## GET /api/v1/agents/:agentId/telegram/allowlist {#get-apiv1agentsagentidtelegramallowlist}

Return all users in the `allowFrom` list for the agent's Telegram channel.

```bash
curl -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/telegram/allowlist | jq
```

```json
{ "allowFrom": ["123456789", "987654321"] }
```

---

## DELETE /api/v1/agents/:agentId/telegram/allow/:userId {#delete-apiv1agentsagentidtelegramallowuserid}

Remove a user from the `allowFrom` list. `:userId` must be a numeric Telegram user ID.

```bash
curl -X DELETE \
  -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/telegram/allow/123456789 | jq
```

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `userId` is not numeric |
| 404 | Agent not found |

---

## GET /api/v1/agents/:agentId/telegram/group/allowlist {#get-apiv1agentsagentidtelegramgroupallowlist}

Return the allowlisted group ids for the agent's Telegram channel.

```bash
curl -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/telegram/group/allowlist | jq
```

```json
{ "groupAllowlist": ["-1001234567890"] }
```

---

## DELETE /api/v1/agents/:agentId/telegram/group/allow/:groupId {#delete-apiv1agentsagentidtelegramgroupallowgroupid}

Remove a group from the `groupAllowlist`. Telegram group ids are negative, so a
leading minus is allowed (e.g. `-1001234567890`). Also drops any legacy per-sender
restriction retained for that group.

```bash
curl -X DELETE \
  -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/telegram/group/allow/-1001234567890 | jq
```

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `groupId` is not a numeric Telegram chat ID |
| 404 | Agent not found |

---
