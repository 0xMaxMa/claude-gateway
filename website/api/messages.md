# Messages API {#messages-api}

## POST /api/v1/agents/:agentId/messages {#post-apiv1agentsagentidmessages}

Send a message to an agent. Returns a JSON response or SSE stream.

> **Breaking change (PR #69):** `chat_id` is now required. Messages are stored under `sessions/api-{chat_id}/` on disk.
>
> **Breaking change:** `session_id` now *resumes* a session and nothing else. An id
> the gateway has never issued returns `404 SESSION_NOT_FOUND` instead of quietly
> becoming a brand-new session under that name. Clients that minted their own ids
> must either call [`POST /sessions`](/api/sessions#post-apiv1agentsagentidsessions) first and
> use the id it returns, or omit `session_id` and adopt the one in the response.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `message` | Yes | Message text (max 10,000 chars), or a slash command (e.g. `/session`, `/clear`) |
| `chat_id` | Yes | Caller identity — used to namespace sessions (e.g. `"myapp"`, `"user-123"`) |
| `session_id` | No | Resume an existing session under this `chat_id`; omit to start a new one. Must already exist — an unknown id is `404`, never a new session |
| `stream` | No | `true` to enable SSE streaming (default `false`) |
| `timeout_ms` | No | Override the default response timeout in milliseconds (default 60000) |
| `media_files` | No | Array of `mediaPath` strings returned by the Media Upload endpoint |
| `store_user_message` | No | Set to `false` to skip persisting the user message in session history — only the assistant response is stored. Requires a write or admin key. Useful for proactive/trigger prompts where the user trigger should be invisible. |
| `image_params` | No | Composer-selected image-generation options, surfaced to the agent so it calls the built-in `generate_image` tool with them. An object with optional string fields `model`, `quality`, `size`, `aspect_ratio`, `image_ref` and optional positive number `n`. Empty/whitespace strings are ignored; a non-object (or `n < 1`) returns `400`. The latest sent value is persisted to session meta as `imageConfig` (see the sessions list endpoint) so a web client can restore the selection on reload. |
| `video_params` | No | Composer-selected video-generation options, surfaced to the agent so it calls the built-in `generate_video` tool with them (model/duration/aspect made authoritative — no invented cap, no scene split). An object with optional string fields `model`, `resolution`, `aspect_ratio`, `image_ref` (source frame for image-to-video) and optional positive integer `duration`. Empty/whitespace strings are ignored; a non-object (or `duration < 1`) returns `400`. The latest sent value is persisted to session meta as `videoConfig` (see the sessions list endpoint) so a web client can restore the selection on reload. |

### Slash command dispatch {#slash-command-dispatch}

If `message` starts with `/`, the endpoint executes the command instead of forwarding to Claude:

| Command | Description |
|---------|-------------|
| `/session` | Return current session info (name, message count, context %) |
| `/clear` | Clear the session history |
| `/compact` | Compact Claude Code context without changing chat history |
| `/stop` | Interrupt the in-flight turn |
| `/restart` | Gracefully restart the session |
| `/model` | Return the current model for this agent |

**Command response:**

```json
{
  "command": "/session",
  "session_id": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "result": {
    "name": "My Project Discussion",
    "messageCount": 42,
    "contextPercent": 18
  }
}
```

**New session:**

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! What can you help me with?", "chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/alfred/messages | jq
```

```json
{
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "agent_id": "alfred",
  "response": "Hello! I'm Alfred, your personal assistant. I can help you with...",
  "session_id": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "duration_ms": 2341,
  "attachments": [
    { "type": "image", "url": "/v1/agents/alfred/media/api-sess-id/browser_shot_default_1234567890.jpg" }
  ]
}
```

> `attachments` is only present when the agent captured images during the turn (e.g. via `browser_screenshot`). Each entry has `type: "image"` and a `url` that can be fetched via `GET /api/v1/agents/:agentId/media/*`.

**Continue a session:**

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"message": "What did I just ask you?", "chat_id": "myapp", "session_id": "da19d84a-6a36-4f57-b419-d322d82c4db8"}' \
  http://localhost:10850/api/v1/agents/alfred/messages | jq
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Empty or too-long message, or missing `chat_id` |
| 401 | Missing API key |
| 403 | Invalid key or key has no access to that agent |
| 404 | Agent ID not found, or `session_id` names no session in this `chat_id` (`code: "SESSION_NOT_FOUND"`) |
| 409 | Session is busy processing another request |
| 504 | Agent did not respond within timeout (default 60s) — **sync mode only** |
| 503 | Provider capacity is exhausted or the provider is temporarily unavailable |
| 500 | Internal error |

Typed provider failures (including plain text inside an `error` envelope) preserve the provider message in `error`, including reset times and account guidance, after redacting credentials, internal paths, stack frames and URL credentials/query parameters. This does not depend on recognizing the provider wording or language. Known internal failures return a safe explanation and diagnostic code. Unknown internal exceptions return `GATEWAY_INTERNAL_ERROR` guidance without exposing their raw message. Missing workspace context returns the actionable `WORKSPACE_CONTEXT_MISSING` code and a repair hint; provider calls have not started in that case. Recognized failures also include a `code` field.

Error classification remains separate from display text. A bare HTTP 429 without a provider message is described as a rate limit or quota because it does not identify which limit was reached. Reset/retry wording in provider messages is preserved, not parsed or reformatted. Older callers without typed provider-message metadata retain the existing classification fallback.

> - `session_id` is optional — omit for a stateless one-shot call
> - Sessions idle-timeout after `idleTimeoutMinutes` (default 30 min); history is restored automatically on next message
> - Error 409 = session is currently processing a request — wait and retry
> - After a soft timeout, the same `session_id` keeps returning `409` until the hard cap (a further 10 min) — the subprocess is still finishing that turn, so a retry would interleave. Omit `session_id` to start a fresh session immediately, or stay with this one and read the turn out via [`GET …/sessions/:sessionId/stream`](/api/streaming#resuming-an-interrupted-stream), which is never a conflict.
> - The soft timeout only ends the *request* in sync mode (`504`). In streaming mode it is a non-terminal [`timeout` event](/api/streaming#streaming-api-sse) — the turn is still running and the stream stays open.

---


### Internal response failures

Chat delivery, synchronous API responses, SSE and resumed terminal frames share the same error presentation. Provider wording is preserved from typed error events; internal exceptions use diagnostic codes and safe explanations.

| Failure | Diagnostic |
| --- | --- |
| Claude executable missing / cannot start | `CLAUDE_BINARY_NOT_FOUND`, `CONTAINER_RUNTIME_NOT_FOUND`, `PROCESS_PERMISSION_DENIED`, `PROCESS_START_FAILED` |
| Workspace context missing | `WORKSPACE_CONTEXT_MISSING`, `WORKSPACE_DIRECTORY_MISSING` |
| Process dies during a turn | `PROCESS_EXITED` |
| Response cannot be saved / is too large | `RESPONSE_PERSISTENCE_FAILED`, `RESPONSE_TOO_LARGE` |
| Startup, first-response, idle or total deadline | `TIMEOUT`, with phase-specific guidance |
| HTTP request wait expires while work may continue | `TIMEOUT_SOFT` |
| CLI turn, spending or response-format limit | `MODEL_MAX_TURNS`, `MODEL_BUDGET_EXCEEDED`, `MODEL_OUTPUT_INVALID` |
| Gateway busy, shutting down or mismatched deployment | `CAPACITY_EXCEEDED`, `ORCHESTRATION_CLOSING`, `PROFILE_INVENTORY_MISMATCH` |
| Storage or permission failure | `ENOSPC`, `EACCES`, `EPERM`, `SQLITE_FULL`, `SQLITE_BUSY` |

New orchestration errors retain their diagnostic code even before a dedicated explanation is added. Unclassified exceptions do not expose arbitrary internal text. Legacy uncoded stream/command errors retain their redacted message. HTTP response status and diagnostic codes are separate from provider wording; a provider's HTTP 400 message does not imply the gateway itself returns HTTP 400.

Worker failures remain task failures with bounded, scrubbed evidence, visible to the agent and task inspection. Tool errors remain tool results so the agent can recover. Delivery failures remain outbox/delivery state: if the channel transport is down, an error notice through that same transport cannot be guaranteed. These mechanisms are distinct from a failed conversational response; not every background error should become a new chat message.

Managed streaming errors are normalized before entering legacy stream callbacks, so uncoded internal exceptions stay private on both live and replayed connections. A typed provider error is superseded when the model resumes producing normal output; a later process crash is reported as a process failure, not as an already-recovered provider error.
