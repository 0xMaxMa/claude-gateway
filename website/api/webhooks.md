# Public Webhook Ingress {#public-webhook-ingress}

For channel setup, see [LINE](/channels/line), [Slack](/channels/slack) and [WhatsApp Cloud](/channels/whatsapp-cloud). The provider dispatch also accepts `app: "whatsapp_cloud"`; its GET verification and signed POST deliveries use the same `/webhooks/:app/:agentId` surface.

## LINE pending senders

### GET /api/v1/agents/:agentId/line/pending

Requires an admin API key. Returns `{ "senders": [] }` with up to five recently denied senders for this agent's LINE channel. Each entry has `userId`, `firstSeen`, `lastSeen` (Unix milliseconds) and `count`; optional fields are `displayName`, `kind` (`user`, `group` or `room`) and a pairing `code`. This list is held in memory and clears on restart. A repeated sender updates its count and timestamp; older entries are evicted when the cap is exceeded.

```bash
curl --fail http://127.0.0.1:10850/api/v1/agents/assistant/line/pending \
  -H "X-Api-Key: $CLAUDE_GATEWAY_API_KEY"
```

### DELETE /api/v1/agents/:agentId/line/pending/:senderId

Requires an admin API key. Dismiss a pending LINE user, group or room identifier. Returns `{ "ok": true }`, including when the identifier is already absent. This does not add the sender to an allowlist; another denied message may add it again. Use the agent PATCH API to persist an access policy change.

Both routes return `403` for a non-admin key and `404` for an unknown agent, in addition to API authentication errors.

## Provider verification and delivery

All external, unauthenticated webhooks (LINE today; more apps can be added later) enter
through a single dispatcher route `/webhooks/:app/:agentId?`, routed to a per-app handler
by the `:app` path segment.

**This zone bypasses the gateway's API-key auth entirely** — it is mounted outside the
`/api` routers, before `express.json()`, so each handler gets the raw request bytes it
needs for its own signature validation. There is no ambient auth: every app handler
(e.g. LINE's `x-line-signature` HMAC check) **must authenticate its own requests** as its
first step.

Request bodies on this route are capped at 256KB (pre-auth cap, applies to every app).
An unknown `:app` returns `404`:

```bash
curl http://localhost:10850/webhooks/nope
```

```json
{ "error": "unknown webhook app: nope" }
```

## LINE (`app: "line"`) {#line-app-line}

**Setup:** configure `line.channelSecret` + `line.channelAccessToken` for an agent via
`PATCH /api/v1/agents/:agentId` (see Agent API above), then point the LINE Developer
Console's webhook URL at:

```
https://<your-gateway-host>/webhooks/line/<agentId>
```

`<agentId>` may be omitted — the dispatcher then falls back to the first agent with
`line.channelSecret` set — but an explicit ID is recommended once more than one agent has
LINE configured.

**Verification (`GET`):** LINE's Console "Verify" button sends a GET (or empty POST); the
handler answers unconditionally:

```json
{ "ok": true }
```

**Inbound delivery (`POST`):** the request must carry a valid `x-line-signature` header
(HMAC-SHA256 of the raw body, keyed by `channelSecret`, base64-encoded).

```bash
BODY='{"events":[{"type":"message","message":{"type":"text","id":"1","text":"hi"},"source":{"type":"user","userId":"Uxxxx"},"replyToken":"xxx","timestamp":1234567890}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "<CHANNEL_SECRET>" -binary | base64)
curl -X POST http://localhost:10850/webhooks/line/<agentId> \
  -H "Content-Type: application/json" \
  -H "x-line-signature: $SIG" \
  -d "$BODY"
```

Text, image, and file messages from allowed 1:1/group/room sources are normalized and
forwarded to the agent's `/channel` intake (the same path Telegram uses). Image and file
bytes are fetched via the LINE blob API and handed to the agent as `meta.image_path`; a
file also carries `meta.attachment_kind: "document"` and `meta.attachment_name` (the
sanitized sender-supplied name). LINE sends no MIME type for a file, so the stored
extension is derived from that name and constrained to a short alphanumeric run —
anything unusable, or any type a browser would render as active content (the HTML and
XML families, script and style), is stored as `.bin`. When the bytes cannot be fetched —
over the 20 MB media cap, an empty upload, or a failed transfer — the turn is still
forwarded, with no `meta.image_path` and a `content` that states the file is not
available and why, so the agent never mistakes a lost attachment for one it has yet to
open. Sticker, video, and location messages are ignored. Audio messages are transcribed when orchestration and the Agent’s voice-note recognition are enabled; legacy mode ignores audio. The
request is acknowledged (`200 {"ok":true}`) **before** event processing, so LINE never
sees a slow response.

**Error responses:**

| Status | When |
|--------|------|
| 401 | Missing or invalid `x-line-signature` (the resolved agent always has `channelSecret` set — see the 404 row below) |
| 404 | No LINE-enabled agent found — no agent has `line.channelSecret` set, or the given `:agentId` doesn't |

**Access control:** DMs and groups/rooms are closed by default (`dmPolicy` /
`groupPolicy` allowlist, per agent config); a denied sender receives a one-time pairing
code (via LINE reply) to share with the admin, who approves it the same way as Telegram
pairing.

## Slack (`app: "slack"`) {#slack-app-slack}

**Setup:** configure `slack.botToken` (Bot User OAuth Token, `xoxb-…`) +
`slack.signingSecret` for an agent via `PATCH /api/v1/agents/:agentId` (see Agent API
above — both must be sent together, and the token is validated with `auth.test` at save
time). Then, in the Slack app's **Event Subscriptions**, point the Request URL at:

```
https://<your-gateway-host>/webhooks/slack/<agentId>
```

Subscribe the bot to `message.im` (DMs) and `app_mention` (channel mentions). **Socket
Mode must be off** — this is the HTTP Request URL integration, not Socket Mode.

`<agentId>` may be omitted — the dispatcher then falls back to the first agent with
`slack.signingSecret` set — but an explicit ID is recommended once more than one agent has
Slack configured.

**URL verification (`POST`):** Slack's one-time handshake arrives as a *signed* POST with
`{"type":"url_verification","challenge":"…"}` (unlike LINE's unsigned Console button). The
signature is verified like any other request, then the raw `challenge` is echoed back:

```json
{ "challenge": "<the value Slack sent>" }
```

**Inbound delivery (`POST`):** the request must carry a valid `x-slack-signature` header —
`v0=` + HMAC-SHA256 of `v0:{timestamp}:{rawBody}`, keyed by `signingSecret` — together with
`x-slack-request-timestamp`. Requests whose timestamp is more than 5 minutes from now are
rejected (replay protection).

```bash
TS=$(date +%s)
BODY='{"type":"event_callback","event_id":"Ev1","authorizations":[{"user_id":"U0BOT"}],"event":{"type":"app_mention","channel":"C123","user":"U456","text":"<@U0BOT> hi","ts":"1.2","event_ts":"1.2"}}'
SIG="v0=$(printf 'v0:%s:%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "<SIGNING_SECRET>" | sed 's/^.* //')"
curl -X POST http://localhost:10850/webhooks/slack/<agentId> \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: $TS" \
  -H "x-slack-signature: $SIG" \
  -d "$BODY"
```

Text messages from allowed DMs and `@mention`s in allowed channels are normalized and
forwarded to the agent's `/channel` intake (the same path Telegram/LINE use); the bot's own
self-mention is stripped from `app_mention` text. The request is acknowledged
(`200 {"ok":true}`) **before** event processing, so Slack never sees a slow response and its
3-second-ack retry is avoided. Duplicate retries (Slack's at-least-once delivery) are
de-duplicated by `event_id`.

**Error responses:**

| Status | When |
|--------|------|
| 401 | Missing or invalid `x-slack-signature` (or a timestamp outside the 5-minute window) |
| 400 | Body was not valid JSON |
| 404 | No Slack-enabled agent found — no agent has `slack.signingSecret` set, or the given `:agentId` doesn't |

**Access control:** DMs (gated on the sender's Slack user id) and channels (gated on the
channel id) are closed by default (`slack.dmPolicy` / `slack.groupPolicy` allowlist, per
agent config); allowlist entries MUST be stable Slack ids (`U…` for users, `C…` for
channels), never display/channel names. A denied sender receives a one-time pairing code
(via `chat.postMessage`) to share with the admin, who approves it the same way as Telegram
pairing. In channels, only `@mention`s are answered unless `slack.requireMention` is set to
`false`.

**Pending-sender discovery (admin only):** the recently-denied Slack senders/channels are
surfaced for one-click allowlisting, mirroring LINE:

| Method | Endpoint | Auth |
|--------|----------|------|
| `GET` | `/api/v1/agents/:agentId/slack/pending` | Admin key — list recently-denied Slack senders (id, best-effort name, pairing code) |
| `DELETE` | `/api/v1/agents/:agentId/slack/pending/:senderId` | Admin key — dismiss one knock from the in-memory pending list |

---
