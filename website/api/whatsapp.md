# WhatsApp Channel API {#whatsapp-channel-api}

Two independent WhatsApp integrations live side by side, each with its own config block and its own subset of endpoints:

- **Baileys device-link bridge** (`whatsapp` config block) — an unofficial WhatsApp Web multi-device bridge. One `WhatsAppManager` per linked number, multi-account per agent (`whatsapp.accounts[]`). Linking is via QR code or a text pairing code. Access control mirrors Telegram's model (`dmPolicy`/`pairing` for DMs, `groupPolicy` for groups) but is scoped **per account**, not per agent.
- **WhatsApp Business Cloud API** (`whatsapp_cloud` config block) — Meta's official webhook + REST integration. DM-only (the Cloud API has no group concept). Its credentials (`accessToken`, `phoneNumberId`, `appSecret`, `verifyToken`) are plain fields under `whatsapp_cloud` in `config.json` (interpolatable from the agent's `.env` the same way Telegram bot tokens are) — there is no REST endpoint to manage them. Only its pairing-discovery endpoints below exist as HTTP API.

Unlike the Telegram section above, these endpoints are **not** uniformly admin-gated: the `pending` routes require an **admin** key, everything else (`status`, `link`, `pairing-code`, `unlink`, `send`, `accounts`) requires a **write**-scoped key for that agent.

## Endpoints Overview {#endpoints-overview}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/agents/:agentId/whatsapp/pending` | Admin | List denied senders/groups pending pairing for one Baileys account |
| `DELETE` | `/api/v1/agents/:agentId/whatsapp/pending/:senderId` | Admin | Dismiss one pending knock for one Baileys account |
| `GET` | `/api/v1/agents/:agentId/whatsapp_cloud/pending` | Admin | List denied senders pending pairing for the WhatsApp Cloud channel |
| `DELETE` | `/api/v1/agents/:agentId/whatsapp_cloud/pending/:senderId` | Admin | Dismiss one pending knock on the WhatsApp Cloud channel |
| `GET` | `/api/v1/agents/:agentId/whatsapp/status` | Write | Live link status (status/QR/pairing code/number) for one Baileys account |
| `POST` | `/api/v1/agents/:agentId/whatsapp/link` | Write | Start (or restart) QR-code linking for one Baileys account |
| `POST` | `/api/v1/agents/:agentId/whatsapp/pairing-code` | Write | Start linking via a text pairing code instead of QR |
| `POST` | `/api/v1/agents/:agentId/whatsapp/unlink` | Write | Log out and wipe one Baileys account's linked session |
| `POST` | `/api/v1/agents/:agentId/whatsapp/send` | Write | Internal bridge route the `whatsapp_reply` MCP tool calls to send |
| `GET` | `/api/v1/agents/:agentId/whatsapp/accounts` | Write | List every Baileys account slot (config + live link state) |
| `POST` | `/api/v1/agents/:agentId/whatsapp/accounts` | Write | Add a new, empty, unlinked account slot |
| `DELETE` | `/api/v1/agents/:agentId/whatsapp/accounts/:accountId` | Write | Unlink and remove one account slot |

---

## GET /api/v1/agents/:agentId/whatsapp/pending {#get-apiv1agentsagentidwhatsapppending}

Recently denied senders/groups for **one linked Baileys number** (a discovery aid, same purpose as the Telegram pending list). Namespaced per account so the same JID can independently knock on two different numbers on the same agent.

`account_id` query param selects the account; omit it for the pre-multi-account `default` account.

```bash
curl -H "X-Api-Key: admin-key-456" \
  "http://localhost:10850/api/v1/agents/alfred/whatsapp/pending?account_id=default" | jq
```

```json
{
  "senders": [
    {
      "userId": "66812345678@s.whatsapp.net",
      "displayName": "Somchai",
      "kind": "user",
      "code": "A3F9C1",
      "firstSeen": 1775737709000,
      "lastSeen": 1775738309000,
      "count": 2
    }
  ]
}
```

---

## DELETE /api/v1/agents/:agentId/whatsapp/pending/:senderId {#delete-apiv1agentsagentidwhatsapppendingsenderid}

Dismiss one knock from one account's pending list. `:senderId` is a WhatsApp JID (DM sender or group), matched against the same `account_id` (default `default`) as the GET route above.

```bash
curl -X DELETE \
  -H "X-Api-Key: admin-key-456" \
  "http://localhost:10850/api/v1/agents/alfred/whatsapp/pending/66812345678%40s.whatsapp.net?account_id=default" | jq
```

```json
{ "ok": true }
```

---

## GET /api/v1/agents/:agentId/whatsapp_cloud/pending {#get-apiv1agentsagentidwhatsapp_cloudpending}

Recently denied senders for the WhatsApp Cloud channel (mirrors the Slack pending-list endpoint exactly). There is only one Cloud number per agent, so no `account_id` param.

```bash
curl -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/whatsapp_cloud/pending | jq
```

```json
{
  "senders": [
    {
      "userId": "66812345678",
      "displayName": "Somchai",
      "kind": "user",
      "code": "B7E2D0",
      "firstSeen": 1775737709000,
      "lastSeen": 1775738309000,
      "count": 1
    }
  ]
}
```

`userId` is a bare phone-number string (digits only, no `+`), never a JID — the Cloud API's inbound `from` field has no `@s.whatsapp.net` suffix.

---

## DELETE /api/v1/agents/:agentId/whatsapp_cloud/pending/:senderId {#delete-apiv1agentsagentidwhatsapp_cloudpendingsenderid}

Dismiss one knock from the WhatsApp Cloud pending list. `:senderId` is the bare phone-number string.

```bash
curl -X DELETE \
  -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/alfred/whatsapp_cloud/pending/66812345678 | jq
```

```json
{ "ok": true }
```

---

## GET /api/v1/agents/:agentId/whatsapp/status {#get-apiv1agentsagentidwhatsappstatus}

Live link status for one Baileys account, read straight from the in-process `WhatsAppManager` (never derived from config — there's no config field that would encode it). Polled by the web UI while linking and while showing the connected card.

`account_id` query param selects the account; omitting it targets the agent's first account (the only one for anyone who hasn't added a second).

```bash
curl -H "X-Api-Key: my-write-key-789" \
  "http://localhost:10850/api/v1/agents/alfred/whatsapp/status?account_id=default" | jq
```

```json
{
  "account_id": "default",
  "status": "pending_scan",
  "qr": "data:image/png;base64,iVBORw0KGgo...",
  "loggedOut": false
}
```

`status` is one of `unlinked`, `pending_scan`, `linked`, `reconnecting`. `qr` is present only while `status: "pending_scan"` and QR linking (not a pairing code) was requested; `pairingCode` is present instead when a pairing code was requested; `phoneNumber` is present only once `status: "linked"`.

**Error responses:**

| Status | When |
|--------|------|
| 400 | `account_id` names an account not configured for this agent |
| 403 | Key lacks write access to this agent |
| 404 | Agent not found |

---

## POST /api/v1/agents/:agentId/whatsapp/link {#post-apiv1agentsagentidwhatsapplink}

Start (or restart) a QR-code linking flow for one Baileys account. Returns immediately — poll `GET .../status` for the QR image once it's available.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `account_id` | No | Account to link. Defaults to the agent's first account (`default` if none configured) |

```bash
curl -X POST \
  -H "X-Api-Key: my-write-key-789" \
  -H "Content-Type: application/json" \
  -d '{"account_id": "default"}' \
  http://localhost:10850/api/v1/agents/alfred/whatsapp/link | jq
```

```json
{ "ok": true, "account_id": "default" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `account_id` names an account not configured for this agent |
| 403 | Key lacks write access to this agent |
| 404 | Agent not found |
| 500 | Baileys failed to start the linking flow |

---

## POST /api/v1/agents/:agentId/whatsapp/pairing-code {#post-apiv1agentsagentidwhatsapppairing-code}

Start linking via a text pairing code instead of a QR image.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `phoneNumber` | Yes | E.164 phone number to link (e.g. `"+66812345678"`) |
| `account_id` | No | Account to link. Defaults to the agent's first account |

```bash
curl -X POST \
  -H "X-Api-Key: my-write-key-789" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+66812345678", "account_id": "default"}' \
  http://localhost:10850/api/v1/agents/alfred/whatsapp/pairing-code | jq
```

```json
{ "pairingCode": "ABCD-1234", "account_id": "default" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `phoneNumber` missing/empty, or `account_id` names an account not configured for this agent |
| 403 | Key lacks write access to this agent |
| 404 | Agent not found |
| 500 | Baileys failed to issue a pairing code |

---

## POST /api/v1/agents/:agentId/whatsapp/unlink {#post-apiv1agentsagentidwhatsappunlink}

Log out and wipe one Baileys account's linked session. A fresh QR scan or pairing code is required afterward.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `account_id` | No | Account to unlink. Defaults to the agent's first account |

```bash
curl -X POST \
  -H "X-Api-Key: my-write-key-789" \
  -H "Content-Type: application/json" \
  -d '{"account_id": "default"}' \
  http://localhost:10850/api/v1/agents/alfred/whatsapp/unlink | jq
```

```json
{ "ok": true, "account_id": "default" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `account_id` names an account not configured for this agent |
| 403 | Key lacks write access to this agent |
| 404 | Agent not found |

---

## POST /api/v1/agents/:agentId/whatsapp/send {#post-apiv1agentsagentidwhatsappsend}

**Internal route** — called by the `whatsapp_reply` MCP tool (via `GATEWAY_API_URL`/`GATEWAY_API_KEY`, the same way every other MCP subprocess reaches the gateway), not meant for external API consumers. It exists because Baileys has no stateless per-call send path: all sends must go through the live socket the gateway process already holds, so the MCP tool cannot open its own connection.

Requires a **write**-scoped key. The target `jid` must already be allowed to receive messages from the resolved account (the same `dmPolicy`/`dmAllowlist` or `groupPolicy`/`groupAllowlist` gate that admits inbound messages) — a normal reply's `jid` is the chat the inbound message arrived on, so the golden path always passes.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `jid` | Yes | Target WhatsApp JID (`...@s.whatsapp.net`, `...@lid`, or `...@g.us` for a group) |
| `text` | No* | Message text. *One of `text`/`image_path` is required |
| `image_path` | No* | Absolute path to an image file to send. *One of `text`/`image_path` is required |
| `account_id` | No | Account to send from. Defaults to the last-inbound account for this chat, then `default`, then the agent's only account |
| `reply_to_message_id` | No | Quote an earlier message by id |
| `as_document` | No | Boolean. Send the image uncompressed as a document instead of a compressed photo |
| `message_id` | No | The inbound message whose ⏳ ack reaction should be cleared once this send lands |

```bash
curl -X POST \
  -H "X-Api-Key: my-write-key-789" \
  -H "Content-Type: application/json" \
  -d '{"jid": "66812345678@s.whatsapp.net", "text": "On my way!", "account_id": "default"}' \
  http://localhost:10850/api/v1/agents/alfred/whatsapp/send | jq
```

```json
{ "ok": true }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `jid` missing, neither `text` nor `image_path` provided, or `account_id` not a string |
| 403 | Key lacks write access to this agent, or `jid` is not allowed to receive messages from the resolved account |
| 404 | Agent not found |
| 502 | The underlying Baileys send failed |

---

## GET /api/v1/agents/:agentId/whatsapp/accounts {#get-apiv1agentsagentidwhatsappaccounts}

Every linked-number slot configured on this agent — config fields plus live link state, the same objects the agent response's `whatsapp_accounts` field carries.

```bash
curl -H "X-Api-Key: my-write-key-789" \
  http://localhost:10850/api/v1/agents/alfred/whatsapp/accounts | jq
```

```json
{
  "accounts": [
    {
      "id": "default",
      "label": null,
      "connected": true,
      "status": "linked",
      "number": "66812345678",
      "dm_policy": "allowlist",
      "dm_allowlist": ["66898765432@s.whatsapp.net"],
      "group_policy": null,
      "group_allowlist": [],
      "require_mention": null,
      "pairing": true
    }
  ]
}
```

---

## POST /api/v1/agents/:agentId/whatsapp/accounts {#post-apiv1agentsagentidwhatsappaccounts}

Add a new, empty, unlinked account slot. The number itself is linked afterward through the normal `POST .../whatsapp/link` or `.../whatsapp/pairing-code`, passing this `account_id`.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | 1-32 chars, lowercase letters/digits/`-`/`_`, must start with a letter or digit. Becomes the on-disk state-directory suffix — `"default"` can never be created here (it always already exists implicitly) |
| `label` | No | Display label shown in the Settings UI |

```bash
curl -X POST \
  -H "X-Api-Key: my-write-key-789" \
  -H "Content-Type: application/json" \
  -d '{"id": "sales-line", "label": "Sales line"}' \
  http://localhost:10850/api/v1/agents/alfred/whatsapp/accounts | jq
```

```json
{
  "account": {
    "id": "sales-line",
    "label": "Sales line",
    "connected": false,
    "status": "unlinked",
    "number": null,
    "dm_policy": null,
    "dm_allowlist": [],
    "group_policy": null,
    "group_allowlist": [],
    "require_mention": null,
    "pairing": true
  },
  "accounts": [ "..." ]
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `id` fails the slug pattern, or `label` is not a string/null |
| 403 | Key lacks write access to this agent |
| 404 | Agent not found |
| 409 | An account with this `id` already exists |
| 500 | No `configPath` available (agent management disabled), or the config write failed |

---

## DELETE /api/v1/agents/:agentId/whatsapp/accounts/:accountId {#delete-apiv1agentsagentidwhatsappaccountsaccountid}

Unlink the number (logout + wipe that account's session directory), tear down its manager, and drop it from config. The **last remaining account cannot be deleted** — use `POST .../whatsapp/unlink` instead, which keeps the slot but clears its session.

```bash
curl -X DELETE \
  -H "X-Api-Key: my-write-key-789" \
  http://localhost:10850/api/v1/agents/alfred/whatsapp/accounts/sales-line | jq
```

```json
{ "ok": true, "accounts": [ "..." ] }
```

**Error responses:**

| Status | When |
|--------|------|
| 403 | Key lacks write access to this agent |
| 404 | Agent or `:accountId` not found |
| 409 | `:accountId` is the only remaining account |
| 500 | Unlink or config write failed |

---

**WhatsApp Cloud (`whatsapp_cloud`) config:** there is no REST endpoint to manage it. `accessToken`, `phoneNumberId`, `appSecret`, `verifyToken`, `dmPolicy`, `dmAllowlist`, `pairing`, `sendReadReceipts`, `reactionLevel`, and `templatesEnabled` are all plain fields set directly in `config.json` (or `${ENV_VAR}`-interpolated from the agent's `.env`). `dmPolicy` uses the same `open` / `allowlist` / `disabled` model described in the Telegram policy table above; there is no group tier since the Cloud API has no group concept.

---
