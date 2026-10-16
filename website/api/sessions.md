# Session Management API {#session-management-api}

Manage API sessions for a specific agent and `chat_id`. Sessions are stored at `sessions/api-{chat_id}/` — symmetric with Telegram (`telegram-{id}`) and Discord (`discord-{id}`).

**`chat_id`** identifies the caller. Use any stable string (e.g. `"myapp"`, `"user-123"`, `"getpod"`). It is **required** on all session endpoints — pass it as:
- Query string for `GET` and `DELETE` requests: `?chat_id=myapp`
- Request body for `POST` and `PATCH` requests: `{"chat_id": "myapp", ...}`

---

## POST /api/v1/agents/:agentId/greeting {#post-apiv1agentsagentidgreeting}

Stream a proactive welcome into an **existing** session. The endpoint reads `GREETING.md` from the agent's workspace and sends its content to the agent as a trigger prompt via SSE. Only the **assistant response** is stored in session history — the trigger prompt is invisible (uses `store_user_message: false` internally).

Returns `204 No Content` if `GREETING.md` does not exist or is empty.

**Auth:** Write or Admin key required.

**Two-step flow:**

1. Create the session first: `POST /api/v1/agents/:agentId/sessions` → redirect the user to the chat UI with the returned `session_id`.
2. Once in the chat UI, trigger the greeting: `POST /api/v1/agents/:agentId/greeting` with that `session_id` and the same `chat_id` → stream the assistant's opening message as SSE with typing animation visible to the user.

**Request:**

| Field | Required | Description |
|-------|----------|-------------|
| `session_id` | Yes | ID of an existing session to deliver the greeting into. Must already exist under `chat_id` — an unknown id is `404`, never a new session |
| `chat_id` | Yes | Same `chat_id` used when the session was created; names the history bucket (`api-{chat_id}`) the greeting is stored in |

> **Breaking change:** `chat_id` is now required. It used to default to `session_id`,
> which filed the greeting under `api-{session_id}` — an index the real chat never
> reads, so the opening message vanished from history while still consuming the
> one-shot `GREETING.md`. Pass the same `chat_id` you created the session with.

```bash
curl -N -X POST \
  -H "X-Api-Key: my-write-key" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "7f3a1c2d-89ab-4def-b012-345678901234", "chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/getpod/greeting
```

**Response `200` (SSE stream)** — greeting is streaming:

```
data: {"type":"text_delta","text":"Hello! "}
data: {"type":"text_delta","text":"Welcome to GetPod."}
data: {"type":"result","text":"Hello! Welcome to GetPod.","session_id":"7f3a1c2d-..."}
data: [DONE]
```

If the session has an active request in flight, the endpoint returns `409` before sending SSE headers.

**Response `204`** — `GREETING.md` not found or empty; nothing sent to session.

**`GREETING.md` format:**

Place the file at `~/.claude-gateway/agents/{agentId}/workspace/GREETING.md`. Its content is used as the prompt sent to the agent. It is **not** concatenated into the agent system prompt — it is a one-time trigger only.

```markdown
The user's environment is ready. Send a warm, concise welcome message
introducing yourself and what you can help with.
```

**Notes:**
- `GREETING.md` is **deleted before streaming begins**. Subsequent calls return 204 immediately, making the endpoint idempotent. Re-provisioning `GREETING.md` enables a new greeting on the next call.
- A `session_id` that names no session under `chat_id` returns `404` with `code: "SESSION_NOT_FOUND"`. The check runs *before* the unlink, so a rejected call leaves `GREETING.md` intact for the real session.
- The SSE stream format matches `POST /messages` with `stream: true` — use the same client-side handler.
- If the agent errors mid-stream, an `{"type":"error","message":"...","code":"..."}` SSE event is sent and the stream closes (`code` omitted when the failure carries none).

---

## GET /api/v1/agents/:agentId/sessions {#get-apiv1agentsagentidsessions}

List all API sessions for a given `chat_id`.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/sessions?chat_id=myapp" | jq
```

```json
{
  "sessions": [
    {
      "id": "da19d84a-6a36-4f57-b419-d322d82c4db8",
      "name": "Project Planning",
      "createdAt": 1775737709000,
      "lastActivity": 1775823600000
    }
  ]
}
```

Every session response carries `project`, `trusted` and `projectState`: here, on create, in the
[info](#get-apiv1agentsagentidsessionssessionidinfo) response and on the admin
list `GET /v1/agents/sessions`. `project` is the project name the session was
created with, or `null`. `trusted` is `true` only when the session has a
project, its folder is `available`, and the operator trusts it (see below); it is `false` otherwise.
`projectState` is `null` when `project` is `null`. Otherwise it says whether the folder still
resolves when the response is built:

| `projectState` | Meaning |
|----------------|---------|
| `available` | The folder exists under the projects root. |
| `missing` | No folder with that name exists, for example after it was deleted or renamed. |
| `unavailable` | The folder exists but cannot be used, for example a symlink that leaves the root or a file in place of a folder. |

A session whose `projectState` is `missing` or `unavailable` cannot run, and a message to it fails with `409 PROJECT_UNAVAILABLE`.

---

## POST /api/v1/agents/:agentId/sessions {#post-apiv1agentsagentidsessions}

Create a new API session. Optionally auto-generates a session name by summarising a prompt.

The gateway mints the id; there is no way to choose one. Along with omitting
`session_id` on [`POST /messages`](/api/messages#post-apiv1agentsagentidmessages), this is
the only way a session comes into existence.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `chat_id` | Yes | Caller identity |
| `prompt` | No | Initial user intent — used to auto-generate a session name |
| `name` | No | Explicit session name (overrides auto-generated name) |
| `project` | No | Name of a [project](/api/projects) under `gateway.projects.root`. Binds the session to that project for its whole life. `null` is the same as omitting it |

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp", "prompt": "I want to discuss the deployment plan for Q3"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions | jq
```

```json
{
  "sessionId": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "sessionName": "Q3 Deployment Plan",
  "createdAt": 1775737709000
}
```

**Project-bound sessions.** With `project`, the agent runs in the project
folder instead of its workspace. Its persona still loads, and it gets a short
note naming the project, the folder and the git state: the branch when its name
is plain (`[\w./-]`, at most 100 characters), the change count and the remote
host, never a remote URL. The response then includes `"project": "<name>"`,
`"trusted"` and `"projectState"`. You cannot change the project later.

The project runs untrusted unless the operator lists its name in
[`gateway.projects.trusted`](/reference/configuration) and `<root>/<name>` is
a real directory, not a symlink. The root itself may be a symlink. Untrusted means one thing: the repo's own
hooks, MCP servers (`.mcp.json`), settings and `CLAUDE.md` do not load. It does
not restrict anything else. The agent still runs with the gateway's normal
permissions and tools in that folder, so it can read and change the files and
run commands there, and the repo's content (files, READMEs, commit messages)
can still prompt-inject it. Treat an untrusted project as a folder the agent
works in, not as a sandbox.

Trust is decided by name. Anything that can write under the projects root,
including an agent chatting in another project, can put files into a trusted
folder, and the next trusted chat loads them. Trusting a project means trusting
everyone who can write to the root.

Check that `capabilities.projects` includes `"chat"` (see [`GET /capabilities`](/api/system))
before you send `project`. A gateway with orchestration off, or with the Projects API disabled,
does not advertise it. With the Projects API disabled, the create call answers `409 projects_disabled`.
With orchestration off, the gateway still creates the session (`201`) and a message sent with
[`POST /messages`](/api/messages) still runs in the project folder, but
[`POST /messages/accept`](/api/messages), which the web uses, answers `409 NOT_SUPPORTED`.
Do not rely on the first behaviour; it is not advertised.

| Status | `code` | When |
|--------|--------|------|
| `400` | `invalid_name` | `project` is not a valid project name |
| `403` | `forbidden_key` | The key is not an admin key. Binding a chat to a project needs `admin: true` |
| `404` | `project_not_found` | No folder with that name exists under the projects root |
| `409` | `projects_disabled` | The Projects API is disabled on this gateway (`gateway.projects.enabled` is `false`). No session is created |
| `409` | `project_unavailable` | The folder exists but cannot be used, for example a symlink that leaves the root. `reason` holds the projects error code |
| `409` | `project_unsupported_agent` | The agent cannot run in a project folder. `reason` is `container` for container (app) agents, `workspace_mode` when an orchestrated agent's `tasks.workspaceMode` is not `host`, or `codex` when its workers would run on the Codex harness |

Each check runs again when the session starts its process. If the folder has
gone, been renamed or moved out of the root, the message fails with code
`PROJECT_UNAVAILABLE` (uppercase) and the gateway does not fall back to the
workspace. A synchronous [`POST /messages`](/api/messages) answers `409`. A
streaming request gets an SSE `error` frame with that code. The key check runs
again on every request that drives or watches the session: a key that is not an admin
key gets `403` with `code: "forbidden_key"` from [`POST /messages`](/api/messages),
`POST /messages/accept`, `POST /greeting` (a read-only key too) and the session's message, activity and event streams.
The same answer comes from every other route that takes the session's id: info, rename, delete, clear, compact,
stop, restart, `GET /sessions/:id/activity`, tasks (list, show, answer, control, cancel), voice,
`POST /chats/:chatId/sessions/:sessionId/messages`, attachments, and its media folder; from
`GET /v1/image-catalog`, `GET /v1/video-catalog`, `POST /v1/shares` and `POST /v1/image-artifacts` when `session_id`
names the session or a path names a file in its media folder; from `media_files` in a message that names such a
file; and from the chat history routes (`/chats/:chatId/messages`, `/messages/search`, `/messages/active-days`) when
the request names the session with `session_id`. A session id that is not a plain id (`[A-Za-z0-9_-]`, 1 to 64
characters) in the path of any route under `/api/v1/agents/:agentId/sessions/:sessionId` (the voice and browser-binding
routes too) answers `400 INVALID_INPUT` before authentication, so for every key, and the media path is
checked after dot segments, `%2e` and double slashes are resolved. For a key that is not an admin key, `GET /sessions`, `GET /chats`,
the unfiltered history routes and the `/sessions` chat command leave the session out, its messages included, and
carry no project name. When the gateway cannot read its `project-bindings` folder, the reads that list sessions or chats
(`GET /sessions`, `GET /chats`, the unfiltered history routes) answer
`503 project_bindings_unreadable` for a key that is not an admin key, and the gateway logs the reason once. A route that
names one session in its path or body, the `/sessions` chat command included (it is sent through `POST /messages` with a
`session_id`), answers `403 forbidden_key` instead, because the gateway cannot tell that the session is unbound. Both
fail closed. An admin key is not affected. On start the gateway also removes binding files whose session no longer
exists and logs the count.

**Routes that are not refused, and why.** `GET /v1/agents/sessions`, the `/dashboard/*` routes and
`GET /api/v1/sessions/:id/screen` need an admin key or a dashboard login for every session, so they never reach a
bound session through a key that is not an admin key. `GET /chats/:chatId/sessions` lists the sessions of
Telegram, Discord and the other channel chats, which are never project-bound. `POST /v1/agents/:agentId/media`
(upload) takes no session id. `DELETE /v1/shares/:shareId` takes a share id and answers only for a key with access
to the owning agent. `GET /shared/:token` is public: the token is the capability, and it can only be minted through
the refused `POST /v1/shares`.

**The agent of a project chat.** The attachment tool (`api_reply`), `share_file` and the image tools call the share,
catalog, artifact and attachment routes with the API key the gateway hands the agent: the first key in `gateway.api.keys`
that reaches it. These routes apply the same admin key rule, so the agent must hold an admin key to attach or share media
in a project chat, as it does on a provisioned pod. The same holds for the orchestration workers of that agent, which use the same key. With a key that is not an admin key, those tool calls in a project
chat answer `403 forbidden_key`; a plain chat is not affected. A share URL is not private: anyone who holds it can open it.

**When the chat is deleted.** Deleting a project chat removes its whole media folder (`media/api-<sessionId>/`), not only
the files its messages name, once its last turn has ended. A read of a media folder named `api-<name>` by a key that is not
an admin key answers `403 forbidden_key` only when `<name>` is a session bound to a project; every other folder is answered
as it is on a gateway without projects, including the leftovers of a deleted session that was never bound.

On an orchestrated agent the deciding agent stays in its workspace and is told
which project the chat is in. Every task it starts runs in the project folder,
or in a `working_directory` inside it. Task failures use uppercase codes:

| Task `failure.code` or `task_spawn` error | When |
|--------|------|
| `PROJECT_UNAVAILABLE` | The project folder is gone, renamed or moved when the task is queued or its worker starts |
| `WORKING_DIRECTORY_OUTSIDE_PROJECT` | `working_directory` does not resolve, through symlinks, to an existing folder inside the project. It may be absolute or relative to the project folder |
| `PROJECT_UNSUPPORTED_AGENT` | Workers do not run in `host` workspace mode, or the task would run on the Codex worker harness |

---

## GET /api/v1/agents/:agentId/sessions/:sessionId/info {#get-apiv1agentsagentidsessionssessionidinfo}

Get info for a specific session — name, message count, and context usage.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a/info?chat_id=myapp" | jq
```

```json
{
  "sessionId": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "sessionName": "Q3 Deployment Plan",
  "messageCount": 42,
  "archivedCount": 0,
  "contextUsedPct": 90,
  "contextTokens": 180000,
  "contextWindow": 200000,
  "contextModel": "claude-sonnet-5",
  "model": "claude-sonnet-5"
}
```

Context fields use the latest measured agent request, matching the dashboard token report, rather than message counts or a pre-compaction peak. Measurements expire when the latest agent decision is older than one hour. Missing measurements are `null`; unknown capacity leaves `contextWindow` and `contextUsedPct` null. `contextModel` identifies the measured model, while `model` is the selected model. Sessions outside orchestration use their stored `lastInputTokens` and model, with freshness based on `lastActive`; they do not have an orchestration request ledger. Message counts remain in the structured API for compatibility; `/session` text omits them and displays `—` when context is unavailable.

**Error responses:**

| Status | When |
|--------|------|
| 404 | Session not found |

---

## PATCH /api/v1/agents/:agentId/sessions/:sessionId {#patch-apiv1agentsagentidsessionssessionid}

Rename a session.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `chat_id` | Yes | Caller identity |
| `session_name` | Yes | New session name (snake_case preferred; `sessionName` also accepted for backward compatibility) |

```bash
curl -X PATCH \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp", "session_name": "Q3 Infra Discussion"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a | jq
```

```json
{
  "sessionId": "da19d84a-6a36-4f57-b419-d322d82c4db8",
  "sessionName": "Q3 Infra Discussion"
}
```

**Notes:**
- Request body accepts `session_name` (snake_case, preferred) or `sessionName` (camelCase, backward compatibility). When both are present, `session_name` takes priority.
- The response body always uses camelCase (`sessionName`), consistent with all other API responses.

---

## DELETE /api/v1/agents/:agentId/sessions/:sessionId {#delete-apiv1agentsagentidsessionssessionid}

Delete a session. Returns 204 No Content on success.

```bash
curl -X DELETE \
  -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a?chat_id=myapp"
```

---

## POST /api/v1/agents/:agentId/sessions/:sessionId/clear {#post-apiv1agentsagentidsessionssessionidclear}

Reset the Claude Code context for this session without deleting chat history or attachments. The next message starts a new CLI session and loads up to the latest 50 history messages once; subsequent managed turns resume the new CLI session. Existing tasks remain unchanged. An active response or compaction must finish before clearing. The reset survives a gateway restart. This endpoint runs at once; the `/clear` chat command asks for [confirmation](/api/messages#command-reply) first.

**Request body:** `{ "chat_id": "myapp" }`

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a/clear | jq
```

```json
{ "success": true, "historyUnchanged": true, "historyLimit": 50 }
```

---

## POST /api/v1/agents/:agentId/sessions/:sessionId/compact {#post-apiv1agentsagentidsessionssessionidcompact}

Run native Claude Code `/compact` on the existing CLI session. Gateway chat history stays unchanged; recent messages are not appended again. A busy response must finish first. Missing transcripts and unconfirmed CLI compaction fail explicitly, without falling back to history summarization. This endpoint runs at once; the `/compact` chat command asks for [confirmation](/api/messages#command-reply) first.

**Request body:** `{ "chat_id": "myapp" }`

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a/compact | jq
```

```json
{ "success": true, "native": true, "historyUnchanged": true }
```

---

## POST /api/v1/agents/:agentId/sessions/:sessionId/stop {#post-apiv1agentsagentidsessionssessionidstop}

Interrupt the currently in-flight turn for this session. In legacy mode this sends SIGINT and returns the simple response below. With orchestration enabled, it also returns a scoped task-selection menu; see [orchestration stop semantics](/api/orchestration#user-task-cancellation).

**Request body:** `{ "chat_id": "myapp" }`

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a/stop | jq
```

```json
{ "stopped": true }
```

---

## POST /api/v1/agents/:agentId/sessions/:sessionId/restart {#post-apiv1agentsagentidsessionssessionidrestart}

Gracefully restart the session (kills the subprocess and notifies when back online). This endpoint runs at once; the `/restart` chat command asks for [confirmation](/api/messages#command-reply) first.

**Request body:** `{ "chat_id": "myapp" }`

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "myapp"}' \
  http://localhost:10850/api/v1/agents/alfred/sessions/da19d84a/restart | jq
```

```json
{ "restarting": true }
```

---
