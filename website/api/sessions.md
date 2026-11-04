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

Every session response carries `cwd`, `trusted`, `cwdState` and `active`: here, on create, in the
[info](#get-apiv1agentsagentidsessionssessionidinfo) response and on the admin
list `GET /v1/agents/sessions`. List entries carry folder binding in `cwd` when present.

| Field | Meaning |
|-------|---------|
| `cwd` | The absolute path the session stores as its working folder, or `null` when the session has none. |
| `trusted` | `true` only when the session has a `cwd`, its folder is `available`, and the operator trusts it (see below). `false` otherwise. |
| `cwdState` | `null` when the session has no `cwd`. Otherwise it says whether the folder still resolves when the response is built. |
| `active` | `true` while a turn runs or is queued, a session process is spawning, or an orchestrated task on this session has not finished. |

| `cwdState` | Meaning |
|------------|---------|
| `available` | The folder exists under the files root. |
| `missing` | No folder exists at that path, for example after it was deleted or renamed. |
| `unavailable` | The folder exists but cannot be used, for example a symlink that leaves the root, a file in place of a folder, or a folder held by a delete. |

A session whose `cwdState` is `missing` or `unavailable` cannot run. A message to it fails with `409 CWD_UNAVAILABLE`.

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
| `cwd` | No | A folder under the [files root](/api/files) `gateway.files.root`, as an absolute path or a path relative to the root. Binds the session to that folder for its whole life. `null` is the same as omitting it |

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
  "createdAt": 1775737709000,
  "cwd": null,
  "trusted": false,
  "cwdState": null,
  "active": false
}
```

**Folder-bound sessions.** With `cwd`, the agent runs in that folder instead
of its workspace. Its persona still loads, and it gets a short note naming the
folder and the git state: the branch when its name is plain (`[\w./-]`, at most
100 characters), the change count and the remote host, never a remote URL. You
cannot change the folder later.

`cwd` names any folder under the root, not only a folder directly under it. The root itself is refused. A relative
`cwd` such as `site/web` follows the files [path rules](/api/files#paths), so each segment must pass the entry-name
rule. An absolute `cwd` must be a normalized path under the root, with no `.` or `..` segment, no `//` and no trailing `/`. A trailing `/` is refused in the relative form too, so `site/` is `400 invalid_cwd` whatever `site` is. The part below
the root follows the same rules. The root may be spelled as configured or as its real path. The session stores the absolute path `join(<real root>, <relative path>)`,
where `<real root>` is the root resolved through symlinks. The gateway resolves the stored path again at every spawn
and every turn.

The folder runs untrusted unless the operator lists its path in
[`gateway.files.trusted`](/api/files#configuration). Each entry is a path relative to the root, and nested paths such
as `site/web` are allowed. A session is trusted only when the real path of its folder is exactly `<real root>/<entry>`
and its `cwd` does not reach the folder through a symlink. A subfolder of a trusted folder is not trusted. The root
itself may be a symlink. Untrusted means one thing: the repo's own
hooks, MCP servers (`.mcp.json`), settings and `CLAUDE.md` do not load. It does
not restrict anything else. The agent still runs with the gateway's normal
permissions and tools in that folder, so it can read and change the files and
run commands there, and the repo's content (files, READMEs, commit messages)
can still prompt-inject it. Treat an untrusted folder as a folder the agent
works in, not as a sandbox.

Trust is decided by path. Anything that can write under the files root,
including an agent chatting in another folder, can put files into a trusted
folder, and the next trusted chat loads them. Trusting a folder means trusting
everyone who can write to the root.

An agent with `isolateMemory: true` can chat in a folder like any other host agent, and the folder is not split per
conversation. Every chat bound to the folder works in the same place, so what one conversation writes there reaches
the others. A trusted folder also loads its own settings, hooks and `.mcp.json`, so its MCP servers reach the session
although isolated memory mode gives a session none of the operator's. Bind a chat of an isolated agent only to a
folder its conversations may share, and leave that folder out of `gateway.files.trusted`. App agents cannot chat in
a folder (`409 cwd_unsupported_agent`, reason `container`).

Check that `capabilities.sessions` includes `"cwd"` (see [`GET /capabilities`](/api/system))
before you send `cwd`. A gateway with orchestration off, or with the files API disabled,
does not advertise it. With the files API disabled, the create call answers `409 files_disabled`.
With orchestration off, the gateway still creates the session (`201`) and a message sent with
[`POST /messages`](/api/messages) still runs in the folder, but
[`POST /messages/accept`](/api/messages), which the web uses, answers `409 NOT_SUPPORTED`.
Do not rely on the first behaviour; it is not advertised.

A `cwd` needs write permission on the agent. The create call answers these errors for `cwd`. No session is created
on any of them.

| Status | `code` | When |
|--------|--------|------|
| `400` | `invalid_cwd` | `cwd` is not a string, is empty, ends with `/`, is an absolute path that is not normalized, or has a segment that fails the entry-name rule |
| `403` | | `Write permission required`: the key cannot write to this agent (it has no `write` and is not an admin key). `API key has no access to agent '<id>'`: the key does not list this agent. Binding a chat needs the same write access as any other change to the agent |
| `403` | `cwd_outside_root` | `cwd` resolves outside the files root, through symlinks included, or is the root itself, including through a link such as `all -> .` |
| `404` | `cwd_not_found` | No folder exists at `cwd` |
| `409` | `files_disabled` | The files API is disabled on this gateway (`gateway.files.enabled` is `false`) |
| `409` | `cwd_unavailable` | The folder exists but cannot be used. `reason` is `not_a_directory`, `permission_denied`, `deleting` (a `DELETE` is removing an overlapping folder) or `internal` |
| `409` | `cwd_unsupported_agent` | The agent cannot run in a folder. `reason` is `container` for container (app) agents, `workspace_mode` when an orchestrated agent's `tasks.workspaceMode` is not `host`, or `codex` when its workers would run on the Codex harness |

Each check runs again when the session starts its process and at every turn. If
the folder has gone, been renamed, moved out of the root, or is held by a delete,
the message fails with code `CWD_UNAVAILABLE` (uppercase), and the gateway does
not fall back to the workspace. The response carries no `reason` field. While a mark holds the folder the
answers `409`. A streaming request gets an SSE `error` frame with that code.

**A session id belongs to one chat.** Each session id belongs to one `chat_id` of an agent. A request that would
register the id under another `chat_id` answers `409 SESSION_ID_IN_USE` and writes nothing. That covers rename
(`PATCH`), `clear`, `compact`, `stop` and `restart`, including two such requests for one new id sent at once from two
chats: one wins and the other answers `409 SESSION_ID_IN_USE`. [`POST /messages`](/api/messages) and
[`POST /messages/accept`](/api/messages) check the chat first, so they answer `404 SESSION_NOT_FOUND` for an id
that belongs to another chat.

**Who can use a folder-bound chat.** A folder-bound chat belongs to its agent. Every route answers a key for a
folder-bound chat exactly as it does for a plain chat of the same agent: an admin key reaches every agent; any other key
reaches the agents it lists (or every agent with `agents: "*"`), and needs `write: true` wherever a plain chat needs it.
A key that does not list the agent gets `403` with `API key has no access to agent '<id>'`. Lists, history, search,
streams, media, attachments, shares and catalogs show folder-bound chats to every key that reaches the agent, with
their `cwd`, `trusted`, `cwdState` and `active` fields. Only binding a chat to a folder adds a check: the key must be
able to write to the agent (see the table above).

**Session ids.** A session id in the path of any route under `/api/v1/agents/:agentId/sessions/:sessionId`, the voice
and browser-binding routes included, and in `POST /chats/:chatId/sessions/:sessionId/messages`, must be 1 to 64 of `[A-Za-z0-9_-]`. Any other id answers `400` with
`code: "INVALID_INPUT"` before authentication, so for every key and for no key.

**The agent of a folder-bound chat.** The attachment tool (`api_reply`), `share_file` and the image tools call the share,
catalog, artifact and attachment routes with the API key the gateway hands the agent: the first key in `gateway.api.keys`
that reaches it. The orchestration workers of that agent use the same key. Those routes treat a folder-bound chat like a
plain chat, so a key scoped to the agent is enough. A share URL is not private: anyone who holds it can open it.

**When the chat is deleted.** Deleting a folder-bound chat removes its whole media folder (`media/api-<sessionId>/`),
not only the files its messages name, once its last turn has ended. When the delete comes while a turn is still
running, the gateway removes the media folder and what the turn wrote to history after the turn ends, the next time it
lists that agent's sessions or checks whether a folder is in use.

On an orchestrated agent the deciding agent stays in its workspace and is told
which folder the chat is in. Every task it starts runs in that folder,
or in a `working_directory` inside it. Task failures use uppercase codes:

| Task `failure.code` or `task_spawn` error | When |
|--------|------|
| `CWD_UNAVAILABLE` | The folder is gone, renamed or moved when the task is queued or its worker starts |
| `WORKING_DIRECTORY_OUTSIDE_CWD` | `working_directory` does not resolve, through symlinks, to an existing folder inside the chat's folder. It may be absolute or relative to that folder |
| `CWD_UNSUPPORTED_AGENT` | Workers do not run in `host` workspace mode, or the task would run on the Codex worker harness |

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
