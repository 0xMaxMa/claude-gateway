# PTY Shell API {#pty-shell-api}

Available only for agents running in wrap-shell (PTY) mode (`gateway.headless: false`).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/sessions/:sessionId/screen` | Key | Read the current visible screen as plain text — ANSI stripped, trailing blanks removed |

**Response:**

```json
{
  "text": "plain text content of the screen\ncursor is here",
  "cursorRow": 12,
  "cursorCol": 4,
  "cols": 200,
  "rows": 50
}
```

- `text` — visible screen rows joined by `\n`, trailing blank lines stripped. Suitable for agent consumption (detect menus, prompts, hang states).
- `cursorRow` / `cursorCol` — zero-based cursor position in the terminal grid.
- `cols` / `rows` — terminal dimensions (matches server PTY size).

Returns `404` if the session does not exist or is not running in wrap-shell mode.

**Example:**

```bash
curl -s http://localhost:10850/api/v1/sessions/<sessionId>/screen \
  -H "X-Api-Key: <key>"
```

The `sessionId` is the gateway session UUID. Find it from the process list:

```bash
# /processes requires an admin API key when gateway.api.keys is configured
curl -s -H "X-Api-Key: $KEY" http://localhost:10850/processes | grep -o 'sessions/[^/]*' | head -1
```

### Live screen stream (WebSocket) {#live-screen-stream-websocket}

For a real-time mirror of the PTY (instead of a one-shot snapshot), connect to the
PTY stream WebSocket. Streams are **per session**, so a `session` is always required —
each session of an agent is an isolated stream.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/v1/pty-stream-ticket` | Admin key *or* dashboard session | Exchange an **admin** API key **or** the `dash_session` cookie for a one-time, 30s-TTL ticket bound to a specific `{ agentId, sessionId }` |
| `WS` | `/api/v1/agents/:agentId/pty-stream` | Ticket *or* Key | Subscribe to the live PTY stream for one session |

> The browser dashboard authenticates with the `HttpOnly; SameSite=Lax` `dash_session`
> cookie (from `POST /dashboard/login`), which is sent automatically — it no longer embeds
> any token in the page. `POST /api/v1/pty-stream-ticket` accepts that cookie, so
> the ticket flow works without a token in the HTML or the WS URL.

**Auth path 1 — ephemeral ticket (used by the browser viewer):**

```bash
# 1. Mint a ticket (the ticket is bound to this sessionId)
curl -s -X POST http://localhost:10850/api/v1/pty-stream-ticket \
  -H "X-Api-Key: <key>" -H "Content-Type: application/json" \
  -d '{"agentId":"<agentId>","sessionId":"<sessionId>"}'
# → { "ticket": "<hex>", "expiresAt": "..." }

# 2. Connect (no API key on the URL — the ticket carries the session binding)
#    ws://localhost:10850/api/v1/agents/<agentId>/pty-stream?ticket=<hex>
```

**Auth path 2 — header auth (programmatic clients):** pass the API key as a header
(`X-Api-Key` or `Authorization: Bearer`) **and** the session as a query param:

```
ws://localhost:10850/api/v1/agents/<agentId>/pty-stream?session=<sessionId>
```

> **Required:** the header-auth path returns `400 Bad Request` if `?session=` is
> omitted (streams are per session — there is no agent-wide stream). The ticket path
> does not need `?session=` because the ticket is already bound to one session.

Closes with code `4404` if the session is not running in PTY mode.

**Direction:** the stream is server → client (live PTY output) by default, and the socket is bidirectional: inbound **text** frames carry raw keystroke bytes that are written into the live PTY (interactive terminal mode), bounded per frame and dropped for headless sessions. A dashboard viewer only sends these frames while its mode toggle is in input mode (a client-side choice); binary and oversized/empty frames are always dropped. Access is protected by the socket's auth (ticket/API key) and the localhost-default [`gateway.bind`](/reference/configuration) — see the [Terminal Viewer](/api/terminal) docs.

**Auth levels:** `Key` = any valid API key, `Write` = key with write access to the agent, `Admin` = key with `admin: true` (wildcard agent scope alone is insufficient).

---
