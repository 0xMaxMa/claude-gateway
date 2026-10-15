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

If `message` starts with one of these commands, the endpoint answers it locally instead of forwarding to Claude. It never reaches the model:

| Command | Description |
|---------|-------------|
| `/help` | List supported API slash commands and their behavior |
| `/session` | Return the current session, selected model and measured context usage |
| `/sessions` | List sessions in this API chat |
| `/new [name]` | Create a session in this chat; `result.sessionId` is its ID. Sent with `session_id`, that session stays current and the client opens the new one; sent without it, the request's own new session is the one created (and named) |
| `/rename <name>` | Rename the session given by `session_id`; without `session_id` it returns `result: { "error": "SESSION_ID_REQUIRED" }` |
| `/clear` | Reset model context; keep history and seed the next context with 50 recent messages. Confirmation required |
| `/compact` | Compact Claude Code context without changing chat history. Confirmation required |
| `/restart` | Gracefully restart the session. Confirmation required |
| `/stop` | Interrupt the in-flight turn; with orchestration, also choose a task to cancel |
| `/tasks` | With orchestration: browse this session's tasks, open one, stop it |
| `/model` | Return the current model for this agent |
| `/models` | List the available models with the current one marked. Change the model with `PUT /api/v1/agents/:agentId/model` |
| `/pstack-setup` | Show the [pstack](/guide/pstack) setup and its menu; changes need write access to the agent |

`/voice` and `/voices` are answered too, with a pointer to the [voice settings](/api/voice) endpoints: web voice is not a chat command.

`GET /api/v1/commands` returns these commands (name and description) for client command pickers.

Restarting an active response records an intentional interruption, not a process failure. A restart keeps chat history and does not restart the gateway or app container.

Unknown slash commands, including skill commands such as `/pstack:how`, are ordinary messages for the agent. In orchestration mode (for web chat, `orchestration.channels` must include `api`), three `/pstack:*` cases are answered by the gateway instead: on an agent that is not set up for pstack (a pointer to `/pstack-setup`), for a skill that is not user-invocable, and for a name the plugin has no skill for (with close command names when there are any). Without orchestration mode they reach the agent like any other message. See [pstack](/guide/pstack).

#### Command reply {#command-reply}

A command reply has the normal reply shape — `response` (sync) or the `text_delta` and `result` frames (stream) — plus its structured part:

| Field | Description |
|-------|-------------|
| `command` | The command that ran, e.g. `"/stop"` |
| `result` | The command's fields, e.g. `sessions` for `/sessions`, `tasks` and `menuId` for `/stop`, `sessionId` for `/new` |
| `actions` | Buttons, in display order; `[]` when there are none. Each is `{ "label": string, "command": string }` |

In a stream, the three fields are on the `result` frame. Replies from the model have none of them.

To press a button, send its `command` as the next `message`, with the same `chat_id`, `session_id` and API key. It goes through the same checks as a typed command; menu actions (`/orch …`, `/stop <menu> <n>`) are bound to the session and key that opened them and expire, after which the reply says to run the command again. The reply to a pressed button is another command reply: show its `response`, replace the earlier buttons with its `actions`, and close the menu when `actions` is empty. History keeps the replies; the buttons and a pressed action's command are not stored.

| Command | Actions |
|---------|---------|
| `/clear`, `/compact`, `/restart` | `Yes` runs it, `No` cancels. One use each, for five minutes |
| `/stop` (orchestration) | One per running task, then `Dismiss`. A bare number reply still works |
| `/tasks` | Task list, Previous/Next, Refresh, task detail with Stop task and Back, Dismiss |
| `/pstack-setup` | The pstack menu: turn on/off, default effort, a role and its models, reset, close. A change needs write access to the agent |

**Confirmation:** `/clear`, `/compact` and `/restart` first return a prompt with `result: { "confirmationRequired": true }` and Yes/No actions, and do nothing else. Pressing Yes runs the command and returns its normal result. A caller that has already confirmed — an automation, or a client with its own dialog — sends `/clear confirm` (likewise `/compact confirm`, `/restart confirm`) to run it at once. The session endpoints [`POST …/sessions/:sessionId/clear`](/api/sessions#post-apiv1agentsagentidsessionssessionidclear), `/compact` and `/restart` also run without the prompt.

::: warning Upgrading
Before this confirmation, `/clear`, `/compact` and `/restart` sent as messages ran at once. A script that sends them must now add `confirm` (or call the session endpoints); otherwise it gets the prompt and nothing runs.
:::

```json
{
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "agent_id": "alfred",
  "response": "Reset Claude Code context? Chat history stays unchanged; your next message starts a new context with the latest 50 messages. Choose Yes or No.\n\nOr reply /clear confirm.",
  "session_id": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "duration_ms": 3,
  "command": "/clear",
  "result": { "confirmationRequired": true },
  "actions": [
    { "label": "Yes", "command": "/orch 0f6a3c1e-7d0b-4c52-9a43-5a1b2c3d4e5f" },
    { "label": "No", "command": "/orch 9b2e4d10-1c3a-4f6e-8d7b-6c5d4e3f2a1b" }
  ]
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
| 403 | Invalid key or key has no access to that agent. Also, with `code: "forbidden_key"`, any key that is not an admin key (a read-only key and a pod-wide write key included) sending to a [project-bound session](/api/sessions#post-apiv1agentsagentidsessions), or naming a file of one in `media_files` |
| 404 | Agent ID not found, or `session_id` names no session in this `chat_id` (`code: "SESSION_NOT_FOUND"`) |
| 409 | Session is busy processing another request, or, with `code: "PROJECT_UNAVAILABLE"`, the session's project folder is gone, renamed or outside the projects root |
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
| Startup arguments exceed the OS limit (`E2BIG` / `ENAMETOOLONG`) | `PROCESS_ARGS_TOO_LARGE` |
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

## Incoming messages and follow-ups

For committed incoming user-message events and immediate admission while a response is active, see [Committed input stream and immediate admission](./chat-input-stream).
