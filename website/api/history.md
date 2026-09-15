# Chat History API {#chat-history-api}

Access per-agent conversation history stored in the history DB (SQLite). `chatId` uses the format `telegram-{rawId}`, `discord-{rawId}`, or `api-{rawId}`.

## GET /api/v1/agents/sessions {#get-apiv1agentssessions}

List all sessions across **all agents** in a single call. Admin key required. Queries each agent's history DB sequentially and returns a nested structure grouped by agent.

```bash
curl -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/agents/sessions | jq
```

```json
{
  "agents": [
    {
      "agentId": "alfred",
      "description": "Personal assistant",
      "sessions": [
        {
          "chatId": "telegram-997170033",
          "sessionId": "abc-123",
          "source": "telegram",
          "messageCount": 42,
          "createdAt": 1775737709000,
          "lastActivity": 1775823600000,
          "lastMessage": "Sure, I can help with that!",
          "sessionName": "Project Planning",
          "imageConfig": { "model": "openai/gpt-image-1", "quality": "medium" },
          "videoConfig": { "model": "grok-video/grok-imagine-video-1.5", "duration": 15 },
          "model": "claude-opus-4-8"
        }
      ]
    }
  ]
}
```

**Session fields:**

| Field | Type | Description |
|-------|------|-------------|
| `chatId` | string | Channel chat ID (`telegram-{id}` / `discord-{id}` / `api-{id}`) |
| `sessionId` | string | Unique session identifier |
| `source` | string | `telegram`, `discord`, or `api` |
| `messageCount` | number | Total messages in this session |
| `createdAt` | number | Session start timestamp (ms) |
| `lastActivity` | number | Last message timestamp (ms) |
| `lastMessage` | string\|null | Preview of the last message content |
| `sessionName` | string\|null | Human-readable session name (set via `/rename` or `POST /sessions`) |
| `imageConfig` | object\|null | Last `image_params` sent for this session (composer image-generation options); `null` when none set. Lets a web client restore the composer selection on reload. |
| `videoConfig` | object\|null | Last `video_params` sent for this session (composer video-generation options); `null` when none set. Lets a web client restore the composer selection on reload. |
| `model` | string\|null | Real Claude model that produced the session's latest turn, captured from the stream and updated every turn (so a mid-session `/model` switch is reflected). `null` for legacy sessions recorded before this was tracked, or when no turn has run yet. |

**Error responses:**

| Status | When |
|--------|------|
| 403 | Not an admin key |

---

## GET /api/v1/agents/:agentId/chats {#get-apiv1agentsagentidchats}

List all chats (across all channels) for an agent.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/agents/alfred/chats | jq
```

```json
{
  "chats": [
    { "chatId": "telegram-<CHAT_ID>", "messageCount": 42, "lastActivity": "2026-05-10T03:00:00.000Z" }
  ]
}
```

---

## GET /api/v1/agents/:agentId/chats/:chatId/sessions {#get-apiv1agentsagentidchatschatidsessions}

List sessions for a specific chat. Supports `telegram`, `discord`, and `api` chats.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/sessions" | jq
```

```json
{
  "sessions": [
    { "sessionId": "abc-123", "messageCount": 10, "createdAt": "2026-05-10T02:00:00.000Z", "lastActivity": "2026-05-10T03:00:00.000Z" }
  ]
}
```

**Error responses:**

| Status | When |
|--------|------|
| 403 | Key has no access to agent |
| 404 | Agent not found |

---

## GET /api/v1/agents/:agentId/chats/:chatId/messages {#get-apiv1agentsagentidchatschatidmessages}

Paginated message history (cursor-based). Returns messages in reverse chronological order by default; pass `order=asc` to read forward.

**Query parameters:**

| Param | Description |
|-------|-------------|
| `limit` | Max messages to return (default 50, max 1000). Values above the max are clamped; non-numeric, `0`, or negative fall back to the default. |
| `before` | Return messages before this timestamp (ms) |
| `after` | Return messages after this timestamp (ms) |
| `before_id` | Id component of the cursor, paired with `before`. Echo back `nextCursorId` here to page correctly across messages that share a `ts` (see below). Ignored without `before`. |
| `after_id` | Id component of the cursor, paired with `after` (the `order=asc` counterpart of `before_id`). Ignored without `after`. |
| `session_id` | Filter to a specific session |
| `order` | `asc` reads forward (oldest→newest) from `after`; `desc` (default) reads newest→oldest. Case-insensitive; any other value returns `400`. |

`before`, `after`, `before_id`, and `after_id` must be numeric; a present-but-non-numeric value returns `400`.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/messages?limit=20" | jq
```

```json
{
  "messages": [
    { "role": "assistant", "content": "Hi there!", "ts": 1775737712000, "sessionId": "abc-123" },
    { "role": "user", "content": "Hello!", "ts": 1775737709000, "sessionId": "abc-123" }
  ],
  "hasMore": true,
  "nextCursor": 1775737709000,
  "nextCursorId": 8412
}
```

When `hasMore` is `true`, the response carries a **composite cursor**: `nextCursor` (the boundary message's `ts`) and `nextCursorId` (its row id). `nextCursorId` is `null` whenever `nextCursor` is.

**Seek-forward example** (jump to a date and read that day's first messages in one round-trip):

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/messages?order=asc&after=<startOfDay-1>&limit=20" | jq
```

`nextCursor` continues forward via `after` when `order=asc` (vs. `before` for the default `desc`).

**Paging across equal-`ts` messages.** `ts` is millisecond-granular and not unique — an image burst coalesced into one turn, or rapid messages, can share a `ts`. To page a run of tied rows without skipping the remainder at the boundary, echo **both** cursor components back: `before=<nextCursor>&before_id=<nextCursorId>` for the default `desc`, or `after=<nextCursor>&after_id=<nextCursorId>` for `order=asc`. The query then matches the boundary as a composite `(ts, id)` tuple. Passing only `before`/`after` (the `ts`) remains valid and byte-for-byte backward compatible; it just retains the legacy behavior of dropping not-yet-shown rows that share the exact boundary `ts`.

---

## GET /api/v1/agents/:agentId/chats/:chatId/messages/search {#get-apiv1agentsagentidchatschatidmessagessearch}

Full-text search across messages using SQLite FTS5.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `q` | Yes | Search query string |
| `limit` | No | Max results (default 20, max 100) |
| `offset` | No | Pagination offset (default 0) |

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/messages/search?q=meeting" | jq
```

```json
{
  "messages": [
    { "role": "user", "content": "Schedule a meeting tomorrow", "ts": 1775737709000, "sessionId": "abc-123" }
  ],
  "total": 1
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `q` is missing or empty |

---

## GET /api/v1/agents/:agentId/chats/:chatId/messages/active-days {#get-apiv1agentsagentidchatschatidmessagesactive-days}

Returns the distinct **local calendar days** that have at least one message inside a `[from, to)`
window. Intended for a jump-to-date calendar: the client requests the visible month once and
draws a "has history" dot under each returned day, without paging the whole thread into memory.
The query rides the `(chat_id, ts)` index as a bounded range scan, so a one-month window returns
at most ~31 days.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `from` | Yes | Window start, UTC epoch ms, **inclusive** (`ts >= from`) |
| `to` | Yes | Window end, UTC epoch ms, **exclusive** (`ts < to`) |
| `tz_offset` | No | Viewer's timezone offset in **minutes east of UTC** (`local = UTC + offset`). Bangkok (UTC+7) is `+420`, India (UTC+5:30) is `+330`, New York (UTC-4 DST) is `-240`. Default `0` (UTC bucketing). Clients computing this from JavaScript should send `-new Date().getTimezoneOffset()` (that API returns the opposite sign). |
| `session_id` | No | Restrict to a single session (parity with the messages endpoint) |

Days are returned as `YYYY-MM-DD` strings, **distinct and sorted ascending**. An empty or
inverted window (`to <= from`) and a window with no messages both return `{ "days": [] }` with
status `200`. The window may span at most **366 days** (`to - from`); a larger range returns 400,
since the calendar only ever requests one visible month at a time.

> **Window is filtered in UTC, days are bucketed in local time.** `from`/`to` are matched against
> the raw stored `ts` (UTC ms), while the returned day labels use `tz_offset`. For a viewer east of
> UTC, the first local day of a month begins *before* its UTC midnight (e.g. Bangkok's `2026-07-01`
> starts at `2026-06-30T17:00Z`). Send `from`/`to` covering the visible month **in the viewer's
> local time** — i.e. widen the UTC window by `tz_offset` — so edge days aren't under-counted.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/messages/active-days?from=1751328000000&to=1754006400000&tz_offset=420" | jq
```

```json
{
  "days": ["2026-07-02", "2026-07-03", "2026-07-05", "2026-07-09"]
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `from` or `to` is missing or non-numeric |
| 400 | `tz_offset` is present but non-numeric |
| 400 | window is larger than 366 days (`to - from`) |

---

## POST /api/v1/agents/:agentId/chats/:chatId/sessions/:sessionId/messages {#post-apiv1agentsagentidchatschatidsessionssessionidmessages}

Inject a message into an existing Telegram, Discord, or API session and stream the assistant's response via SSE. Useful for cross-channel continuation.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `content` | Yes | Message text (max 10,000 chars) |
| `senderName` | No | Optional display name for the injected message |

```bash
curl -N -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"content": "Continue from where we left off", "senderName": "API"}' \
  "http://localhost:10850/api/v1/agents/alfred/chats/telegram-<CHAT_ID>/sessions/abc-123/messages"
```

**Response** (SSE stream):

```
data: {"type":"text_delta","text":"Sure, let me continue..."}
data: {"type":"result","text":"Sure, let me continue...","session_id":"abc-123"}
data: [DONE]
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | `content` is missing or too long |
| 403 | Key has no access to agent |
| 404 | Agent not found |

**Timeouts differ from the main messages endpoint.** This stream has a fixed
60-second budget, and passing it is **terminal** here: the connection closes
with `{"type":"error","message":"Agent response timeout","code":"TIMEOUT_SOFT"}`.
There is no `timeout` event, no hard cap, and no resume endpoint for this path —
the turn is abandoned, not interrupted, so the agent keeps working and its reply
still lands in the session history. Read it back from
[`GET …/chats/:chatId/sessions`](/api/history#get-apiv1agentsagentidchatschatidsessions) or
start a fresh turn. See [Streaming API (SSE)](/api/streaming#streaming-api-sse) for how
`TIMEOUT_SOFT` differs from `TIMEOUT`.

---
