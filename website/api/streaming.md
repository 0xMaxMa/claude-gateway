# Streaming API (SSE) {#streaming-api-sse}

Set `"stream": true` in the request body to receive a Server-Sent Events stream.

With semantic conversation intake enabled, contextual task acknowledgements also arrive as `text_delta` events before task execution, including web continuations of channel sessions. Acknowledgements belong to the requesting input; they do not consume pending reports from earlier tasks. Incomplete-material turns can finish with empty text while retaining their input history. See [conversation intake configuration](/guide/orchestration) for the configurable waiting interval.

```bash
curl -N -X POST \
  -H "X-Api-Key: my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message": "Explain this code", "chat_id": "myapp", "stream": true}' \
  http://localhost:10850/api/v1/agents/alfred/messages
```

**Response:**

```
data: {"type":"text_delta","text":"Let me","seq":1}
data: {"type":"text_delta","text":" explain...","seq":2}
data: {"type":"tool_use","name":"Read","id":"toolu_abc123","seq":3}
data: {"type":"text_delta","text":"Here's the explanation...","seq":4}
data: {"type":"result","text":"Here's the full explanation...","seq":5,"request_id":"550e8400-...","session_id":"abc-123","duration_ms":4200}
data: [DONE]

> When images are captured during the turn, the `result` event also includes `"attachments": [{"type":"image","url":"..."}]`.
```

> `seq` is the event's position **within this turn**, counting from 1 — it
> restarts at 1 on the next turn, so it is a cursor only in combination with the
> turn's `request_id`. Remember both: they are what
> [resuming an interrupted stream](/api/streaming#resuming-an-interrupted-stream) takes.
> (`data: [DONE]` is a stream terminator, not an event, and carries neither.)

## Requests with tool use {#requests-with-tool-use}

Tool access is resolved from the agent's explicit `allow_tools` value, falling back to the API key's `allow_tools` flag when the agent value is unset. This applies to sync and streaming requests. No request-body field grants tool access.

```bash
curl -N -X POST \
  -H "X-Api-Key: automation-key-789" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Run the setup script in /workspace and report the output",
    "chat_id": "myapp",
    "stream": true,
    "timeout_ms": 120000
  }' \
  http://localhost:10850/api/v1/agents/alfred/messages
```

> When the effective `allow_tools` value is false, requests remain conversational. The request body cannot enable tools.

**Workspace identity files are always protected in API sessions.**
Regardless of `allow_tools`, the agent will not create or update workspace identity files (`AGENTS.md`, `SOUL.md`, `MEMORY.md`, `CLAUDE.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) during an API session. If asked to remember something, the agent will decline. Memory updates require a Telegram or Cron session where the agent has full workspace access.

**Event types:**

> **⚠️ Breaking change — the soft timeout is no longer terminal.**
> Up to and including 1.8.2, a turn that passed `timeout_ms` emitted a terminal
> `{"type":"error","message":"Agent response timeout"}` and the stream ended
> there. It now emits a **non-terminal** `timeout` event instead, and the
> connection stays open until the turn finishes or the hard cap (a further 10
> minutes) fires.
>
> A client written against 1.8.2 or earlier that ignores unknown event types
> will not fail at `timeout_ms` any more — it will sit on an open connection for
> up to 10 extra minutes waiting for a terminal frame. **Handle `timeout`
> explicitly**: render it as "still working", and if you need the old cut-off,
> close the connection yourself when you receive it (the turn keeps running
> server-side and its reply is still persisted to history; you can read it back
> via [`GET …/stream`](/api/streaming#resuming-an-interrupted-stream) or from the session
> history).

Every event in the table below carries a `seq` — the turn-scoped sequence number
described above — in addition to its own fields. The `data: [DONE]` line that
closes the stream is a terminator, not an event, and has no fields at all.

| Type | Fields | Terminal | Description |
|------|--------|----------|-------------|
| `text_delta` | `text` | no | Incremental text chunk |
| `tool_use` | `name`, `id` | no | Tool invocation (e.g. Read, Grep, Bash) |
| `thinking` | `text` | no | Agent reasoning (if available) |
| `timeout` | `message`, `resumable: true` | **no** | The soft response budget elapsed, but the turn is still running — see below |
| `result` | `text`, `request_id`, `session_id`, `duration_ms`, `attachments?` | yes | Final aggregated result; `attachments` present only when images were captured |
| `error` | `message`, `code?` | yes | The turn failed |

Typed provider failures preserve the sanitized provider text in `message`, including reset wording and unfamiliar error types. Error classification and retry behavior are separate from presentation. Failures with only code/status use general guidance; internal failures without provider error evidence use `Internal error`.

The stream ends with `data: [DONE]` after `result`.

**Idle streams send a keepalive.** While a turn is working without producing
events — a long tool call, a slow model — the connection emits an SSE comment
line (`: keepalive`) every 15 seconds so a reverse proxy does not close it as
idle. Comment lines are discarded by every conforming SSE parser, carry no
`seq`, and never reach your event handler; if you parse the stream by hand,
ignore any line that starts with `:`.

**`timeout` is not a failure.** It means the turn passed `timeout_ms` without
finishing; the connection stays open and the turn keeps streaming, because the
subprocess is still working and its reply will still be persisted to history.
Render it as "still working", not as an error. Only `error` is a failure — that
includes the hard cap (a further 10 minutes), at which point the turn really is
abandoned.

**Branch on `code`, not on `message`.** An `error` event carries the originating
failure's code when it has one. The field is omitted when there is no code, so
treat it as optional. It is present on replayed frames too, so a client that
resumed through [`GET …/stream`](/api/streaming#resuming-an-interrupted-stream) learns exactly
what the original connection would have.

| `code` | Meaning | Is the turn still running? |
|--------|---------|----------------------------|
| `TIMEOUT` | The hard cap fired; the turn was interrupted with `SIGINT` | **No** — it is dead |
| `TIMEOUT_SOFT` | The caller's `timeout_ms` elapsed on an endpoint that cannot keep streaming the turn | **Yes** — its reply will land in history |
| `PROCESS_EXITED` | The subprocess crashed mid-turn | No |

`TIMEOUT` and `TIMEOUT_SOFT` are deliberately distinct: the two describe
opposite situations and their messages differ only by a tense and a full stop
(`Agent response timed out.` vs `Agent response timeout`), which is exactly the
kind of string-matching this field exists to replace.

**Which endpoints emit which timeout:**

| Endpoint | At `timeout_ms` | Hard cap | Resumable |
|----------|-----------------|----------|-----------|
| `POST …/messages` with `stream: true` | non-terminal `timeout` event, connection stays open | yes, +10 min → `error` / `TIMEOUT` | yes, via `GET …/stream` |
| `POST …/messages` (synchronous) | `504` response | yes, +10 min (server-side only) | no |
| Cross-channel live view (`POST …/chats/:chatId/sessions/:sessionId/messages`) | terminal `error` / `TIMEOUT_SOFT` | **none** | no |

The cross-channel live view keeps the pre-#421 behaviour on purpose: it has no
resume endpoint to reconnect through, so holding the connection open would buy
nothing. Its turn is *abandoned*, never interrupted — the agent keeps working
and the reply appears in the session history. Poll history, or start a fresh
turn.

**What the hard cap does.** At the cap the turn is *interrupted*, not merely
abandoned: the subprocess is sent `SIGINT` so it stops working and stops
consuming tokens. History gets exactly one assistant row for that turn — any
text the turn had already streamed, followed by `⚠️ Agent response timed out.`
A hard-capped turn never produces a later reply, so it can never leave both a
failure row and a reply row behind.

## Resuming an interrupted stream {#resuming-an-interrupted-stream}

A streamed turn is no longer bound to the request that started it. If the
connection drops — a browser reload, a flaky mobile network, a proxy idle
timeout — the turn keeps running server-side and its events keep being buffered,
so a new connection can pick it up where the old one left off.

### GET /api/v1/agents/:agentId/sessions/:sessionId/stream {#get-apiv1agentsagentidsessionssessionidstream}

Re-attach to the session's current turn. Replays every buffered event after the
cursor, then keeps streaming live events on the same connection, terminating
with the same `result` + `[DONE]` frames the original connection would have got.

| Query param | Description |
|-------------|-------------|
| `after_seq` | Resume after this sequence number. Omit (or `0`) to replay the turn from its first event. |
| `request_id` | The turn you mean to resume — the `request_id` its frames carry. **Required whenever `after_seq > 0`**; optional when replaying from the start, and the frames you get back report the turn's own `request_id` either way. |

```bash
# The stream died after seq 12 — pick the same turn back up.
curl -N -H "X-Api-Key: my-secret-key" \
  "http://localhost:10850/api/v1/agents/alfred/sessions/abc-123/stream?after_seq=12&request_id=req-abc"
```

Read access is enough — resuming a turn reads it, it does not start one.

**A cursor without a `request_id` is not a resume.** Sequence numbers restart at
1 for every turn, so `after_seq=12` alone does not say *which* turn's twelfth
event you saw. If the session has moved on to a later turn, that cursor lands
inside it and would replay a stream you were never watching, with everything
before seq 12 silently missing. The endpoint answers `400` instead: send the
`request_id` from the frames you received, or drop `after_seq` and replay the
current turn from its first event.

**A client that reloaded has no `request_id`, and that is fine.** Drop
`after_seq`, and the frames you get back carry the turn's own `request_id` —
which is what you feed to the next resume, cursor and all.

**Resuming is never a conflict.** `409` still means "you tried to start a second
turn on a busy session"; it is never the answer to a resume. When a turn cannot
be resumed the endpoint answers `410 Gone` with a `code` saying why:

| `code` | Meaning | What to do |
|--------|---------|------------|
| `TURN_GONE` | No turn for that session — it never ran, or it finished more than 2 minutes ago | Read the session's history |
| `TURN_MISMATCH` | The session has a turn, but not the `request_id` you asked for — yours is over | Read the session's history |
| `TURN_TRUNCATED` | That cursor's events have been evicted (see the buffer limits below) — only a non-zero `after_seq` can get this | Retry **without** `after_seq` |
| `CURSOR_AHEAD` | `after_seq` is past the turn's last event | Retry **without** `after_seq` |

Each response carries a `hint` field with the same advice.

**`CURSOR_AHEAD` and `TURN_TRUNCATED` are the two you can recover from without
history.** Both mean the turn is live and only your *cursor* is unusable — past
the turn's last event, or pointing into events the buffer has already dropped.
The answer to either is the same: drop `after_seq` and call again.

A completed turn stays replayable for **2 minutes** after its terminal frame,
which is what makes a reload immediately after the answer arrives still work. The
replayed `result` frame reports `duration_ms` for the turn itself, not for the
time since you reconnected.

**Starting a new turn ends the previous one's grace window immediately.** A
session holds at most one turn: the moment a new turn starts, the completed one
is dropped, even if less than 2 minutes have passed. So if two clients share a
`session_id` — a phone reloading to resume turn *N* while a laptop has already
posted turn *N+1* — the reload gets `TURN_MISMATCH` rather than the replay the
grace window otherwise promises. Read the session's history for that turn's
result; the reply was persisted regardless. Give each client its own session —
one [`POST /sessions`](/api/sessions#post-apiv1agentsagentidsessions) each — if you need their
turns to be independently resumable.

The buffer is bounded per turn — 2,000 events or ~4 MB, whichever comes first —
and once the oldest events are evicted, a cursor pointing into the evicted region
gets `TURN_TRUNCATED` rather than a replay with a silent hole in it. Replaying
from the start (no `after_seq`) is never refused, though: you get the oldest
event still buffered onwards, and the first frame's `seq` tells you how much of
the turn came before it. Nothing is actually lost — the terminal `result` carries
the turn's full text regardless of how much of the delta stream survived.

---
