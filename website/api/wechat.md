# WeChat Channel API {#wechat-channel-api}

A single personal WeChat account, linked via **QR code** through Tencent's own iLink Bot API bridge (`wechat` config block) — Tencent's self-serve product (`Tencent/openclaw-weixin` on GitHub), not a third-party grey-market bridge. Unlike Telegram/Discord/LINE/Slack, there is no credential field to set: linking is device-pairing, not a typed-in token, so this channel exposes only a link-status/link/unlink/send surface (mirrors the WhatsApp Baileys shape below) plus the same pending-discovery pair every allowlisted channel has. **DM-only** — no group tier exists, since the iLink bridge cannot reliably deliver WeChat group events. Inbound delivery is **long-polling** (`getupdates`, 35s timeout), not a webhook — there is no `/webhooks/wechat/...` route.

**Kill switch:** the whole channel can be disabled without a redeploy via the `WECHAT_CHANNEL_DISABLED` environment variable (opt-out — enabled by default). When set to `"true"`, `POST .../wechat/link` returns `500` with an explanatory message, and any previously-linked session is not resumed on gateway boot.

## Endpoints Overview {#endpoints-overview}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/wechat/status` | Write | Live link status (status/QR) from the in-process `WeChatManager` |
| `POST` | `/api/v1/agents/:agentId/wechat/link` | Write | Start (or restart) QR-code linking; resolves once linked or the attempt window elapses |
| `POST` | `/api/v1/agents/:agentId/wechat/unlink` | Write | Log out and wipe the linked session |
| `POST` | `/api/v1/agents/:agentId/wechat/send` | Write | Internal bridge route the `wechat_reply` MCP tool calls to send |
| `GET` | `/api/v1/agents/:agentId/wechat/pending` | Admin | List recently-denied WeChat senders pending pairing |
| `DELETE` | `/api/v1/agents/:agentId/wechat/pending/:senderId` | Admin | Dismiss one pending knock |

---

## GET /api/v1/agents/:agentId/wechat/status {#get-apiv1agentsagentidwechatstatus}

Live link status, read straight from the in-process `WeChatManager` (never config-derived — there is no credential field to derive it from).

```bash
curl -H "X-Api-Key: my-write-key-789" \
  http://localhost:10850/api/v1/agents/alfred/wechat/status | jq
```

```json
{ "status": "pending_scan", "qr": "data:image/png;base64,iVBORw0KGgo...", "loggedOut": false }
```

`status` is one of `unlinked`, `pending_scan`, `linked`, `reconnecting`. `qr` is present only while `status: "pending_scan"`.

**Error responses:**

| Status | When |
|--------|------|
| 403 | Key lacks write access to this agent |
| 404 | Agent not found |

---

## POST /api/v1/agents/:agentId/wechat/link {#post-apiv1agentsagentidwechatlink}

Start (or restart) a QR-code linking flow. Unlike WhatsApp's fire-and-forget `/whatsapp/link`, this call resolves once linked or once the attempt window (2 minutes) elapses — poll `GET .../status` for the QR image while waiting, or just await this call.

```bash
curl -X POST -H "X-Api-Key: my-write-key-789" \
  http://localhost:10850/api/v1/agents/alfred/wechat/link | jq
```

```json
{ "ok": true, "status": { "status": "linked", "loggedOut": false } }
```

**Error responses:**

| Status | When |
|--------|------|
| 403 | Key lacks write access to this agent |
| 404 | Agent not found |
| 500 | `WECHAT_CHANNEL_DISABLED` is `"true"`, or the iLink QR request failed |

---

## POST /api/v1/agents/:agentId/wechat/unlink {#post-apiv1agentsagentidwechatunlink}

Log out and wipe the linked session. A fresh QR scan is required afterward.

```bash
curl -X POST -H "X-Api-Key: my-write-key-789" \
  http://localhost:10850/api/v1/agents/alfred/wechat/unlink | jq
```

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 403 | Key lacks write access to this agent |
| 404 | Agent not found |

---

## POST /api/v1/agents/:agentId/wechat/send {#post-apiv1agentsagentidwechatsend}

**Internal route** — called by the `wechat_reply` MCP tool (via `GATEWAY_API_URL`/`GATEWAY_API_KEY`, the same way every other MCP subprocess reaches the gateway), not meant for external API consumers. It exists because the live iLink session (credentials, per-recipient context tokens) only exists inside the main gateway process — the same reasoning WhatsApp's Baileys socket needs for its own `/whatsapp/send` route.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `to_id` | Yes | iLink sender id to send to |
| `text` | Yes | Message text (auto-chunked at 4000 chars per iLink's documented per-message limit, split on line boundaries where possible) |

```bash
curl -X POST \
  -H "X-Api-Key: my-write-key-789" \
  -H "Content-Type: application/json" \
  -d '{"to_id": "wx_abc123", "text": "On my way!"}' \
  http://localhost:10850/api/v1/agents/alfred/wechat/send | jq
```

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `to_id` or `text` missing |
| 403 | Key lacks write access to this agent |
| 404 | Agent not found |
| 500 | The underlying iLink send failed |

---

## GET /api/v1/agents/:agentId/wechat/pending {#get-apiv1agentsagentidwechatpending}

Recently denied WeChat senders (Tier 1 allowlist discovery aid, admin only). Mirrors `GET .../line/pending` exactly.

```bash
curl -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/wechat/pending | jq
```

```json
{
  "senders": [
    { "userId": "wx_abc123", "displayName": null, "kind": "user", "code": "C4D8E1", "firstSeen": 1775737709000, "lastSeen": 1775738309000, "count": 1 }
  ]
}
```

---

## DELETE /api/v1/agents/:agentId/wechat/pending/:senderId {#delete-apiv1agentsagentidwechatpendingsenderid}

Dismiss one knock from the pending list (admin only). `:senderId` is an iLink sender id.

```bash
curl -X DELETE \
  -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/wechat/pending/wx_abc123 | jq
```

```json
{ "ok": true }
```

---

**WeChat (`wechat`) config:** there is no REST endpoint to manage it — WeChat has no credential to set, only access control. `dmPolicy`, `dmAllowlist`, `pairing`, and `botAgent` are all plain fields set directly in `config.json`. `dmPolicy` uses the same `open` / `allowlist` / `disabled` model described in the Telegram policy table above (closed by default); there is no group tier since the iLink bridge cannot reliably deliver WeChat group events. `botAgent` is a short, self-declared identity string (`base_info.bot_agent`) sent with every iLink request — analogous to an HTTP User-Agent, not used for auth or routing — defaulting to this package's own name when unset.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `WECHAT_CHANNEL_DISABLED` | unset (channel enabled) | Hard kill switch for the whole channel. Set to `"true"` to disable it without a redeploy — blocks new linking and skips resuming any previously-linked session on boot |
| `ILINK_BASE_URL` | `https://ilinkai.weixin.qq.com` | Override the iLink Bot API base URL |
| `WECHAT_ILINK_FAKE` | unset | Test-only. Set to `"true"` to use a fake iLink client instead of the real network client |

---
